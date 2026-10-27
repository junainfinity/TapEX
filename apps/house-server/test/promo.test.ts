import { describe, expect, it } from 'vitest';
import { DEFAULT_DEFENSES, DEFAULT_EDGE_SCHEDULE, DEFAULT_PROMO, DEFENSES_OFF, X100_EPSILON, freezeDefenses, freezePromo, type PromoConfig, type PromoTierConfig } from '@maya/house';
import { quotesView } from '../src/api/views.js';
import { PROMO_GUARD_ACTOR, PROMO_MIGRATION_ACTOR, type HouseEngine } from '../src/engine/engine.js';
import type { EngineEvent, EngineNotice } from '../src/engine/types.js';
import { MemoryJournal } from '../src/ledger/journal.js';
import type { HouseQuote } from '../src/quotes/quote-book.js';
import { HISTORY, T0, deliver, makeEngine, offered, simPlayer, walk } from './helpers.js';

const ADMIN = (reason: string, confirm?: string) => ({ actor: 'admin', reason, ...(confirm ? { confirm } : {}) });
const P0 = HISTORY.get(T0 - 1)!;
const PATH = walk({ t0: T0, seconds: 1200, start: Number(P0), sigma: 3e-5, seed: 77 });

function promoWith(tiers: Partial<Record<'launch' | 'growth' | 'scale', Partial<PromoTierConfig>>>, extra: Partial<PromoConfig> = {}): PromoConfig {
  return freezePromo({ ...DEFAULT_PROMO, ...extra, tiers: DEFAULT_PROMO.tiers.map(t => ({ ...t, ...(tiers[t.id] ?? {}) })) });
}
const standardQuotes = (engine: HouseEngine) => (engine.quotes.latestVariant('btc-usd', 'standard')?.quotes ?? []).filter((q): q is HouseQuote => q !== null);
const place = (engine: HouseEngine, requestId: string, account: string, q: HouseQuote, stakeCenti: string) =>
  engine.placeBet({ requestId, account, quoteId: q.quoteId, revision: q.revision, cellId: q.cellId, stakeCenti });

describe('promo tiers in the engine (SPEC-12)', () => {
  it('publishes a boosted main grid at −lossBudget with the minimum win, a standard grid for capped accounts, and stamps the tier on every quote', () => {
    const { engine } = makeEngine({ config: { promo: DEFAULT_PROMO } });
    expect(engine.promoMode).toBe(true);
    deliver(engine, 'btc-usd', T0, P0);
    const main = engine.latestGrid('btc-usd')!;
    expect(main.grid.edge).toMatchObject({ tier: 'launch', boosted: true, edge: -0.1, phase: 'launch' });
    const boosted = offered(engine);
    expect(boosted.length).toBeGreaterThan(5);
    for (const q of boosted) {
      expect(q).toMatchObject({ tier: 'launch', boosted: true, variant: 'main', policyEdge: -0.1, guardAdjust: 0, phase: 'launch' });
      expect(q.quoteId).not.toMatch(/\.[sf]$/);
      expect(q.x100).toBeGreaterThanOrEqual(125);
      expect(q.x100).toBe(Math.floor((100 * 1.1) / q.q + X100_EPSILON));
      expect((q.p * q.x100) / 100).toBeLessThanOrEqual(1.1 + 1e-9);
    }
    const std = engine.quotes.latestVariant('btc-usd', 'standard')!;
    expect(std.grid.edge).toMatchObject({ tier: 'launch', boosted: false, edge: 0.08, phase: 'standard' });
    for (const q of standardQuotes(engine)) { expect(q).toMatchObject({ tier: 'launch', boosted: false, variant: 'standard', policyEdge: 0.08 }); expect(q.quoteId).toMatch(/\.s$/); }
    // The same square pays more at boosted odds, and quote identity differs per variant.
    for (const q of boosted) { const s = standardQuotes(engine).find(x => x.cellId === q.cellId); if (s) { expect(q.x100).toBeGreaterThan(s.x100); expect(s.quoteId).toBe(`${q.quoteId}.s`); } }
    expect(engine.currentPricing()).toMatchObject({ tier: 'launch', boosted: true, baseEdge: -0.1, minWinX100: 125 });
    expect(engine.launchView()).toEqual({ enabled: true, active: true, edge: -0.1, untilPlayers: 10_000, standardEdge: 0.08 });
    expect(engine.promoView()).toEqual({ tier: 'launch', label: 'Launch boost', minWinX100: 125, progress: { players: 0, untilPlayers: 10_000, turnoverCenti: '0', untilTurnoverCenti: '100000000' }, account: null });
  });

  it('caps each account\'s boosted turnover per tier: past the cap it is quoted from the standard grid, and the accepted odds are always the quoted ones', () => {
    const { engine } = makeEngine({ config: { promo: promoWith({ launch: { perAccountBoostCapCenti: '5000' } }) } });
    const a = simPlayer(engine), b = simPlayer(engine);
    deliver(engine, 'btc-usd', T0, P0);
    const quotes = offered(engine).filter(q => q.window >= 1 && q.x100 < 300);
    const [q1, q2] = [quotes[0]!, quotes[1] ?? quotes[0]!];
    const r1 = place(engine, 'cap-1', a, q1, '3000');
    expect(r1).toMatchObject({ status: 'accepted', leg: { x100: q1.x100, tier: 'launch', boosted: true, phase: 'launch', guardAdjust: 0, policyEdge: -0.1 } });
    expect(engine.boostRemaining(a)).toBe(2000n);
    expect(engine.promoView(a).account).toEqual({ boostRemainingCenti: '2000' });
    const over = place(engine, 'cap-2', a, q2, '2500');
    expect(over).toMatchObject({ status: 'rejected', reason: 'STAKE_NOT_ALLOWED', message: expect.stringMatching(/remaining launch promo allowance of 2000 Centi/) });
    expect(place(engine, 'cap-2', a, q2, '2500')).toEqual(over); // idempotent rejection
    expect(place(engine, 'cap-3', a, q2, '2000')).toMatchObject({ status: 'accepted', leg: { tier: 'launch', boosted: true } });
    expect(place(engine, 'cap-3', a, q2, '2100')).toMatchObject({ status: 'rejected', reason: 'REQUEST_CONFLICT' });
    expect(engine.boostRemaining(a)).toBe(0n);
    expect(engine.accountVariant(a)).toBe('standard');
    expect(engine.accountVariant(b)).toBe('main');
    expect(engine.gridFor(a, 'btc-usd')!.variant).toBe('standard');
    expect(place(engine, 'cap-4', a, q1, '10')).toMatchObject({ status: 'rejected', reason: 'STAKE_NOT_ALLOWED', message: expect.stringMatching(/used up/) });
    const sq = standardQuotes(engine).find(q => q.window >= 1)!;
    expect(place(engine, 'cap-5', a, sq, '5000')).toMatchObject({ status: 'accepted', leg: { x100: sq.x100, tier: 'launch', boosted: false, phase: 'standard', policyEdge: 0.08 } });
    expect(engine.turnover).toBe(10_000n);
    expect(engine.promoLedger.book('launch')).toMatchObject({ turnover: 10_000n, boostedTurnover: 5_000n, bets: 3, boostedBets: 2 });
    expect(engine.promoLedger.boostUsed('launch', a)).toBe(5_000n);
    // The player-facing views follow the account: standard odds for the capped account, boosted with a capped max stake for the other.
    const va = quotesView(engine, 'btc-usd', a), vb = quotesView(engine, 'btc-usd', b);
    expect(va).toMatchObject({ tier: 'launch', pricing: 'standard', variant: 'standard', boostRemainingCenti: null, minWinX100: null });
    expect(vb).toMatchObject({ tier: 'launch', pricing: 'boosted', variant: 'main', boostRemainingCenti: '5000', minWinX100: 125 });
    for (const c of vb['cells'] as { available: boolean; maxStakeCenti?: string }[]) if (c.available) expect(BigInt(c.maxStakeCenti!)).toBeLessThanOrEqual(5000n);
    expect(engine.promoLedger.accountCounts('launch', 5000n, 10n)).toEqual({ boosted: 1, capped: 1 });
  });

  it('moves launch → growth → scale → standard on turnover or players, logs each transition, and keeps issued quotes immutable across a tier change', () => {
    const promo = promoWith({ launch: { untilPlayers: 3, untilTurnoverCenti: '10000' }, growth: { untilPlayers: 5, untilTurnoverCenti: '1000000' }, scale: { untilPlayers: 7, untilTurnoverCenti: '100000000' } });
    const { engine } = makeEngine({ config: { promo } });
    const alerts: string[] = [];
    engine.on((n: EngineNotice) => { if (n.type === 'alert' && n.data.code) alerts.push(n.data.code); });
    const a = simPlayer(engine);
    deliver(engine, 'btc-usd', T0, P0);
    const launchQuotes = offered(engine).filter(q => q.window >= 1);
    expect(launchQuotes[0]!.tier).toBe('launch');
    expect(place(engine, 'tier-1', a, launchQuotes[0]!, '10000')).toMatchObject({ status: 'accepted', leg: { tier: 'launch' } });
    expect(engine.currentTier().tier).toBe('growth'); // 100 OPEN of turnover reached
    // A launch quote issued before the change is still accepted at its launch terms.
    const late = place(engine, 'tier-2', a, launchQuotes[1]!, '500');
    expect(late).toMatchObject({ status: 'accepted', leg: { tier: 'launch', boosted: true, x100: launchQuotes[1]!.x100, policyEdge: -0.1 } });
    deliver(engine, 'btc-usd', T0 + 1, PATH.get(T0 + 1)!);
    expect(engine.latestGrid('btc-usd')!.grid.edge).toMatchObject({ tier: 'growth', boosted: true, edge: -0.05 });
    for (const q of offered(engine)) { expect(q.x100).toBeGreaterThanOrEqual(110); expect(q.tier).toBe('growth'); }
    simPlayer(engine); simPlayer(engine); simPlayer(engine); simPlayer(engine); // 5 players → scale
    expect(engine.currentTier().tier).toBe('scale');
    deliver(engine, 'btc-usd', T0 + 2, PATH.get(T0 + 2)!);
    expect(engine.latestGrid('btc-usd')!.grid.edge).toMatchObject({ tier: 'scale', boosted: true, edge: -0.01 });
    simPlayer(engine); simPlayer(engine); // 7 → standard
    deliver(engine, 'btc-usd', T0 + 3, PATH.get(T0 + 3)!);
    expect(engine.latestGrid('btc-usd')!.grid.edge).toMatchObject({ tier: 'standard', boosted: false, edge: 0.08 });
    expect(engine.quotes.latestVariant('btc-usd', 'standard')).toBeUndefined();
    for (const q of offered(engine)) expect(q).toMatchObject({ tier: 'standard', boosted: false });
    expect(engine.tierLog.map(x => [x.tier, x.players, x.turnoverCenti])).toEqual([['launch', 0, '0'], ['growth', 1, '10000'], ['scale', 5, '10500'], ['standard', 7, '10500']]);
    expect(engine.tierLog[1]!.cause).toMatch(/turnover reached/);
    expect(engine.tierLog[2]!.cause).toMatch(/5 registered players reached/);
    expect(alerts.filter(c => c === 'PROMO_TIER_CHANGED')).toHaveLength(3);
    expect(engine.promoView()).toMatchObject({ tier: 'standard', label: 'Standard odds', minWinX100: 101, progress: { untilPlayers: null, untilTurnoverCenti: null } });
    expect(engine.launchView()).toMatchObject({ enabled: true, active: false, edge: 0.08 });
    expect(engine.phaseLog.map(p => p.phase)).toEqual(['launch', 'standard']);
  });

  it('never gives flagged accounts boosted odds', () => {
    const { engine } = makeEngine({ config: { promo: DEFAULT_PROMO, schedule: { ...DEFAULT_EDGE_SCHEDULE, flowEdge: 0.05 } } });
    const a = simPlayer(engine);
    expect(engine.setPlayerFlag(a, 'flag', ADMIN('suspicious flow in test')).ok).toBe(true);
    deliver(engine, 'btc-usd', T0, P0);
    expect(engine.accountVariant(a)).toBe('flagged');
    const flagged = engine.latestGrid('btc-usd', true)!;
    expect(flagged.grid.edge).toMatchObject({ tier: 'launch', boosted: false, edge: 0.13, flow: 0.05 });
    const boosted = offered(engine).find(q => q.window >= 1)!;
    expect(place(engine, 'flag-1', a, boosted, '1000')).toMatchObject({ status: 'rejected', reason: 'QUOTE_CHANGED' });
    const fq = offered(engine, 'btc-usd', true).find(q => q.window >= 1)!;
    expect(place(engine, 'flag-2', a, fq, '1000')).toMatchObject({ status: 'accepted', leg: { flagged: true, boosted: false, tier: 'launch' } });
    expect(engine.promoView(a).account).toEqual({ boostRemainingCenti: null });
    // Without a surcharge a flagged account is quoted from the standard grid and still refused boosted odds.
    const { engine: e2 } = makeEngine({ config: { promo: DEFAULT_PROMO } });
    const b = simPlayer(e2);
    e2.setPlayerFlag(b, 'flag', ADMIN('suspicious flow in test'));
    deliver(e2, 'btc-usd', T0, P0);
    expect(e2.accountVariant(b)).toBe('standard');
    expect(place(e2, 'flag-3', b, offered(e2).find(q => q.window >= 1)!, '1000')).toMatchObject({ status: 'rejected', reason: 'QUOTE_CHANGED', message: expect.stringMatching(/standard odds/) });
  });

  it('reserves boosted stake of held placements against the cap and accepts them at the original quote', () => {
    const defenses = freezeDefenses({ ...DEFENSES_OFF, hold: { ...DEFAULT_DEFENSES.hold, enabled: true, tolRel: 5, newAccountHolds: 0 } });
    const { engine } = makeEngine({ config: { promo: promoWith({ launch: { perAccountBoostCapCenti: '5000' } }), defenses } });
    const a = simPlayer(engine);
    deliver(engine, 'btc-usd', T0, P0);
    const [q1, q2] = offered(engine).filter(q => q.window >= 2 && q.x100 < 300); // low liability: stays inside the cell limit
    expect(place(engine, 'hold-1', a, q1!, '3000')).toMatchObject({ status: 'pending' });
    expect(engine.boostRemaining(a)).toBe(2000n);
    expect(place(engine, 'hold-2', a, q2!, '3000')).toMatchObject({ status: 'rejected', reason: 'STAKE_NOT_ALLOWED' });
    expect(place(engine, 'hold-3', a, q2!, '2000')).toMatchObject({ status: 'pending' });
    expect(engine.boostRemaining(a)).toBe(0n);
    deliver(engine, 'btc-usd', T0 + 1, PATH.get(T0 + 1)!);
    expect(engine.receiptFor('hold-1')).toMatchObject({ status: 'accepted', leg: { x100: q1!.x100, boosted: true, tier: 'launch' } });
    expect(engine.receiptFor('hold-3')).toMatchObject({ status: 'accepted', leg: { x100: q2!.x100, boosted: true } });
    expect(engine.promoLedger.boostUsed('launch', a)).toBe(5000n);
    expect(engine.boostRemaining(a)).toBe(0n);
  });
});

/** A path that jumps into band `bandIndex` right after T0 and stays there (the square is touched: the player wins). */
function winningPath(bandIndex: number, seconds: number): Map<number, string> {
  const target = ((bandIndex + 0.5) * 10).toFixed(2);
  const out = new Map<number, string>();
  for (let t = T0 + 1; t <= T0 + seconds; t++) out.set(t, target);
  return out;
}

describe('promo budget guard and admin (SPEC-12 §3, §6)', () => {
  const guardPromo = promoWith({ launch: { lossBudget: 0, minWinX100: 101 } }, { guard: { ...DEFAULT_PROMO.guard, evalEveryMs: 60_000, minTurnoverCenti: '0', tripMarginRel: 0, tripZ: 0, zGate: 0, deadband: 0 } });

  function tripScenario(): { engine: HouseEngine; journal: MemoryJournal; alerts: { code?: string; level: string }[]; player: string } {
    const journal = new MemoryJournal();
    const { engine } = makeEngine({ journal, config: { promo: guardPromo } });
    const alerts: { code?: string; level: string }[] = [];
    engine.on((n: EngineNotice) => { if (n.type === 'alert') alerts.push(n.data); });
    const player = simPlayer(engine);
    deliver(engine, 'btc-usd', T0, P0);
    const q = offered(engine).filter(x => x.window === 1 && x.bandOffset >= 2).sort((x, y) => y.x100 - x.x100)[0]!;
    expect(q).toBeDefined();
    expect(place(engine, 'guard-1', player, q, '1000')).toMatchObject({ status: 'accepted', leg: { boosted: true, tier: 'launch' } });
    const path = winningPath(q.bandIndex, 90);
    for (let t = T0 + 1; t <= T0 + 90; t++) deliver(engine, 'btc-usd', t, path.get(t)!);
    return { engine, journal, alerts, player };
  }

  it('trips the budget breaker when the realized loss exceeds the budget, falls back to standard pricing for new quotes, and resumes only by admin with confirmation', () => {
    const { engine, journal, alerts } = tripScenario();
    expect(engine.settledLegs().find(l => l.requestId === 'guard-1')?.status).toBe('won');
    expect(engine.promoLedger.guard('launch')).toMatchObject({ tripped: true });
    const guardRecords = journal.records<EngineEvent>().filter(r => r.type === 'promo-guard');
    expect(guardRecords).toHaveLength(1);
    expect(guardRecords[0]).toMatchObject({ change: { tier: 'launch', action: 'trip', before: { tripped: false }, after: { tripped: true } }, actor: PROMO_GUARD_ACTOR });
    expect(engine.auditLog(50).find(a => a.action === 'promo-guard-trip')).toMatchObject({ kind: 'system', actor: PROMO_GUARD_ACTOR, target: 'launch' });
    expect(alerts.some(a => a.code === 'PROMO_BUDGET_BREAKER' && a.level === 'critical')).toBe(true);
    // New quotes: the tier is still launch, but priced at the standard edge; the public view says the boost is paused.
    expect(engine.currentPricing()).toMatchObject({ tier: 'launch', boosted: false, baseEdge: 0.08, fallback: 'budget-breaker' });
    expect(engine.latestGrid('btc-usd')!.grid.edge).toMatchObject({ tier: 'launch', boosted: false, edge: 0.08 });
    expect(engine.promoView()).toMatchObject({ tier: 'launch', label: 'Launch boost (paused)', minWinX100: 101 });
    expect(engine.promoBreakers()).toMatchObject([{ id: 'promoBudget', state: 'tripped', tier: 'launch' }]);
    expect((engine.promoAdminView()['guard'] as { tripped: string[] }).tripped).toEqual(['launch']);
    // Resume: confirmation required, journaled, then boosted pricing returns on the next grid.
    expect(engine.resumePromo(undefined, ADMIN('resume after review'))).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    expect(engine.resumePromo('bonus', ADMIN('resume after review', 'promo-resume'))).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(engine.resumePromo('growth', ADMIN('resume after review', 'promo-resume'))).toMatchObject({ ok: false, code: 'NOT_TRIPPED' });
    const resumed = engine.resumePromo(undefined, ADMIN('resume after review', 'promo-resume'));
    expect(resumed).toMatchObject({ ok: true, action: 'promo-resume', before: { tier: 'launch', guard: { tripped: true } }, after: { tier: 'launch', guard: { tripped: false } } });
    deliver(engine, 'btc-usd', T0 + 91, PATH.get(T0 + 91)!);
    expect(engine.latestGrid('btc-usd')!.grid.edge).toMatchObject({ tier: 'launch', boosted: true });
    expect(journal.records<EngineEvent>().filter(r => r.type === 'promo-guard').map(r => (r as Extract<EngineEvent, { type: 'promo-guard' }>).change.action)).toEqual(['trip', 'resume']);
    expect(engine.promoBreakers()).toEqual([]);
  });

  it('lists a budget breaker only while its tier is the one being priced', () => {
    const { engine } = tripScenario();
    expect(engine.promoBreakers()).toHaveLength(1);
    expect(engine.endPromoTier(ADMIN('move past the tripped launch tier', 'promo-end-tier'))).toMatchObject({ ok: true, after: { tier: 'growth' } });
    expect(engine.promoBreakers()).toEqual([]); // launch stays tripped in the ledger but prices nothing now
    expect((engine.promoAdminView()['guard'] as { tripped: string[] }).tripped).toEqual(['launch']);
    expect(engine.currentPricing()).toMatchObject({ tier: 'growth', boosted: true });
  });

  it('journals every admin change with before/after, reason and actor; confirmation guards edge moves; the legacy launch endpoint is replaced', () => {
    const { engine } = makeEngine({ config: { promo: DEFAULT_PROMO } });
    expect(engine.setLaunch({ enabled: false }, ADMIN('end the old boost', 'edge-change'))).toMatchObject({ ok: false, status: 409, code: 'LAUNCH_REPLACED' });
    expect(engine.setPromo({ tiers: { launch: { minWinX100: 130 } } }, ADMIN('raise the launch minimum win'))).toMatchObject({ ok: true, action: 'promo', before: { tier: 'launch' }, after: { tier: 'launch' } });
    expect(engine.promo!.tiers[0]!.minWinX100).toBe(130);
    expect(engine.setPromo({ tiers: { launch: { lossBudget: 0.05 } } }, ADMIN('halve the launch budget'))).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    expect(engine.setPromo({ tiers: { launch: { lossBudget: 0.05 } } }, ADMIN('halve the launch budget', 'edge-change'))).toMatchObject({ ok: true });
    expect(engine.setPromo({ tiers: { launch: { lossBudget: 0.05 } } }, ADMIN('same again for test'))).toMatchObject({ ok: false, code: 'NO_CHANGE' });
    expect(engine.setPromo({ tiers: { launch: { untilPlayers: 500_000 } } }, ADMIN('extend past growth'))).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(engine.setPromo({ bogus: 1 } as never, ADMIN('unknown field test'))).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(engine.endPromoTier(ADMIN('launch is over'))).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    expect(engine.endPromoTier(ADMIN('launch is over', 'promo-end-tier'))).toMatchObject({ ok: true, action: 'promo-end-tier', before: { tier: 'launch' }, after: { tier: 'growth' } });
    expect(engine.auditLog(1)[0]).toMatchObject({ action: 'promo-end-tier', target: 'launch' });
    expect(engine.currentTier().tier).toBe('growth');
    // Launch now has the same 5 % budget as growth: reopening it moves no edge, so no confirmation is needed.
    expect(engine.setPromo({ tiers: { launch: { enabled: true } } }, ADMIN('reopen launch (extend)'))).toMatchObject({ ok: true, after: { tier: 'launch' } });
    expect(engine.setPromo({ enabled: false }, ADMIN('disable the promo'))).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    expect(engine.setPromo({ enabled: false }, ADMIN('disable the promo', 'edge-change'))).toMatchObject({ ok: true, after: { tier: 'standard' } });
    expect(engine.endPromoTier(ADMIN('nothing to end', 'promo-end-tier'))).toMatchObject({ ok: false, code: 'NO_PROMO_TIER' });
    const audit = engine.auditLog(50).filter(a => a.action.startsWith('promo'));
    expect(audit.map(a => a.action)).toEqual(['promo', 'promo', 'promo-end-tier', 'promo', 'promo']); // newest first
    expect(audit.every(a => a.kind === 'admin' && a.actor === 'admin' && a.reason && a.before !== undefined && a.after !== undefined)).toBe(true);
    expect(engine.tierLog.map(t => [t.tier, t.cause])).toEqual([['launch', 'start'], ['growth', 'ended early by admin'], ['launch', 'configuration change'], ['standard', 'promo disabled']]);
  });

  it('rebuilds promo state exactly from the journal (turnover, per-tier books, caps, guard, tier log)', () => {
    const { engine, journal } = tripScenario();
    engine.setPromo({ tiers: { growth: { minWinX100: 115 } } }, ADMIN('tune growth minimum'));
    engine.resumePromo('launch', ADMIN('resume after review', 'promo-resume'));
    const before = engine.stateSnapshot() as Record<string, unknown>;
    const rebuilt = makeEngine({ records: journal.records<EngineEvent>(), journal: new MemoryJournal() }).engine;
    const { seq: _a, ...x } = rebuilt.stateSnapshot() as Record<string, unknown>;
    const { seq: _b, ...y } = before;
    expect(x).toEqual(y);
    expect(rebuilt.promoMode).toBe(true);
    expect(rebuilt.turnover).toBe(engine.turnover);
    expect(rebuilt.promoLedger.guard('launch')).toEqual(engine.promoLedger.guard('launch'));
    expect(rebuilt.promo!.tiers[1]!.minWinX100).toBe(115);
  });

  it('migrates a journal written with the single launch boost: the configured tiers replace it, journaled once with an audit entry', () => {
    const journal = new MemoryJournal();
    const { engine: legacy } = makeEngine({ journal });
    expect(legacy.promoMode).toBe(false);
    const a = simPlayer(legacy);
    deliver(legacy, 'btc-usd', T0, P0);
    const q = offered(legacy).find(x => x.window >= 1)!;
    expect(q.tier).toBeUndefined();
    expect(place(legacy, 'legacy-1', a, q, '5000')).toMatchObject({ status: 'accepted', leg: { phase: 'launch', edge: 0.03 } });
    const records = journal.records<EngineEvent>();
    const j2 = new MemoryJournal();
    const { engine: migrated } = makeEngine({ records, journal: j2, config: { promo: DEFAULT_PROMO } });
    expect(migrated.promoMode).toBe(true);
    expect(migrated.turnover).toBe(5000n);
    expect(migrated.registeredPlayers).toBe(1);
    const added = j2.records<EngineEvent>();
    expect(added.filter(r => r.type === 'config' && r.target === 'promo')).toHaveLength(1);
    const audit = migrated.auditLog(10).find(x => x.action === 'promo-migrated')!;
    expect(audit).toMatchObject({ kind: 'system', actor: PROMO_MIGRATION_ACTOR, before: { launch: { enabled: true, edge: 0.03, untilPlayers: 10_000 } } });
    expect(audit.reason).toMatch(/5000 Centi of turnover/);
    expect(migrated.currentTier().tier).toBe('launch');
    expect(migrated.legView('L1')).toMatchObject({ phase: 'launch', edge: 0.03, status: 'open' });
    // Reopening the migrated journal does not migrate again.
    const j3 = new MemoryJournal();
    makeEngine({ records: [...records, ...added], journal: j3, config: { promo: DEFAULT_PROMO } });
    expect(j3.records<EngineEvent>().filter(r => r.type === 'config')).toHaveLength(0);
    // A legacy engine that opens a promo journal keeps the journal's tiers.
    const { engine: reopened } = makeEngine({ records: [...records, ...added], journal: new MemoryJournal() });
    expect(reopened.promoMode).toBe(true);
  });
});
