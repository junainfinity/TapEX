import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OBSERVED_PATH_RULE_VERSION, createCell, parseDecimal, segmentTouchesCell, type DecimalValue, type MarketId } from '@maya/contracts';
import { getMarket } from '@maya/config';
import {
  DEFAULT_EDGE_SCHEDULE, DEFAULT_PRICING_CONFIG, DEFAULT_RISK_LIMITS, DEFAULT_TABLE_PRICING, LiabilityBook, REFIT_SOURCE, buildQuoteGrid, ewmaSigmaAt, exactBucket,
  lookup, parseCalibratedTable, refitTable, touchesFast, type CalibratedTableJSON, type PathView,
} from '../src/index.js';
import { MARKETS, TOOLING, gaussian, randomWalk, rng, roundTo, table } from './fixtures.js';

type Touches = (path: Map<number, number>, s: number, e: number, L: number, U: number) => number;
const marketLog = (await import(new URL('market-log.mjs', TOOLING).href)) as { touches: Touches };

function exactTouch(path: PathView, market: MarketId, s: number, lower: DecimalValue, upper: DecimalValue): 1 | 0 | -1 {
  const cell = createCell(market, s * 1000, lower, upper, OBSERVED_PATH_RULE_VERSION);
  let missing = false;
  for (let k = s - 1; k < s + 5; k++) {
    const pa = path.get(k), pb = path.get(k + 1);
    if (pa === undefined || pb === undefined) { missing = true; continue; }
    if (segmentTouchesCell({ marketId: market, sourceTimeMs: k * 1000, price: parseDecimal(String(pa)) }, { marketId: market, sourceTimeMs: (k + 1) * 1000, price: parseDecimal(String(pb)) }, cell)) return 1;
  }
  return missing ? -1 : 0;
}

describe('fast float touch rule', () => {
  it('agrees with the exact @maya/contracts segment touch (and market-log.mjs) on 12,000 random cells incl. boundary ties', () => {
    const random = rng(2026); const normal = gaussian(random);
    const tally = { hit: 0, miss: 0, unresolved: 0, boundaryHits: 0, flatSegments: 0 };
    for (let i = 0; i < 12_000; i++) {
      const market: MarketId = random() < 0.5 ? 'btc-usd' : 'eth-usd';
      const h = market === 'btc-usd' ? 10 : 0.5, tick = market === 'btc-usd' ? 0.01 : 0.001;
      const s = 1_790_000_000 + 5 * Math.floor(random() * 1_000_000);
      const base = market === 'btc-usd' ? 60_000 + random() * 1000 : 2500 + random() * 50;
      const bucket = Math.floor(base / h) + Math.floor(random() * 7) - 3;
      const L = bucket * h, U = L + h;
      const boundaries = [L, U, L - h, U + h];
      const path = new Map<number, number>(); let p = roundTo(base, tick); let boundary = false;
      for (let k = s - 1; k <= s + 5; k++) {
        const r = random();
        if (r < 0.2) { p = boundaries[Math.floor(random() * boundaries.length)]!; if (p === L || p === U) boundary = true; }
        else if (r < 0.3) tally.flatSegments++;
        else p = roundTo(p + normal() * h * 0.8, tick);
        if (random() < 0.03) continue;
        path.set(k, p);
      }
      const fast = touchesFast(path, s, s + 5, L, U);
      const reference = marketLog.touches(path, s, s + 5, L, U);
      const exact = exactTouch(path, market, s, parseDecimal(String(L)), parseDecimal(String(U)));
      expect({ i, fast, reference }).toEqual({ i, fast: exact, reference: exact });
      if (exact === 1) { tally.hit++; if (boundary) tally.boundaryHits++; } else if (exact === 0) tally.miss++; else tally.unresolved++;
    }
    expect(tally.hit).toBeGreaterThan(2000);
    expect(tally.miss).toBeGreaterThan(2000);
    expect(tally.unresolved).toBeGreaterThan(200);
    expect(tally.boundaryHits).toBeGreaterThan(500);
    expect(tally.flatSegments).toBeGreaterThan(5000);
  });
  it('handles hand-picked edge cases exactly like the settlement rule', () => {
    const at = (entries: [number, number][]) => new Map(entries);
    // Touch exactly at the window end is excluded (half-open); at the start it counts.
    expect(touchesFast(at([[9, 5], [10, 5], [11, 5], [12, 5], [13, 5], [14, 5], [15, 20]]), 10, 15, 20, 30)).toBe(0);
    expect(touchesFast(at([[9, 0], [10, 20], [11, 0], [12, 0], [13, 0], [14, 0], [15, 0]]), 10, 15, 20, 30)).toBe(1);
    // Crossing inside the lead segment before the window starts does not count.
    expect(touchesFast(at([[9, 25], [10, 35], [11, 35], [12, 35], [13, 35], [14, 35], [15, 35]]), 10, 15, 20, 30)).toBe(0);
    // A missing point is unresolved unless a hit is already proven.
    expect(touchesFast(at([[9, 0], [10, 0], [12, 0], [13, 0], [14, 0], [15, 0]]), 10, 15, 20, 30)).toBe(-1);
    expect(touchesFast(at([[9, 0], [10, 25], [12, 0], [13, 0], [14, 0], [15, 0]]), 10, 15, 20, 30)).toBe(1);
  });
});

const T0 = 1_790_000_000;
const FIXTURE_S = 9000;
const paths: Record<MarketId, Map<number, number>> = {
  'btc-usd': randomWalk({ t0: T0, seconds: FIXTURE_S, start: 60_000, sigma: 3e-5, tick: 0.01, seed: 101, gapRate: 0.01, flatRate: 0.05, outages: [[T0 + 4000, T0 + 4020]] }),
  'eth-usd': randomWalk({ t0: T0, seconds: FIXTURE_S, start: 2500, sigma: 4e-5, tick: 0.01, seed: 202, gapRate: 0.01, flatRate: 0.05, outages: [[T0 + 6100, T0 + 6107]] }),
};

/** Writes the paths as market-log CSVs and runs the real tooling/calibrate/fit.mjs CLI on them. */
function runFitCli(dir: string, trainHours: number): Record<MarketId, CalibratedTableJSON> {
  const root = join(dir, 'market-data'), out = join(dir, 'out');
  mkdirSync(join(root, 'day'), { recursive: true });
  for (const market of MARKETS) {
    const path = paths[market]; const band = getMarket(market).bandHeight;
    const prices = ['t,first,final']; const odds = ['t,age_ms,spot,sigma,start,bucket,' + Array.from({ length: 42 }, (_, i) => `w${Math.floor(i / 7)}b${(i % 7) - 3}`).join(',')];
    for (const [t, p] of [...path].sort(([a], [b]) => a - b)) {
      prices.push(`${t},${p},${p}`);
      // Synthetic quote instants: the refit's own start rule, exact bucket and EWMA fallback sigma.
      odds.push(`${t},0,${p},${ewmaSigmaAt(path, t) ?? 0},${Math.ceil((t + 3) / 5) * 5},${exactBucket(p, band)},${Array(42).fill(-1).join(',')}`);
    }
    writeFileSync(join(root, 'day', `prices-${market}-2026-09-21.csv.gz`), gzipSync(prices.join('\n') + '\n'));
    writeFileSync(join(root, 'day', `odds-${market}-2026-09-21.csv.gz`), gzipSync(odds.join('\n') + '\n'));
  }
  const env = { ...process.env }; delete env.MAYA_PRIOR;
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('fit.mjs', TOOLING)), root, '--out', out, '--sigma', 'h10', '--train-hours', String(trainHours), '--refit-hours', '0.5'], { encoding: 'utf8', env, timeout: 120_000 });
  if (run.status !== 0) throw new Error(`fit.mjs failed: ${run.stderr}`);
  return Object.fromEntries(MARKETS.map((m) => [m, JSON.parse(readFileSync(join(out, `maya-calibrated-v3-${m}.json`), 'utf8'))])) as Record<MarketId, CalibratedTableJSON>;
}

describe('rolling refit', () => {
  let dir = '';
  let reference: Record<MarketId, CalibratedTableJSON>;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'maya-house-refit-')); reference = runFitCli(dir, 1); }, 180_000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  for (const market of MARKETS) {
    it(`${market}: reproduces the fit.mjs table for the same path exactly (edges, counts, golden rows, window)`, () => {
      const cli = reference[market];
      const result = refitTable(paths[market], { market, trainHours: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { json } = result;
      const { source: cliSource, ...cliRest } = cli; const { source, ...ours } = json;
      expect(ours).toEqual(cliRest);
      expect(cliSource).toMatch(/Maya market log/);
      expect(source).toBe(REFIT_SOURCE);
      expect(json.golden.length).toBeGreaterThanOrEqual(3);
      expect(result.rows).toBeGreaterThan(3500);
      expect(result.observations).toBe(json.counts.n0.reduce((a, b) => a + b, 0));
      // fit.mjs output passes the house validator (incl. golden verification) and yields the same table identity.
      const parsed = parseCalibratedTable(cli);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.table.id).toBe(result.table.id);
      expect(result.table.id).not.toBe(table(market).id);
    });
  }

  it('accepts a PathPoint iterable, keeps first-seen values and ignores samples after `now`', () => {
    const market: MarketId = 'btc-usd'; const path = paths[market];
    const points = [...path].map(([t, price]) => ({ t, price }));
    // Later revisions for the same second and invalid prices must not change the result.
    const noisy = [...points, ...points.slice(0, 500).map((p) => ({ t: p.t, price: p.price + 1 })), { t: T0 + 10.5, price: 1 }, { t: T0 + 20_000, price: -1 }];
    const a = refitTable(path, { market, trainHours: 1 }), b = refitTable(noisy, { market, trainHours: 1 });
    expect(a.ok && b.ok && b.json).toEqual(a.ok && a.json);
    const now = T0 + 6000;
    const truncated = refitTable(path, { market, trainHours: 1, now });
    const filtered = refitTable([...path].filter(([t]) => t <= now), { market, trainHours: 1 });
    expect(truncated.ok && filtered.ok).toBe(true);
    if (truncated.ok && filtered.ok) {
      expect(truncated.json).toEqual(filtered.json);
      expect(Date.parse(truncated.json.trainedThrough)).toBeLessThanOrEqual((now - 31) * 1000);
      expect(truncated.table.id).not.toBe(a.ok ? a.table.id : '');
    }
  });

  it('observes tau 3 (the refit uses the live start rule) and plugs straight into the quote grid without touching issued quotes', () => {
    const market: MarketId = 'btc-usd'; const path = paths[market];
    const result = refitTable(path, { market, trainHours: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.json.counts.n0.slice(0, 4).reduce((x, y) => x + y, 0)).toBeGreaterThan(0);
    expect(lookup(result.table, { s: result.json.golden[0]!.s, frac: 0.5, tau: 3, b: 0 })).toBeDefined();
    const t = T0 + FIXTURE_S - 1; const spot = parseDecimal(String(path.get(t)!));
    const base = { market, t, spot, path, pricing: DEFAULT_PRICING_CONFIG, schedule: DEFAULT_EDGE_SCHEDULE, registeredPlayers: 0, limits: DEFAULT_RISK_LIMITS, book: new LiabilityBook(), equityCenti: 100_000_000n } as const;
    const issued = buildQuoteGrid({ ...base, table: table(market) });
    const snapshot = JSON.stringify(issued);
    const next = buildQuoteGrid({ ...base, table: result.table });
    expect(next.tableId).toBe(result.table.id);
    expect(next.cells.some((c) => c.available)).toBe(true);
    expect(JSON.stringify(issued)).toBe(snapshot);
    expect(issued.tableId).toBe(table(market).id);
  });

  it('fails closed on bad options, empty or oversized paths and too little data', () => {
    const path = paths['eth-usd'];
    expect(refitTable(path, { market: 'sol-usd' as MarketId })).toMatchObject({ ok: false, reason: 'invalid-options' });
    expect(refitTable(path, { market: 'eth-usd', trainHours: 0 })).toMatchObject({ ok: false, reason: 'invalid-options' });
    expect(refitTable(path, { market: 'eth-usd', now: 1.5 })).toMatchObject({ ok: false, reason: 'invalid-options' });
    expect(refitTable(path, { market: 'eth-usd', minRows: 3 })).toMatchObject({ ok: false, reason: 'invalid-options' });
    expect(refitTable([], { market: 'eth-usd' })).toMatchObject({ ok: false, reason: 'invalid-path' });
    expect(refitTable([[0, 1], [61 * 86_400, 1]], { market: 'eth-usd' })).toMatchObject({ ok: false, reason: 'invalid-path' });
    expect(refitTable([...path].slice(0, 20), { market: 'eth-usd' })).toMatchObject({ ok: false, reason: 'insufficient-data' });
    expect(refitTable([...path].slice(0, 400), { market: 'eth-usd' })).toMatchObject({ ok: false, reason: 'insufficient-data' });
    expect(refitTable(path, { market: 'eth-usd', trainHours: 0.1 })).toMatchObject({ ok: false, reason: 'insufficient-data' });
    expect(refitTable(path, { market: 'eth-usd', pricing: { ...DEFAULT_TABLE_PRICING, capX100: 50 } })).toMatchObject({ ok: false, reason: 'table-rejected' });
  });
});
