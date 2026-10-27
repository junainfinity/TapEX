import { describe, expect, it } from 'vitest';
import { parseDecimal } from '@maya/contracts';
import {
  DEFAULT_DEFENSES, DEFAULT_EDGE_SCHEDULE, DEFAULT_PRICING_CONFIG, DEFAULT_RISK_LIMITS, DEFENSES_OFF, EdgeController, HoldMoveBaseline, LiabilityBook, MULTIPLIER_RANGES, RANGE_KEYS,
  buildQuoteGrid, cellFairValue, changeDefenses, fairValueTolerance, freezeDefenses, holdTolRelFor, holdVerdict, rampLimitCenti, rangeKeyOf, toxicityAction, toxicityDecision, validateDefenses,
  type ControllerConfig, type ControllerLeg, type FlowStats, type OfferedGridCell, type QuoteGridInput,
} from '../src/index.js';
import { randomWalk, table } from './fixtures.js';

const META = { actor: 'admin', atMs: 1_000, reason: 'tune defenses for the test' };

describe('defense configuration', () => {
  it('ships valid production defaults and a Stage A (all off) profile', () => {
    expect(validateDefenses(DEFAULT_DEFENSES)).toBeUndefined();
    expect(validateDefenses(DEFENSES_OFF)).toBeUndefined();
    expect(DEFAULT_DEFENSES).toMatchObject({ hold: { enabled: true, maxHoldMs: 1500 }, quoteValidity: { enabled: true }, ramp: { enabled: true }, toxicity: { enabled: true }, controller: { enabled: true } });
    expect(DEFENSES_OFF).toMatchObject({ hold: { enabled: false }, quoteValidity: { enabled: false }, minLeadS: 3, ramp: { enabled: false }, toxicity: { enabled: false }, controller: { enabled: false }, reference: { enabled: false } });
    expect(Object.isFrozen(DEFAULT_DEFENSES) && Object.isFrozen(DEFAULT_DEFENSES.hold) && Object.isFrozen(DEFAULT_DEFENSES.controller.overrides)).toBe(true);
  });

  it('rejects out-of-range values with the offending section named', () => {
    const bad = (patch: Record<string, unknown>) => validateDefenses(freezeDefenses({ ...DEFAULT_DEFENSES, ...patch } as typeof DEFAULT_DEFENSES));
    expect(bad({ hold: { ...DEFAULT_DEFENSES.hold, maxHoldMs: 100 } })).toMatch(/^hold/);
    expect(bad({ hold: { ...DEFAULT_DEFENSES.hold, tolRel: -0.1 } })).toMatch(/^hold/);
    expect(bad({ hold: { ...DEFAULT_DEFENSES.hold, onTimeout: 'maybe' } })).toMatch(/^hold/);
    expect(bad({ quoteValidity: { ...DEFAULT_DEFENSES.quoteValidity, graceMs: 5000 } })).toMatch(/^quoteValidity/);
    expect(bad({ minLeadS: 2 })).toMatch(/minLeadS/);
    expect(bad({ minLeadS: 4.5 })).toMatch(/minLeadS/);
    expect(bad({ ramp: { ...DEFAULT_DEFENSES.ramp, startCenti: '0' } })).toMatch(/^ramp/);
    expect(bad({ toxicity: { ...DEFAULT_DEFENSES.toxicity, blockZ: 1 } })).toMatch(/^toxicity/);
    expect(bad({ toxicity: { ...DEFAULT_DEFENSES.toxicity, minBets: 2 } })).toMatch(/^toxicity/);
    expect(bad({ controller: { ...DEFAULT_DEFENSES.controller, maxAdjust: 0.5 } })).toMatch(/^controller/);
    expect(bad({ controller: { ...DEFAULT_DEFENSES.controller, overrides: { '3-4': 0.01 } } })).toMatch(/unknown range/);
    expect(bad({ controller: { ...DEFAULT_DEFENSES.controller, overrides: { '2-5': 0.5 } } })).toMatch(/2-5/);
    expect(bad({ reference: { enabled: true, moveSigma: 0 } })).toMatch(/^reference/);
  });

  it('changes by strict partial patch, reports switched-off defenses and journals before/after', () => {
    const r = changeDefenses(DEFAULT_DEFENSES, { hold: { tolRel: 0.2 }, minLeadS: 5, controller: { overrides: { '2-5': 0.01 } } }, META);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.hold).toEqual({ ...DEFAULT_DEFENSES.hold, tolRel: 0.2 });
    expect(r.config.minLeadS).toBe(5);
    expect(r.config.controller.overrides).toEqual({ '2-5': 0.01 });
    expect(r.event).toMatchObject({ type: 'defenses-changed', actor: 'admin', reason: META.reason, before: DEFAULT_DEFENSES, disabled: [] });
    const cleared = changeDefenses(r.config, { controller: { overrides: { '2-5': null } } }, META);
    expect(cleared.ok && cleared.config.controller.overrides).toEqual({});
    const off = changeDefenses(DEFAULT_DEFENSES, { hold: { enabled: false }, ramp: { enabled: false } }, META);
    expect(off.ok && off.event.disabled).toEqual(['hold', 'ramp']);
    expect(changeDefenses(DEFAULT_DEFENSES, { hold: { tolRel: DEFAULT_DEFENSES.hold.tolRel } }, META)).toMatchObject({ ok: false, reason: 'no-change' });
    expect(changeDefenses(DEFAULT_DEFENSES, { hold: { bogus: 1 } } as never, META)).toMatchObject({ ok: false, reason: 'invalid-patch' });
    expect(changeDefenses(DEFAULT_DEFENSES, { nope: {} } as never, META)).toMatchObject({ ok: false, reason: 'invalid-patch' });
    expect(changeDefenses(DEFAULT_DEFENSES, { hold: { maxHoldMs: 9_999 } }, META)).toMatchObject({ ok: false, reason: 'invalid-config' });
    expect(changeDefenses(DEFAULT_DEFENSES, { minLeadS: 5 }, { ...META, reason: ' ' })).toMatchObject({ ok: false, reason: 'invalid-meta' });
  });
});

describe('acceptance hold verdict', () => {
  it('checks symmetrically on the log-odds scale when configured', () => {
    const hold = { tolScale: 'logit' as const, tolRel: 1, tolAbs: 0 };
    expect(fairValueTolerance(0.9, hold)).toBe(1);
    // p = 0.9: log-odds band [0.768, 0.961] — both sides reachable, unlike a ±40 % relative band.
    expect(holdVerdict(0.9, 0.95, hold)).toMatchObject({ ok: true });
    expect(holdVerdict(0.9, 0.97, hold)).toMatchObject({ ok: false, reason: 'fair-value-moved' });
    expect(holdVerdict(0.9, 0.78, hold)).toMatchObject({ ok: true });
    expect(holdVerdict(0.9, 0.75, hold)).toMatchObject({ ok: false });
    expect(holdVerdict(0.05, 0.12, hold)).toMatchObject({ ok: true });
    expect(holdVerdict(0.05, 0.14, hold)).toMatchObject({ ok: false });
    expect(holdVerdict(0.5, 0.5, hold)).toMatchObject({ ok: true, delta: 0 });
  });
  it('picks the account tolerance: latency-flagged, then the new-account ramp, then the default', () => {
    const hold = { ...DEFAULT_DEFENSES.hold, tolRel: 0.4, flaggedTolRel: 0.02, newAccountHolds: 10, newAccountTolRel: 0.1 };
    expect(holdTolRelFor(hold, { flagged: true, holds: 100 })).toBe(0.02);
    expect(holdTolRelFor(hold, { flagged: false, holds: 9 })).toBe(0.1);
    expect(holdTolRelFor(hold, { flagged: false, holds: 10 })).toBe(0.4);
    expect(holdTolRelFor({ ...hold, newAccountHolds: 0 }, { flagged: false, holds: 0 })).toBe(0.4);
    expect(holdTolRelFor({ ...hold, flaggedTolRel: 3 }, { flagged: true, holds: 0 })).toBe(0.4); // never looser than the default
    // Graduation also needs clean latency evidence.
    expect(holdTolRelFor(hold, { flagged: false, holds: 50, latencyZ: 2.5 })).toBe(0.1);
    expect(holdTolRelFor(hold, { flagged: false, holds: 50, latencyZ: 1.9 })).toBe(0.4);
    expect(holdTolRelFor({ ...hold, newAccountHolds: 0 }, { flagged: false, holds: 0, latencyZ: 9 })).toBe(0.4);
  });
  it('uses a symmetric tolerance max(tolAbs, tolRel × p_quote)', () => {
    const hold = { tolRel: 0.1, tolAbs: 0.01 };
    expect(fairValueTolerance(0.5, hold)).toBeCloseTo(0.05, 12);
    expect(fairValueTolerance(0.05, hold)).toBe(0.01);
    expect(holdVerdict(0.5, 0.54, hold)).toMatchObject({ ok: true });
    expect(holdVerdict(0.5, 0.46, hold)).toMatchObject({ ok: true });
    expect(holdVerdict(0.5, 0.55, hold)).toMatchObject({ ok: true }); // exactly at the tolerance
    // Either direction beyond the tolerance rejects: a favourable move for the player and one for the house alike.
    expect(holdVerdict(0.5, 0.56, hold)).toMatchObject({ ok: false, reason: 'fair-value-moved' });
    expect(holdVerdict(0.5, 0.44, hold)).toMatchObject({ ok: false, reason: 'fair-value-moved' });
    expect(holdVerdict(0.5, undefined, hold)).toMatchObject({ ok: false, reason: 'fair-value-unavailable' });
    expect(holdVerdict(0.5, Number.NaN, hold)).toMatchObject({ ok: false, reason: 'fair-value-unavailable' });
  });
});

describe('new-account ramp', () => {
  const ramp = { enabled: true, startCenti: '25000', perSettledBetCenti: '2500', handleFraction: 0.25 };
  it('starts small, grows with settled bets and handle, and never exceeds the account limit', () => {
    expect(rampLimitCenti(1_000_000n, { settledBets: 0, settledHandleCenti: 0n }, ramp)).toBe(25_000n);
    expect(rampLimitCenti(1_000_000n, { settledBets: 10, settledHandleCenti: 40_000n }, ramp)).toBe(25_000n + 25_000n + 10_000n);
    expect(rampLimitCenti(50_000n, { settledBets: 100, settledHandleCenti: 10_000_000n }, ramp)).toBe(50_000n);
    expect(rampLimitCenti(1_000_000n, { settledBets: -5, settledHandleCenti: -1n }, ramp)).toBe(25_000n);
    expect(rampLimitCenti(777n, { settledBets: 0, settledHandleCenti: 0n }, { ...ramp, enabled: false })).toBe(777n);
  });
});

describe('graduated toxicity', () => {
  // Explicit thresholds (the production defaults are tuned by the ablation).
  const cfg = { ...DEFAULT_DEFENSES.toxicity, minBets: 20, minWins: 3, surchargeZ: 3, blockZ: 5, blockMinBets: 40, unflagZ: 1, holdMinN: 15, holdZ: 4, holdBlockMinN: 30, holdBlockZ: 6 };
  const base: FlowStats = { settledBets: 0, wins: 0, z: 0, holdN: 0, holdZ: 0, flagged: false, blocked: false, flaggedByMonitor: false };
  it('never acts on too little data', () => {
    expect(toxicityAction({ ...base, settledBets: 19, wins: 10, z: 10 }, cfg)).toBe('none');
    expect(toxicityAction({ ...base, settledBets: 50, wins: 2, z: 10 }, cfg)).toBe('none');
    expect(toxicityAction({ ...base, holdN: 14, holdZ: 20 }, cfg)).toBe('none');
    expect(validateDefenses(freezeDefenses({ ...DEFAULT_DEFENSES, toxicity: cfg }))).toBeUndefined();
    expect(toxicityAction({ ...base, settledBets: 500, wins: 100, z: 10 }, { ...cfg, enabled: false })).toBe('none');
  });
  it('surcharges first on outcome or latency evidence, then blocks on stronger evidence', () => {
    expect(toxicityDecision({ ...base, settledBets: 20, wins: 3, z: 3.1 }, cfg)).toEqual({ action: 'flag', evidence: 'outcomes' });
    expect(toxicityDecision({ ...base, holdN: 15, holdZ: 4.1 }, cfg)).toEqual({ action: 'flag', evidence: 'latency' });
    // An unflagged account is never blocked directly.
    expect(toxicityAction({ ...base, settledBets: 400, wins: 200, z: 12, holdN: 400, holdZ: 30 }, cfg)).toBe('flag');
    const flagged = { ...base, flagged: true, flaggedByMonitor: true };
    expect(toxicityDecision({ ...flagged, settledBets: 40, wins: 5, z: 5.5 }, cfg)).toEqual({ action: 'block', evidence: 'outcomes' });
    expect(toxicityAction({ ...flagged, settledBets: 39, wins: 5, z: 5.5, holdN: 10, holdZ: 5 }, cfg)).toBe('none');
    expect(toxicityDecision({ ...flagged, holdN: 30, holdZ: 6.5 }, cfg)).toEqual({ action: 'block', evidence: 'latency' });
    expect(toxicityAction({ ...flagged, blocked: true, holdN: 300, holdZ: 60 }, cfg)).toBe('none');
  });
  it('lifts only its own flag, and only once both kinds of evidence faded', () => {
    expect(toxicityAction({ ...base, flagged: true, flaggedByMonitor: true, settledBets: 60, wins: 10, z: 0.5, holdN: 40, holdZ: 0.2 }, cfg)).toBe('unflag');
    expect(toxicityAction({ ...base, flagged: true, flaggedByMonitor: true, settledBets: 60, wins: 10, z: 0.5, holdN: 40, holdZ: 3 }, cfg)).toBe('none');
    expect(toxicityAction({ ...base, flagged: true, flaggedByMonitor: false, settledBets: 60, wins: 10, z: -3 }, cfg)).toBe('none');
  });
  it('measures hold moves against a clamped population baseline', () => {
    expect(HoldMoveBaseline.clamp(5)).toBe(1);
    expect(HoldMoveBaseline.clamp(-0.9)).toBe(-0.5);
    const b = new HoldMoveBaseline(0.01);
    for (let i = 0; i < 1000; i++) b.observe(i % 2 ? 0.1 : -0.1);
    expect(Math.abs(b.mean)).toBeLessThan(0.02);
    expect(b.sd).toBeGreaterThan(0.08); expect(b.sd).toBeLessThan(0.12);
    b.observe(Number.NaN);
    expect(b.n).toBe(1000);
  });
});

describe('adaptive edge controller', () => {
  const cfg: ControllerConfig = { ...DEFAULT_DEFENSES.controller, minBets: 100, evalEveryMs: 60_000, windowMs: 3_600_000, zGate: 2, deadband: 0.005, maxStepPerEval: 0.005, maxStepPerHour: 0.01 };
  /** Settled legs at x100 with realized RTP `rtp` against the policy RTP. */
  function feed(c: EdgeController, n: number, opts: { atMs: number; x100: number; rtp: number; policyRtp: number; adjust?: number }): void {
    for (let i = 0; i < n; i++) {
      const stake = 1000n;
      const credit = BigInt(Math.round(1000 * opts.rtp));
      c.observe({ atMs: opts.atMs + i, x100: opts.x100, stakeCenti: stake, creditCenti: credit, p: 100 / opts.x100 * 0.97, policyRtp: opts.policyRtp, adjust: opts.adjust ?? 0 } satisfies ControllerLeg);
    }
  }
  it('maps multipliers to the §7 ranges', () => {
    expect(RANGE_KEYS).toEqual(MULTIPLIER_RANGES.map(r => r.key));
    expect([101, 199, 200, 499, 500, 1999, 2000, 5000, 5001].map(rangeKeyOf)).toEqual(['1.01-2', '1.01-2', '2-5', '2-5', '5-10', '10-20', '20-50', '20-50', '50-100']);
  });
  it('waits for enough flow, then raises the edge of an under-charging range within the step bounds', () => {
    const c = new EdgeController();
    feed(c, 50, { atMs: 0, x100: 150, rtp: 1.03, policyRtp: 0.97 });
    expect(c.evaluate(60_000, cfg)).toEqual([]);
    feed(c, 950, { atMs: 1000, x100: 150, rtp: 1.03, policyRtp: 0.97 });
    const moves = c.evaluate(120_000, cfg);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ key: '1.01-2', before: 0, after: cfg.maxStepPerEval, bets: 1000 });
    expect(moves[0]!.realized).toBeCloseTo(1.03, 6); expect(moves[0]!.target).toBeCloseTo(0.97, 6);
    for (const m of moves) c.apply(m.key, m.after, 120_000);
    expect(c.effective(cfg)).toEqual({ '1.01-2': cfg.maxStepPerEval });
    // The per-hour budget (0.01) allows one more 0.005 step inside the hour, then nothing until it rolls.
    const second = c.evaluate(180_000, cfg); for (const m of second) c.apply(m.key, m.after, 180_000);
    expect(c.adjust('1.01-2')).toBeCloseTo(0.01, 9);
    expect(c.evaluate(240_000, cfg)).toEqual([]);
    expect(c.evaluate(120_000 + 3_600_001, { ...cfg, windowMs: 7 * 24 * 3_600_000 })[0]).toMatchObject({ before: 0.01, after: 0.015 });
  });
  it('holds still inside the deadband and the statistical gate, and never winds up past the window-average need', () => {
    const c = new EdgeController();
    feed(c, 1000, { atMs: 0, x100: 300, rtp: 0.972, policyRtp: 0.97 });
    expect(c.evaluate(60_000, cfg)).toEqual([]); // 0.2 pts < 0.5 pt deadband
    const d = new EdgeController();
    feed(d, 1000, { atMs: 0, x100: 150, rtp: 0.99, policyRtp: 0.97, adjust: 0.02 });
    d.apply('1.01-2', 0.02, -4_000_000); // set more than an hour ago, so the hourly budget is free again
    // A 2-point gap over 1,000 bets is inside 2 SE (≈ 4.5 points here): the statistical gate holds.
    expect(d.evaluate(60_000, cfg)).toEqual([]);
    feed(d, 9000, { atMs: 1000, x100: 150, rtp: 0.99, policyRtp: 0.97, adjust: 0.02 });
    // Legs priced with +2 pts still returned 2 pts too much: aim at 0.04 — one bounded step up, not a reset.
    expect(d.evaluate(70_000, cfg)[0]).toMatchObject({ before: 0.02, after: 0.025, bets: 10_000 });
    const e = new EdgeController();
    feed(e, 10_000, { atMs: 0, x100: 150, rtp: 0.95, policyRtp: 0.97 });
    expect(e.evaluate(60_000, cfg)[0]).toMatchObject({ before: 0, after: -0.005 }); // over-charging lowers the edge
    for (let i = 0; i < 10; i++) for (const m of e.evaluate(60_000 + (i + 1) * 3_600_000, { ...cfg, windowMs: 30 * 24 * 3_600_000 })) e.apply(m.key, m.after, 60_000 + (i + 1) * 3_600_000);
    expect(e.adjust('1.01-2')).toBeGreaterThanOrEqual(cfg.minAdjust);
  });
  it('respects admin overrides and the disabled state', () => {
    const c = new EdgeController();
    feed(c, 1000, { atMs: 0, x100: 150, rtp: 1.05, policyRtp: 0.97 });
    expect(c.evaluate(60_000, { ...cfg, overrides: { '1.01-2': 0.03 } })).toEqual([]);
    expect(c.effective({ ...cfg, overrides: { '1.01-2': 0.03 } })).toEqual({ '1.01-2': 0.03 });
    c.apply('1.01-2', 0.01, 1);
    expect(c.effective({ ...cfg, enabled: false })).toEqual({});
    expect(c.effective({ ...cfg, enabled: false, overrides: { '5-10': -0.01 } })).toEqual({ '5-10': -0.01 });
    expect(c.evaluate(60_000, { ...cfg, enabled: false })).toEqual([]);
    const state = c.state(60_000, cfg).find(s => s.key === '1.01-2')!;
    expect(state).toMatchObject({ adjust: 0.01, effective: 0.01, bets: 1000, lastChangeMs: 1 });
    expect(state.realized).toBeCloseTo(1.05, 6);
    // Window expiry drops old flow.
    expect(c.state(60_000 + cfg.windowMs + 600_000, cfg).find(s => s.key === '1.01-2')!.bets).toBe(0);
  });
});

describe('quote grid defenses', () => {
  const T0 = 1_790_000_000;
  const path = randomWalk({ t0: T0, seconds: 1200, start: 60_000, sigma: 3e-5, tick: 0.01, seed: 42 });
  const T = T0 + 1199; // tau0 = 6
  const input = (o: Partial<QuoteGridInput> = {}): QuoteGridInput => ({ market: 'btc-usd', t: T, spot: parseDecimal(String(path.get(T)!)), path, table: table('btc-usd'), pricing: DEFAULT_PRICING_CONFIG, schedule: DEFAULT_EDGE_SCHEDULE, registeredPlayers: 0, limits: DEFAULT_RISK_LIMITS, book: new LiabilityBook(), equityCenti: 100_000_000n, ...o });
  it('keeps the §3.1 geometry and closes cells inside the minimum lead', () => {
    const base = buildQuoteGrid(input()), lead = buildQuoteGrid(input({ minLeadS: 7 }));
    expect(lead.start0).toBe(base.start0);
    expect(lead.cells.map(c => c.cell.cellId)).toEqual(base.cells.map(c => c.cell.cellId));
    for (const c of lead.cells) {
      if (c.tau < 7) expect(c).toMatchObject({ available: false, reason: 'too-late' });
      else expect(c.available).toBe(base.cells[c.index]!.available);
    }
    expect(buildQuoteGrid(input({ minLeadS: 2 })).reason).toBe('model-incompatible');
  });
  it('prices a range adjustment into that range only, carrying the cell edge', () => {
    const base = buildQuoteGrid(input());
    const adj = buildQuoteGrid(input({ rangeAdjust: { '2-5': 0.05 } }));
    let moved = 0;
    for (const c of adj.cells) {
      const b = base.cells[c.index]!;
      if (!c.available || !b.available) continue;
      const bc = b as OfferedGridCell, ac = c as OfferedGridCell;
      if (rangeKeyOf(bc.x100) === '2-5') { expect(ac.x100).toBeLessThan(bc.x100); expect(ac.rangeAdjust).toBe(0.05); expect(ac.cellEdge).toBeCloseTo(adj.edge.edge + 0.05, 12); moved++; }
      else { expect(ac.x100).toBe(bc.x100); expect(ac.rangeAdjust).toBe(0); expect(ac.cellEdge).toBe(adj.edge.edge); }
    }
    expect(moved).toBeGreaterThan(0);
    expect(buildQuoteGrid(input({ rangeAdjust: { '2-5': 0.9 } })).reason).toBe('model-incompatible');
  });
  it('re-values one fixed cell exactly as the grid does at its instant', () => {
    const grid = buildQuoteGrid(input());
    for (const c of grid.cells) {
      const fv = cellFairValue({ market: 'btc-usd', t: T, spot: grid.spot, path, table: table('btc-usd'), startMs: c.cell.startMs, bandIndex: BigInt(grid.bucket) + BigInt(c.bandOffset), sigma: grid.sigma! });
      if (c.p === undefined) { expect(fv.ok).toBe(false); continue; }
      expect(fv).toMatchObject({ ok: true, p: c.p, se: c.se, tau: c.tau, b: c.bandOffset });
      const recomputed = cellFairValue({ market: 'btc-usd', t: T, spot: grid.spot, path, table: table('btc-usd'), startMs: c.cell.startMs, bandIndex: BigInt(grid.bucket) + BigInt(c.bandOffset) });
      expect(recomputed).toEqual(fv);
    }
    const far = cellFairValue({ market: 'btc-usd', t: T, spot: grid.spot, path, table: table('btc-usd'), startMs: grid.cells[0]!.cell.startMs, bandIndex: BigInt(grid.bucket) + 5n });
    expect(far).toEqual({ ok: false, reason: 'out-of-domain' });
    expect(cellFairValue({ market: 'eth-usd', t: T, spot: grid.spot, path, table: table('btc-usd'), startMs: 0, bandIndex: 0n })).toEqual({ ok: false, reason: 'model-incompatible' });
  });
});
