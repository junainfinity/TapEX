import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDeployArgs, runDeployCli, USAGE } from '../../src/chain/deploy-cli.js';
import { deployContracts, MIN_OPERATOR_ETH_WEI, preflight, type DeployResult } from '../../src/chain/deploy.js';
import { ChainError } from '../../src/chain/errors.js';
import { createContext, fundLocalWallets } from '../../src/chain/context.js';
import { ANVIL_DEV_ACCOUNT_0 } from '../../src/chain/networks.js';
import { ARTIFACTS_DIR, cleanupTemps, startFakeRpc, tempDir, testAddress, writeTestWallets } from './fixtures.js';

afterEach(() => cleanupTemps());

const E18 = 10n ** 18n;

describe('deploy CLI arguments', () => {
  it('parses the documented flags exactly', () => {
    const parsed = parseDeployArgs(['--network', 'base-sepolia', '--fund-house', '1000000', '--player-eth', '0.0005', '--player-tokens', '2500.5', '--redeploy', '--rpc-url', 'http://x']);
    expect(parsed).toEqual({
      ok: true, help: false,
      options: { network: 'base-sepolia', fundHouseWei: 1_000_000n * E18, playerEthWei: 5n * 10n ** 14n, playerTokensWei: 25_005n * 10n ** 17n, signerEthWei: undefined, limits: undefined, redeploy: true, rpcUrl: 'http://x' },
    });
  });

  it('leaves unspecified amounts to the network defaults', () => {
    expect(parseDeployArgs(['--network', 'local'])).toMatchObject({ ok: true, options: { network: 'local', fundHouseWei: undefined, playerEthWei: undefined, redeploy: false } });
  });

  // CS-L3: an omitted limit flag is not filled with a default (that silently reset owner-tuned limits on every
  // re-run); only the flags given are converged, and the deployer checks the merged combination on chain.
  it('passes only the limit flags given and validates them like setLimits', () => {
    const one = parseDeployArgs(['--network', 'local', '--max-voucher', '5000']);
    expect(one.ok && !one.help ? one.options.limits : undefined).toEqual({ maxVoucherAmountWei: 5_000n * E18 });
    const age = parseDeployArgs(['--network', 'local', '--max-attestation-age', '600']);
    expect(age.ok && !age.help ? age.options.limits : undefined).toEqual({ maxAttestationAgeSec: 600n });
    expect(parseDeployArgs(['--network', 'local', '--max-voucher', '2000000'])).toMatchObject({ ok: true, options: { limits: { maxVoucherAmountWei: 2_000_000n * E18 } } }); // checked against on-chain values by the deployer
    expect(parseDeployArgs(['--network', 'local', '--max-voucher', '2000000', '--daily-cap', '1000000'])).toMatchObject({ ok: false, message: expect.stringContaining('--max-voucher <= --daily-cap') });
    expect(parseDeployArgs(['--network', 'local', '--max-voucher', '0'])).toMatchObject({ ok: false });
    // SPEC-11: the vault caps maxAttestationAge at 1 day.
    expect(parseDeployArgs(['--network', 'local', '--max-attestation-age', '86401'])).toMatchObject({ ok: false, message: expect.stringContaining('1 day') });
    expect(parseDeployArgs(['--network', 'local', '--max-attestation-age', '604801'])).toMatchObject({ ok: false, message: expect.stringContaining('1 day') });
    expect(parseDeployArgs(['--network', 'local', '--max-attestation-age', '86400'])).toMatchObject({ ok: true, options: { limits: { maxAttestationAgeSec: 86_400n } } });
    expect(parseDeployArgs(['--network', 'local', '--max-attestation-age', '1.5'])).toMatchObject({ ok: false });
  });

  it.each([
    [[], '--network must be local or base-sepolia'],
    [['--network', 'mainnet'], 'got "mainnet"'],
    [['--network', 'local', '--fund-house', '-5'], '--fund-house'],
    [['--network', 'local', '--player-eth', '1e3'], '--player-eth'],
    [['--network', 'local', '--bogus'], 'bogus'],
    [['--network', 'local', 'extra'], 'extra'],
  ])('rejects %j', (argv, message) => {
    const parsed = parseDeployArgs(argv);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.message).toContain(message);
  });
});

describe('deploy CLI runner', () => {
  const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }; };

  it('prints help and usage errors', async () => {
    const help = io();
    expect(await runDeployCli(['--help'], help.io)).toBe(0);
    expect(help.out.join('\n')).toBe(USAGE);
    const bad = io();
    expect(await runDeployCli(['--network', 'nope'], bad.io)).toBe(2);
    expect(bad.err.join('\n')).toContain('Usage:');
  });

  it('prints the deployment summary with addresses and actions', async () => {
    const t = io();
    const result: DeployResult = {
      mode: 'deployed', file: '/repo/contracts/deployments/84532.json', actions: ['deployed MockOpenToken (tOPEN) at 0x5FbDB2315678afecb367f032d93F642f64180aa3 (tx 0xabc)'],
      deployment: { chainId: 84532, token: '0x5FbDB2315678afecb367f032d93F642f64180aa3', vault: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512', operator: testAddress('open-operator'), ledgerSigner: testAddress('ledger-signer'), blockNumber: 42n, txs: {} },
    };
    let received: unknown;
    const code = await runDeployCli(['--network', 'base-sepolia', '--fund-house', '10'], t.io, async options => { received = options; return result; });
    expect(code).toBe(0);
    expect(received).toMatchObject({ network: 'base-sepolia', fundHouseWei: 10n * E18 });
    const summary = t.out.join('\n');
    expect(summary).toContain('Maya-Live contracts on base-sepolia (chainId 84532): deployed');
    expect(summary).toContain('https://sepolia.basescan.org/address/0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512');
    expect(summary).toContain('not the real $OPEN');
    expect(summary).toContain('start block   42');
  });

  it('reports typed failures with their code and exits 1', async () => {
    const t = io();
    const code = await runDeployCli(['--network', 'local'], t.io, async () => { throw new ChainError('RPC_UNAVAILABLE', 'Cannot reach the local RPC'); });
    expect(code).toBe(1);
    expect(t.err.join('\n')).toContain('deploy failed [RPC_UNAVAILABLE]: Cannot reach the local RPC');
  });
});

describe('deploy preflight', () => {
  const operator = testAddress('open-operator');

  it('refuses Base Sepolia below 0.01 ETH, naming the operator address', () => {
    const result = preflight({ network: 'base-sepolia', operator, operatorEthWei: MIN_OPERATOR_ETH_WEI - 1n, distributionEthWei: 0n });
    expect(result.ok).toBe(false);
    const message = result.ok ? '' : result.message;
    expect(message).toContain(operator);
    expect(message).toContain('0.009999999999999999 ETH');
    expect(message).toContain('at least 0.01 ETH');
    expect(preflight({ network: 'base-sepolia', operator, operatorEthWei: MIN_OPERATOR_ETH_WEI, distributionEthWei: 0n })).toEqual({ ok: true });
  });

  it('requires enough ETH for the top-ups plus a gas reserve', () => {
    const result = preflight({ network: 'base-sepolia', operator, operatorEthWei: MIN_OPERATOR_ETH_WEI, distributionEthWei: MIN_OPERATOR_ETH_WEI });
    expect(result).toMatchObject({ ok: false, code: 'INSUFFICIENT_GAS_FUNDS', message: expect.stringContaining('--player-eth') });
    expect(preflight({ network: 'local', operator, operatorEthWei: 0n, distributionEthWei: 0n })).toEqual({ ok: true });
  });

  it.skipIf(!existsSync(path.join(ARTIFACTS_DIR, 'MayaHouseVault.sol', 'MayaHouseVault.json')))('stops the CLI before any transaction when the Base Sepolia operator is unfunded', async () => {
    const rpc = await startFakeRpc({ eth_chainId: () => '0x14a34', eth_getBalance: () => '0x0' });
    try {
      const dir = tempDir();
      const secretsPath = writeTestWallets(dir);
      const deploymentsDir = path.join(dir, 'deployments');
      await expect(deployContracts({ network: 'base-sepolia', rpcUrl: rpc.url, secretsPath, deploymentsDir, artifactsDir: ARTIFACTS_DIR })).rejects.toMatchObject({ code: 'INSUFFICIENT_GAS_FUNDS', message: expect.stringContaining(operator) });
      expect(rpc.calls.every(m => m === 'eth_chainId' || m === 'eth_getBalance')).toBe(true);
      expect(existsSync(deploymentsDir)).toBe(false);
    } finally {
      await rpc.close();
    }
  });

  it('funds local wallets only on anvil, and only when dev account 0 can cover them', async () => {
    const dir = tempDir();
    const secretsPath = writeTestWallets(dir);
    await expect(fundLocalWallets(createContext('base-sepolia', { secretsPath, rpcUrl: 'http://127.0.0.1:9', env: {} }))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const rpc = await startFakeRpc({
      eth_chainId: () => '0x7a69',
      eth_getBalance: ([address]) => (String(address).toLowerCase() === ANVIL_DEV_ACCOUNT_0.address.toLowerCase() ? '0xde0b6b3a7640000' : '0x0'), // dev has 1 ETH
    });
    try {
      const error = await fundLocalWallets(createContext('local', { secretsPath, rpcUrl: rpc.url })).catch(e => e as ChainError);
      expect(error).toMatchObject({ code: 'INSUFFICIENT_GAS_FUNDS', message: expect.stringContaining('restart anvil') });
      expect(rpc.calls).not.toContain('eth_sendRawTransaction');
    } finally {
      await rpc.close();
    }
  });

  it.skipIf(!existsSync(path.join(ARTIFACTS_DIR, 'MayaHouseVault.sol', 'MayaHouseVault.json')))('refuses an RPC that serves a different chain', async () => {
    const rpc = await startFakeRpc({ eth_chainId: () => '0x1' });
    try {
      const dir = tempDir();
      await expect(deployContracts({ network: 'base-sepolia', rpcUrl: rpc.url, secretsPath: writeTestWallets(dir), deploymentsDir: path.join(dir, 'd'), artifactsDir: ARTIFACTS_DIR })).rejects.toMatchObject({ code: 'CHAIN_ID_MISMATCH' });
    } finally {
      await rpc.close();
    }
  });
});
