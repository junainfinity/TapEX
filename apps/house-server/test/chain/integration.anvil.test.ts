// Runs only when an anvil node answers at MAYA_RPC_URL (default http://127.0.0.1:8545) with chainId 31337, e.g.
//   docker run -d --rm --name maya-anvil-test -p 8546:8545 ghcr.io/foundry-rs/foundry:stable "anvil --host 0.0.0.0 --chain-id 31337"
//   MAYA_RPC_URL=http://127.0.0.1:8546 pnpm --filter @maya/house-server exec vitest run test/chain
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mayaHouseVaultAbi, mockOpenTokenAbi } from '../../src/chain/abi.js';
import { runDeployCli } from '../../src/chain/deploy-cli.js';
import { deployContracts } from '../../src/chain/deploy.js';
import { writeDeployment } from '../../src/chain/deployment.js';
import { createChain, type LiveChain } from '../../src/chain/live-chain.js';
import type { DepositEvent, WithdrawalEvent } from '../../src/chain/indexer.js';
import { buildBalanceTree } from '../../src/chain/merkle.js';
import { withdrawalDigest } from '../../src/chain/voucher.js';
import { ARTIFACTS_DIR, REPO_ROOT, cleanupTemps, tempDir, testAddress, testKey, testWalletsJson, waitFor, writeJson, writeTestWallets } from './fixtures.js';

const ANVIL = process.env['MAYA_RPC_URL']?.trim() || 'http://127.0.0.1:8545';
const E18 = 10n ** 18n;

async function anvilRpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** Moves anvil's clock forward and mines a block at the new time. */
async function advanceTime(seconds: bigint): Promise<void> {
  await anvilRpc('evm_increaseTime', [Number(seconds)]);
  await anvilRpc('evm_mine');
}

async function anvilReachable(): Promise<boolean> {
  try {
    const response = await fetch(ANVIL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(1_500),
    });
    const body = await response.json() as { result?: string };
    return body.result === '0x7a69';
  } catch {
    return false;
  }
}

const reachable = await anvilReachable();
if (!reachable) console.warn(`[chain integration] anvil not reachable at ${ANVIL} with chainId 31337; skipping`);

describe.skipIf(!reachable)('chain adapter on anvil', { timeout: 120_000 }, () => {
  // A salt per run gives fresh zero-balance wallets even on a long-lived anvil (exercises dev-account funding).
  const salt = `maya-live-anvil-it:${Date.now()}`;
  const player1 = testAddress('player-1', salt);
  const player2 = testAddress('player-2', salt);
  const operator = testAddress('open-operator', salt);
  const client = createPublicClient({ chain: foundry, transport: http(ANVIL) });
  const logs: string[] = [];
  const log = (line: string) => { logs.push(line); };
  let dir: string; let secretsPath: string; let deploymentsDir: string; let dataDir: string;
  let chain: LiveChain;
  const deposits: DepositEvent[] = [];
  const withdrawals: WithdrawalEvent[] = [];
  let voucherTx: { txHash: string; blockNumber: bigint } | undefined;

  beforeAll(() => {
    dir = tempDir('maya-anvil-');
    secretsPath = writeTestWallets(dir, undefined, salt);
    deploymentsDir = path.join(dir, 'deployments');
    dataDir = path.join(dir, 'data');
  });
  afterAll(async () => {
    await chain?.stop();
    // Keys must never reach logs.
    const keysFile = JSON.parse(readFileSync(secretsPath, 'utf8')) as { wallets: { privateKey: string }[] };
    cleanupTemps();
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) for (const w of keysFile.wallets) expect(line.toLowerCase()).not.toContain(w.privateKey.slice(2).toLowerCase());
  });

  it('deploys token + vault, funds the house and players, then attaches idempotently', async () => {
    const options = { network: 'local' as const, rpcUrl: ANVIL, secretsPath, deploymentsDir, artifactsDir: ARTIFACTS_DIR, fundHouseWei: 1_000_000n * E18, playerEthWei: 1n * E18, playerTokensWei: 10_000n * E18, signerEthWei: 1n * E18, log };
    const first = await deployContracts(options);
    expect(first.mode).toBe('deployed');
    const file = JSON.parse(readFileSync(path.join(deploymentsDir, '31337.json'), 'utf8'));
    expect(file).toMatchObject({ chainId: 31337, token: first.deployment.token, vault: first.deployment.vault, operator, ledgerSigner: testAddress('ledger-signer', salt), network: 'local' });
    expect(typeof file.blockNumber).toBe('number');
    expect(file.txs).toMatchObject({ deployToken: expect.stringMatching(/^0x[0-9a-f]{64}$/), deployVault: expect.any(String), fundHouse: expect.any(String), approveHouse: expect.any(String) });
    expect(Object.keys(file.txs.playerTokens)).toHaveLength(11);
    expect(first.actions.some(a => a.includes('funded open-operator from anvil dev account 0'))).toBe(true);
    const vault = first.deployment.vault;
    expect(await client.readContract({ address: vault, abi: mayaHouseVaultAbi, functionName: 'houseFunded' })).toBe(1_000_000n * E18);
    expect(await client.readContract({ address: vault, abi: mayaHouseVaultAbi, functionName: 'owner' })).toBe(operator);
    expect(await client.readContract({ address: first.deployment.token, abi: mockOpenTokenAbi, functionName: 'balanceOf', args: [player1] })).toBe(10_000n * E18);
    expect(await client.readContract({ address: first.deployment.token, abi: mockOpenTokenAbi, functionName: 'symbol' })).toBe('tOPEN');

    const second = await deployContracts(options);
    expect(second.mode).toBe('attached');
    expect(second.deployment.vault).toBe(vault);
    expect(second.actions.at(-1)).toContain('nothing to do');
    expect(second.deployment.txs['deployVault']).toBe(file.txs.deployVault);

    // A higher target tops up by the difference only.
    const third = await deployContracts({ ...options, fundHouseWei: 1_000_500n * E18 });
    expect(third.actions.some(a => a.startsWith('funded the house with 500 tOPEN'))).toBe(true);
  });

  it('starts, indexes a deposit (with dust) exactly once and reports it with exact fields', async () => {
    chain = createChain('local', { rpcUrl: ANVIL, secretsPath, deploymentsDir, dataDir, pollIntervalMs: 100, log });
    chain.onDeposit(d => deposits.push(d));
    chain.onWithdrawn(w => withdrawals.push(w));
    await chain.start();
    const amount = 123n * E18 + 45n * 10n ** 16n + 7n; // 123.45 OPEN + 7 wei dust
    const tx = await chain.playerDeposit('player-1', amount);
    const [deposit] = await waitFor(() => (deposits.length >= 1 ? deposits : null), { what: 'deposit delivery' });
    expect(deposit).toEqual({ player: player1, amountWei: amount, depositId: 1n, txHash: tx.txHash, logIndex: expect.any(Number), blockNumber: tx.blockNumber });
    await new Promise(resolve => setTimeout(resolve, 400)); // several more polls
    expect(deposits).toHaveLength(1);
    expect(chain.indexerLagBlocks()).toBeLessThanOrEqual(2);
    expect(chain.explorerUrl('tx', tx.txHash)).toBeNull();
    await expect(chain.playerDeposit('player-1', 10n ** 30n)).rejects.toMatchObject({ code: 'INSUFFICIENT_TOKEN_BALANCE' });
    await expect(chain.playerDeposit('open-operator', 1n)).rejects.toMatchObject({ code: 'UNKNOWN_ROLE' });
  });

  it('pays a signed voucher once and rejects replays and misuse with decoded reverts', async () => {
    const { vault } = chain.addresses();
    const expiry = (await chain.chainTime()) + 3_600n;
    const voucher = { account: player1, amountWei: 50n * E18, nonce: 1n, expiry };
    const signature = await chain.signWithdrawal(voucher);
    const onchain = await client.readContract({ address: vault as Address, abi: mayaHouseVaultAbi, functionName: 'hashWithdrawal', args: [player1, voucher.amountWei, voucher.nonce, voucher.expiry] });
    expect(onchain).toBe(withdrawalDigest({ chainId: 31337, vault: vault as Address }, voucher));
    const before = await chain.balances(player1);
    voucherTx = await chain.playerWithdraw('player-1', { amountWei: voucher.amountWei, nonce: 1n, expiry, signature });
    const after = await chain.balances(player1);
    expect(after.tokenWei - before.tokenWei).toBe(50n * E18);
    expect(after.ethWei < before.ethWei).toBe(true); // paid gas
    await expect(chain.playerWithdraw('player-1', { amountWei: voucher.amountWei, nonce: 1n, expiry, signature })).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'NonceAlreadyUsed' } });
    await expect(chain.playerWithdraw('player-2', { amountWei: voucher.amountWei, nonce: 1n, expiry, signature })).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'InvalidSignature' } });
    await expect(chain.playerWithdraw('player-1', { amountWei: voucher.amountWei, nonce: 2n, expiry, signature: signature.slice(0, 20) })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('attests (clamping a future asOf to indexed chain time), withdraws only surplus and keeps the vault consistent', async () => {
    const { vault, token } = chain.addresses();
    const deposited = deposits[0]!.amountWei;
    const liabilities = deposited - 50n * E18; // the ledger's player-1 balance after the withdrawal
    const ledgerRoot = keccak256(toHex('maya-ledger-root-1'));
    const wallClockMs = BigInt(Date.now()) * 1_000n; // wrong unit and in the future: must be clamped, never attested
    const attested = await chain.attest({ liabilitiesWei: liabilities, ledgerRoot, asOf: wallClockMs, seq: 1n });
    const latest = await chain.chainTime();
    expect(attested.asOf <= latest).toBe(true);
    expect(logs.some(l => l.includes('attest seq 1') && l.includes('past the indexed chain time'))).toBe(true);
    let state = await chain.vaultState();
    expect(state.lastAttestation).toEqual({ liabilitiesWei: liabilities, asOf: attested.asOf, seq: 1n, ledgerRoot });
    await expect(chain.attest({ liabilitiesWei: liabilities, ledgerRoot, asOf: attested.asOf, seq: 1n })).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'NonIncreasingSeq' } });
    // CS-H1: no key can jump the seq to 2^64 - 1 (or anywhere past one step) and make its root permanent.
    await expect(chain.attest({ liabilitiesWei: liabilities, ledgerRoot, asOf: attested.asOf, seq: 2n ** 64n - 1n })).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'SeqStepTooLarge' } });
    await expect(chain.attest({ liabilitiesWei: liabilities, ledgerRoot, asOf: attested.asOf, seq: 1_000_002n })).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'SeqStepTooLarge' } });
    expect((await chain.vaultState()).lastAttestation?.seq).toBe(1n);

    const read = <F extends 'requiredAssets' | 'depositsSinceAttest' | 'claimedSinceAttest'>(functionName: F) => client.readContract({ address: vault as Address, abi: mayaHouseVaultAbi, functionName });
    const [required, depositsSince, claimedSince] = await Promise.all([read('requiredAssets'), read('depositsSinceAttest'), read('claimedSinceAttest')]);
    expect(required).toBe(liabilities + depositsSince - claimedSince);
    expect(state.surplusWei).toBe(state.assetsWei - required);
    expect(state.surplusWei > 0n).toBe(true);

    const operatorBefore = await chain.balances(testAddress('open-operator', salt));
    await expect(chain.withdrawHouse(state.surplusWei + 1n, testAddress('open-operator', salt))).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'ExceedsHouseSurplus' } });
    const take = state.surplusWei / 4n;
    await chain.withdrawHouse(take, testAddress('open-operator', salt));
    const operatorAfter = await chain.balances(testAddress('open-operator', salt));
    expect(operatorAfter.tokenWei - operatorBefore.tokenWei).toBe(take);

    await chain.pauseVault();
    expect((await chain.vaultState()).paused).toBe(true);
    await expect(chain.playerDeposit('player-2', E18)).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'EnforcedPause' } });
    await chain.unpauseVault();

    state = await chain.vaultState();
    expect(state.paused).toBe(false);
    expect(state.totalDepositsWei).toBe(deposited);
    expect(state.totalWithdrawalsWei).toBe(50n * E18);
    expect(state.houseFundedWei).toBe(1_000_500n * E18);
    expect(state.houseWithdrawnWei).toBe(take);
    expect(state.assetsWei).toBe(state.totalDepositsWei + state.houseFundedWei - state.totalWithdrawalsWei - state.houseWithdrawnWei);
    expect(await client.readContract({ address: token as Address, abi: mockOpenTokenAbi, functionName: 'balanceOf', args: [vault as Address] })).toBe(state.assetsWei);
    expect(state).toMatchObject({ maxVoucherAmountWei: 100_000n * E18, dailyOutflowCapWei: 1_000_000n * E18, accountDailyOutflowCapWei: 250_000n * E18, pendingLimits: null });
    expect(await chain.remainingAccountDailyOutflow(player1)).toBe(250_000n * E18 - 50n * E18); // the 50 voucher redeemed today

    // fundHouse through the port (approve + fundHouse under one flow).
    await chain.fundHouse(25n * E18);
    expect((await chain.vaultState()).houseFundedWei).toBe(1_000_525n * E18);
  });

  // ------------------------------------------------------------------ SPEC-11 hardening

  /** Waits until the indexer has scanned the current head (so attest's asOf is the head's timestamp). */
  async function caughtUp(c: LiveChain): Promise<void> {
    const head = await client.getBlockNumber({ cacheTime: 0 });
    await waitFor(() => ((c.watermark()?.number ?? -1n) >= head ? true : null), { what: `watermark at block ${head}` });
  }

  it('indexes the redeemed voucher as a Withdrawn event exactly once and reports nonceUsed', async () => {
    const [w] = await waitFor(() => (withdrawals.length >= 1 ? withdrawals : null), { what: 'withdrawal delivery' });
    expect(w).toEqual({ player: player1, amountWei: 50n * E18, nonce: 1n, txHash: voucherTx!.txHash, logIndex: expect.any(Number), blockNumber: voucherTx!.blockNumber });
    await new Promise(resolve => setTimeout(resolve, 300)); // several more polls re-read the overlap
    expect(withdrawals).toHaveLength(1);
    expect(await chain.nonceUsed(player1, 1n)).toBe(true);
    expect(await chain.nonceUsed(player1, 2n)).toBe(false);
    expect(await chain.nonceUsed(player2, 1n)).toBe(false);
    expect(chain.indexerStatus()).toMatchObject({ withdrawalsIndexed: true, withdrawalsDelivered: 1, pendingWithdrawals: 0 });
  });

  it('sweeps donated tokens and never touches accounted assets', async () => {
    const { vault, token } = chain.addresses();
    const operator = testAddress('open-operator', salt);
    const donor = createWalletClient({ account: privateKeyToAccount(testKey('player-2', salt)), chain: foundry, transport: http(ANVIL) });
    const hash = await donor.writeContract({ address: token as Address, abi: mockOpenTokenAbi, functionName: 'transfer', args: [vault as Address, 7n * E18] });
    await client.waitForTransactionReceipt({ hash });
    const before = await chain.vaultState();
    expect(before.excessWei).toBe(7n * E18);
    const operatorBefore = (await chain.balances(operator)).tokenWei;
    const swept = await chain.sweepExcess(operator);
    expect(swept.amountWei).toBe(7n * E18);
    const after = await chain.vaultState();
    expect(after).toMatchObject({ excessWei: 0n, assetsWei: before.assetsWei });
    expect((await chain.balances(operator)).tokenWei - operatorBefore).toBe(7n * E18);
    await expect(chain.sweepExcess(operator)).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'NothingToSweep' } });
  });

  it('tightens house limits at once and applies a loosening only after the timelock', async () => {
    const operator = testAddress('open-operator', salt);
    const liabilities = deposits[0]!.amountWei - 50n * E18;
    await chain.setHouseLimits(2_000n, 1_000n * E18);
    let state = await chain.vaultState();
    expect(state).toMatchObject({ houseBufferBps: 2_000n, houseDailyCap: 1_000n * E18, pendingHouseLimits: null });
    await caughtUp(chain);
    await chain.attest({ liabilitiesWei: liabilities, ledgerRoot: keccak256(toHex('maya-ledger-root-2')), asOf: await chain.chainTime(), seq: 2n });
    // A quarter of the surplus already left today, far above the new 1,000 tOPEN cap.
    await expect(chain.withdrawHouse(1n, operator)).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'HouseDailyCapExceeded' } });
    expect((await chain.vaultState()).houseWithdrawableWei).toBe(0n);

    const scheduled = await chain.setHouseLimits(1_000n, 10_000_000n * E18);
    const scheduledAt = (await client.getBlock({ blockNumber: scheduled.blockNumber })).timestamp;
    state = await chain.vaultState();
    expect(state.pendingHouseLimits).toEqual({ houseBufferBps: 1_000n, houseDailyCap: 10_000_000n * E18, eta: scheduledAt + 172_800n, expiresAt: scheduledAt + 172_800n + 604_800n });
    expect(state.houseDailyCap).toBe(1_000n * E18);
    await expect(chain.acceptHouseLimits()).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'TimelockNotElapsed' } });
    await advanceTime(172_800n);
    await chain.acceptHouseLimits();
    expect(await chain.vaultState()).toMatchObject({ houseBufferBps: 1_000n, houseDailyCap: 10_000_000n * E18, pendingHouseLimits: null });
  });

  it('rotates the ledger signer only through the timelock, fails closed while rotated away, then rotates back', async () => {
    const original = testAddress('ledger-signer', salt);
    const interim = testAddress('interim-signer', salt);
    const operator = testAddress('open-operator', salt);
    const liabilities = deposits[0]!.amountWei - 50n * E18;
    await expect(chain.acceptLedgerSigner()).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'NoPendingLedgerSigner' } });
    await expect(chain.proposeLedgerSigner(operator)).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'SignerIsOwner' } });
    await chain.proposeLedgerSigner(interim);
    await chain.cancelLedgerSigner();
    expect((await chain.vaultState()).pendingSigner).toBeNull();

    const proposal = await chain.proposeLedgerSigner(interim);
    const proposedAt = (await client.getBlock({ blockNumber: proposal.blockNumber })).timestamp;
    expect(proposal.eta).toBe(proposedAt + 172_800n);
    expect((await chain.vaultState()).pendingSigner).toEqual({ address: interim, eta: proposal.eta, expiresAt: proposal.eta + 604_800n }); // CS-L2: acceptable for 7 days after the eta
    await expect(chain.acceptLedgerSigner()).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'TimelockNotElapsed' } });
    await advanceTime(172_800n);
    await chain.acceptLedgerSigner();
    expect((await chain.vaultState()).ledgerSigner).toBe(interim);
    expect(chain.addresses().ledgerSigner).toBe(interim);
    expect(JSON.parse(readFileSync(path.join(deploymentsDir, '31337.json'), 'utf8'))).toMatchObject({ ledgerSigner: interim, txs: { acceptLedgerSigner: expect.any(String) } });
    // This adapter only holds the original key: it refuses to hand out worthless vouchers or send doomed attestations.
    await expect(chain.signWithdrawal({ account: player1, amountWei: E18, nonce: 99n, expiry: 10n ** 12n })).rejects.toMatchObject({ code: 'SIGNER_MISMATCH' });
    await expect(chain.attest({ liabilitiesWei: liabilities, ledgerRoot: keccak256(toHex('x')), asOf: 1n, seq: 3n })).rejects.toMatchObject({ code: 'SIGNER_MISMATCH' });
    await expect(chain.withdrawHouse(E18, operator)).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'AttestationBySupersededSigner' } });

    await chain.proposeLedgerSigner(original);
    await advanceTime(172_800n);
    await chain.acceptLedgerSigner();
    expect(chain.addresses().ledgerSigner).toBe(original);
    await caughtUp(chain);
    await chain.attest({ liabilitiesWei: liabilities, ledgerRoot: keccak256(toHex('maya-ledger-root-3')), asOf: await chain.chainTime(), seq: 3n });
    const before = (await chain.vaultState()).houseWithdrawnWei;
    await chain.withdrawHouse(E18, operator);
    expect((await chain.vaultState()).houseWithdrawnWei - before).toBe(E18);
  });

  it('runs the escape hatch end to end on its own vault: frozen Merkle root, proofs, exactly-once claims', async () => {
    const escSalt = `${salt}:escape`;
    const escDir = path.join(dir, 'escape');
    const escSecrets = writeTestWallets(escDir, undefined, escSalt);
    const escDeployments = path.join(escDir, 'deployments');
    const who = (role: string) => testAddress(role, escSalt);
    await deployContracts({
      network: 'local', rpcUrl: ANVIL, secretsPath: escSecrets, deploymentsDir: escDeployments, artifactsDir: ARTIFACTS_DIR,
      fundHouseWei: 1_000n * E18, playerEthWei: E18, playerTokensWei: 1_000n * E18, signerEthWei: E18, escapeDelaySec: 259_200n, log,
    });
    const esc = createChain('local', { rpcUrl: ANVIL, secretsPath: escSecrets, deploymentsDir: escDeployments, dataDir: null, pollIntervalMs: 100, log });
    const seen: DepositEvent[] = [];
    esc.onDeposit(d => seen.push(d));
    esc.onWithdrawn(() => undefined); // the ledger consumes withdrawals, so attest waits for them
    try {
      await esc.start();
      await esc.playerDeposit('player-1', 300n * E18);
      await esc.playerDeposit('player-2', 200n * E18);
      await advanceTime(1n); // a block strictly after the deposits
      await waitFor(() => (seen.length >= 2 ? seen : null), { what: 'escape-vault deposits' });
      await caughtUp(esc);
      const tree = buildBalanceTree([{ account: who('player-1'), balanceWei: 250n * E18 }, { account: who('player-2'), balanceWei: 260n * E18 }]);
      await esc.attest({ liabilitiesWei: 510n * E18, ledgerRoot: tree.root, asOf: await esc.chainTime(), seq: 1n });
      await advanceTime(1n); // later flows are mined strictly after the root's asOf
      await esc.playerDeposit('player-3', 100n * E18);
      const expiry = (await esc.chainTime()) + 3_600n;
      const voucher = { account: who('player-1'), amountWei: 50n * E18, nonce: 1n, expiry };
      await esc.playerWithdraw('player-1', { amountWei: voucher.amountWei, nonce: 1n, expiry, signature: await esc.signWithdrawal(voucher) });

      await expect(esc.triggerEscape('player-3')).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'EscapeNotYetAvailable' } });
      await advanceTime(259_200n);
      await esc.triggerEscape('player-3');
      const state = await esc.vaultState();
      expect(state.escape).toMatchObject({ mode: true, escapeDelay: 259_200n, poolWei: 610n * E18, claimedWei: 0n });
      expect(await esc.escapeEntitlement(who('player-1'), 250n * E18)).toBe(200n * E18);

      await expect(esc.playerClaimEscape('player-1', 251n * E18, tree.proofFor(who('player-1')))).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'InvalidProof' } });
      const before = (await esc.balances(who('player-1'))).tokenWei;
      const claim = await esc.playerClaimEscape('player-1', 250n * E18, tree.proofFor(who('player-1')));
      expect(claim.paidWei).toBe(200n * E18); // 250 attested - the 50 voucher redeemed after the root
      expect((await esc.balances(who('player-1'))).tokenWei - before).toBe(200n * E18);
      await expect(esc.playerClaimEscape('player-1', 250n * E18, tree.proofFor(who('player-1')))).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'NothingToClaim' } });
      expect((await esc.playerClaimEscape('player-2', 260n * E18, tree.proofFor(who('player-2')))).paidWei).toBe(260n * E18);
      expect((await esc.playerClaimEscape('player-3', 0n, [])).paidWei).toBe(100n * E18); // deposited after the root
      await expect(esc.playerDeposit('player-1', E18)).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'EscapeModeActive' } });
      await expect(esc.attest({ liabilitiesWei: 0n, ledgerRoot: tree.root, asOf: await esc.chainTime(), seq: 2n })).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'EscapeModeActive' } });

      // CS-M1: the owner recovers what no claim can reach (1,000 bankroll + 600 deposits - 50 voucher - 560 claims,
      // minus the 50 of the pool still unclaimed), never the unclaimed pool.
      const operator = esc.addresses().operator;
      expect((await esc.vaultState()).escape.surplusWei).toBe(940n * E18);
      const operatorBefore = (await esc.balances(operator)).tokenWei;
      expect((await esc.recoverEscapeSurplus(operator)).amountWei).toBe(940n * E18);
      expect((await esc.balances(operator)).tokenWei - operatorBefore).toBe(940n * E18);
      await expect(esc.recoverEscapeSurplus(operator)).rejects.toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'NothingToRecover' } });

      const final = await esc.vaultState();
      expect(final.escape.claimedWei).toBe(560n * E18);
      expect(final.escape.surplusWei).toBe(0n);
      expect(final.assetsWei).toBe(final.escape.poolWei - final.escape.claimedWei);
      expect(final.assetsWei).toBe(final.totalDepositsWei + final.houseFundedWei - final.totalWithdrawalsWei - final.houseWithdrawnWei);
      expect(await client.readContract({ address: esc.addresses().token as Address, abi: mockOpenTokenAbi, functionName: 'balanceOf', args: [esc.addresses().vault as Address] })).toBe(final.assetsWei);

      // A deployer re-run on an escaped vault skips house funding (fundHouse would revert) and says why.
      const rerun = await deployContracts({
        network: 'local', rpcUrl: ANVIL, secretsPath: escSecrets, deploymentsDir: escDeployments, artifactsDir: ARTIFACTS_DIR,
        fundHouseWei: 2_000n * E18, playerEthWei: E18, playerTokensWei: 1_000n * E18, signerEthWei: E18, log,
      });
      expect(rerun.actions.some(a => a.startsWith('the vault is in escape mode (irreversible): house funding skipped'))).toBe(true);
      expect((await esc.vaultState()).houseFundedWei).toBe(1_000n * E18);
    } finally {
      await esc.stop();
    }
  });

  it('converges timelocked parameters across deployer re-runs: signer rotation, delay decrease, house limits', async () => {
    const baseSalt = `${salt}:converge`;
    const convDir = path.join(dir, 'converge');
    const convDeployments = path.join(convDir, 'deployments');
    const first = writeTestWallets(path.join(convDir, 'a'), undefined, baseSalt);
    const common = { network: 'local' as const, rpcUrl: ANVIL, deploymentsDir: convDeployments, artifactsDir: ARTIFACTS_DIR, fundHouseWei: 1_000n * E18, playerEthWei: E18, playerTokensWei: 10n * E18, signerEthWei: E18, log };
    const deployed = await deployContracts({ ...common, secretsPath: first });
    const vault = deployed.deployment.vault;
    const read = <F extends 'ledgerSigner' | 'signerChangeDelay' | 'houseBufferBps' | 'houseDailyCap' | 'pendingLedgerSigner'>(functionName: F) =>
      client.readContract({ address: vault, abi: mayaHouseVaultAbi, functionName });

    // The immutable escape delay cannot be converged on an existing vault.
    await expect(deployContracts({ ...common, secretsPath: first, escapeDelaySec: 259_200n })).rejects.toMatchObject({ code: 'DEPLOYMENT_MISMATCH', message: expect.stringContaining('immutable') });

    // Same operator, new ledger-signer key: the deployer proposes, reports the pending eta, and accepts once due.
    const rotated = testWalletsJson(undefined, baseSalt);
    const newSigner = testWalletsJson(undefined, `${baseSalt}:signer-2`).wallets.find(w => w.role === 'ledger-signer')!;
    const second = writeJson(path.join(convDir, 'b', 'testnet-wallets.json'), { ...rotated, wallets: rotated.wallets.map(w => (w.role === 'ledger-signer' ? newSigner : w)) });
    const options = { ...common, secretsPath: second, signerChangeDelaySec: 3_600n, houseLimits: { houseBufferBps: 0n, houseDailyCapWei: 10_000_000n * E18 } };
    const proposing = await deployContracts(options);
    expect(proposing.actions.some(a => a.startsWith(`proposed ledger signer ${testAddress('ledger-signer', baseSalt)} → ${newSigner.address}`))).toBe(true);
    expect(proposing.actions.some(a => a.startsWith('scheduled signer-change delay decrease 172800 s → 3600 s'))).toBe(true);
    expect(proposing.actions.some(a => a.startsWith('scheduled house limits → buffer 0 bps'))).toBe(true);
    expect(proposing.deployment.ledgerSigner).toBe(testAddress('ledger-signer', baseSalt)); // still the vault's signer
    expect(await read('pendingLedgerSigner')).toBe(newSigner.address);

    const waiting = await deployContracts(options);
    expect(waiting.actions.some(a => a.includes('is pending until chain time'))).toBe(true);
    expect(waiting.actions.some(a => a.includes('signer-change delay decrease to 3600 s is pending'))).toBe(true);
    expect(waiting.actions.some(a => a.includes('are pending until chain time'))).toBe(true);

    await advanceTime(172_800n);
    const accepting = await deployContracts(options);
    expect(accepting.actions.some(a => a.startsWith('accepted ledger signer'))).toBe(true);
    expect(accepting.actions.some(a => a.startsWith('signer-change delay 172800 s → 3600 s accepted'))).toBe(true);
    expect(accepting.actions.some(a => a.startsWith('house limits → buffer 0 bps') && a.includes('accepted'))).toBe(true);
    expect(accepting.deployment.ledgerSigner).toBe(newSigner.address);
    expect(await read('ledgerSigner')).toBe(newSigner.address);
    expect(await read('signerChangeDelay')).toBe(3_600n);
    expect(await read('houseBufferBps')).toBe(0n);
    expect(JSON.parse(readFileSync(path.join(convDeployments, '31337.json'), 'utf8'))).toMatchObject({ ledgerSigner: newSigner.address, txs: { proposeLedgerSigner: expect.any(String), acceptLedgerSigner: expect.any(String) } });

    // Tightening needs no wait; a re-run with the same targets is a no-op.
    const tightened = await deployContracts({ ...options, signerChangeDelaySec: 7_200n, houseLimits: { houseBufferBps: 500n, houseDailyCapWei: 5_000n * E18 } });
    expect(tightened.actions.some(a => a.startsWith('signer-change delay 3600 s → 7200 s'))).toBe(true);
    expect(tightened.actions.some(a => a.startsWith('house limits → buffer 500 bps, daily house cap 5000 tOPEN'))).toBe(true);
    expect(await read('houseDailyCap')).toBe(5_000n * E18);
    const idle = await deployContracts({ ...options, signerChangeDelaySec: 7_200n, houseLimits: { houseBufferBps: 500n, houseDailyCapWei: 5_000n * E18 } });
    expect(idle.actions.at(-1)).toContain('nothing to do');
    const restarted = createChain('local', { rpcUrl: ANVIL, secretsPath: second, deploymentsDir: convDeployments, dataDir: null, pollIntervalMs: 100, log });
    try {
      await restarted.start(); // the rotated deployment verifies against the new key
      expect((await restarted.vaultState()).ledgerSigner).toBe(newSigner.address);
    } finally {
      await restarted.stop();
    }
  });

  it('converges only the vault limits it is given; raising one waits the timelock (CS-L3, CS-L1)', async () => {
    const limSalt = `${salt}:limits`;
    const limDir = path.join(dir, 'limits');
    const common = {
      network: 'local' as const, rpcUrl: ANVIL, secretsPath: writeTestWallets(limDir, undefined, limSalt), deploymentsDir: path.join(limDir, 'deployments'), artifactsDir: ARTIFACTS_DIR,
      fundHouseWei: 1_000n * E18, playerEthWei: E18, playerTokensWei: 10n * E18, signerEthWei: E18, log,
    };
    const tuned = { maxVoucherAmountWei: 5_000n * E18, dailyOutflowCapWei: 50_000n * E18, accountDailyOutflowCapWei: 20_000n * E18, maxAttestationAgeSec: 300n };
    const first = await deployContracts({ ...common, limits: tuned });
    const vault = first.deployment.vault;
    const read = <F extends 'maxVoucherAmount' | 'dailyOutflowCap' | 'accountDailyOutflowCap' | 'maxAttestationAge' | 'pendingMaxVoucherAmount' | 'pendingLimitsEta'>(functionName: F) =>
      client.readContract({ address: vault, abi: mayaHouseVaultAbi, functionName });
    const limitsOf = async () => {
      const [maxVoucherAmountWei, dailyOutflowCapWei, accountDailyOutflowCapWei, maxAttestationAgeSec] = await Promise.all([read('maxVoucherAmount'), read('dailyOutflowCap'), read('accountDailyOutflowCap'), read('maxAttestationAge')]);
      return { maxVoucherAmountWei, dailyOutflowCapWei, accountDailyOutflowCapWei, maxAttestationAgeSec };
    };
    expect(await limitsOf()).toEqual(tuned); // all lower than the defaults: applied at once
    // CS-M1: a funded vault that was never attested is on the escape clock; the deployer says so.
    expect(first.actions.some(a => a.startsWith('no attestation yet: anyone can trigger the vault\'s escape mode from chain time'))).toBe(true);
    expect(first.actions.some(a => a.startsWith('limits (maxVoucher 100000 tOPEN') && a.includes('→ (maxVoucher 5000 tOPEN'))).toBe(true);

    // A routine re-run without limit flags leaves the tuned limits alone (it used to reset them to the defaults).
    const rerun = await deployContracts(common);
    expect(await limitsOf()).toEqual(tuned);
    expect(rerun.actions.some(a => a.includes('limits'))).toBe(false);
    expect(rerun.actions.at(-1)).toContain('nothing to do');

    // One flag converges one limit; raising it is scheduled with public notice, accepted on a re-run once due.
    const raise = { ...common, limits: { maxVoucherAmountWei: 10_000n * E18 } };
    const scheduled = await deployContracts(raise);
    expect(scheduled.actions.some(a => a.startsWith('scheduled limits') && a.includes('→ (maxVoucher 10000 tOPEN, daily cap 50000 tOPEN'))).toBe(true);
    expect(await limitsOf()).toEqual(tuned);
    expect(await read('pendingMaxVoucherAmount')).toBe(10_000n * E18);
    const waiting = await deployContracts(raise);
    expect(waiting.actions.some(a => a.includes('are pending until chain time'))).toBe(true);
    await advanceTime(172_800n);
    const accepted = await deployContracts(raise);
    expect(accepted.actions.some(a => a.startsWith('limits') && a.includes('accepted'))).toBe(true);
    expect(await limitsOf()).toEqual({ ...tuned, maxVoucherAmountWei: 10_000n * E18 });
    expect(await read('pendingLimitsEta')).toBe(0n);

    // A merged combination the vault would refuse fails before any transaction.
    await expect(deployContracts({ ...common, limits: { maxVoucherAmountWei: 30_000n * E18 } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('per-account daily cap') });
  });

  it('resumes from the persisted cursor after a restart without re-delivering', async () => {
    await chain.stop();
    const again: DepositEvent[] = [];
    chain = createChain('local', { rpcUrl: ANVIL, secretsPath, deploymentsDir, dataDir, pollIntervalMs: 100, log });
    chain.onDeposit(d => again.push(d));
    await chain.start();
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(again).toHaveLength(0);
    const tx = await chain.playerDeposit('player-2', 5n * E18);
    const [deposit] = await waitFor(() => (again.length >= 1 ? again : null), { what: 'second deposit' });
    expect(deposit).toMatchObject({ player: player2, amountWei: 5n * E18, depositId: 2n, txHash: tx.txHash });
    expect(existsSync(path.join(dataDir, 'chain-cursor-31337.json'))).toBe(true);
  });

  it('runs the deploy CLI end to end (attach mode) and prints the summary', async () => {
    const out: string[] = []; const err: string[] = [];
    const code = await runDeployCli(['--network', 'local', '--player-tokens', '10000', '--fund-house', '1000000'], { out: l => out.push(l), err: l => err.push(l) },
      options => deployContracts({ ...options, rpcUrl: ANVIL, secretsPath, deploymentsDir, artifactsDir: ARTIFACTS_DIR }));
    expect(err.join('\n')).not.toContain('deploy failed');
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Maya-Live contracts on local (chainId 31337): attached');
    expect(out.join('\n')).toContain(chain.addresses().vault);
  });

  it('refuses a deployment file that points at missing contracts, and redeploys it on local when asked', async () => {
    const staleDir = path.join(dir, 'stale-deployments');
    const staleSalt = `${salt}:stale`;
    const staleSecrets = writeTestWallets(path.join(dir, 'stale'), undefined, staleSalt);
    writeDeployment(staleDir, { chainId: 31337, token: '0x000000000000000000000000000000000000dEaD', vault: '0x000000000000000000000000000000000000bEEF', operator: testAddress('open-operator', staleSalt), ledgerSigner: testAddress('ledger-signer', staleSalt), blockNumber: 0n, txs: {} });
    const refusing = createChain('local', { rpcUrl: ANVIL, secretsPath: staleSecrets, deploymentsDir: staleDir, dataDir: null, log });
    await expect(refusing.start()).rejects.toMatchObject({ code: 'DEPLOYMENT_MISMATCH', message: expect.stringContaining('--redeploy') });
    const healing = createChain('local', { rpcUrl: ANVIL, secretsPath: staleSecrets, deploymentsDir: staleDir, dataDir: null, deployIfMissing: true, pollIntervalMs: 100, log });
    try {
      await healing.start();
      expect(healing.addresses().vault).not.toBe('0x000000000000000000000000000000000000bEEF');
      expect((await healing.vaultState()).houseFundedWei).toBe(100_000_000n * E18);
    } finally {
      await healing.stop();
    }
  });

  const realSecrets = path.join(REPO_ROOT, '.secrets', 'testnet-wallets.json');
  it.skipIf(!existsSync(realSecrets))('uses the .secrets testnet wallets by default: funds them from the anvil dev account and deploys on demand', async () => {
    const deployments = path.join(dir, 'real-wallet-deployments');
    const real = createChain('local', { rpcUrl: ANVIL, repoRoot: REPO_ROOT, deploymentsDir: deployments, dataDir: null, deployIfMissing: true, pollIntervalMs: 100, log });
    const seen: DepositEvent[] = [];
    real.onDeposit(d => seen.push(d));
    try {
      await real.start();
      const record = JSON.parse(readFileSync(path.join(deployments, '31337.json'), 'utf8')) as { operator: string; ledgerSigner: string };
      expect(real.addresses()).toMatchObject({ operator: record.operator, ledgerSigner: record.ledgerSigner });
      expect(real.players()).toHaveLength(11);
      const player = real.players()[0]!;
      expect((await real.balances(player.address)).ethWei > 0n).toBe(true);
      const tx = await real.playerDeposit(player.role, 3n * E18);
      await waitFor(() => seen.find(d => d.txHash === tx.txHash) ?? null, { what: 'real-wallet deposit' });
    } finally {
      await real.stop();
    }
  });

  const cli = path.join(REPO_ROOT, 'apps', 'house-server', 'dist', 'chain', 'deploy-cli.js');
  it.skipIf(!existsSync(cli))('the built CLI deploys into a MAYA_REPO_ROOT and refuses bad flags', async () => {
    const root = tempDir('maya-cli-root-');
    mkdirSync(path.join(root, '.secrets'), { recursive: true });
    writeTestWallets(path.join(root, '.secrets'), undefined, `${salt}:cli`);
    for (const name of ['MockOpenToken', 'MayaHouseVault']) {
      mkdirSync(path.join(root, 'contracts', 'out', `${name}.sol`), { recursive: true });
      copyFileSync(path.join(ARTIFACTS_DIR, `${name}.sol`, `${name}.json`), path.join(root, 'contracts', 'out', `${name}.sol`, `${name}.json`));
    }
    const run = promisify(execFile);
    const env = { ...process.env, MAYA_REPO_ROOT: root };
    const { stdout } = await run(process.execPath, [cli, '--network', 'local', '--rpc-url', ANVIL, '--player-eth', '0.5', '--player-tokens', '100', '--fund-house', '1000'], { env });
    expect(stdout).toContain('Maya-Live contracts on local (chainId 31337): deployed');
    const written = JSON.parse(readFileSync(path.join(root, 'contracts', 'deployments', '31337.json'), 'utf8')) as { vault: Hex };
    expect(stdout).toContain(written.vault);
    const failed = await run(process.execPath, [cli, '--network', 'nowhere'], { env }).catch((e: { code: number; stderr: string }) => e);
    expect(failed).toMatchObject({ code: 2, stderr: expect.stringContaining('--network must be local or base-sepolia') });
  });
});
