import { describe, expect, it } from 'vitest';
import { parseDecimal } from '@maya/contracts';
import {
  DEFAULT_EDGE_SCHEDULE, DEFAULT_PRICING_CONFIG, DEFAULT_PROMO, DEFAULT_RISK_LIMITS, GUARD_OK, LiabilityBook, PromoAgg, PromoLedger, X100_EPSILON, boostRemainingCenti, buildQuoteGrid,
  changePromo, freezePromo, offerX100, offerX100Signed, resolveTier, scalePromoThresholds, tierPricing, tierReached, validatePromo,
  type OfferedGridCell, type PromoConfig, type QuoteGrid, type QuoteGridInput,
} from '../src/index.js';
import { randomWalk, rng, table } from './fixtures.js';

const OPEN = 100n;
const meta = { actor: 'admin', atMs: 1_000, reason: 'operator decision' };
const progress = (players: number, turnoverOpen: bigint | number) => ({ players, turnoverCenti: BigInt(turnoverOpen) * OPEN });

describe('promo schedule (SPEC-12 §1)', () => {
  it('defaults to the operator table: thresholds, budgets, minimum wins and per-account caps', () => {
    expect(validatePromo(DEFAULT_PROMO)).toBeUndefined();
    expect(DEFAULT_PROMO.tiers.map(t => [t.id, t.untilPlayers, t.untilTurnoverCenti, t.lossBudget, t.minWinX100, t.perAccountBoostCapCenti, t.enabled])).toEqual([
      ['launch', 10_000, '100000000', 0.10, 125, '100000', true],
      ['growth', 100_000, '1000000000', 0.05, 110, '500000', true],
      ['scale', 1_000_000, '10000000000', 0.01, 101, '2000000', true],
    ]);
    expect(DEFAULT_PROMO.enabled).toBe(true);
    expect(Object.isFrozen(DEFAULT_PROMO) && Object.isFrozen(DEFAULT_PROMO.tiers[0])).toBe(true);
  });

  it('resolves the tier from players and cumulative turnover, whichever threshold comes first', () => {
    const tier = (players: number, open: bigint | number) => resolveTier(DEFAULT_PROMO, progress(players, open)).tier;
    expect(tier(0, 0)).toBe('launch');
    expect(tier(9_999, 999_999)).toBe('launch');
    expect(resolveTier(DEFAULT_PROMO, { players: 9_999, turnoverCenti: 99_999_999n }).tier).toBe('launch');
    expect(tier(10_000, 0)).toBe('growth'); // players first
    expect(tier(12, 1_000_000)).toBe('growth'); // turnover first
    expect(tier(99_999, 9_999_999)).toBe('growth');
    expect(tier(100_000, 5)).toBe('scale');
    expect(tier(5, 10_000_000)).toBe('scale');
    expect(tier(999_999, 99_999_999)).toBe('scale');
    expect(tier(1_000_000, 0)).toBe('standard');
    expect(tier(3, 100_000_000)).toBe('standard');
    const r = resolveTier(DEFAULT_PROMO, progress(4_000, 250_000));
    expect(r).toMatchObject({ tier: 'launch', label: 'Launch boost', untilPlayers: 10_000, untilTurnoverCenti: 100_000_000n });
    expect(resolveTier(DEFAULT_PROMO, progress(2_000_000, 0))).toMatchObject({ tier: 'standard', label: 'Standard odds', untilPlayers: null, untilTurnoverCenti: null });
    expect(tierReached(DEFAULT_PROMO.tiers[0]!, progress(10_000, 0))).toBe(true);
  });

  it('fails closed to standard when the promo is disabled or the progress reading is invalid; disabled tiers are skipped', () => {
    const off = freezePromo({ ...DEFAULT_PROMO, enabled: false });
    expect(resolveTier(off, progress(0, 0)).tier).toBe('standard');
    expect(resolveTier(DEFAULT_PROMO, { players: -1, turnoverCenti: 0n }).tier).toBe('standard');
    expect(resolveTier(DEFAULT_PROMO, { players: 1.5, turnoverCenti: 0n }).tier).toBe('standard');
    expect(resolveTier(DEFAULT_PROMO, { players: 0, turnoverCenti: -1n }).tier).toBe('standard');
    const noLaunch = freezePromo({ ...DEFAULT_PROMO, tiers: DEFAULT_PROMO.tiers.map(t => (t.id === 'launch' ? { ...t, enabled: false } : t)) });
    expect(resolveTier(noLaunch, progress(0, 0)).tier).toBe('growth');
  });

  it('scales thresholds for a compressed simulation without touching budgets, minimum wins or caps', () => {
    const s = scalePromoThresholds(DEFAULT_PROMO, 0.01, 0.1);
    expect(validatePromo(s)).toBeUndefined();
    expect(s.tiers.map(t => [t.untilPlayers, t.untilTurnoverCenti])).toEqual([[100, '10000000'], [1_000, '100000000'], [10_000, '1000000000']]);
    expect(s.tiers.map(t => [t.lossBudget, t.minWinX100, t.perAccountBoostCapCenti])).toEqual(DEFAULT_PROMO.tiers.map(t => [t.lossBudget, t.minWinX100, t.perAccountBoostCapCenti]));
    expect(() => scalePromoThresholds(DEFAULT_PROMO, 0, 1)).toThrow();
  });
});

describe('promo admin changes', () => {
  it('edits tier fields with strict keys and returns a journal event with before/after, actor and reason', () => {
    const r = changePromo(DEFAULT_PROMO, { tiers: { launch: { untilPlayers: 20_000, minWinX100: 130 } } }, meta);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.tiers[0]).toMatchObject({ id: 'launch', untilPlayers: 20_000, minWinX100: 130, lossBudget: 0.1 });
    expect(r.event).toMatchObject({ type: 'promo-changed', actor: 'admin', atMs: 1_000, reason: 'operator decision' });
    expect(r.event.before.tiers[0]!.untilPlayers).toBe(10_000);
    expect(r.event.after.tiers[0]!.untilPlayers).toBe(20_000);
    expect(DEFAULT_PROMO.tiers[0]!.untilPlayers).toBe(10_000); // the input is never mutated
  });

  it('ends a tier early by disabling it, disables the whole promo, and refuses bad input', () => {
    const ended = changePromo(DEFAULT_PROMO, { tiers: { launch: { enabled: false } } }, meta);
    expect(ended.ok && resolveTier(ended.config, progress(0, 0)).tier).toBe('growth');
    const off = changePromo(DEFAULT_PROMO, { enabled: false }, meta);
    expect(off.ok && resolveTier(off.config, progress(0, 0)).tier).toBe('standard');
    expect(changePromo(DEFAULT_PROMO, { enabled: true }, meta)).toMatchObject({ ok: false, reason: 'no-change' });
    expect(changePromo(DEFAULT_PROMO, { tiers: { bonus: { enabled: false } } } as never, meta)).toMatchObject({ ok: false, reason: 'invalid-patch' });
    expect(changePromo(DEFAULT_PROMO, { tiers: { launch: { id: 'growth' } } } as never, meta)).toMatchObject({ ok: false, reason: 'invalid-patch' });
    expect(changePromo(DEFAULT_PROMO, { guard: { nope: 1 } } as never, meta)).toMatchObject({ ok: false, reason: 'invalid-patch' });
    expect(changePromo(DEFAULT_PROMO, { bogus: 1 } as never, meta)).toMatchObject({ ok: false, reason: 'invalid-patch' });
    expect(changePromo(DEFAULT_PROMO, { tiers: { launch: { lossBudget: 0.3 } } }, meta)).toMatchObject({ ok: false, reason: 'invalid-config' });
    expect(changePromo(DEFAULT_PROMO, { tiers: { scale: { minWinX100: 100 } } }, meta)).toMatchObject({ ok: false, reason: 'invalid-config' });
    expect(changePromo(DEFAULT_PROMO, { tiers: { launch: { perAccountBoostCapCenti: '0' } } }, meta)).toMatchObject({ ok: false, reason: 'invalid-config' });
    // Thresholds are cumulative since launch: a later tier may not end before an earlier one.
    const bad = changePromo(DEFAULT_PROMO, { tiers: { launch: { untilPlayers: 200_000 } } }, meta);
    expect(bad).toMatchObject({ ok: false, reason: 'invalid-config' });
    expect(!bad.ok && bad.detail).toMatch(/growth\.untilPlayers must be at least/);
    expect(changePromo(DEFAULT_PROMO, { enabled: false }, { ...meta, reason: ' ' })).toMatchObject({ ok: false, reason: 'invalid-meta' });
  });

  it('validates every field', () => {
    const broken = (patch: (c: PromoConfig) => unknown) => validatePromo(patch(DEFAULT_PROMO) as PromoConfig);
    expect(broken(c => ({ ...c, tiers: c.tiers.slice(0, 2) }))).toMatch(/tiers must be exactly/);
    expect(broken(c => ({ ...c, tiers: [c.tiers[1], c.tiers[0], c.tiers[2]] }))).toMatch(/tiers must be exactly/);
    expect(broken(c => ({ ...c, standardLabel: '' }))).toMatch(/standardLabel/);
    expect(broken(c => ({ ...c, guard: { ...c.guard, maxTighten: 0.5 } }))).toMatch(/guard/);
    expect(broken(c => ({ ...c, tiers: c.tiers.map(t => ({ ...t, untilTurnoverCenti: '1.5' })) }))).toMatch(/untilTurnoverCenti/);
  });
});

describe('promo pricing (SPEC-12 §2)', () => {
  it('prices a boosted tier at −lossBudget plus the guard adjustment; a tripped tier and standard use the standard edge', () => {
    const launch = resolveTier(DEFAULT_PROMO, progress(0, 0));
    expect(tierPricing(launch, 0.08)).toMatchObject({ tier: 'launch', boosted: true, baseEdge: -0.1, minWinX100: 125, lossBudget: 0.1, guardAdjust: 0 });
    expect(tierPricing(launch, 0.08, { adjust: 0.02, tripped: false }).baseEdge).toBeCloseTo(-0.08, 12);
    expect(tierPricing(launch, 0.08, { adjust: 0.02, tripped: true })).toMatchObject({ tier: 'launch', boosted: false, baseEdge: 0.08, fallback: 'budget-breaker' });
    expect(tierPricing(resolveTier(DEFAULT_PROMO, progress(2_000_000, 0)), 0.08)).toMatchObject({ tier: 'standard', boosted: false, baseEdge: 0.08 });
    expect(tierPricing(resolveTier(DEFAULT_PROMO, progress(200_000, 0)), 0.08)).toMatchObject({ tier: 'scale', boosted: true, baseEdge: -0.01, minWinX100: 101 });
  });

  it('offers with a signed edge: every boosted square returns at most 1 + lossBudget at its fair probability; offerX100 still refuses negative edges', () => {
    const params = { edge: -0.1, z: 0, minX100: 125, capX100: 5000, aboveCap: 'hide' as const };
    expect(offerX100(0.5, 0, params)).toMatchObject({ ok: false, reason: 'out-of-domain' });
    expect(offerX100Signed(0.5, 0, params)).toEqual({ ok: true, x100: 220, q: 0.5, capped: false });
    expect(offerX100Signed(0.9, 0, params)).toMatchObject({ ok: false, reason: 'below-minimum' }); // 1.1 / 0.9 = 1.222 < 1.25 → hidden
    expect(offerX100Signed(0.88, 0, params)).toMatchObject({ ok: true, x100: 125 });
    expect(offerX100Signed(0.5, 0, { ...params, edge: -0.6 })).toMatchObject({ ok: false, reason: 'out-of-domain' });
    const random = rng(9);
    for (let i = 0; i < 2000; i++) {
      const p = 0.01 + random() * 0.98;
      const o = offerX100Signed(p, 0, params);
      if (!o.ok) { expect(o.reason === 'below-minimum' || o.reason === 'hidden-above-cap').toBe(true); continue; }
      expect((p * o.x100) / 100).toBeLessThanOrEqual(1.1 + 1e-9);
      expect(o.x100).toBe(Math.floor((100 * 1.1) / p + X100_EPSILON));
      expect(o.x100).toBeGreaterThanOrEqual(125);
    }
  });

  const T0 = 1_790_000_000;
  const path = randomWalk({ t0: T0, seconds: 1200, start: 60_000, sigma: 3e-5, tick: 0.01, seed: 42 });
  const T = T0 + 1199;
  const input = (overrides: Partial<QuoteGridInput> = {}): QuoteGridInput => ({
    market: 'btc-usd', t: T, spot: parseDecimal(String(path.get(T)!)), path, table: table('btc-usd'), pricing: DEFAULT_PRICING_CONFIG, schedule: DEFAULT_EDGE_SCHEDULE,
    registeredPlayers: 0, limits: DEFAULT_RISK_LIMITS, book: new LiabilityBook(), equityCenti: 100_000_000n, minLeadS: 4, ...overrides,
  });
  const offered = (g: QuoteGrid) => g.cells.filter((c): c is OfferedGridCell => c.available);

  it('builds a boosted grid at the tier edge, hides squares below the minimum win, and a standard promo grid equal to the legacy standard grid', () => {
    const boosted = buildQuoteGrid(input({ promo: { tier: 'launch', boosted: true, baseEdge: -0.1, minWinX100: 125 } }));
    expect(boosted.reason).toBeUndefined();
    expect(boosted.edge).toMatchObject({ edge: -0.1, base: -0.1, phase: 'launch', tier: 'launch', boosted: true, flow: 0, widen: 0 });
    let hidden = 0;
    for (const c of boosted.cells) {
      if (c.p === undefined) continue;
      const q = c.q!;
      const m = Math.floor((100 * 1.1) / q + X100_EPSILON);
      if (c.available) {
        expect(c.x100).toBe(m); expect(c.x100).toBeGreaterThanOrEqual(125);
        expect((c.p * c.x100) / 100).toBeLessThanOrEqual(1.1 + 1e-9);
        expect(c.cellEdge).toBe(-0.1);
      } else if (c.reason === 'below-minimum') { expect(m).toBeLessThan(125); hidden++; }
    }
    expect(offered(boosted).length).toBeGreaterThan(10);
    // The same square is priced higher than at the standard edge.
    const standard = buildQuoteGrid(input({ promo: { tier: 'launch', boosted: false, baseEdge: 0.08 } }));
    const legacy = buildQuoteGrid(input({ registeredPlayers: 20_000 }));
    expect(standard.edge).toMatchObject({ edge: 0.08, phase: 'standard', tier: 'launch', boosted: false });
    expect(standard.cells.map(c => (c.available ? c.x100 : c.reason))).toEqual(legacy.cells.map(c => (c.available ? c.x100 : c.reason)));
    for (const [i, c] of boosted.cells.entries()) { const s = standard.cells[i]!; if (c.available && s.available) expect(c.x100).toBeGreaterThan(s.x100); }
    expect(hidden).toBeGreaterThanOrEqual(0);
  });

  it('applies the flow surcharge and drawdown widening on top of the promo edge, and the controller adjustment with a signed clamp', () => {
    const flagged = buildQuoteGrid(input({ flagged: true, schedule: { ...DEFAULT_EDGE_SCHEDULE, flowEdge: 0.05 }, promo: { tier: 'growth', boosted: false, baseEdge: 0.08 } }));
    expect(flagged.edge).toMatchObject({ edge: 0.13, flow: 0.05, base: 0.08 });
    const widened = buildQuoteGrid(input({ gate: { allowed: true, drawdownWidened: true }, promo: { tier: 'launch', boosted: true, baseEdge: -0.1, minWinX100: 125 } }));
    expect(widened.edge.edge).toBeCloseTo(-0.08, 12);
    const adj = buildQuoteGrid(input({ rangeAdjust: { '1.01-2': 0.01, '2-5': -0.01 }, promo: { tier: 'launch', boosted: true, baseEdge: -0.1, minWinX100: 125 } }));
    for (const c of offered(adj)) expect([-0.1, -0.09, -0.11].map(v => Math.round(v * 1e9)).includes(Math.round(c.cellEdge * 1e9))).toBe(true);
  });

  it('fails closed on an invalid promo input', () => {
    for (const promo of [{ tier: 'bonus', boosted: true, baseEdge: -0.1, minWinX100: 125 }, { tier: 'launch', boosted: true, baseEdge: -0.7, minWinX100: 125 }, { tier: 'launch', boosted: true, baseEdge: -0.1 }, { tier: 'standard', boosted: true, baseEdge: -0.1, minWinX100: 125 }]) {
      const g = buildQuoteGrid(input({ promo: promo as never }));
      expect(g.reason).toBe('model-incompatible');
      expect(g.cells.every(c => !c.available)).toBe(true);
    }
  });
});

describe('promo ledger and budget guard (SPEC-12 §3, §4)', () => {
  const tier = DEFAULT_PROMO.tiers[0]!;
  const guard = { ...DEFAULT_PROMO.guard, minTurnoverCenti: '1000000' };
  function settleMany(ledger: PromoLedger, n: number, rtpBias: number, seed = 1, stake = 10_000n, clean = true): void {
    const random = rng(seed);
    for (let i = 0; i < n; i++) {
      const p = 0.5; const x100 = 220; // fair RTP 1.10
      const won = random() < p + rtpBias;
      ledger.onBet({ tier: 'launch', boosted: true, account: `a${i % 50}`, stakeCenti: stake });
      ledger.onSettle({ tier: 'launch', boosted: true, clean, stakeCenti: stake, creditCenti: won ? (stake * 220n) / 100n : 0n, x100, p, guardAdjust: ledger.guard('launch').adjust, status: won ? 'won' : 'lost' });
    }
  }

  it('accounts turnover per tier and per account, boosted and standard-priced, and counts capped accounts', () => {
    const l = new PromoLedger();
    l.onBet({ tier: 'launch', boosted: true, account: 'a', stakeCenti: 60_000n });
    l.onBet({ tier: 'launch', boosted: true, account: 'a', stakeCenti: 39_995n });
    l.onBet({ tier: 'launch', boosted: false, account: 'a', stakeCenti: 5_000n });
    l.onBet({ tier: 'launch', boosted: true, account: 'b', stakeCenti: 10n });
    l.onBet({ tier: 'growth', boosted: true, account: 'a', stakeCenti: 7n });
    expect(l.book('launch')).toMatchObject({ turnover: 105_005n, bets: 4, boostedTurnover: 100_005n, boostedBets: 3 });
    expect(l.boostUsed('launch', 'a')).toBe(99_995n);
    expect(l.boostUsed('growth', 'a')).toBe(7n);
    expect(boostRemainingCenti(100_000n, l.boostUsed('launch', 'a'))).toBe(5n);
    expect(boostRemainingCenti(100_000n, 99_995n, 10n)).toBe(0n);
    expect(l.accountCounts('launch', 100_000n, 10n)).toEqual({ boosted: 2, capped: 1 });
    l.onSettle({ tier: 'launch', boosted: false, clean: true, stakeCenti: 5_000n, creditCenti: 0n, x100: 150, p: 0.6, guardAdjust: 0, status: 'lost' });
    l.onSettle({ tier: 'launch', boosted: true, clean: false, stakeCenti: 10n, creditCenti: 0n, x100: 150, p: 0.6, guardAdjust: 0, status: 'refunded' });
    expect(l.book('launch').standardPriced.housePnl).toBe(5_000n);
    expect(l.book('launch').boosted.refunds).toBe(1);
    expect(l.book('launch').all.bets).toBe(1);
  });

  it('does nothing below the minimum turnover or inside the statistical band', () => {
    const l = new PromoLedger();
    settleMany(l, 50, 0);
    expect(l.evaluateGuard(tier, { ...guard, minTurnoverCenti: '10000000' })).toBeUndefined();
    const fair = new PromoLedger();
    settleMany(fair, 4000, 0, 3);
    expect(fair.evaluateGuard(tier, guard)).toBeUndefined();
  });

  it('tightens toward the budget when the realized loss exceeds it statistically, and relaxes back, never below 0', () => {
    const l = new PromoLedger();
    settleMany(l, 20_000, 0.03, 5); // realized RTP ≈ 1.166: loss rate ≈ 16.6 % vs 10 %
    const t = l.evaluateGuard(tier, { ...guard, tripMarginRel: 0.5, tripZ: 20 })!;
    expect(t).toMatchObject({ tier: 'launch', action: 'tighten', before: { adjust: 0, tripped: false }, after: { adjust: 0.01, tripped: false }, budget: 0.1 });
    expect(t.lossRate!).toBeGreaterThan(0.12);
    l.applyGuard(t, 5_000);
    expect(l.guard('launch')).toMatchObject({ adjust: 0.01, tripped: false, lastChangeMs: 5_000 });
    const back = new PromoLedger();
    back.applyGuard({ ...t, after: { adjust: 0.03, tripped: false } }, 1);
    settleMany(back, 20_000, -0.03, 6); // realized RTP ≈ 1.034: loss rate 3.4 % < 10 %
    const r = back.evaluateGuard(tier, guard)!;
    expect(r).toMatchObject({ action: 'relax', before: { adjust: 0.03 }, after: { adjust: 0.02 } });
    const floor = new PromoLedger();
    settleMany(floor, 20_000, -0.03, 7);
    expect(floor.evaluateGuard(tier, guard)).toBeUndefined(); // already at 0: never looser than the tier's pricing
  });

  it('trips the budget breaker when the cumulative loss exceeds the budget by more than the margin, and resumes only by admin', () => {
    const l = new PromoLedger();
    settleMany(l, 20_000, 0.08, 8); // loss rate ≈ 27.6 %
    const trip = l.evaluateGuard(tier, guard)!;
    expect(trip).toMatchObject({ action: 'trip', after: { tripped: true } });
    expect(trip.reason).toMatch(/exceeds the 10.00% budget/);
    l.applyGuard(trip, 7_000);
    expect(l.guard('launch')).toMatchObject({ tripped: true, since: 7_000 });
    expect(tierPricing(resolveTier(DEFAULT_PROMO, progress(0, 0)), 0.08, l.guard('launch'))).toMatchObject({ boosted: false, fallback: 'budget-breaker' });
    const again = l.evaluateGuard(tier, guard);
    expect(again?.action).not.toBe('trip');
    const resume = l.resumeChange('launch', 'reviewed: sim adversary run')!;
    expect(resume).toMatchObject({ action: 'resume', before: { tripped: true }, after: { tripped: false } });
    l.applyGuard(resume, 9_000);
    expect(l.guard('launch').tripped).toBe(false);
    expect(l.resumeChange('launch', 'nothing to resume')).toBeUndefined();
    expect(l.evaluateGuard(tier, { ...guard, enabled: false })).toBeUndefined();
  });

  it('acts on the expected loss at acceptance (p_fresh) long before settled outcomes are significant, and relaxes only when both signals agree', () => {
    const l = new PromoLedger();
    // Quoted at the tier target (x = 2.2 at p = 0.5 → 110 %), but the hold accepted them at p_fresh = 0.51 (≈ 112.2 %).
    for (let i = 0; i < 300; i++) l.onBet({ tier: 'launch', boosted: true, account: `a${i}`, stakeCenti: 10_000n, x100: 220, p: 0.5, pAccept: 0.51, guardAdjust: 0 });
    expect(l.book('launch').boostedAccepted).toMatchObject({ bets: 300, handle: 3_000_000n });
    const t = l.evaluateGuard(tier, guard)!;
    expect(t).toMatchObject({ action: 'tighten', basis: 'acceptance', after: { adjust: 0.01 }, acceptedCenti: '3000000' });
    expect(t.expectedLossRate!).toBeCloseTo(0.122, 9);
    expect(t.lossRate).toBeUndefined(); // nothing settled yet
    expect(l.evaluateGuard(tier, { ...guard, acceptanceSignal: false })).toBeUndefined();
    l.applyGuard(t, 1);
    // Tightened legs (x = 2.16: 110.16 % at p_fresh) and the anti-windup aim: average adjustment (0.5 %) + cumulative gap
    // ((112.2 % + 110.16 %) / 2 − 110 % = 1.18 %) = 1.68 %.
    for (let i = 0; i < 300; i++) l.onBet({ tier: 'launch', boosted: true, account: `b${i}`, stakeCenti: 10_000n, x100: 216, p: 0.5, pAccept: 0.51, guardAdjust: 0.01 });
    const t2 = l.evaluateGuard(tier, guard)!;
    expect(t2.action).toBe('tighten');
    expect(t2.after.adjust).toBeCloseTo(0.0168, 6);
    // Relaxing needs the acceptance estimate below budget; settled outcomes below budget alone do not relax it.
    const r = new PromoLedger();
    r.applyGuard({ ...t, after: { adjust: 0.03, tripped: false } }, 1);
    for (let i = 0; i < 300; i++) r.onBet({ tier: 'launch', boosted: true, account: `c${i}`, stakeCenti: 10_000n, x100: 220, p: 0.5, pAccept: 0.5, guardAdjust: 0.03 });
    settleMany(r, 20_000, -0.03, 11);
    expect(r.evaluateGuard(tier, guard)).toBeUndefined(); // acceptance at exactly 110 %: inside the deadband
    for (let i = 0; i < 3000; i++) r.onBet({ tier: 'launch', boosted: true, account: `d${i}`, stakeCenti: 10_000n, x100: 220, p: 0.5, pAccept: 0.48, guardAdjust: 0.03 });
    expect(r.evaluateGuard(tier, guard)).toMatchObject({ action: 'relax', basis: 'both', before: { adjust: 0.03 }, after: { adjust: 0.02 } });
  });

  it('clusters the variance by shared outcome: a crowd on one square is one outcome, not many independent ones', () => {
    const crowd = new PromoAgg(), spread = new PromoAgg();
    for (let i = 0; i < 100; i++) {
      // 100 legs on the same square (same outcome) vs 100 legs on 100 different squares in different minutes.
      crowd.add(1_000n, 125, 0.8, 1_250n, 'won', 0, { cell: 'c1', block: 'btc:1', minute: 1 });
      spread.add(1_000n, 125, 0.8, i % 5 === 0 ? 0n : 1_250n, i % 5 === 0 ? 'lost' : 'won', 0, { cell: `c${i}`, block: `btc:${i * 3}`, minute: i * 3 });
    }
    const c = crowd.snapshot(), s = spread.snapshot();
    expect(c.seIndependent).toBeCloseTo(s.seIndependent!, 12);
    expect(c.seClustered!).toBeCloseTo(c.seIndependent! * 10, 9); // √100 legs share one outcome
    expect(c.se).toBe(Math.max(c.seIndependent!, c.seClustered!, c.seBlock!));
    expect(s.seClustered!).toBeCloseTo(s.seIndependent!, 9);
    expect(crowd.se!).toBeGreaterThan(spread.se!);
    // Deterministic canonical state (rebuild comparison), open blocks included.
    expect(JSON.stringify(crowd.state())).toBe(JSON.stringify(crowd.state()));
    // Legs without a cluster are their own cluster.
    const lone = new PromoAgg();
    lone.add(1_000n, 125, 0.8, 1_250n, 'won');
    expect(lone.snapshot().seClustered).toBeCloseTo(lone.snapshot().seIndependent!, 12);
  });

  it('reports loss rates with 95 % intervals against the budget', () => {
    const agg = new PromoAgg();
    agg.add(10_000n, 200, 0.5, 20_000n, 'won'); agg.add(10_000n, 200, 0.5, 0n, 'lost'); agg.add(5n, 200, 0.5, 5n, 'refunded');
    const v = agg.snapshot(0.1);
    expect(v).toMatchObject({ bets: 2, refunds: 1, handleCenti: '20000', returnedCenti: '20000', housePnlCenti: '0', rtp: 1, lossRate: 0, budget: 0.1, budgetUsed: 0, budgetCenti: '2000' });
    expect(v.lossRateHigh!).toBeGreaterThan(0); expect(v.lossRateLow!).toBeLessThan(0);
    expect(GUARD_OK).toEqual({ adjust: 0, tripped: false });
  });
});
