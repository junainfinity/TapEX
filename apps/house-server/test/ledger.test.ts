import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileJournal, MemoryJournal, parseJournal, readJournal, repairJournalTail } from '../src/ledger/journal.js';
import { ACCOUNTS, Ledger } from '../src/ledger/ledger.js';
import { makeEngine, tempDir } from './helpers.js';

const P = 'player:0x' + 'a'.repeat(40);

describe('ledger', () => {
  it('posts balanced transactions atomically in exact bigint Centi', () => {
    const l = new Ledger();
    expect(l.post({ kind: 'deposit', ref: 'd1', atMs: 1, postings: [{ account: ACCOUNTS.vault, delta: -12_345_678_901_234_567_890n }, { account: P, delta: 12_345_678_901_234_567_890n }] })).toMatchObject({ ok: true });
    expect(l.balance(P)).toBe(12_345_678_901_234_567_890n);
    expect(l.total('player')).toBe(12_345_678_901_234_567_890n);
    expect(l.sum()).toBe(0n);
    expect(l.snapshot()).toEqual({ [ACCOUNTS.vault]: '-12345678901234567890', [P]: '12345678901234567890' });
  });

  it('rejects unbalanced, malformed and overdrawing transactions without partial effects', () => {
    const l = new Ledger();
    l.post({ kind: 'deposit', ref: 'd1', atMs: 1, postings: [{ account: ACCOUNTS.vault, delta: -100n }, { account: P, delta: 100n }] });
    expect(l.post({ kind: 'stake', ref: 's', atMs: 2, postings: [{ account: P, delta: -60n }, { account: ACCOUNTS.escrow, delta: 59n }] })).toMatchObject({ ok: false, reason: 'UNBALANCED' });
    expect(l.post({ kind: 'stake', ref: 's', atMs: 2, postings: [{ account: P, delta: -101n }, { account: ACCOUNTS.escrow, delta: 101n }] })).toMatchObject({ ok: false, reason: 'NEGATIVE_BALANCE', account: P });
    expect(l.post({ kind: 'stake', ref: 's', atMs: 2, postings: [{ account: 'player:0xABC', delta: -1n }, { account: ACCOUNTS.escrow, delta: 1n }] })).toMatchObject({ ok: false, reason: 'INVALID_ACCOUNT' });
    expect(l.post({ kind: 'stake', ref: 's', atMs: 2, postings: [{ account: P, delta: 1 as unknown as bigint }, { account: ACCOUNTS.escrow, delta: -1n }] })).toMatchObject({ ok: false, reason: 'INVALID_AMOUNT' });
    expect(l.post({ kind: 'stake', ref: 's', atMs: 2, postings: [{ account: P, delta: 0n }] })).toMatchObject({ ok: false, reason: 'UNBALANCED' });
    expect(l.balance(P)).toBe(100n); expect(l.balance(ACCOUNTS.escrow)).toBe(0n); expect(l.transactions).toBe(1);
    // House equity may go negative (it is reported, never used to refuse a payout).
    expect(l.post({ kind: 'win', ref: 'w', atMs: 3, postings: [{ account: ACCOUNTS.equity, delta: -5n }, { account: P, delta: 5n }] }).ok).toBe(true);
    expect(l.negativeAccounts()).toEqual([]);
  });
});

describe('deposits and dust', () => {
  it('credits wei deposits exactly once by txHash:logIndex and keeps the sub-Centi remainder as dust', () => {
    const { engine } = makeEngine();
    const d = { player: '0x' + 'B'.repeat(40), amountWei: 10n ** 18n * 25n + 10n ** 16n * 3n + 777n, depositId: 1n, txHash: '0x' + '1'.repeat(64), logIndex: 2, blockNumber: 10n };
    const r = engine.creditDeposit(d);
    expect(r).toMatchObject({ ok: true, duplicate: false, record: { centi: '2503', dustWei: '777', account: '0x' + 'b'.repeat(40) } });
    expect(engine.creditDeposit(d)).toMatchObject({ ok: true, duplicate: true });
    expect(engine.creditDeposit({ ...d, txHash: d.txHash.toUpperCase().replace('0X', '0x') })).toMatchObject({ duplicate: true });
    expect(engine.balanceOf('0x' + 'b'.repeat(40))).toBe(2503n);
    expect(engine.dustWei).toBe(777n);
    expect(engine.registeredPlayers).toBe(1);
    expect(engine.creditDeposit({ ...d, logIndex: 3, amountWei: 999n })).toMatchObject({ ok: true, record: { centi: '0', dustWei: '999' } });
    expect(engine.balanceOf('0x' + 'b'.repeat(40))).toBe(2503n);
    expect(engine.dustWei).toBe(1776n);
    expect(engine.creditDeposit({ ...d, player: 'nope' })).toMatchObject({ ok: false, code: 'INVALID_DEPOSIT' });
    expect(engine.creditDeposit({ ...d, amountWei: 0n, logIndex: 9 })).toMatchObject({ ok: false });
    // Reconciliation counts the dust: ledger wei = −external:vault × 1e16 + dust.
    const vault = { assetsWei: 10n ** 16n * (100_000_000n + 2503n) + 1776n, houseFundedWei: 0n, houseWithdrawnWei: 0n, totalDepositsWei: 0n, totalWithdrawalsWei: 0n };
    expect(engine.reconcile(vault)).toMatchObject({ match: true, deltaWei: '0', dustWei: '1776' });
    expect(engine.reconcile({ ...vault, assetsWei: vault.assetsWei + 1n })).toMatchObject({ match: false, deltaWei: '1' });
  });
});

describe('journal', () => {
  it('round-trips records through the file journal and detects gaps', () => {
    const dir = tempDir();
    const path = join(dir, 'journal-x.jsonl');
    const j = new FileJournal(path, 0);
    j.append({ type: 'a', seq: 1, atMs: 1 }); j.append({ type: 'b', seq: 2, atMs: 2 });
    expect(readFileSync(path, 'utf8')).toBe('');
    j.flush();
    j.append({ type: 'c', seq: 3, atMs: 3 }); j.close();
    expect(readJournal(path)).toEqual({ records: [{ type: 'a', seq: 1, atMs: 1 }, { type: 'b', seq: 2, atMs: 2 }, { type: 'c', seq: 3, atMs: 3 }], truncatedTail: false });
    expect(() => parseJournal('{"type":"a","seq":1,"atMs":1}\n{"type":"b","seq":3,"atMs":2}\n')).toThrow(/sequence/);
    expect(() => parseJournal('{"type":"a","seq":1,"atMs":1}\nnot json\n{"type":"b","seq":2,"atMs":2}\n')).toThrow(/malformed/);
  });

  it('drops only a torn final line and repairs the file for further appends', () => {
    const dir = tempDir();
    const path = join(dir, 'journal-torn.jsonl');
    writeFileSync(path, '{"type":"a","seq":1,"atMs":1}\n{"type":"b","seq":2,"at');
    expect(readJournal(path)).toMatchObject({ records: [{ type: 'a' }], truncatedTail: true });
    expect(repairJournalTail(path)).toBeGreaterThan(0);
    const j = new FileJournal(path); j.append({ type: 'b', seq: 2, atMs: 2 }); j.close();
    expect(readJournal(path)).toMatchObject({ records: [{ type: 'a' }, { type: 'b' }], truncatedTail: false });
  });

  it('journals every state change in dense sequence with amounts as strings', () => {
    const journal = new MemoryJournal();
    const { engine } = makeEngine({ journal });
    engine.creditDeposit({ player: '0x' + 'c'.repeat(40), amountWei: 10n ** 18n, depositId: 1n, txHash: '0x' + '2'.repeat(64), logIndex: 0, blockNumber: 1n });
    const records = journal.records();
    expect(records.map(r => r.seq)).toEqual(records.map((_, i) => i + 1));
    expect(records.map(r => r.type)).toEqual(['boot', 'table', 'treasury', 'register', 'deposit']);
    expect(journal.lines.every(l => !/\d+n"/.test(l))).toBe(true);
    expect(records[4]).toMatchObject({ amountWei: '1000000000000000000', centi: '100', dustWei: '0' });
  });
});
