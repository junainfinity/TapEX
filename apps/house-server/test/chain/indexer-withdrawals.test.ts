import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DepositIndexer, fileCursorStore, memoryCursorStore, withdrawalKey, type DepositEvent, type IndexerOptions, type WithdrawalEvent } from '../../src/chain/indexer.js';
import { depositOnly, FakeChain } from './fake-chain.js';
import { cleanupTemps, tempDir } from './fixtures.js';

const ALICE = '0x00000000000000000000000000000000000A11CE';
const BOB = '0x0000000000000000000000000000000000000B0B';
const VAULT = '0x1111111111111111111111111111111111111111';

afterEach(() => cleanupTemps());

function setup(overrides: Partial<IndexerOptions> = {}, chain = new FakeChain()) {
  const logs: string[] = [];
  const indexer = new DepositIndexer(chain, {
    chainId: 31337, vault: VAULT, startBlock: 0n, confirmations: 0, reorgDepth: 3, batchSize: 100, pollIntervalMs: 5,
    store: memoryCursorStore(), log: line => logs.push(line), ...overrides,
  });
  const seen: DepositEvent[] = [];
  const withdrawals: WithdrawalEvent[] = [];
  indexer.onDeposit(d => seen.push(d));
  indexer.onWithdrawal(w => withdrawals.push(w));
  return { chain, indexer, seen, withdrawals, logs };
}

describe('DepositIndexer: withdrawals (SPEC-11)', () => {
  it('delivers each Withdrawn event once, in chain order, keyed by player:nonce, from the same log query', async () => {
    const { chain, indexer, seen, withdrawals } = setup();
    const b = chain.mineWith({ deposits: [{ player: ALICE, amountWei: 9n }], withdrawals: [{ player: BOB, amountWei: 4n, nonce: 7n }, { player: ALICE, amountWei: 1n, nonce: 2n ** 200n }] });
    const queries = chain.calls.deposits;
    await indexer.pollOnce();
    expect(chain.calls.deposits - queries).toBe(1);
    expect(seen).toHaveLength(1);
    expect(withdrawals).toEqual([
      { player: BOB, amountWei: 4n, nonce: 7n, txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/), logIndex: 1, blockNumber: b },
      { player: ALICE, amountWei: 1n, nonce: 2n ** 200n, txHash: expect.any(String), logIndex: 2, blockNumber: b },
    ]);
    expect(Object.isFrozen(withdrawals[0])).toBe(true);
    expect(withdrawalKey(withdrawals[0]!)).toBe(`w:${BOB.toLowerCase()}:7`);
    await indexer.pollOnce(); await indexer.pollOnce();
    chain.mineWith({ withdrawals: [{ player: BOB, amountWei: 5n, nonce: 8n }] });
    await indexer.pollOnce();
    expect(withdrawals.map(w => w.nonce)).toEqual([7n, 2n ** 200n, 8n]);
    expect(indexer.status()).toMatchObject({ withdrawalsIndexed: true, withdrawalsDelivered: 3, pendingWithdrawals: 0, delivered: 1 });
  });

  it('holds withdrawals until they have the configured confirmations', async () => {
    const { chain, indexer, withdrawals } = setup({ confirmations: 2 });
    chain.mineWith({ withdrawals: [{ player: ALICE, amountWei: 1n, nonce: 1n }] });
    await indexer.pollOnce();
    chain.mine();
    await indexer.pollOnce();
    expect(withdrawals).toHaveLength(0);
    chain.mine();
    await indexer.pollOnce();
    expect(withdrawals).toHaveLength(1);
  });

  it('queues withdrawals until the first withdrawal listener, independently of deposit delivery', async () => {
    const chain = new FakeChain();
    const indexer = new DepositIndexer(chain, { chainId: 1, vault: VAULT, startBlock: 0n, confirmations: 0, reorgDepth: 2, batchSize: 10, pollIntervalMs: 5, store: memoryCursorStore() });
    const seen: DepositEvent[] = [];
    indexer.onDeposit(d => seen.push(d));
    chain.mineWith({ deposits: [{ player: ALICE, amountWei: 3n }], withdrawals: [{ player: ALICE, amountWei: 1n, nonce: 1n }] });
    await indexer.pollOnce();
    expect(seen).toHaveLength(1);
    expect(indexer.pendingWithdrawalCount()).toBe(1);
    expect(indexer.withdrawalListenerCount()).toBe(0);
    const late: WithdrawalEvent[] = [];
    const off = indexer.onWithdrawal(w => late.push(w));
    expect(late).toHaveLength(0); // flushed on a microtask, not re-entrantly
    await Promise.resolve();
    expect(late.map(w => w.nonce)).toEqual([1n]);
    expect(indexer.pendingWithdrawalCount()).toBe(0);
    off();
    expect(indexer.withdrawalListenerCount()).toBe(0);
  });

  it('never re-delivers a withdrawal re-mined in another block or transaction, and flags one that vanished', async () => {
    const { chain, indexer, withdrawals, logs } = setup({ reorgDepth: 4 });
    chain.mineWith({ withdrawals: [{ player: ALICE, amountWei: 5n, nonce: 1n }] });
    const doomed = chain.mineWith({ withdrawals: [{ player: BOB, amountWei: 6n, nonce: 1n }] });
    await indexer.pollOnce();
    expect(withdrawals).toHaveLength(2);
    chain.reorg(2);
    chain.mine();
    // The first voucher lands again, in a later block and a different transaction (same account and nonce).
    chain.mineWith({ withdrawals: [{ player: ALICE, amountWei: 5n, nonce: 1n }] });
    const result = await indexer.pollOnce();
    expect(result).toMatchObject({ reorg: true, foundWithdrawals: 0, orphaned: 1 });
    expect(withdrawals).toHaveLength(2);
    expect(indexer.status().orphaned).toEqual([`w:${BOB.toLowerCase()}:1`]);
    expect(withdrawals[1]!.blockNumber).toBe(doomed);
    expect(logs.some(l => l.includes('ALERT withdrawal'))).toBe(true);
  });

  it('drops an undelivered withdrawal that leaves the chain', async () => {
    const chain = new FakeChain();
    const logs: string[] = [];
    const indexer = new DepositIndexer(chain, { chainId: 1, vault: VAULT, startBlock: 0n, confirmations: 0, reorgDepth: 3, batchSize: 10, pollIntervalMs: 5, store: memoryCursorStore(), log: l => logs.push(l) });
    chain.mineWith({ withdrawals: [{ player: ALICE, amountWei: 1n, nonce: 3n }] });
    await indexer.pollOnce();
    chain.reorg(1); chain.mine();
    await indexer.pollOnce();
    expect(indexer.pendingWithdrawalCount()).toBe(0);
    expect(indexer.status().orphaned).toEqual([]);
    expect(logs.some(l => l.includes('undelivered withdrawal'))).toBe(true);
  });

  it('persists undelivered withdrawals and delivers them after a restart', async () => {
    const store = memoryCursorStore();
    const chain = new FakeChain();
    const options = { chainId: 1, vault: VAULT, startBlock: 0n, confirmations: 0, reorgDepth: 2, batchSize: 10, pollIntervalMs: 5, store };
    const lonely = new DepositIndexer(chain, options);
    chain.mineWith({ withdrawals: [{ player: BOB, amountWei: 8n, nonce: 11n }] });
    await lonely.pollOnce();
    expect(store.current?.pendingWithdrawals).toHaveLength(1);
    expect(store.current?.pendingWithdrawals[0]).toMatchObject({ key: `w:${BOB.toLowerCase()}:11`, amountWei: '8', nonce: '11' });
    const restarted = new DepositIndexer(chain, options);
    const seen: WithdrawalEvent[] = [];
    restarted.onWithdrawal(w => seen.push(w));
    await restarted.pollOnce();
    expect(seen).toEqual([expect.objectContaining({ player: BOB, amountWei: 8n, nonce: 11n })]);
    expect(store.current?.pendingWithdrawals).toHaveLength(0);
    chain.mine();
    await restarted.pollOnce();
    expect(seen).toHaveLength(1);
  });

  it('rescans when the cursor predates withdrawal indexing (a version 1 file, or a deposit-only source)', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'cursor.json');
    const chain = new FakeChain();
    chain.mineWith({ deposits: [{ player: ALICE, amountWei: 1n }], withdrawals: [{ player: ALICE, amountWei: 1n, nonce: 1n }] });
    writeFileSync(file, JSON.stringify({ version: 1, chainId: 31337, vault: VAULT.toLowerCase(), startBlock: '0', deploymentBlockHash: null, scannedTo: chain.headNumber.toString(), watermark: null, delivered: [], pending: [] }));
    const logs: string[] = [];
    const fromFile = setup({ store: fileCursorStore(file, l => logs.push(l)) }, chain);
    await fromFile.indexer.pollOnce();
    expect(logs.some(l => l.includes('unsupported cursor version 1'))).toBe(true);
    expect(fromFile.withdrawals).toHaveLength(1);
    expect(fromFile.seen).toHaveLength(1); // re-delivered: the ledger credits idempotently

    const store = memoryCursorStore();
    const legacy = new DepositIndexer(depositOnly(chain), { chainId: 31337, vault: VAULT, startBlock: 0n, confirmations: 0, reorgDepth: 3, batchSize: 100, pollIntervalMs: 5, store });
    const legacySeen: DepositEvent[] = [];
    legacy.onDeposit(d => legacySeen.push(d));
    await legacy.pollOnce();
    expect(legacySeen).toHaveLength(1);
    expect(legacy.status()).toMatchObject({ withdrawalsIndexed: false, pendingWithdrawals: 0 });
    expect(store.current).toMatchObject({ withdrawalsIndexed: false });
    const upgraded = setup({ store }, chain);
    await upgraded.indexer.pollOnce();
    expect(upgraded.logs.some(l => l.includes('withdrawal indexing changed'))).toBe(true);
    expect(upgraded.withdrawals).toHaveLength(1);
  });

  it('isolates a throwing withdrawal listener', async () => {
    const { chain, indexer, withdrawals, logs } = setup();
    indexer.onWithdrawal(() => { throw new Error('ledger down'); });
    chain.mineWith({ withdrawals: [{ player: ALICE, amountWei: 1n, nonce: 5n }] });
    await indexer.pollOnce();
    expect(withdrawals).toHaveLength(1);
    expect(logs.some(l => l.includes('withdrawal listener threw') && l.includes('ledger down'))).toBe(true);
  });
});
