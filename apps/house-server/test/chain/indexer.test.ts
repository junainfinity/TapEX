import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DepositIndexer, depositId, depositKey, fileCursorStore, memoryCursorStore, type CursorStore, type DepositEvent, type IndexerOptions } from '../../src/chain/indexer.js';
import { FakeChain } from './fake-chain.js';
import { cleanupTemps, tempDir, waitFor } from './fixtures.js';

const ALICE = '0x00000000000000000000000000000000000A11CE';
const BOB = '0x0000000000000000000000000000000000000B0B';
const VAULT = '0x1111111111111111111111111111111111111111';

afterEach(() => cleanupTemps());

function setup(overrides: Partial<IndexerOptions> = {}, chain = new FakeChain()) {
  const logs: string[] = [];
  const store = overrides.store ?? memoryCursorStore();
  const indexer = new DepositIndexer(chain, {
    chainId: 31337, vault: VAULT, startBlock: 0n, confirmations: 0, reorgDepth: 3, batchSize: 100, pollIntervalMs: 5,
    store, log: line => logs.push(line), ...overrides,
  });
  const seen: DepositEvent[] = [];
  const unsubscribe = indexer.onDeposit(d => seen.push(d));
  return { chain, indexer, seen, logs, store, unsubscribe };
}

describe('DepositIndexer: delivery', () => {
  it('delivers each deposit once, in chain order, with exact fields', async () => {
    const { chain, indexer, seen } = setup();
    const b1 = chain.mine([{ player: ALICE, amountWei: 10n ** 18n + 7n }, { player: BOB, amountWei: 5n }]);
    await indexer.pollOnce();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ player: ALICE, amountWei: 10n ** 18n + 7n, depositId: 1n, logIndex: 0, blockNumber: b1 });
    expect(seen[1]).toMatchObject({ player: BOB, amountWei: 5n, depositId: 2n, logIndex: 1, blockNumber: b1 });
    expect(Object.isFrozen(seen[0])).toBe(true);
    // Re-polling (including the re-read overlap) never re-delivers.
    await indexer.pollOnce(); await indexer.pollOnce();
    chain.mine([{ player: ALICE, amountWei: 3n }]);
    await indexer.pollOnce(); await indexer.pollOnce();
    expect(seen.map(d => d.depositId)).toEqual([1n, 2n, 3n]);
    expect(indexer.status().delivered).toBe(3);
  });

  it('never leaves found deposits undelivered across an await, and advances the watermark only after delivery', async () => {
    const { chain, indexer, seen } = setup({ batchSize: 2 });
    chain.mineEmpty(3);
    chain.mine([{ player: ALICE, amountWei: 1n }]);
    chain.mineEmpty(2);
    chain.mine([{ player: BOB, amountWei: 2n }]);
    const observed: { pending: number; delivered: number; watermark: bigint | null }[] = [];
    chain.onCall = () => observed.push({ pending: indexer.pendingCount(), delivered: seen.length, watermark: indexer.watermark()?.number ?? null });
    await indexer.pollOnce();
    expect(seen).toHaveLength(2);
    expect(observed.length).toBeGreaterThan(4);
    expect(observed.every(o => o.pending === 0)).toBe(true);
    // Until the final chunk is read the watermark stays unset: nothing claims coverage it does not have.
    expect(observed.filter(o => o.delivered < 2).every(o => o.watermark === null)).toBe(true);
    expect(indexer.watermark()?.number).toBe(chain.headNumber);
  });

  it('holds deposits until they have the configured confirmations', async () => {
    const { chain, indexer, seen } = setup({ confirmations: 2 });
    const b = chain.mine([{ player: ALICE, amountWei: 1n }]);
    await indexer.pollOnce();
    expect(seen).toHaveLength(0);
    chain.mine();
    await indexer.pollOnce();
    expect(seen).toHaveLength(0);
    chain.mine();
    await indexer.pollOnce();
    expect(seen.map(d => d.blockNumber)).toEqual([b]);
    expect(indexer.watermark()?.number).toBe(chain.headNumber - 2n);
    expect(indexer.lagBlocks()).toBe(2);
  });

  it('scans long ranges in batches and never reads before the start block', async () => {
    const chain = new FakeChain(1);
    chain.mineEmpty(20);
    chain.mine([{ player: ALICE, amountWei: 1n }]);
    chain.mineEmpty(30);
    const { indexer, seen } = setup({ startBlock: 5n, batchSize: 10 }, chain);
    await indexer.pollOnce();
    expect(seen).toHaveLength(1);
    expect(chain.ranges[0]).toEqual([5n, 14n]);
    expect(chain.ranges.every(([from, to]) => to - from + 1n <= 10n && from >= 5n)).toBe(true);
    expect(chain.ranges.at(-1)![1]).toBe(chain.headNumber);
  });

  it('halves the getLogs range when the RPC rejects a span, then keeps going', async () => {
    const chain = new FakeChain(1);
    chain.mineEmpty(40);
    chain.mine([{ player: BOB, amountWei: 9n }]);
    chain.maxRange = 12n;
    const { indexer, seen, logs } = setup({ batchSize: 50 }, chain);
    await indexer.pollOnce();
    expect(seen.map(d => d.amountWei)).toEqual([9n]);
    expect(chain.ranges.every(([from, to]) => to - from + 1n <= 12n)).toBe(true);
    expect(logs.some(l => l.includes('retrying with 25-block ranges'))).toBe(true);
  });

  it('skips the log scan when head and watermark hash are unchanged', async () => {
    const { chain, indexer } = setup();
    chain.mine([{ player: ALICE, amountWei: 1n }]);
    await indexer.pollOnce();
    const before = chain.calls.deposits;
    await indexer.pollOnce(); await indexer.pollOnce();
    expect(chain.calls.deposits).toBe(before);
  });

  it('keys two deposits in one transaction by ordinal', async () => {
    const { chain, indexer, seen } = setup();
    const tx = chain.txHash();
    chain.mine([{ player: ALICE, amountWei: 1n, txHash: tx }, { player: ALICE, amountWei: 2n, txHash: tx }]);
    await indexer.pollOnce();
    expect(seen).toHaveLength(2);
    expect(depositKey(tx, 1)).toBe(`${tx.toLowerCase()}#1`);
    expect(depositId(seen[1]!)).toBe(`${tx.toLowerCase()}:1`);
  });
});

describe('DepositIndexer: listeners', () => {
  it('queues deposits found while nobody listens and delivers them on the first subscription', async () => {
    const chain = new FakeChain();
    const indexer = new DepositIndexer(chain, { chainId: 1, vault: VAULT, startBlock: 0n, confirmations: 0, reorgDepth: 2, batchSize: 10, pollIntervalMs: 5, store: memoryCursorStore() });
    chain.mine([{ player: ALICE, amountWei: 4n }]);
    await indexer.pollOnce();
    expect(indexer.pendingCount()).toBe(1);
    const seen: DepositEvent[] = [];
    indexer.onDeposit(d => seen.push(d));
    expect(seen).toHaveLength(0); // delivered on a microtask, not re-entrantly inside onDeposit
    await Promise.resolve();
    expect(seen.map(d => d.amountWei)).toEqual([4n]);
    expect(indexer.pendingCount()).toBe(0);
  });

  it('isolates a throwing listener and honours unsubscribe', async () => {
    const { chain, indexer, seen, logs, unsubscribe } = setup();
    indexer.onDeposit(() => { throw new Error('ledger down'); });
    chain.mine([{ player: ALICE, amountWei: 1n }]);
    await indexer.pollOnce();
    expect(seen).toHaveLength(1);
    expect(logs.some(l => l.includes('listener threw') && l.includes('ledger down'))).toBe(true);
    unsubscribe();
    chain.mine([{ player: ALICE, amountWei: 2n }]);
    await indexer.pollOnce();
    expect(seen).toHaveLength(1);
  });
});

describe('DepositIndexer: reorgs', () => {
  it('delivers a deposit that appears in a replacement block and flags the one that vanished', async () => {
    const { chain, indexer, seen } = setup({ reorgDepth: 4 });
    chain.mine([{ player: ALICE, amountWei: 1n }]);
    const doomed = chain.mine([{ player: BOB, amountWei: 2n }]);
    await indexer.pollOnce();
    expect(seen).toHaveLength(2);
    chain.reorg(1);
    chain.mine([{ player: ALICE, amountWei: 3n }]);
    const result = await indexer.pollOnce();
    expect(result.reorg).toBe(true);
    expect(seen.map(d => d.amountWei)).toEqual([1n, 2n, 3n]);
    expect(result.orphaned).toBe(1);
    const orphaned = indexer.status().orphaned;
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]).toBe(depositId(seen[1]!));
    expect(seen[1]!.blockNumber).toBe(doomed);
  });

  it('does not re-deliver a transaction re-included in a later block with a new logIndex', async () => {
    const { chain, indexer, seen } = setup({ reorgDepth: 4 });
    const tx = chain.txHash();
    chain.mine([{ player: ALICE, amountWei: 7n, txHash: tx }]);
    await indexer.pollOnce();
    chain.reorg(1);
    chain.mine();
    chain.mine([{ player: ALICE, amountWei: 7n, txHash: tx }], 3);
    await indexer.pollOnce();
    expect(seen).toHaveLength(1);
    expect(indexer.status().orphaned).toEqual([]);
  });

  it('re-reads the retained window when the watermark block was replaced deeper than the overlap', async () => {
    const { chain, indexer, seen, logs } = setup({ reorgDepth: 1, retainBlocks: 16 });
    chain.mineEmpty(5);
    await indexer.pollOnce();
    chain.reorg(4);
    chain.mine([{ player: BOB, amountWei: 11n }]);
    chain.mineEmpty(3);
    const result = await indexer.pollOnce();
    expect(result.reorg).toBe(true);
    expect(seen.map(d => d.amountWei)).toEqual([11n]);
    expect(logs.some(l => l.includes('was reorganised'))).toBe(true);
    expect(indexer.status().reorgs).toBe(1);
  });

  it('orphans deposits from blocks above a shorter new head', async () => {
    const { chain, indexer, seen } = setup({ reorgDepth: 2 });
    chain.mineEmpty(3);
    chain.mine([{ player: ALICE, amountWei: 5n }]);
    await indexer.pollOnce();
    chain.reorg(2);
    const result = await indexer.pollOnce();
    expect(result.reorg).toBe(true);
    expect(seen).toHaveLength(1);
    expect(indexer.status().orphaned).toEqual([depositId(seen[0]!)]);
    expect(indexer.status().scannedTo).toBe(chain.headNumber);
  });

  it('drops a queued, undelivered deposit that leaves the chain instead of delivering it', async () => {
    const chain = new FakeChain();
    const logs: string[] = [];
    const indexer = new DepositIndexer(chain, { chainId: 1, vault: VAULT, startBlock: 0n, confirmations: 0, reorgDepth: 3, batchSize: 10, pollIntervalMs: 5, store: memoryCursorStore(), log: l => logs.push(l) });
    chain.mine([{ player: ALICE, amountWei: 1n }]);
    await indexer.pollOnce();
    chain.reorg(1); chain.mine();
    await indexer.pollOnce();
    expect(indexer.pendingCount()).toBe(0);
    const seen: DepositEvent[] = [];
    indexer.onDeposit(d => seen.push(d));
    await Promise.resolve();
    expect(seen).toHaveLength(0);
    expect(indexer.status().orphaned).toEqual([]);
    expect(logs.some(l => l.includes('undelivered deposit'))).toBe(true);
  });

  it('resets when the head falls far below the scanned range (a reset dev chain)', async () => {
    const { chain, indexer, seen, logs } = setup({ reorgDepth: 1, retainBlocks: 4 });
    chain.mineEmpty(20);
    chain.mine([{ player: ALICE, amountWei: 1n }]);
    await indexer.pollOnce();
    chain.reorg(20);
    chain.mine([{ player: BOB, amountWei: 2n }]);
    await indexer.pollOnce();
    expect(logs.some(l => l.includes('resetting deposit indexer'))).toBe(true);
    expect(seen.map(d => d.amountWei)).toEqual([1n, 2n]);
  });
});

describe('DepositIndexer: persistence', () => {
  it('resumes from a persisted cursor without re-delivering, across processes', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'cursor.json');
    const chain = new FakeChain();
    const first = setup({ store: fileCursorStore(file) }, chain);
    chain.mine([{ player: ALICE, amountWei: 1n }]);
    chain.mine([{ player: BOB, amountWei: 2n }]);
    await first.indexer.pollOnce();
    expect(first.seen).toHaveLength(2);
    const cursor = JSON.parse(readFileSync(file, 'utf8'));
    expect(cursor).toMatchObject({ version: 2, chainId: 31337, vault: VAULT.toLowerCase(), startBlock: '0', scannedTo: chain.headNumber.toString(), withdrawalsIndexed: true, pendingWithdrawals: [] });
    expect(cursor.delivered).toHaveLength(2);
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);

    const second = setup({ store: fileCursorStore(file) }, chain);
    chain.mine([{ player: ALICE, amountWei: 3n }]);
    await second.indexer.pollOnce();
    expect(second.seen.map(d => d.amountWei)).toEqual([3n]);
  });

  it('persists undelivered deposits and delivers them after a restart', async () => {
    const store = memoryCursorStore();
    const chain = new FakeChain();
    const lonely = new DepositIndexer(chain, { chainId: 1, vault: VAULT, startBlock: 0n, confirmations: 0, reorgDepth: 2, batchSize: 10, pollIntervalMs: 5, store });
    chain.mine([{ player: ALICE, amountWei: 8n }]);
    await lonely.pollOnce();
    expect(store.current?.pending).toHaveLength(1);
    const restarted = new DepositIndexer(chain, { chainId: 1, vault: VAULT, startBlock: 0n, confirmations: 0, reorgDepth: 2, batchSize: 10, pollIntervalMs: 5, store });
    const seen: DepositEvent[] = [];
    restarted.onDeposit(d => seen.push(d));
    await restarted.pollOnce();
    expect(seen.map(d => d.amountWei)).toEqual([8n]);
    expect(store.current?.pending).toHaveLength(0);
  });

  it.each([
    ['chainId', { chainId: 84532 }],
    ['vault', { vault: '0x2222222222222222222222222222222222222222' }],
    ['start block', { startBlock: 1n }],
    ['deployment block hash', { deploymentBlockHash: `0x${'ab'.repeat(32)}` }],
  ])('discards a cursor whose %s differs and rescans', async (_label, change) => {
    const store = memoryCursorStore();
    const chain = new FakeChain();
    chain.mine([{ player: ALICE, amountWei: 1n }]);
    const first = setup({ store }, chain);
    await first.indexer.pollOnce();
    const second = setup({ store, ...change }, chain);
    await second.indexer.pollOnce();
    expect(second.seen).toHaveLength(1);
    expect(second.logs.some(l => l.includes('discarding indexer cursor'))).toBe(true);
  });

  it('ignores an unreadable cursor file', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'cursor.json');
    writeFileSync(file, '{ not json');
    const chain = new FakeChain();
    chain.mine([{ player: ALICE, amountWei: 1n }]);
    const logs: string[] = [];
    const { indexer, seen } = setup({ store: fileCursorStore(file, l => logs.push(l)) }, chain);
    await indexer.pollOnce();
    expect(seen).toHaveLength(1);
    expect(logs.some(l => l.includes('ignoring unreadable indexer cursor'))).toBe(true);
  });
});

describe('DepositIndexer: lifecycle and failures', () => {
  it('start() fails loudly when the first scan fails', async () => {
    const chain = new FakeChain();
    chain.failures.push(new Error('connection refused'));
    const { indexer } = setup({}, chain);
    await expect(indexer.start()).rejects.toThrow('connection refused');
    expect(indexer.status().running).toBe(false);
  });

  it('keeps polling in the background, backing off on errors and recovering', async () => {
    const { chain, indexer, seen, logs } = setup({ pollIntervalMs: 5, maxBackoffMs: 20 });
    await indexer.start();
    chain.failures.push(new Error('502 bad gateway'), new Error('502 bad gateway'));
    const failed = await waitFor(() => { const f = logs.filter(l => l.includes('poll failed')); return f.length >= 2 ? f : null; }, { what: 'two failed polls' });
    // Capped exponential backoff: 5 ms after the first failure, 10 ms after the second.
    expect(failed[0]).toContain('502 bad gateway');
    expect(failed[0]).toContain('retrying in 5 ms');
    expect(failed[1]).toContain('retrying in 10 ms');
    chain.mine([{ player: ALICE, amountWei: 6n }]);
    await waitFor(() => seen.length === 1 || null, { what: 'recovery delivery' });
    await waitFor(() => indexer.status().consecutiveFailures === 0 || null, { what: 'failure counter reset' });
    expect(indexer.status().lastError).toBeNull();
    await indexer.stop();
    const polls = chain.calls.head;
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(chain.calls.head).toBe(polls);
  });

  it('reports lag against the last seen head', async () => {
    const { chain, indexer } = setup({ confirmations: 3 });
    expect(indexer.lagBlocks()).toBe(0);
    chain.mineEmpty(10);
    await indexer.pollOnce();
    expect(indexer.lagBlocks()).toBe(3);
    expect(indexer.watermark()).toEqual({ number: 7n, hash: expect.any(String), timestamp: chain.timestampOf(7n) });
  });

  it('rejects invalid options', () => {
    const chain = new FakeChain();
    const base = { chainId: 1, vault: VAULT, startBlock: 0n, confirmations: 0, reorgDepth: 1, batchSize: 1, pollIntervalMs: 5, store: memoryCursorStore() as CursorStore };
    expect(() => new DepositIndexer(chain, { ...base, confirmations: -1 })).toThrow(RangeError);
    expect(() => new DepositIndexer(chain, { ...base, reorgDepth: 1.5 })).toThrow(RangeError);
    expect(() => new DepositIndexer(chain, { ...base, batchSize: 0 })).toThrow(RangeError);
  });
});
