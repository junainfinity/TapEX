import { describe, expect, it } from 'vitest';
import { parseDecimal, type DecimalValue } from '@maya/contracts';
import { getMarket } from '@maya/config';
import { BAND_OFFSETS, EWMA, GRID_CELLS, H10, WINDOWS, ewmaSigma, ewmaSigmaAt, exactBucket, h10Sigma, pathFromSamples, quoteSigma, scaledFeatures, windowGrid } from '../src/index.js';
// Test-only cross-check against the game model's implementation (the package itself may not depend on @maya/pricing).
import { ewmaSigma as pricingEwmaSigma } from '../../pricing/src/model.js';
import { randomWalk, rng } from './fixtures.js';

const T0 = 1_790_000_000;
function naiveH10(path: Map<number, number>, t: number): number | undefined {
  const r: number[] = [];
  for (const [u, b] of path) {
    if (u <= t - 600 || u > t) continue;
    const a = path.get(u - 10); if (a !== undefined) r.push(Math.log(b / a));
  }
  return r.length >= 30 ? Math.sqrt(r.reduce((s, x) => s + x * x, 0) / r.length / 10) : undefined;
}

describe('h10 volatility', () => {
  it('matches an independent RMS of 10 s log displacements over (t − 600, t], divided by √10', () => {
    const path = randomWalk({ t0: T0, seconds: 1500, start: 60_000, sigma: 3e-5, tick: 0.01, seed: 5, gapRate: 0.1, outages: [[T0 + 700, T0 + 760]] });
    for (let t = T0; t < T0 + 1500; t += 7) {
      const expected = naiveH10(path, t), actual = h10Sigma(path, t);
      if (expected === undefined) expect(actual).toBeUndefined();
      else expect(actual! / expected).toBeCloseTo(1, 12);
    }
    expect(H10).toEqual({ lag: 10, windowS: 600, minPairs: 30 });
  });
  it('needs at least 30 pairs', () => {
    const path = new Map<number, number>();
    for (let i = 0; i < 40; i++) path.set(T0 + i, 100 + (i % 3));
    expect(h10Sigma(path, T0 + 38)).toBeUndefined(); // 29 pairs
    expect(h10Sigma(path, T0 + 39)).toBeDefined(); // 30 pairs
    expect(h10Sigma(path, T0 + 39.5)).toBeUndefined();
  });
});

describe('EWMA fallback', () => {
  it('ewmaSigma is bit-identical to packages/pricing ewmaSigma', () => {
    const random = rng(8);
    for (let trial = 0; trial < 300; trial++) {
      const samples: { sourceTimeMs: number; value: number }[] = []; let t = 1_700_000_000_000, v = 2500;
      const n = 1 + Math.floor(random() * 90);
      for (let i = 0; i < n; i++) { t += random() < 0.1 ? 0 : (1 + Math.floor(random() * 3)) * 1000; v = random() < 0.02 ? -1 : Math.abs(v) * Math.exp((random() - 0.5) * 1e-3); samples.push({ sourceTimeMs: t, value: v }); }
      for (const lambda of [0.94, 0.5, 0]) expect(ewmaSigma(samples, lambda)).toBe(pricingEwmaSigma(samples, lambda));
    }
    expect(() => ewmaSigma([], 1)).toThrow();
  });
  it('ewmaSigmaAt equals ewmaSigma over the trailing 68 s of the path (bit-identical), undefined without a return', () => {
    const path = randomWalk({ t0: T0, seconds: 400, start: 2500, sigma: 4e-5, tick: 0.01, seed: 9, gapRate: 0.15, flatRate: 0.2 });
    for (let t = T0; t < T0 + 400; t++) {
      const samples = [...path].filter(([u]) => u > t - EWMA.samples && u <= t).map(([u, value]) => ({ sourceTimeMs: u * 1000, value }));
      const at = ewmaSigmaAt(path, t);
      if (samples.length < 2) expect(at).toBeUndefined();
      else expect(at).toBe(ewmaSigma(samples));
    }
    expect(EWMA).toEqual({ lambda: 0.94, samples: 68 });
  });
});

describe('quoteSigma fallback rule', () => {
  it('uses h10 once 30 pairs exist, the EWMA before that, and fails closed otherwise', () => {
    const path = randomWalk({ t0: T0, seconds: 900, start: 60_000, sigma: 3e-5, tick: 0.01, seed: 1 });
    expect(quoteSigma(path, T0 + 899)).toEqual({ ok: true, sigma: h10Sigma(path, T0 + 899), source: 'h10' });
    expect(quoteSigma(path, T0 + 20)).toEqual({ ok: true, sigma: ewmaSigmaAt(path, T0 + 20), source: 'ewma' });
    expect(quoteSigma(path, T0)).toEqual({ ok: false, reason: 'insufficient-history' });
    const flat = new Map(Array.from({ length: 700 }, (_, i) => [T0 + i, 60_000] as const));
    expect(quoteSigma(flat, T0 + 699)).toEqual({ ok: false, reason: 'invalid-volatility' });
    // A flat last 10 minutes with an earlier move: h10 is 0, the EWMA still sees nothing → no quote.
    const stale = new Map<number, number>(flat); stale.set(T0, 59_000);
    expect(quoteSigma(stale, T0 + 699)).toEqual({ ok: false, reason: 'invalid-volatility' });
  });
});

describe('cell features and window grid', () => {
  it('start0 = ceil((t + 3) / 5) × 5 and tau covers 3..32', () => {
    for (let t = T0; t < T0 + 10; t++) {
      const { start0, windows } = windowGrid(t);
      expect(start0 % 5).toBe(0);
      expect(start0).toBe(Math.ceil((t + 3) / 5) * 5);
      expect(windows).toHaveLength(WINDOWS);
      expect(windows[0]!.tau).toBeGreaterThanOrEqual(3);
      expect(windows[0]!.tau).toBeLessThanOrEqual(7);
      expect(windows[5]!.tau).toBe(windows[0]!.tau + 25);
      windows.forEach((w, i) => { expect(w).toEqual({ w: i, start: start0 + 5 * i, end: start0 + 5 * i + 5, tau: start0 + 5 * i - t }); });
      expect(Object.isFrozen(windows) && Object.isFrozen(windows[0])).toBe(true);
    }
    expect(windowGrid(2).start0).toBe(5);
    expect(windowGrid(7).windows[0]!.tau).toBe(3);
    expect(windowGrid(8).windows[0]!.tau).toBe(7);
    expect(() => windowGrid(1.5)).toThrow(RangeError);
    expect(GRID_CELLS).toBe(42);
    expect(BAND_OFFSETS).toEqual([-3, -2, -1, 0, 1, 2, 3]);
  });
  it('exact bucket uses decimal arithmetic on the recorded price', () => {
    const btc = getMarket('btc-usd').bandHeight, eth = getMarket('eth-usd').bandHeight;
    expect(exactBucket(60_010, btc)).toBe(6001n);
    expect(exactBucket(60_009.99, btc)).toBe(6000n);
    expect(exactBucket(2500.5, eth)).toBe(5001n);
    expect(exactBucket(2500.49, eth)).toBe(5000n);
    expect(exactBucket(parseDecimal('60010.000') as DecimalValue, btc)).toBe(6001n);
    expect(exactBucket(1e15 + 0.5, eth)).toBe(2n * 10n ** 15n + 1n);
    expect(exactBucket(0.3, parseDecimal('0.1'))).toBe(3n);
    expect(Math.floor(0.3 / 0.1)).toBe(2); // the float bucket would be wrong here
    expect(() => exactBucket(Number.NaN, btc)).toThrow(RangeError);
  });
  it('s = sigma × spot / h and frac = spot / h − bucket', () => {
    expect(scaledFeatures(3e-5, 60_005, 10, 6000)).toEqual({ s: (3e-5 * 60_005) / 10, frac: 60_005 / 10 - 6000, bucket: 6000 });
  });
  it('pathFromSamples keeps the first value per whole second', () => {
    const sample = (ms: number, price: string) => ({ sourceTimeMs: ms, price: parseDecimal(price) });
    const path = pathFromSamples([sample(1000, '10'), sample(1000, '11'), sample(2000, '12.5'), sample(2500, '13'), sample(3000, '0')]);
    expect([...path]).toEqual([[1, 10], [2, 12.5]]);
  });
});
