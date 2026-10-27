// MC-4: an acknowledged voucher (or bet, or treasury move) must survive an OS crash, not just a process crash.
//  - FileJournal fsyncs a flush that carries a durable record before returning, even inside its 1 s window;
//  - the engine marks money moves and acknowledged records durable (feed samples and sim flow are not);
//  - if a tail were ever lost anyway, the rebuilt ledger (a new boot) never re-issues the spent voucher nonce.
import { fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '../src/engine/types.js';
import { FileJournal, type JournalRecord, type JournalSink } from '../src/ledger/journal.js';
import { startTestApp, type TestApp } from './app-helpers.js';
import { HISTORY, T0, deliver, makeEngine, offered, simPlayer, tempDir } from './helpers.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

const E18 = 10n ** 18n;
const CENTI = 10n ** 16n;

describe('FileJournal durability', () => {
  beforeEach(() => { vi.mocked(fsyncSync).mockClear(); });

  it('fsyncs a flush carrying a durable record before returning, even right after the previous fsync', () => {
    const j = new FileJournal(join(tempDir('journal-durable-'), 'journal.jsonl'), 1000);
    j.append({ type: 'sample', seq: 1, atMs: 1 });
    j.flush(); // the first flush syncs (nothing synced yet)
    expect(fsyncSync).toHaveBeenCalledTimes(1);
    j.append({ type: 'sample', seq: 2, atMs: 2 });
    j.flush(); // inside the 1 s window, nothing durable: not synced
    expect(fsyncSync).toHaveBeenCalledTimes(1);
    j.append({ type: 'voucher-signed', seq: 3, atMs: 3 }, true);
    j.flush(); // an acknowledged voucher signature: synced now, with everything before it
    expect(fsyncSync).toHaveBeenCalledTimes(2);
    j.append({ type: 'sample', seq: 4, atMs: 4 });
    j.flush();
    expect(fsyncSync).toHaveBeenCalledTimes(2);
    j.close();
  });
});

/** Records the durable flag the engine passes with each record. */
class RecordingJournal implements JournalSink {
  readonly kind = 'memory' as const;
  readonly entries: { type: string; durable: boolean; record: JournalRecord }[] = [];
  append(record: JournalRecord, durable?: boolean): void { this.entries.push({ type: record.type, durable: durable === true, record }); }
  flush(): void { /* memory */ }
  close(): void { /* memory */ }
}

describe('engine durability classification', () => {
  it('marks money moves and acknowledged records durable, and leaves feed samples and simulated flow to the periodic fsync', () => {
    const journal = new RecordingJournal();
    const { engine } = makeEngine({ journal });
    const player = '0x' + 'c'.repeat(40);
    engine.creditDeposit({ player, amountWei: 1_000n * E18, depositId: 1n, txHash: '0x' + '2'.repeat(64), logIndex: 0, blockNumber: 1n });
    const sim = simPlayer(engine);
    deliver(engine, 'btc-usd', T0, HISTORY.get(T0 - 1)!);
    const quote = offered(engine).find(q => q.window === 5 && !q.capped)!;
    expect(engine.placeBet({ requestId: 'onchain-1', account: player, quoteId: quote.quoteId, revision: 1, cellId: quote.cellId, stakeCenti: '1000' }).status).toBe('accepted');
    expect(engine.placeBet({ requestId: 'sim-1', account: sim, quoteId: quote.quoteId, revision: 1, cellId: quote.cellId, stakeCenti: '1000' }).status).toBe('accepted');
    const w = engine.requestWithdrawal('wd-1', player, '5000', BigInt(T0));
    if (!w.ok) throw new Error(w.code);
    expect(engine.attachVoucherSignature(w.voucher.voucherId, '0x' + '1'.repeat(130))).toBe(true);
    engine.recordTreasury('fund', '100', '0x' + '3'.repeat(64));
    const durable = (type: string, pick: (r: JournalRecord) => boolean = () => true) => journal.entries.filter(e => e.type === type && pick(e.record)).map(e => e.durable);
    expect(durable('deposit')).toEqual([true]);
    expect(durable('voucher')).toEqual([true]);
    expect(durable('voucher-signed')).toEqual([true]);
    expect(durable('treasury', r => (r as Extract<EngineEvent, { type: 'treasury' }>).action === 'fund')).toEqual([true]);
    expect(durable('treasury').every(d => d)).toBe(true);
    expect(durable('bet', r => (r as Extract<EngineEvent, { type: 'bet' }>).leg.kind === 'onchain')).toEqual([true]);
    expect(durable('bet', r => (r as Extract<EngineEvent, { type: 'bet' }>).leg.kind === 'sim')).toEqual([false]);
    expect(durable('sim-credit').every(d => !d)).toBe(true);
    expect(durable('sample').length).toBeGreaterThan(0);
    expect(durable('sample').every(d => !d)).toBe(true);
  });
});

describe('acknowledged voucher cut from the journal tail (defence in depth)', () => {
  const open: TestApp[] = [];
  afterEach(async () => { for (const t of open.splice(0)) await t.close().catch(() => undefined); });

  it('the rebuilt ledger issues its next voucher under a nonce the vault has not consumed', async () => {
    const statePath = join(tempDir('journal-loss-'), 'offline-chain.json');
    const t1 = await startTestApp({ chain: { statePath }, bootId: 'jl1' }); open.push(t1);
    const p = t1.chain.players()[0]!;
    const account = p.address.toLowerCase();
    await t1.chain.playerDeposit(p.role, 1_000n * E18);
    t1.advance(2);
    const durableUpTo = t1.journal.lines.length;
    const issued = await t1.app.issueVoucher('jl-wd-1', account, '50000');
    if (!issued.ok) throw new Error(issued.code);
    const old = issued.voucher;
    await t1.close(); open.length = 0;

    // Simulated OS crash: the records after the last fsync are gone (FileJournal now fsyncs them before acknowledging).
    const records = t1.journal.records<EngineEvent>().slice(0, durableUpTo);
    const t2 = await startTestApp({ chain: { statePath }, records, bootId: 'jl2' }); open.push(t2);
    const e = t2.app.engine;
    await t2.chain.playerWithdraw(p.role, { amountWei: 50_000n * CENTI, nonce: BigInt(old.nonce), expiry: BigInt(old.expiry), signature: old.signature! });
    const again = await t2.app.issueVoucher('jl-wd-2', account, '10000');
    if (!again.ok) throw new Error(again.code);
    expect(again.voucher.voucherId).toBe(old.voucherId); // the same id is reused ...
    expect(again.voucher.nonce).not.toBe(old.nonce); // ... under a different nonce
    expect(await t2.chain.nonceUsed(account, BigInt(again.voucher.nonce))).toBe(false);
    // The new voucher is redeemable and is claimed by its own event.
    await t2.chain.playerWithdraw(p.role, { amountWei: 10_000n * CENTI, nonce: BigInt(again.voucher.nonce), expiry: BigInt(again.voucher.expiry), signature: again.voucher.signature! });
    expect(e.vouchers.get(again.voucher.voucherId)).toMatchObject({ status: 'claimed' });
  });
});
