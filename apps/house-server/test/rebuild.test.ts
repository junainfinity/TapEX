import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../src/engine/types.js';
import { FileJournal, MemoryJournal, readJournal } from '../src/ledger/journal.js';
import { runRefitJob, pathPoints } from '../src/refit/runner.js';
import { HISTORY, T0, deliver, makeEngine, offered, simPlayer, tempDir, walk } from './helpers.js';
import type { HouseEngine } from '../src/engine/engine.js';

const ADMIN = (reason: string, confirm?: string) => ({ actor: 'admin', reason, ...(confirm ? { confirm } : {}) });
const PLAYER = '0x' + 'd'.repeat(40);

/** Drive a representative day: deposits with dust, bets, every settlement path, admin changes, vouchers, breakers, refit. */
function scenario(engine: HouseEngine): void {
  const path = walk({ t0: T0, seconds: 900, start: Number(HISTORY.get(T0 - 1)), sigma: 3e-5, seed: 21, gaps: [[T0 + 300, T0 + 312]] });
  engine.creditDeposit({ player: PLAYER, amountWei: 10n ** 21n + 12_345n, depositId: 1n, txHash: '0x' + '3'.repeat(64), logIndex: 0, blockNumber: 7n });
  const sims = [simPlayer(engine, '5000000', 'casual'), simPlayer(engine, '5000000', 'whale'), simPlayer(engine, '5000000', 'sniper')];
  let n = 0;
  for (let t = T0; t < T0 + 900; t++) {
    const p = path.get(t);
    if (p !== undefined) deliver(engine, 'btc-usd', t, p); else engine.step(t * 1000 + 500, []);
    if (t % 7 === 0 && p !== undefined) {
      const quotes = offered(engine);
      for (const [i, who] of [...sims, PLAYER].entries()) {
        const q = quotes[(t + i * 5) % Math.max(1, quotes.length)];
        if (q) engine.placeBet({ requestId: `scn-${n++}`, account: who, quoteId: q.quoteId, revision: 1, cellId: q.cellId, stakeCenti: String(100 + ((t + i) % 9) * 55) });
      }
    }
    if (t === T0 + 100) {
      expect(engine.setPricing({ impactK: 0.05, z: 0.5 }, ADMIN('tune impact and z')).ok).toBe(true);
      expect(engine.setLimits({ cellFraction: 0.002, maxStakePerBetCenti: '900000' }, ADMIN('raise cell limit')).ok).toBe(true);
      expect(engine.setPlayerFlag(sims[2]!, 'flag', ADMIN('toxic flow suspected')).ok).toBe(true);
      expect(engine.setPlayerFlag(sims[1]!, 'block', ADMIN('whale paused by risk')).ok).toBe(true);
    }
    if (t === T0 + 200) {
      expect(engine.pauseMarket('btc-usd', ADMIN('maintenance window')).ok).toBe(true);
      expect(engine.resumeMarket('btc-usd', ADMIN('maintenance complete')).ok).toBe(true);
      expect(engine.pauseAll(ADMIN('incident drill now', 'pause-all')).ok).toBe(true);
    }
    if (t === T0 + 230) expect(engine.resumeAll(ADMIN('incident drill over')).ok).toBe(true);
    if (t === T0 + 400) {
      const v = engine.requestWithdrawal('wd-1', PLAYER, '2500', BigInt(t));
      if (!v.ok) throw new Error(v.code);
      engine.attachVoucherSignature(v.voucher.voucherId, '0x' + 'ab'.repeat(65));
      engine.markVoucherClaimed(v.voucher.voucherId, '0x' + '4'.repeat(64));
      const v2 = engine.requestWithdrawal('wd-2', PLAYER, '1000', BigInt(t));
      if (!v2.ok) throw new Error(v2.code);
      engine.cancelVoucher(v2.voucher.voucherId, 'signing failed in test');
      engine.recordTreasury('fund', '5000000', '0x' + '5'.repeat(64));
      const snap = engine.attestationSnapshot();
      engine.recordAttestation(1n, snap.liabilitiesWei, snap.ledgerRoot, BigInt(t), '0x' + '6'.repeat(64));
      expect(engine.setLaunch({ enabled: false }, ADMIN('end launch early', 'edge-change')).ok).toBe(true);
    }
    if (t === T0 + 600) {
      const now = Math.floor(engine.nowMs / 1000);
      const r = runRefitJob({ market: 'btc-usd', points: pathPoints(engine.paths.get('btc-usd')!.values, now, 36), now, trainHours: 36, minRows: 600 });
      if (!r.ok) throw new Error(`${r.reason}: ${r.detail}`);
      engine.publishTable('btc-usd', r.table, undefined, r.rows);
    }
  }
}

function withoutSeq(snapshot: unknown): unknown { const { seq: _seq, ...rest } = snapshot as Record<string, unknown>; return rest; }

describe('journal rebuild', () => {
  it('reproduces identical state from the journal, then keeps operating idempotently', () => {
    const journal = new MemoryJournal();
    const { engine } = makeEngine({ journal });
    scenario(engine);
    const types = new Set(journal.records().map(r => r.type));
    for (const t of ['sample', 'register', 'deposit', 'sim-credit', 'bet', 'settle', 'voucher', 'voucher-signed', 'voucher-claimed', 'voucher-cancelled', 'treasury', 'attest', 'config', 'player-flag', 'breaker', 'audit', 'table']) expect(types).toContain(t);
    const statuses = new Set(engine.settledLegs().map(l => l.status));
    expect([...statuses].sort()).toEqual(['lost', 'refunded', 'won']);
    const before = engine.stateSnapshot();

    const records = journal.records<EngineEvent>();
    const rebuilt = makeEngine({ records, journal: new MemoryJournal() }).engine;
    expect(withoutSeq(rebuilt.stateSnapshot())).toEqual(withoutSeq(before));
    expect(rebuilt.equity()).toBe(engine.equity());
    expect(rebuilt.limitAmounts()).toEqual(engine.limitAmounts());
    expect(rebuilt.breakerStatus().filter(b => b.id === 'manual')).toEqual(engine.breakerStatus().filter(b => b.id === 'manual'));

    // Same requestId after restart → the original result; the leg counter continues without collisions.
    const firstBet = records.find((r): r is Extract<EngineEvent, { type: 'bet' }> => r.type === 'bet')!;
    expect(rebuilt.receiptFor(firstBet.leg.requestId)).toMatchObject({ status: 'accepted', leg: { legId: firstBet.leg.legId } });
    const t = Math.floor(rebuilt.nowMs / 1000) + 1;
    deliver(rebuilt, 'btc-usd', t, HISTORY.get(T0 - 1)!);
    const q = offered(rebuilt)[0]!;
    const who = rebuilt.player('sim:t00001') ? 'sim:t00001' : [...rebuilt.players.values()].find(p => p.kind === 'sim' && !p.blocked && !p.flagged)!.account;
    const r = rebuilt.placeBet({ requestId: 'after-restart', account: who, quoteId: q.quoteId, revision: 1, cellId: q.cellId, stakeCenti: '100' });
    expect(r.status).toBe('accepted');
    if (r.status === 'accepted') expect(Number(r.leg.legId.slice(1))).toBe(Math.max(...records.filter(x => x.type === 'bet').map(x => (x as Extract<EngineEvent, { type: 'bet' }>).leg.seq)) + 1);
  });

  it('rebuilds from a file journal written across flushes, restoring a latched drawdown pause', () => {
    const dir = tempDir();
    const file = join(dir, 'journal-file.jsonl');
    const journal = new FileJournal(file);
    const { engine } = makeEngine({ journal });
    scenario(engine);
    // Force a drawdown pause: a large on-chain-equity loss shows up as a > 5 % 1 h drop.
    engine.ledger.post({ kind: 'win', ref: 'shock', atMs: engine.nowMs, postings: [{ account: 'house:sim-pnl', delta: -20_000_000n }, { account: 'external:sim-credit', delta: 20_000_000n }] });
    engine.step(engine.nowMs + 1000, []);
    expect(engine.breakerStatus().find(b => b.id === 'drawdown')?.state).toBe('paused');
    engine.flush(); journal.close();
    const { records, truncatedTail } = readJournal<EngineEvent>(file);
    expect(truncatedTail).toBe(false);
    const rebuilt = makeEngine({ records, journal: new MemoryJournal() }).engine;
    // The shock was not a journaled event, so equity differs; the latched breaker must still fail closed.
    expect(rebuilt.breakerStatus().find(b => b.id === 'drawdown')).toMatchObject({ state: 'paused' });
    // Until the first fresh price and equity observation the feed/equity breakers already fail closed.
    expect(rebuilt.gate('btc-usd').allowed).toBe(false);
    deliver(rebuilt, 'btc-usd', Math.floor(rebuilt.nowMs / 1000) + 1, HISTORY.get(T0 - 1)!);
    expect(rebuilt.gate('btc-usd')).toMatchObject({ allowed: false, breaker: 'drawdown' });
    expect(rebuilt.latestGrid('btc-usd')!.grid.reason).toBe('market-paused');
    expect(rebuilt.resumeAll(ADMIN('operator reviewed drawdown')).ok).toBe(true);
    expect(rebuilt.gate('btc-usd')).toMatchObject({ allowed: true });
    expect(rebuilt.auditLog(5)[0]).toMatchObject({ action: 'resume-all', actor: 'admin' });
  });
});
