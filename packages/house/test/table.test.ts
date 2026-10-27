import { describe, expect, it } from 'vitest';
import { GOLDEN_TOLERANCE, V3_DIMS, cellKey, lookup, multiplierX100, offerX100, parseCalibratedTable, sigmaBin, smooth, tableSizes, type CalibratedTableJSON } from '../src/index.js';
import { MARKETS, TOOLING, rng, table, tableJson } from './fixtures.js';

type FitModule = {
  cellKey: (features: { s: number; frac: number; tau: number; b: number }, edges: readonly number[]) => number;
  smooth: (counts: Record<string, Float64Array>) => { p: Float64Array; se: Float64Array };
  multiplierX100: (p: number, se: number, pricing: object) => number;
  SPEC: { prior: number };
};
const fit = (await import(new URL('fit.mjs', TOOLING).href)) as FitModule;
const toFloat = (counts: CalibratedTableJSON['counts']): Record<string, Float64Array> => Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Float64Array.from(v)]));

describe('maya-calibrated-v3 golden rows', () => {
  for (const market of MARKETS) {
    it(`${market}: every golden row reproduces key, p, se and x100 to 1e-9`, () => {
      const t = table(market); const json = tableJson(market);
      expect(json.golden).toHaveLength(48);
      for (const row of json.golden) {
        const hit = lookup(t, row);
        expect(hit, `row ${JSON.stringify(row)}`).toBeDefined();
        expect(hit!.key).toBe(row.key);
        expect(cellKey(row, t.sigmaEdges, t.dims)).toBe(row.key);
        expect(Math.abs(hit!.p - row.p)).toBeLessThanOrEqual(GOLDEN_TOLERANCE);
        expect(Math.abs(hit!.se - row.se)).toBeLessThanOrEqual(GOLDEN_TOLERANCE);
        const offer = offerX100(hit!.p, hit!.se, t.pricing);
        expect(offer.ok ? offer.x100 : -1).toBe(row.x100);
        expect(multiplierX100(hit!.p, hit!.se, t.pricing)).toBe(row.x100);
      }
      // The published tables include hidden cells, so the −1 path is exercised too.
      expect(json.golden.some((row) => row.x100 === -1)).toBe(true);
    });

    it(`${market}: smoothing is bit-identical to fit.mjs smooth() over all ${tableSizes(V3_DIMS).l2} cells`, () => {
      const json = tableJson(market);
      expect(fit.SPEC.prior).toBe(json.prior);
      const reference = fit.smooth(toFloat(json.counts));
      const ours = smooth(json.counts, table(market).dims);
      const t = table(market);
      for (let k = 0; k < reference.p.length; k++) {
        expect(ours.p[k]).toBe(reference.p[k]);
        expect(ours.se[k]).toBe(reference.se[k]);
        expect(t.p[k]).toBe(reference.p[k]);
        expect(t.se[k]).toBe(reference.se[k]);
      }
    });

    it(`${market}: cellKey agrees with fit.mjs cellKey on 20,000 random cells including reflections and clamps`, () => {
      const t = table(market); const random = rng(market === 'btc-usd' ? 11 : 12);
      for (let i = 0; i < 20_000; i++) {
        const features = {
          s: random() < 0.1 ? t.sigmaEdges[Math.floor(random() * t.sigmaEdges.length)]! : random() * 1.2,
          frac: random() < 0.05 ? [0, 1, -0.0001, 1.0001, 0.2, 0.8][Math.floor(random() * 6)]! : random(),
          tau: Math.floor(random() * 36), b: Math.floor(random() * 9) - 4,
        };
        expect(cellKey(features, t.sigmaEdges)).toBe(fit.cellKey(features, t.sigmaEdges));
      }
    });

    it(`${market}: multiplier matches fit.mjs multiplierX100 at several pricings`, () => {
      const t = table(market); const random = rng(21);
      for (const pricing of [t.pricing, { ...t.pricing, edge: 0.03 }, { ...t.pricing, z: 0.5, aboveCap: 'cap' as const }, { ...t.pricing, capX100: 800 }]) {
        for (let k = 0; k < t.p.length; k += 7) expect(multiplierX100(t.p[k]!, t.se[k]!, pricing)).toBe(fit.multiplierX100(t.p[k]!, t.se[k]!, pricing));
        for (let i = 0; i < 2000; i++) { const p = random(), se = random() * 0.05; expect(multiplierX100(p, se, pricing)).toBe(fit.multiplierX100(p, se, pricing)); }
      }
    });
  }

  it('sigmaBin counts edges ≤ s', () => {
    expect(sigmaBin([0.1, 0.2, 0.2, 0.3], 0.05)).toBe(0);
    expect(sigmaBin([0.1, 0.2, 0.2, 0.3], 0.2)).toBe(3);
    expect(sigmaBin([0.1, 0.2, 0.2, 0.3], 9)).toBe(4);
  });
});

describe('fail-closed lookups', () => {
  it('tau 3 has no observations in the published tables, so those cells are refused instead of priced at the 0.5 prior', () => {
    for (const market of MARKETS) {
      const t = table(market); const json = tableJson(market);
      for (let b = 0; b <= 3; b++) expect(json.counts.n0[b]).toBe(0);
      for (const b of [-3, -1, 0, 2]) expect(lookup(t, { s: 0.3, frac: 0.4, tau: 3, b })).toBeUndefined();
      const tau4 = lookup(t, { s: 0.3, frac: 0.4, tau: 4, b: 0 });
      expect(tau4).toBeDefined();
      // The empirical near-band probability at tau 4 is far above the 0.5 prior the smoother would have used at tau 3.
      expect(tau4!.p).toBeGreaterThan(0.7);
      expect(t.p[cellKey({ s: 0.3, frac: 0.4, tau: 3, b: 0 }, t.sigmaEdges)]).toBe(0.5);
    }
  });
  it('out-of-domain and non-finite features return undefined', () => {
    const t = table('btc-usd');
    for (const f of [{ tau: 2, b: 0 }, { tau: 33, b: 0 }, { tau: 10, b: 4 }, { tau: 10, b: -4 }, { tau: 10.5, b: 0 }, { tau: 10, b: 0.5 }]) expect(lookup(t, { s: 0.3, frac: 0.4, ...f })).toBeUndefined();
    for (const bad of [{ s: Number.NaN, frac: 0.4 }, { s: Number.POSITIVE_INFINITY, frac: 0.4 }, { s: 0.3, frac: Number.NaN }]) expect(lookup(t, { ...bad, tau: 10, b: 0 })).toBeUndefined();
  });
  it('the loaded table is deeply frozen and carries a content-derived id', () => {
    const t = table('eth-usd');
    expect(Object.isFrozen(t)).toBe(true);
    for (const part of [t.p, t.se, t.sigmaEdges, t.counts, t.counts.n2, t.golden, t.golden[0], t.dims, t.pricing]) expect(Object.isFrozen(part)).toBe(true);
    expect(t.id).toMatch(/^maya-calibrated-v3:eth-usd:2026-09-26T06:59:21\.000Z:[0-9a-f]{8}$/);
    expect(t.id).not.toBe(table('btc-usd').id);
  });
});

describe('table validation rejects malformed input', () => {
  const base = tableJson('btc-usd');
  const clone = (): Record<string, unknown> => structuredClone(base) as unknown as Record<string, unknown>;
  const reject = (mutate: (json: Record<string, unknown>) => unknown, reason: string) => {
    const json = clone(); const replaced = mutate(json);
    const result = parseCalibratedTable(replaced === undefined ? json : replaced);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  };
  it('accepts the published table', () => { expect(parseCalibratedTable(clone()).ok).toBe(true); });
  it('rejects wrong identity, rule, dims, sigma mode, market and band height', () => {
    reject(() => null, 'not-an-object');
    reject(() => [1, 2], 'not-an-object');
    reject((j) => { j.modelId = 'maya-calibrated-v2'; }, 'unsupported-model');
    reject((j) => { j.ruleVersion = 'maya-sampled-v1'; }, 'unsupported-rule');
    reject((j) => { j.sigmaBins = 12.5; }, 'invalid-dimensions');
    reject((j) => { j.tauMax = 2; }, 'invalid-dimensions');
    reject((j) => { j.prior = 0; }, 'invalid-dimensions');
    reject((j) => { j.fracBins = 4; }, 'invalid-counts');
    reject((j) => { j.sigmaMode = 'ewma'; }, 'unsupported-sigma-mode');
    reject((j) => { j.market = 'sol-usd'; }, 'unsupported-market');
    reject((j) => { j.bandHeight = 5; }, 'band-height-mismatch');
    reject((j) => { j.market = 'eth-usd'; }, 'band-height-mismatch');
  });
  it('rejects invalid pricing', () => {
    reject((j) => { (j.pricing as Record<string, unknown>).edge = 1; }, 'invalid-pricing');
    reject((j) => { (j.pricing as Record<string, unknown>).z = -1; }, 'invalid-pricing');
    reject((j) => { (j.pricing as Record<string, unknown>).capX100 = 100; }, 'invalid-pricing');
    reject((j) => { (j.pricing as Record<string, unknown>).aboveCap = 'show'; }, 'invalid-pricing');
    reject((j) => { delete j.pricing; }, 'invalid-pricing');
  });
  it('rejects bad sigma edges', () => {
    reject((j) => { (j.sigmaEdges as number[]).pop(); }, 'invalid-sigma-edges');
    reject((j) => { const e = j.sigmaEdges as number[]; [e[2], e[3]] = [e[3]!, e[2]!]; }, 'invalid-sigma-edges');
    reject((j) => { (j.sigmaEdges as unknown[])[0] = 'x'; }, 'invalid-sigma-edges');
    reject((j) => { (j.sigmaEdges as number[])[0] = -0.1; }, 'invalid-sigma-edges');
  });
  it('rejects malformed or internally inconsistent counts', () => {
    const counts = (j: Record<string, unknown>) => j.counts as Record<string, number[]>;
    reject((j) => { counts(j).n2!.pop(); }, 'invalid-counts');
    reject((j) => { counts(j).n2![100] = 1.5; }, 'invalid-counts');
    reject((j) => { counts(j).n2![100] = -1; }, 'invalid-counts');
    reject((j) => { delete counts(j).h1; }, 'invalid-counts');
    const k = base.counts.n2.findIndex((n) => n > 5);
    reject((j) => { counts(j).h2![k] = counts(j).n2![k]! + 1; }, 'inconsistent-counts');
    // A single tampered leaf breaks the exact parent sums even when h ≤ n still holds.
    reject((j) => { counts(j).n2![k] = counts(j).n2![k]! + 1; }, 'inconsistent-counts');
    reject((j) => { counts(j).h0![4] = counts(j).h0![4]! - 1; }, 'inconsistent-counts');
  });
  it('rejects bad training window, metadata and golden rows', () => {
    reject((j) => { j.trainedFrom = 'yesterday'; }, 'invalid-training-window');
    reject((j) => { j.trainedFrom = '2026-09-27T00:00:00.000Z'; }, 'invalid-training-window');
    reject((j) => { delete j.source; }, 'invalid-metadata');
    reject((j) => { j.golden = []; }, 'invalid-golden');
    reject((j) => { (j.golden as Record<string, unknown>[])[0]!.p = 'x'; }, 'invalid-golden');
    reject((j) => { (j.golden as { p: number; x100: number; key: number }[])[3]!.p += 2e-9; }, 'golden-mismatch');
    reject((j) => { (j.golden as { p: number; x100: number; key: number }[])[5]!.x100 += 1; }, 'golden-mismatch');
    reject((j) => { (j.golden as { p: number; x100: number; key: number }[])[7]!.key += 1; }, 'golden-mismatch');
    // A counts tamper that stays sum-consistent is still caught by the golden rows.
    reject((j) => {
      const g = (j.golden as { key: number }[])[0]!.key; const c = j.counts as Record<string, number[]>;
      const k1 = Math.floor(g / 5), k0 = Math.floor(k1 / 12);
      for (const [arr, idx] of [['h2', g], ['h1', k1], ['h0', k0]] as const) c[arr]![idx] = c[arr]![idx]! + 1;
      for (const [arr, idx] of [['n2', g], ['n1', k1], ['n0', k0]] as const) c[arr]![idx] = c[arr]![idx]! + 1;
    }, 'golden-mismatch');
  });
  it('can skip golden verification explicitly', () => {
    const json = clone(); (json.golden as { p: number }[])[3]!.p += 1e-6;
    expect(parseCalibratedTable(json, { verifyGolden: false }).ok).toBe(true);
  });
});
