import { describe, expect, it } from 'vitest';
import { parseDecimal } from '@maya/contracts';
import { DEFAULT_DEFENSES, DEFENSES_OFF, cellFairValue, freezeDefenses, type DefenseConfig, type PathView } from '@maya/house';
import { CONTROLLER_ACTOR, TOXICITY_ACTOR, type HouseEngine } from '../src/engine/engine.js';
import type { BetIntent, EngineEvent, PlaceResult } from '../src/engine/types.js';
import { MemoryJournal } from '../src/ledger/journal.js';
import type { HouseQuote } from '../src/quotes/quote-book.js';
import { quotesView } from '../src/api/views.js';
import { HISTORY, LAG_MS, T0, deliver, makeEngine, offered, simPlayer, walk } from './helpers.js';

const FUTURE = walk({ t0: T0, seconds: 900, start: Number(HISTORY.get(T0 - 1)), sigma: 3e-5, seed: 11 });
const ADMIN = (reason: string, confirm?: string) => ({ actor: 'admin', reason, ...(confirm ? { confirm } : {}) });

/**
 * DEFENSES_OFF with the given sections switched on (default parameters) and overridden. The hold
 * starts from a plain relative tolerance without the trust ramp, so each test sets what it exercises.
 */
function defenses(patch: Partial<{ [K in keyof DefenseConfig]: Partial<DefenseConfig[K]> | DefenseConfig[K] }> & { minLeadS?: number } = {}): DefenseConfig {
  const out = { ...DEFENSES_OFF } as Record<string, unknown>;
  const base: Record<string, object> = { ...(DEFAULT_DEFENSES as unknown as Record<string, object>), hold: { ...DEFAULT_DEFENSES.hold, tolScale: 'relative', newAccountHolds: 0 } };
  for (const [k, v] of Object.entries(patch)) out[k] = typeof v === 'object' ? { ...base[k], enabled: true, ...v } : v;
  return freezeDefenses(out as unknown as DefenseConfig);
}
const intent = (account: string, q: HouseQuote, stakeCenti = '1000', requestId = `r-${Math.random().toString(36).slice(2)}`): BetIntent => ({ requestId, account, quoteId: q.quoteId, revision: 1, cellId: q.cellId, stakeCenti });
const status = (r: PlaceResult | undefined) => r?.status;

function setup(d: DefenseConfig, config: Record<string, unknown> = {}, journal = new MemoryJournal()) {
  const { engine } = makeEngine({ journal, config: { defenses: d, ...config } });
  deliver(engine, 'btc-usd', T0, FUTURE.get(T0)!);
  const quotes = offered(engine);
  expect(quotes.length).toBeGreaterThan(5);
  return { engine, journal, quotes, account: simPlayer(engine) };
}
const mid = (quotes: readonly HouseQuote[]) => quotes.find(q => q.window >= 2 && q.p > 0.1 && q.p < 0.9)!;
const at = (t: number) => t * 1000 + LAG_MS;

describe('acceptance hold (SPEC-10 §1)', () => {
  it('answers pending, stays idempotent during the hold, reserves the stake and accepts at the original quote on the next sample', () => {
    const { engine, journal, quotes, account } = setup(defenses({ hold: { tolRel: 5 } }));
    const q = mid(quotes);
    const before = engine.balanceOf(account);
    const r = engine.placeBet(intent(account, q, '1500', 'hold-1'));
    expect(r).toMatchObject({ status: 'pending', newlyHeld: true, hold: { requestId: 'hold-1', quoteId: q.quoteId, cellId: q.cellId, stakeCenti: '1500', x100: q.x100, requestedMs: at(T0), holdUntilMs: at(T0) + 1500 } });
    expect(Object.isFrozen(r)).toBe(true);
    expect(engine.placeBet(intent(account, q, '1500', 'hold-1'))).toMatchObject({ status: 'pending', newlyHeld: false });
    expect(engine.placeBet(intent(account, q, '1600', 'hold-1'))).toMatchObject({ status: 'rejected', reason: 'REQUEST_CONFLICT' });
    expect(engine.receiptFor('hold-1')).toMatchObject({ status: 'pending' });
    expect(engine.holdPending).toBe(1);
    expect(engine.balanceOf(account)).toBe(before);
    expect(engine.availableBalance(account)).toBe(before - 1500n);
    expect(engine.openLegCount).toBe(0);
    deliver(engine, 'btc-usd', T0 + 1, FUTURE.get(T0 + 1)!);
    const done = engine.receiptFor('hold-1');
    expect(done).toMatchObject({ status: 'accepted', leg: { x100: q.x100, stakeCenti: '1500', quoteId: q.quoteId, requestedMs: at(T0), placedMs: at(T0 + 1), p: q.p } });
    if (done?.status !== 'accepted') return;
    expect(done.leg.pFresh).toBeGreaterThan(0);
    expect(engine.holdPending).toBe(0);
    expect(engine.balanceOf(account)).toBe(before - 1500n);
    expect(engine.placeBet(intent(account, q, '1500', 'hold-1'))).toMatchObject({ status: 'accepted', newlyCommitted: false, leg: { legId: done.leg.legId } });
    const events = journal.records<EngineEvent>().filter(e => e.type === 'hold' || e.type === 'hold-resolved');
    expect(events.map(e => e.type)).toEqual(['hold', 'hold-resolved']);
    expect(events[1]).toMatchObject({ outcome: 'accepted', detail: 'ok', freshT: T0 + 1, latencyMs: 1000, legId: done.leg.legId });
    expect(engine.holdStats.snapshot()).toMatchObject({ created: 1, accepted: 1, rejected: 0 });
  });

  it('rejects a move of the fair value beyond the tolerance in either direction (symmetric), and accepts within it', () => {
    const spot = Number(FUTURE.get(T0)!);
    const jump = (factor: number) => {
      const s = setup(defenses({ hold: { tolRel: 0.02, tolAbs: 0 } }), { guardSigma: 1e6 });
      const q = s.quotes.find(x => x.window >= 2 && x.bandOffset === 1 && x.p > 0.05 && x.p < 0.9)!;
      expect(s.engine.placeBet(intent(s.account, q, '1000', 'sym')).status).toBe('pending');
      deliver(s.engine, 'btc-usd', T0 + 1, (spot * factor).toFixed(2));
      return s.engine.receiptFor('sym');
    };
    const up = jump(1 + 6e-5), down = jump(1 - 6e-5); // ± ~0.4 band on BTC (60,000 × 6e-5 = 3.6 USD)
    expect(up).toMatchObject({ status: 'rejected', reason: 'QUOTE_CHANGED', message: expect.stringMatching(/Fair value moved from/) });
    expect(down).toMatchObject({ status: 'rejected', reason: 'QUOTE_CHANGED', message: expect.stringMatching(/Fair value moved from/) });
    const wide = setup(defenses({ hold: { tolRel: 5 } }), { guardSigma: 1e6 });
    const q = wide.quotes.find(x => x.window >= 2 && x.bandOffset === 1)!;
    wide.engine.placeBet(intent(wide.account, q, '1000', 'wide'));
    deliver(wide.engine, 'btc-usd', T0 + 1, (spot * (1 + 6e-5)).toFixed(2));
    expect(status(wide.engine.receiptFor('wide'))).toBe('accepted');
  });

  it('fails closed without a fresh sample (or accepts when configured), within the maximum hold', () => {
    const s = setup(defenses({ hold: { tolRel: 5, maxHoldMs: 1500 } }));
    const q = mid(s.quotes);
    s.engine.placeBet(intent(s.account, q, '1000', 'slow'));
    s.engine.step(at(T0) + 1499, []);
    expect(status(s.engine.receiptFor('slow'))).toBe('pending');
    s.engine.step(at(T0) + 1500, []);
    expect(s.engine.receiptFor('slow')).toMatchObject({ status: 'rejected', reason: 'QUOTE_EXPIRED', message: expect.stringMatching(/No fresh price/) });
    expect(s.engine.holdStats.snapshot()).toMatchObject({ rejected: 1, byDetail: { timeout: 1 } });
    const a = setup(defenses({ hold: { tolRel: 5, onTimeout: 'accept' } }));
    a.engine.placeBet(intent(a.account, mid(a.quotes), '1000', 'slow-ok'));
    a.engine.step(at(T0) + 1500, []);
    expect(a.engine.receiptFor('slow-ok')).toMatchObject({ status: 'accepted', leg: { requestedMs: at(T0) } });
  });

  it('applies the trust ramp to a new account’s first holds, and a tight tolerance only on latency evidence', () => {
    const spot = Number(FUTURE.get(T0)!);
    const run = (d: DefenseConfig) => {
      const s = setup(d, { guardSigma: 1e6 });
      const q = s.quotes.find(x => x.window >= 2 && x.bandOffset === 1 && x.p > 0.05 && x.p < 0.9)!;
      s.engine.placeBet(intent(s.account, q, '1000', 'ramp'));
      deliver(s.engine, 'btc-usd', T0 + 1, (spot * (1 + 2e-5)).toFixed(2)); // ~0.1 band: a modest move of the fair value
      return s.engine.receiptFor('ramp');
    };
    expect(run(defenses({ hold: { tolRel: 5 } }))).toMatchObject({ status: 'accepted' });
    expect(run(defenses({ hold: { tolRel: 5, newAccountHolds: 10, newAccountTolRel: 0.001, tolAbs: 0 } }))).toMatchObject({ status: 'rejected', reason: 'QUOTE_CHANGED' });
    // A flag from outcome evidence alone keeps the normal tolerance (only the surcharge applies).
    const s = setup(defenses({ hold: { tolRel: 5, flaggedTolRel: 0.001, tolAbs: 0 }, toxicity: {} }), { guardSigma: 1e6 });
    expect(s.engine.setPlayerFlag(s.account, 'flag', ADMIN('manual review flag')).ok).toBe(true);
    deliver(s.engine, 'btc-usd', T0 + 1, FUTURE.get(T0 + 1)!);
    const fq = offered(s.engine, 'btc-usd', true).find(x => x.window >= 2 && x.bandOffset === 1)!;
    s.engine.placeBet(intent(s.account, fq, '1000', 'flagged-outcome'));
    deliver(s.engine, 'btc-usd', T0 + 2, (Number(FUTURE.get(T0 + 1)!) * (1 + 2e-5)).toFixed(2));
    expect(s.engine.receiptFor('flagged-outcome')).toMatchObject({ status: 'accepted', leg: { flagged: true } });
  });

  it('re-checks funds at acceptance: held stakes are reserved against new placements', () => {
    const { engine, quotes } = setup(defenses({ hold: { tolRel: 5 } }));
    const poor = simPlayer(engine, '1000');
    const q = mid(quotes);
    expect(engine.placeBet(intent(poor, q, '800', 'p-1')).status).toBe('pending');
    expect(engine.placeBet(intent(poor, quotes.find(x => x.cellId !== q.cellId && x.window >= 3)!, '300', 'p-2'))).toMatchObject({ status: 'rejected', reason: 'INSUFFICIENT_BALANCE' });
    expect(engine.placeBet(intent(poor, q, '200', 'p-3')).status).toBe('pending');
    deliver(engine, 'btc-usd', T0 + 1, FUTURE.get(T0 + 1)!);
    expect([status(engine.receiptFor('p-1')), status(engine.receiptFor('p-3'))]).toEqual(['accepted', 'accepted']);
    expect(engine.balanceOf(poor)).toBe(0n);
  });

  it('rejects placements still held when the server restarts (quotes do not survive), and rebuilds resolved holds exactly', () => {
    const journal = new MemoryJournal();
    const s = setup(defenses({ hold: { tolRel: 5 } }), {}, journal);
    const q = mid(s.quotes);
    s.engine.placeBet(intent(s.account, q, '1000', 'kept'));
    deliver(s.engine, 'btc-usd', T0 + 1, FUTURE.get(T0 + 1)!);
    const q2 = mid(offered(s.engine));
    s.engine.placeBet(intent(s.account, q2, '1000', 'dangling'));
    const before = s.engine.stateSnapshot() as Record<string, unknown>;
    expect((before['holds'] as unknown[]).length).toBe(1);
    const rebuilt = makeEngine({ records: journal.records<EngineEvent>(), journal: new MemoryJournal() }).engine;
    expect(rebuilt.receiptFor('kept')).toMatchObject({ status: 'accepted' });
    expect(rebuilt.receiptFor('dangling')).toMatchObject({ status: 'rejected', reason: 'QUOTE_EXPIRED', message: expect.stringMatching(/restarted/) });
    expect(rebuilt.holdPending).toBe(0);
    expect(rebuilt.availableBalance(s.account)).toBe(rebuilt.balanceOf(s.account));
    expect(rebuilt.holdStats.snapshot()).toMatchObject({ created: 2, accepted: 1, rejected: 1, byDetail: { ok: 1, restart: 1 } });
    // Without a dangling hold the rebuild is exact.
    s.engine.step(at(T0 + 1) + 1500, []);
    const again = makeEngine({ records: journal.records<EngineEvent>(), journal: new MemoryJournal() }).engine;
    const strip = (x: unknown) => { const { seq: _s, ...rest } = x as Record<string, unknown>; return rest; };
    expect(strip(again.stateSnapshot())).toEqual(strip(s.engine.stateSnapshot()));
  });
});

describe('quote validity, minimum lead and account ramp (SPEC-10 §2–§4)', () => {
  it('lets a quote stand only until the next first-seen sample plus the grace', () => {
    const s = setup(defenses({ quoteValidity: { graceMs: 500, maxTtlMs: 2500 } }));
    const q = s.quotes.find(x => x.window >= 3)!;
    expect(q.validUntilMs).toBe(Math.min(at(T0) + 2500, q.cell.startMs - 3000, T0 * 1000 + 7000));
    deliver(s.engine, 'btc-usd', T0 + 1, FUTURE.get(T0 + 1)!);
    expect(s.engine.quoteSupersededAt(q)).toBe(at(T0 + 1) + 500);
    expect(s.engine.quoteStands(q)).toBe(true);
    expect(s.engine.placeBet(intent(s.account, q, '100', 'grace')).status).toBe('accepted');
    s.engine.step(at(T0 + 1) + 500, []);
    expect(s.engine.quoteStands(q)).toBe(false);
    expect(s.engine.placeBet(intent(s.account, q, '100', 'late'))).toMatchObject({ reason: 'QUOTE_EXPIRED', message: expect.stringMatching(/newer price/) });
    const view = quotesView(s.engine, 'btc-usd', s.account) as { cells: { quoteId?: string; available: boolean }[] };
    expect(view.cells.every(c => c.quoteId !== q.quoteId)).toBe(true);
    // Stage A: without validity the old quote is accepted until its fixed TTL.
    const a = setup(DEFENSES_OFF);
    const qa = a.quotes.find(x => x.window >= 3)!;
    deliver(a.engine, 'btc-usd', T0 + 1, FUTURE.get(T0 + 1)!);
    a.engine.step(at(T0) + 1700, []);
    expect(a.engine.placeBet(intent(a.account, qa, '100', 'stage-a')).status).toBe('accepted');
  });

  it('closes cells inside the minimum lead without moving the grid, and rejects late placements', () => {
    const s = setup(defenses({ minLeadS: 5 }));
    const grid = s.engine.latestGrid('btc-usd')!.grid;
    expect(grid.start0).toBe(Math.ceil((T0 + 3) / 5) * 5);
    for (const c of grid.cells) if (c.tau < 5) expect(c).toMatchObject({ available: false, reason: 'too-late' });
    expect(s.engine.minLeadMs()).toBe(5000);
    const q = s.quotes.reduce((a, b) => (b.cell.startMs < a.cell.startMs ? b : a));
    expect(q.validUntilMs).toBeLessThanOrEqual(q.cell.startMs - 5000);
    s.engine.step(q.cell.startMs - 4999, []);
    expect(s.engine.placeBet(intent(s.account, q))).toMatchObject({ reason: 'TOO_LATE' });
  });

  it('caps a new account at the ramp limit and exposes the headroom', () => {
    const s = setup(defenses({ ramp: { startCenti: '1000', perSettledBetCenti: '500', handleFraction: 0 } }));
    const q = s.quotes.find(x => x.x100 >= 300 && x.window >= 3)!;
    expect(s.engine.accountHeadroom(s.account)).toBe(1000n);
    const max = s.engine.accountMaxStake(s.account, q.x100);
    expect(BigInt(q.x100 - 100) * max / 100n).toBeLessThanOrEqual(1000n);
    const tooBig = (max + 10n).toString();
    expect(s.engine.placeBet(intent(s.account, q, tooBig, 'ramp-big'))).toMatchObject({ status: 'rejected', reason: 'LIABILITY_LIMIT', limit: 'account', message: expect.stringMatching(/New-account ramp/) });
    expect(s.engine.placeBet(intent(s.account, q, max.toString(), 'ramp-ok')).status).toBe('accepted');
    const old = setup(DEFENSES_OFF);
    expect(old.engine.placeBet(intent(old.account, old.quotes.find(x => x.x100 >= 300 && x.window >= 3)!, tooBig, 'no-ramp')).status).toBe('accepted');
    // Headroom grows with settled history: run the path until the leg settles.
    for (let t = T0 + 1; t < T0 + 60; t++) deliver(s.engine, 'btc-usd', t, FUTURE.get(t)!);
    const p = s.engine.player(s.account)!;
    expect(p.settledBets).toBe(1);
    expect(s.engine.accountHeadroom(s.account)).toBe(1500n);
  });
});

/** Build a view of the path that already contains second t (the sniper's foresight). */
function withFuture(engine: HouseEngine, t: number, price: string): PathView {
  const store = engine.paths.get('btc-usd')!;
  return { get: (u: number) => (u === t ? Number(price) : store.get(u)) };
}
/** The offered square whose fair value rises most by the next second, as a 1 s sniper would pick it. */
function snipe(engine: HouseEngine, t: number, next: string): HouseQuote | undefined {
  const path = withFuture(engine, t + 1, next);
  let best: { q: HouseQuote; gain: number } | undefined;
  for (const q of offered(engine, 'btc-usd', engine.player('sim:snipe')?.flagged && engine.flowEdgeActive() > 0)) {
    const fv = cellFairValue({ market: 'btc-usd', t: t + 1, spot: parseDecimal(next), path, table: engine.currentTable('btc-usd'), startMs: q.cell.startMs, bandIndex: BigInt(q.bandIndex) });
    if (!fv.ok) continue;
    const gain = fv.p / q.p;
    if (!best || gain > best.gain) best = { q, gain };
  }
  return best && best.gain > 1.05 ? best.q : undefined;
}

describe('graduated toxicity with latency evidence (SPEC-10 §5)', () => {
  it('surcharges then blocks an account whose placements keep preceding favourable moves, and leaves an honest account alone', () => {
    const journal = new MemoryJournal();
    const d = defenses({ hold: { tolRel: 5, flaggedTolRel: 0.02 }, toxicity: {} });
    const { engine } = makeEngine({ journal, config: { defenses: d, guardSigma: 1e6 } });
    engine.register('sim:snipe', 'sim', 'sniper1s'); engine.grantSimCredit('sim:snipe', '100000000', 'g-s');
    // A realistic population: several uninformed accounts set the baseline the sniper is measured against.
    const crowd = Array.from({ length: 6 }, () => simPlayer(engine, '100000000', 'casual'));
    const honest = crowd[0]!;
    let n = 0, flaggedAt: number | undefined, blockedAt: number | undefined;
    for (let t = T0; t < T0 + 600; t++) {
      deliver(engine, 'btc-usd', t, FUTURE.get(t)!);
      const p = engine.player('sim:snipe')!;
      if (p.flagged && flaggedAt === undefined) flaggedAt = p.holdsPlaced;
      if (p.blocked) { blockedAt = p.holdsPlaced; break; }
      const q = snipe(engine, t, FUTURE.get(t + 1)!);
      if (q) engine.placeBet({ requestId: `s-${n++}`, account: 'sim:snipe', quoteId: q.quoteId, revision: 1, cellId: q.cellId, stakeCenti: '1000' });
      const choices = offered(engine).filter(x => x.window >= 1);
      crowd.forEach((who, i) => { const h = choices[(t * 7 + i * 13) % Math.max(1, choices.length)]; if (h) engine.placeBet({ requestId: `h-${n++}`, account: who, quoteId: h.quoteId, revision: 1, cellId: h.cellId, stakeCenti: '1000' }); });
    }
    expect(flaggedAt).toBeGreaterThanOrEqual(DEFAULT_DEFENSES.toxicity.holdMinN);
    expect(flaggedAt).toBeLessThan(40);
    expect(blockedAt).toBeGreaterThanOrEqual(DEFAULT_DEFENSES.toxicity.holdBlockMinN);
    const s = engine.player('sim:snipe')!;
    expect(s.flags.map(f => [f.actor, f.action])).toEqual([[TOXICITY_ACTOR, 'flag'], [TOXICITY_ACTOR, 'block']]);
    expect(s.flags[0]!.reason).toMatch(/^latency evidence z=/);
    expect(engine.holdMoveZ(s)).toBeGreaterThan(DEFAULT_DEFENSES.toxicity.holdZ);
    for (const who of crowd) {
      const h = engine.player(who)!;
      expect(h.flagged).toBe(false);
      expect(Math.abs(engine.holdMoveZ(h))).toBeLessThan(3);
    }
    expect(engine.flowEdgeActive()).toBe(DEFAULT_DEFENSES.toxicity.surchargeEdge);
    // The flag and block are journaled system actions; a rebuild reproduces the evidence and state.
    const audit = journal.records<EngineEvent>().filter((r): r is Extract<EngineEvent, { type: 'audit' }> => r.type === 'audit' && r.entry.actor === TOXICITY_ACTOR);
    expect(audit.map(a => a.entry.action)).toEqual(['player-flag', 'player-block']);
    const rebuilt = makeEngine({ records: journal.records<EngineEvent>(), journal: new MemoryJournal() }).engine;
    expect(rebuilt.player('sim:snipe')).toMatchObject({ flagged: true, blocked: true, holdN: s.holdN });
    expect(rebuilt.holdMoveZ(rebuilt.player('sim:snipe')!)).toBeCloseTo(engine.holdMoveZ(s), 9);
  });
});

describe('adaptive edge controller in the engine (SPEC-10 §6)', () => {
  it('raises the edge of a range whose clean flow returns more than the policy, journaled, priced into new quotes and rebuilt', () => {
    const journal = new MemoryJournal();
    const d = defenses({ controller: { minBets: 20, zGate: 0, deadband: 0.001, evalEveryMs: 60_000, maxStepPerEval: 0.01, maxStepPerHour: 0.05 } });
    const { engine } = makeEngine({ journal, config: { defenses: d } });
    const p = HISTORY.get(T0 - 1)!;
    const who = simPlayer(engine, '100000000', 'casual');
    let n = 0;
    // A flat path: centre-band squares always win, so this flow returns far more than the policy promises.
    for (let t = T0; t < T0 + 400; t++) {
      deliver(engine, 'btc-usd', t, p);
      for (const q of offered(engine).filter(x => x.bandOffset === 0 && x.window >= 1).slice(0, 2)) engine.placeBet({ requestId: `c-${n++}`, account: who, quoteId: q.quoteId, revision: 1, cellId: q.cellId, stakeCenti: '1000' });
    }
    const moves = journal.records<EngineEvent>().filter((r): r is Extract<EngineEvent, { type: 'controller' }> => r.type === 'controller');
    expect(moves.length).toBeGreaterThan(0);
    expect(moves[0]).toMatchObject({ before: 0 });
    expect(moves[0]!.after).toBeGreaterThan(0);
    expect(moves[0]!.realized).toBeGreaterThan(moves[0]!.target);
    const key = moves[0]!.key;
    expect(engine.controller.adjust(key)).toBeGreaterThan(0);
    expect(engine.auditLog(5000).some(a => a.actor === CONTROLLER_ACTOR && a.action === 'controller-adjust' && a.target === key && a.kind === 'system')).toBe(true);
    const priced = offered(engine).filter(q => q.ctlAdjust !== 0);
    expect(priced.length).toBeGreaterThan(0);
    for (const q of priced) expect(q.edge).toBeCloseTo(engine.latestGrid('btc-usd')!.grid.edge.edge + q.ctlAdjust, 12);
    const rebuilt = makeEngine({ records: journal.records<EngineEvent>(), journal: new MemoryJournal() }).engine;
    expect(rebuilt.controller.adjust(key)).toBe(engine.controller.adjust(key));
  });

  it('admin overrides and disabling are journaled changes with the SPEC §7 confirmations', () => {
    const journal = new MemoryJournal();
    const { engine } = makeEngine({ journal, config: { defenses: DEFAULT_DEFENSES } });
    expect(engine.setDefenses({ controller: { overrides: { '2-5': 0.03 } } }, ADMIN('pin the 2-5 range edge'))).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    const r = engine.setDefenses({ controller: { overrides: { '2-5': 0.03 } } }, ADMIN('pin the 2-5 range edge', 'edge-change'));
    expect(r).toMatchObject({ ok: true, action: 'defenses', before: DEFAULT_DEFENSES });
    expect(engine.defenses.controller.overrides).toEqual({ '2-5': 0.03 });
    expect(engine.controller.effective(engine.defenses.controller)).toEqual({ '2-5': 0.03 });
    expect(engine.setDefenses({ controller: { overrides: { '2-5': 0.03 } } }, ADMIN('same again please'))).toMatchObject({ ok: false, code: 'NO_CHANGE' });
    expect(engine.setDefenses({ hold: { enabled: false } }, ADMIN('turn the hold off'))).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED', message: expect.stringMatching(/defenses-disable/) });
    expect(engine.setDefenses({ hold: { enabled: false } }, ADMIN('turn the hold off', 'defenses-disable'))).toMatchObject({ ok: true, disabled: ['hold'] });
    expect(engine.setDefenses({ hold: { maxHoldMs: 10 } }, ADMIN('invalid hold length'))).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(engine.setDefenses({ minLeadS: 5, toxicity: { surchargeEdge: 0.06 } }, ADMIN('lead five, surcharge six'))).toMatchObject({ ok: true });
    const configs = journal.records<EngineEvent>().filter(e => e.type === 'config' && e.target === 'defenses');
    expect(configs).toHaveLength(3);
    const rebuilt = makeEngine({ records: journal.records<EngineEvent>(), journal: new MemoryJournal() }).engine;
    expect(rebuilt.defenses).toEqual(engine.defenses);
    expect(rebuilt.defensesView()).toMatchObject({ minLeadS: 5, hold: { enabled: false }, toxicity: { flowEdge: 0.06 } });
  });
});

describe('reference feed guard (SPEC-10 §7)', () => {
  it('stops standing quotes when the sub-second reference moves beyond moveSigma·σ·√Δt, and ignores small moves', () => {
    const s = setup(defenses({ reference: { moveSigma: 4 } }));
    const q = s.quotes.find(x => x.window >= 3)!;
    const spot = Number(FUTURE.get(T0)!);
    expect(s.engine.observeReference('btc-usd', spot * (1 + q.sigma), T0 * 1000 + 700)).toBe(false);
    expect(s.engine.quoteStands(q)).toBe(true);
    expect(s.engine.observeReference('btc-usd', spot * (1 + 10 * q.sigma), T0 * 1000 + 800)).toBe(true);
    expect(s.engine.quoteStands(q)).toBe(false);
    expect(s.engine.placeBet(intent(s.account, q))).toMatchObject({ reason: 'QUOTE_EXPIRED' });
    expect(s.engine.referenceInvalidations).toBe(1);
    deliver(s.engine, 'btc-usd', T0 + 1, FUTURE.get(T0 + 1)!);
    expect(s.engine.quoteStands(offered(s.engine).find(x => x.window >= 3)!)).toBe(true);
    const off = setup(DEFENSES_OFF);
    expect(off.engine.observeReference('btc-usd', spot * 2, T0 * 1000 + 800)).toBe(false);
  });
});
