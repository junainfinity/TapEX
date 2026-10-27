import { BaseError, ContractFunctionRevertedError, encodeErrorResult, keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount, type LocalAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { mayaHouseVaultAbi } from '../../src/chain/abi.js';
import { vaultCallAbi } from '../../src/chain/context.js';
import { ChainError, revertInfo } from '../../src/chain/errors.js';
import { classifyCallError, TxSender, type TxBackend, type TxCall, type TxReceipt } from '../../src/chain/tx.js';
import { testKey } from './fixtures.js';

const account = privateKeyToAccount(testKey('open-operator'));
const other = privateKeyToAccount(testKey('player-1'));
const CALL: TxCall = { kind: 'transfer', label: 'test transfer', to: other.address, value: 1n };

/** Fake node: a mempool keyed by nonce per address, with scriptable failures. */
class FakeBackend implements TxBackend {
  chainNonce = new Map<Address, number>();
  /** How far the reported pending nonce lags behind the truth (a load-balanced RPC). */
  lag = 0;
  sent: { nonce: number; gas: bigint; hash: Hex; from: Address }[] = [];
  known = new Set<Hex>();
  sendFailures: ((hash: Hex, nonce: number) => Error | null)[] = [];
  receiptFailure: Error | null = null;
  receiptStatus: 'success' | 'reverted' = 'success';
  estimate = 21_000n;
  estimateError: Error | null = null;

  async estimateGas(): Promise<bigint> {
    if (this.estimateError) throw this.estimateError;
    return this.estimate;
  }
  async pendingNonce(address: Address): Promise<number> {
    await Promise.resolve();
    return Math.max(0, (this.chainNonce.get(address) ?? 0) - this.lag);
  }
  async sign(acct: LocalAccount, _call: TxCall, fields: { nonce: number; gas: bigint }): Promise<Hex> {
    return toHex(`${acct.address}:${fields.nonce}:${fields.gas}`);
  }
  async sendRaw(serialized: Hex): Promise<void> {
    const [from, nonceText, gasText] = Buffer.from(serialized.slice(2), 'hex').toString().split(':');
    const nonce = Number(nonceText); const hash = keccak256(serialized);
    const failure = this.sendFailures.shift()?.(hash, nonce);
    if (failure) throw failure;
    const expected = this.chainNonce.get(from as Address) ?? 0;
    if (nonce < expected) throw new Error('nonce too low: next nonce ' + expected);
    this.chainNonce.set(from as Address, nonce + 1);
    this.known.add(hash);
    this.sent.push({ nonce, gas: BigInt(gasText!), hash, from: from as Address });
  }
  async hasTransaction(hash: Hex): Promise<boolean> { return this.known.has(hash); }
  async waitForReceipt(hash: Hex): Promise<TxReceipt> {
    await new Promise(resolve => setTimeout(resolve, 1));
    if (this.receiptFailure) throw this.receiptFailure;
    return { hash, status: this.receiptStatus, blockNumber: 7n, blockHash: `0x${'00'.repeat(32)}`, contractAddress: null, gasUsed: 21_000n };
  }
}

function sender(backend: FakeBackend, logs: string[] = []) {
  return new TxSender(backend, { receiptTimeoutMs: 1_000, nonceRetryDelayMs: 0, log: l => logs.push(l), sleep: async () => undefined });
}

describe('TxSender nonce management', () => {
  it('assigns consecutive nonces even when the RPC pending count lags', async () => {
    const backend = new FakeBackend();
    const s = sender(backend);
    await s.send(account, CALL);
    backend.lag = 1; // node now reports a stale pending count
    await s.send(account, CALL);
    await s.send(account, CALL);
    expect(backend.sent.map(t => t.nonce)).toEqual([0, 1, 2]);
  });

  it('serialises concurrent submits from one account and pipelines receipts', async () => {
    const backend = new FakeBackend();
    backend.lag = 1_000;
    const s = sender(backend);
    const submitted = await Promise.all(Array.from({ length: 8 }, () => s.submit(account, CALL)));
    expect(submitted.map(t => t.nonce)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const receipts = await Promise.all(submitted.map(t => t.wait()));
    expect(receipts.every(r => r.status === 'success')).toBe(true);
    expect(new Set(backend.sent.map(t => t.hash)).size).toBe(8);
  });

  it('keeps accounts independent', async () => {
    const backend = new FakeBackend();
    const s = sender(backend);
    await Promise.all([s.send(account, CALL), s.send(other, CALL), s.send(account, CALL)]);
    expect(backend.sent.filter(t => t.from === account.address).map(t => t.nonce)).toEqual([0, 1]);
    expect(backend.sent.filter(t => t.from === other.address).map(t => t.nonce)).toEqual([0]);
  });

  it('moves past a nonce the chain already consumed (external send from the same key)', async () => {
    const backend = new FakeBackend();
    const logs: string[] = [];
    const s = sender(backend, logs);
    await s.send(account, CALL);
    backend.chainNonce.set(account.address, 3); // two txs sent elsewhere
    backend.lag = 2;
    await s.send(account, CALL);
    expect(backend.sent.map(t => t.nonce)).toEqual([0, 3]);
    expect(logs.filter(l => l.includes('already used'))).toHaveLength(2);
  });

  it('gives up with TX_SEND_FAILED after repeated nonce conflicts', async () => {
    const backend = new FakeBackend();
    backend.sendFailures = Array.from({ length: 10 }, () => () => new Error('nonce too low'));
    const s = sender(backend);
    await expect(s.send(account, CALL)).rejects.toMatchObject({ code: 'TX_SEND_FAILED' });
  });

  it('treats a failed broadcast whose hash the node knows as sent', async () => {
    const backend = new FakeBackend();
    backend.sendFailures = [hash => { backend.known.add(hash); backend.chainNonce.set(account.address, 1); return new Error('socket hang up'); }];
    const s = sender(backend);
    const receipt = await s.send(account, CALL);
    expect(receipt.status).toBe('success');
    await s.send(account, CALL);
    expect(backend.sent.map(t => t.nonce)).toEqual([1]);
  });

  it('treats "already known" as sent', async () => {
    const backend = new FakeBackend();
    backend.sendFailures = [() => new Error('already known')];
    const s = sender(backend);
    const submitted = await s.submit(account, CALL);
    expect(submitted.nonce).toBe(0);
    expect(backend.sent).toHaveLength(0);
  });

  it('drops the cached nonce after an unknown broadcast failure and resyncs from the chain', async () => {
    const backend = new FakeBackend();
    const s = sender(backend);
    await s.send(account, CALL);
    await s.send(account, CALL);
    backend.sendFailures = [() => new Error('insufficient funds for gas * price + value')];
    await expect(s.send(account, CALL)).rejects.toMatchObject({ code: 'TX_SEND_FAILED', message: expect.stringContaining('test transfer') });
    backend.chainNonce.set(account.address, 1); // the chain says 1 (e.g. a dropped tx); the sender must not insist on 2
    await s.send(account, CALL);
    expect(backend.sent.map(t => t.nonce)).toEqual([0, 1, 1]);
  });

  it('adds the gas buffer to the estimate', async () => {
    const backend = new FakeBackend();
    backend.estimate = 100_000n;
    await sender(backend).send(account, CALL);
    expect(backend.sent[0]!.gas).toBe(120_000n);
  });

  it('does not consume a nonce when the estimate reverts', async () => {
    const backend = new FakeBackend();
    backend.estimateError = new ChainError('CONTRACT_REVERT', 'would revert');
    const s = sender(backend);
    await expect(s.send(account, CALL)).rejects.toMatchObject({ code: 'CONTRACT_REVERT' });
    backend.estimateError = null;
    await s.send(account, CALL);
    expect(backend.sent.map(t => t.nonce)).toEqual([0]);
  });
});

describe('TxSender receipts', () => {
  it('reports a missing receipt as TX_TIMEOUT with the hash and an unknown outcome', async () => {
    const backend = new FakeBackend();
    backend.receiptFailure = new Error('timed out');
    const s = sender(backend);
    const error = await s.send(account, CALL).then(() => { throw new Error("expected TX_TIMEOUT"); }, (e: unknown) => e as ChainError);
    expect(error).toBeInstanceOf(ChainError);
    expect(error.code).toBe('TX_TIMEOUT');
    expect(error.txHash).toBe(backend.sent[0]!.hash);
    expect(error.message).toContain('outcome unknown');
  });

  it('reports a reverted receipt as TX_REVERTED', async () => {
    const backend = new FakeBackend();
    backend.receiptStatus = 'reverted';
    await expect(sender(backend).send(account, CALL)).rejects.toMatchObject({ code: 'TX_REVERTED', txHash: expect.stringMatching(/^0x/) });
  });

  it('memoises wait()', async () => {
    const backend = new FakeBackend();
    const submitted = await sender(backend).submit(account, CALL);
    expect(submitted.wait()).toBe(submitted.wait());
  });
});

describe('revert decoding', () => {
  it('decodes vault custom errors from a viem revert', () => {
    const data = encodeErrorResult({ abi: mayaHouseVaultAbi, errorName: 'ExceedsHouseSurplus', args: [5n, 3n] });
    const error = new ContractFunctionRevertedError({ abi: mayaHouseVaultAbi, data, functionName: 'withdrawHouse' });
    expect(revertInfo(error, mayaHouseVaultAbi)).toEqual({ name: 'ExceedsHouseSurplus', args: [5n, 3n] });
    const classified = classifyCallError(error, 'vault.withdrawHouse', vaultCallAbi);
    expect(classified).toMatchObject({ code: 'CONTRACT_REVERT', revert: { name: 'ExceedsHouseSurplus' } });
    expect(classified.message).toBe('vault.withdrawHouse would revert: ExceedsHouseSurplus(5, 3)');
  });

  it('decodes raw revert data carried by an RPC error, including token errors bubbled by the vault', () => {
    const data = encodeErrorResult({ abi: vaultCallAbi, errorName: 'ERC20InsufficientBalance', args: [other.address, 1n, 2n] });
    const inner = Object.assign(new BaseError('execution reverted'), { data });
    const outer = new BaseError('estimate failed', { cause: inner });
    expect(revertInfo(outer, vaultCallAbi)).toEqual({ name: 'ERC20InsufficientBalance', args: [other.address, 1n, 2n] });
  });

  it('classifies transport failures and gas shortfalls', () => {
    expect(classifyCallError(new BaseError('fetch failed'), 'x', vaultCallAbi).code).toBe('RPC_UNAVAILABLE');
    expect(classifyCallError(new BaseError('insufficient funds for gas * price + value'), 'x', undefined).code).toBe('INSUFFICIENT_GAS_FUNDS');
    const passthrough = new ChainError('TX_TIMEOUT', 'x');
    expect(classifyCallError(passthrough, 'x', undefined)).toBe(passthrough);
  });
});
