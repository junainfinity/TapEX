import { describe, expect, it } from 'vitest';
import { DEFAULT_EDGE_SCHEDULE, EdgeSchedule, X100_EPSILON, changeEdgeSchedule, isLaunchActive, offerX100, priceImpact, resolveEdge, type OfferParams } from '../src/index.js';
import { rng } from './fixtures.js';

const params: OfferParams = { edge: 0.08, z: 0, minX100: 101, capX100: 5000, aboveCap: 'hide' };
const meta = (atMs = 1_000, actor = 'admin:alice', reason = 'test change') => ({ actor, atMs, reason });

describe('offer rule §3.2', () => {
  it('x100 = floor(100 (1 − edge) / q) with q = min(1, p + z·se + impact)', () => {
    expect(offerX100(0.5, 0, params)).toEqual({ ok: true, x100: 184, q: 0.5, capped: false });
    const q = 0.2 + 2 * 0.01;
    expect(offerX100(0.2, 0.01, { ...params, z: 2 })).toEqual({ ok: true, x100: Math.floor((100 * (1 - 0.08)) / q + X100_EPSILON), q, capped: false });
    expect(Math.floor((100 * (1 - 0.08)) / q + X100_EPSILON)).toBe(418);
    expect(offerX100(0.2, 0, params, 0.05)).toMatchObject({ ok: true, x100: 368 });
    expect(offerX100(0.9, 0.2, { ...params, z: 1 })).toMatchObject({ ok: false, reason: 'below-minimum', q: 1 });
  });
  it('keeps the fit.mjs epsilon so a float quotient a hair under an integer floors to that integer', () => {
    const q = 97 / 117;
    expect(Math.floor((100 * (1 - 0.03)) / q)).toBe(116);
    expect(offerX100(q, 0, { ...params, edge: 0.03 })).toMatchObject({ ok: true, x100: 117 });
  });
  it('minimum: below 101 is not offered; exactly 101 is', () => {
    expect(offerX100(92 / 101, 0, params)).toMatchObject({ ok: true, x100: 101 });
    expect(offerX100(92 / 100.5, 0, params)).toMatchObject({ ok: false, reason: 'below-minimum' });
  });
  it('cap: exactly the cap is offered; above it is hidden or capped by policy', () => {
    expect(offerX100(92 / 5000, 0, params)).toMatchObject({ ok: true, x100: 5000, capped: false });
    expect(offerX100(0.01, 0, params)).toMatchObject({ ok: false, reason: 'hidden-above-cap' });
    expect(offerX100(0.01, 0, { ...params, aboveCap: 'cap' })).toEqual({ ok: true, x100: 5000, q: 0.01, capped: true });
    expect(offerX100(0.01, 0, { ...params, capX100: 800, aboveCap: 'cap' })).toMatchObject({ ok: true, x100: 800, capped: true });
  });
  it('zero probability is never priced, even under the cap policy', () => {
    expect(offerX100(0, 0, { ...params, aboveCap: 'cap' })).toMatchObject({ ok: false, reason: 'out-of-domain' });
  });
  it('invalid inputs fail closed', () => {
    for (const bad of [[Number.NaN, 0], [1.1, 0], [-0.1, 0], [0.5, -1], [0.5, Number.POSITIVE_INFINITY]] as const) expect(offerX100(bad[0], bad[1], params)).toMatchObject({ ok: false, reason: 'out-of-domain' });
    expect(offerX100(0.5, 0, params, Number.NaN)).toMatchObject({ ok: false, reason: 'out-of-domain' });
    expect(offerX100(0.5, 0, params, -0.01)).toMatchObject({ ok: false, reason: 'out-of-domain' });
    for (const p of [{ ...params, edge: 1 }, { ...params, edge: -0.1 }, { ...params, z: -1 }, { ...params, minX100: 99 }, { ...params, capX100: 100 }, { ...params, aboveCap: 'x' as 'hide' }]) expect(offerX100(0.5, 0, p)).toMatchObject({ ok: false, reason: 'out-of-domain' });
    expect(offerX100(0.5, 0, params, Number.POSITIVE_INFINITY)).toMatchObject({ ok: false, reason: 'below-minimum', q: 1 });
  });
  it('price impact is monotone: more liability never raises the multiplier or re-opens a closed cell', () => {
    const random = rng(99);
    for (let trial = 0; trial < 2000; trial++) {
      const p = random() * 0.9, se = random() * 0.03, equity = BigInt(1 + Math.floor(random() * 1e9));
      const policy = { ...params, aboveCap: random() < 0.5 ? 'hide' as const : 'cap' as const, edge: 0.01 + random() * 0.2 };
      let previous: number | undefined; let closedByMinimum = false; let liability = 0n;
      for (let step = 0; step < 30; step++) {
        const impact = priceImpact(0.05, liability, 0.001, equity);
        const offer = offerX100(p, se, policy, impact);
        if (offer.ok) {
          expect(closedByMinimum).toBe(false);
          if (previous !== undefined) expect(offer.x100).toBeLessThanOrEqual(previous);
          previous = offer.x100;
        } else if (offer.reason === 'below-minimum') closedByMinimum = true;
        liability += BigInt(Math.floor(random() * Number(equity) / 5000) + 1);
      }
    }
  });
  it('priceImpact = impactK × L / (cellFraction × E)', () => {
    expect(priceImpact(0.02, 500n, 0.001, 1_000_000n)).toBeCloseTo(0.01, 15);
    expect(priceImpact(0.02, 0n, 0.001, 1_000_000n)).toBe(0);
    expect(priceImpact(0, 500n, 0.001, 1_000_000n)).toBe(0);
    expect(priceImpact(0.02, 500n, 0.001, 0n)).toBe(Number.POSITIVE_INFINITY);
    expect(priceImpact(0.02, 500n, 0.001, 2_000_000n)).toBeLessThan(priceImpact(0.02, 500n, 0.001, 1_000_000n));
    expect(priceImpact(-1, 500n, 0.001, 1_000_000n)).toBeNaN();
    expect(priceImpact(0.02, 500n, 0, 1_000_000n)).toBeNaN();
  });
});

describe('edge schedule and launch boost', () => {
  it('defaults: launch 3% until 10,000 registered players, then standard 8%', () => {
    expect(DEFAULT_EDGE_SCHEDULE).toEqual({ standard: 0.08, launch: { enabled: true, edge: 0.03, untilPlayers: 10_000 }, flowEdge: 0, drawdownWiden: 0.02 });
    expect(Object.isFrozen(DEFAULT_EDGE_SCHEDULE) && Object.isFrozen(DEFAULT_EDGE_SCHEDULE.launch)).toBe(true);
  });
  it('switches at exactly 10,000 players', () => {
    const s = new EdgeSchedule();
    for (const [players, edge, phase] of [[0, 0.03, 'launch'], [9_999, 0.03, 'launch'], [10_000, 0.08, 'standard'], [10_001, 0.08, 'standard'], [1_000_000, 0.08, 'standard']] as const) {
      expect(s.resolve({ registeredPlayers: players })).toMatchObject({ edge, phase, base: edge, flow: 0, widen: 0 });
      expect(s.isLaunchActive(players)).toBe(phase === 'launch');
    }
  });
  it('invalid player counts fail closed to the standard edge', () => {
    for (const players of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(resolveEdge(DEFAULT_EDGE_SCHEDULE, { registeredPlayers: players })).toMatchObject({ phase: 'standard', edge: 0.08 });
  });
  it('adds the flow surcharge only for flagged accounts and the drawdown widening only while widened', () => {
    const s = new EdgeSchedule({ ...DEFAULT_EDGE_SCHEDULE, flowEdge: 0.04 });
    expect(s.resolve({ registeredPlayers: 12_000, flagged: false }).edge).toBe(0.08);
    expect(s.resolve({ registeredPlayers: 12_000, flagged: true })).toMatchObject({ edge: 0.08 + 0.04, flow: 0.04 });
    expect(s.resolve({ registeredPlayers: 5, drawdownWidened: true })).toMatchObject({ edge: 0.03 + 0.02, widen: 0.02, phase: 'launch' });
    expect(s.resolve({ registeredPlayers: 5, flagged: true, drawdownWidened: true }).edge).toBeCloseTo(0.09, 15);
  });
  it('admin can end the boost early; the change is journaled with actor, time, reason, before and after', () => {
    const s = new EdgeSchedule();
    const result = s.endLaunch(meta(1_700_000_000_000, 'admin:alice', 'target reached early'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toMatchObject({ type: 'edge-schedule-changed', actor: 'admin:alice', atMs: 1_700_000_000_000, reason: 'target reached early' });
    expect(result.event.before.launch.enabled).toBe(true);
    expect(result.event.after.launch.enabled).toBe(false);
    expect(Object.isFrozen(result.event) && Object.isFrozen(result.event.after.launch)).toBe(true);
    expect(s.resolve({ registeredPlayers: 5_000 })).toMatchObject({ phase: 'standard', edge: 0.08 });
  });
  it('admin can extend the boost or change the threshold and edges', () => {
    const s = new EdgeSchedule();
    expect(s.extendLaunch(15_000, meta()).ok).toBe(true);
    expect(s.resolve({ registeredPlayers: 12_000 }).phase).toBe('launch');
    expect(s.resolve({ registeredPlayers: 15_000 }).phase).toBe('standard');
    expect(s.change({ launch: { untilPlayers: 8_000 } }, meta()).ok).toBe(true);
    expect(s.isLaunchActive(9_000)).toBe(false);
    expect(s.change({ standard: 0.1, launch: { edge: 0.05 } }, meta()).ok).toBe(true);
    expect(s.resolve({ registeredPlayers: 1 }).edge).toBe(0.05);
    expect(s.resolve({ registeredPlayers: 9_000 }).edge).toBe(0.1);
    // Re-enabling after ending restores the boost below the threshold.
    s.endLaunch(meta());
    expect(s.extendLaunch(20_000, meta()).ok).toBe(true);
    expect(s.resolve({ registeredPlayers: 19_999 }).phase).toBe('launch');
  });
  it('rejects invalid changes with typed reasons and leaves the schedule unchanged', () => {
    const s = new EdgeSchedule(); const before = s.config;
    expect(s.change({ standard: 0.3 }, meta())).toEqual({ ok: false, reason: 'invalid-standard-edge' });
    expect(s.change({ standard: 0.005 }, meta())).toEqual({ ok: false, reason: 'invalid-standard-edge' });
    expect(s.change({ launch: { edge: 0 } }, meta())).toEqual({ ok: false, reason: 'invalid-launch-edge' });
    expect(s.change({ launch: { untilPlayers: -1 } }, meta())).toEqual({ ok: false, reason: 'invalid-threshold' });
    expect(s.change({ launch: { untilPlayers: 1.5 } }, meta())).toEqual({ ok: false, reason: 'invalid-threshold' });
    expect(s.change({ flowEdge: 0.5 }, meta())).toEqual({ ok: false, reason: 'invalid-flow-edge' });
    expect(s.change({ drawdownWiden: -0.01 }, meta())).toEqual({ ok: false, reason: 'invalid-drawdown-widen' });
    expect(s.change({ standard: 0.1 }, meta(1, '', 'x'))).toEqual({ ok: false, reason: 'invalid-meta' });
    expect(s.change({ standard: 0.1 }, meta(1, 'admin', ' '))).toEqual({ ok: false, reason: 'invalid-meta' });
    expect(s.change({ standard: 0.1 }, meta(-1))).toEqual({ ok: false, reason: 'invalid-meta' });
    expect(s.change({ standard: 0.08 }, meta())).toEqual({ ok: false, reason: 'no-change' });
    expect(s.config).toBe(before);
    expect(() => new EdgeSchedule({ ...DEFAULT_EDGE_SCHEDULE, standard: 2 })).toThrow(RangeError);
  });
  it('changeEdgeSchedule is pure', () => {
    const result = changeEdgeSchedule(DEFAULT_EDGE_SCHEDULE, { launch: { enabled: false } }, meta());
    expect(result.ok).toBe(true);
    expect(DEFAULT_EDGE_SCHEDULE.launch.enabled).toBe(true);
    if (result.ok) expect(isLaunchActive(result.config, 0)).toBe(false);
  });
});
