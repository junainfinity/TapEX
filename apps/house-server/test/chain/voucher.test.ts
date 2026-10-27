import path from 'node:path';
import { encodeAbiParameters, keccak256, concat, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { createChain } from '../../src/chain/index.js';
import { writeDeployment } from '../../src/chain/deployment.js';
import { recoverVoucherSigner, signWithdrawalVoucher, withdrawalDigest } from '../../src/chain/voucher.js';
import { cleanupTemps, tempDir, testAddress, testKey, writeTestWallets } from './fixtures.js';

afterEach(() => cleanupTemps());

const VAULT = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as const;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const signer = privateKeyToAccount(testKey('ledger-signer'));
const terms = { account: testAddress('player-1'), amountWei: 50n * 10n ** 18n, nonce: 7n, expiry: 1_800_003_600n };

/** Independent EIP-712 construction mirroring MayaHouseVault (OZ EIP712 + WITHDRAWAL_TYPEHASH). */
function manualDigest(chainId: number, vault: Hex, t: typeof terms): Hex {
  const domainTypeHash = keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
  const domainSeparator = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [domainTypeHash, keccak256(toHex('MayaHouseVault')), keccak256(toHex('1')), BigInt(chainId), vault],
  ));
  const typeHash = keccak256(toHex('Withdrawal(address account,uint256 amount,uint256 nonce,uint256 expiry)'));
  const structHash = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [typeHash, t.account, t.amountWei, t.nonce, t.expiry],
  ));
  return keccak256(concat(['0x1901', domainSeparator, structHash]));
}

describe('EIP-712 withdrawal vouchers', () => {
  it('hash exactly as the vault does', () => {
    for (const chainId of [31337, 84532]) expect(withdrawalDigest({ chainId, vault: VAULT }, terms)).toBe(manualDigest(chainId, VAULT, terms));
  });

  it('are 65-byte low-s signatures by the ledger signer', async () => {
    const signature = await signWithdrawalVoucher(signer, { chainId: 84532, vault: VAULT }, terms);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    expect(s <= SECP256K1_N / 2n).toBe(true);
    expect([27, 28]).toContain(Number.parseInt(signature.slice(130), 16));
    expect(await recoverVoucherSigner({ chainId: 84532, vault: VAULT }, terms, signature)).toBe(signer.address);
  });

  it('bind the chain, the vault and every term', async () => {
    const signature = await signWithdrawalVoucher(signer, { chainId: 84532, vault: VAULT }, terms);
    const other = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
    expect(await recoverVoucherSigner({ chainId: 31337, vault: VAULT }, terms, signature)).not.toBe(signer.address);
    expect(await recoverVoucherSigner({ chainId: 84532, vault: other }, terms, signature)).not.toBe(signer.address);
    for (const change of [{ amountWei: terms.amountWei + 1n }, { nonce: 8n }, { expiry: terms.expiry + 1n }, { account: testAddress('player-2') }]) {
      expect(await recoverVoucherSigner({ chainId: 84532, vault: VAULT }, { ...terms, ...change }, signature)).not.toBe(signer.address);
    }
  });

  it.each([
    ['a zero amount', { amountWei: 0n }],
    ['an amount above uint256', { amountWei: 1n << 256n }],
    ['a negative nonce', { nonce: -1n }],
    ['a zero expiry', { expiry: 0n }],
    ['a malformed account', { account: '0x1234' }],
  ])('refuse %s', async (_label, change) => {
    await expect(signWithdrawalVoucher(signer, { chainId: 84532, vault: VAULT }, { ...terms, ...change })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('LiveChain.signWithdrawal', () => {
  it('signs for the deployed vault with the ledger-signer wallet, without touching the RPC', async () => {
    const dir = tempDir();
    const secretsPath = writeTestWallets(dir);
    const deploymentsDir = path.join(dir, 'deployments');
    writeDeployment(deploymentsDir, { chainId: 84532, token: '0x5FbDB2315678afecb367f032d93F642f64180aa3', vault: VAULT, operator: testAddress('open-operator'), ledgerSigner: testAddress('ledger-signer'), blockNumber: 1n, txs: {} });
    const chain = createChain('base-sepolia', { secretsPath, deploymentsDir, rpcUrl: 'http://127.0.0.1:9', dataDir: null });
    expect(chain.chainId).toBe(84532);
    expect(chain.addresses()).toEqual({ token: '0x5FbDB2315678afecb367f032d93F642f64180aa3', vault: VAULT, operator: testAddress('open-operator'), ledgerSigner: testAddress('ledger-signer') });
    expect(chain.players().map(p => p.role)).toHaveLength(11);
    expect(chain.explorerUrl('address', VAULT)).toBe(`https://sepolia.basescan.org/address/${VAULT}`);
    expect(chain.indexerLagBlocks()).toBe(0);
    const signature = await chain.signWithdrawal(terms);
    expect(await recoverVoucherSigner({ chainId: 84532, vault: VAULT }, terms, signature as Hex)).toBe(signer.address);
    // Everything that needs the chain refuses until start().
    await expect(chain.vaultState()).rejects.toMatchObject({ code: 'NOT_STARTED' });
    await expect(chain.attest({ liabilitiesWei: 0n, ledgerRoot: `0x${'00'.repeat(32)}`, asOf: 1n, seq: 1n })).rejects.toMatchObject({ code: 'NOT_STARTED' });
    await expect(chain.playerDeposit('player-1', 1n)).rejects.toMatchObject({ code: 'NOT_STARTED' });
  });

  it('reports a missing deployment with the deploy command', () => {
    const dir = tempDir();
    const chain = createChain('local', { secretsPath: writeTestWallets(dir), deploymentsDir: path.join(dir, 'none'), dataDir: null });
    expect(() => chain.addresses()).toThrow(/deploy-cli\.js --network local/);
  });

  it('fails start() with RPC_UNAVAILABLE when the node is unreachable', async () => {
    const dir = tempDir();
    const chain = createChain('local', { secretsPath: writeTestWallets(dir), deploymentsDir: path.join(dir, 'none'), rpcUrl: 'http://127.0.0.1:9', dataDir: null });
    await expect(chain.start()).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });
  });
});
