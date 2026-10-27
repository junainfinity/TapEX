import { OBSERVED_PATH_RULE_VERSION, decimalToNumber, type MarketId } from '@maya/contracts';
import { getMarket } from '@maya/config';
import { BAND_OFFSETS, H10, MIN_LEAD_S, WINDOWS, WINDOW_S, ewmaSigmaAt, exactBucket, type PathView } from './features.js';
import { multiplierX100 } from './pricing.js';
import { DEFAULT_TABLE_PRICING, H10_DEFINITION, TABLE_MODEL_ID, TABLE_SIGMA_MODE, V3_DIMS, cellKey, parseCalibratedTable, smooth, tableSizes, type CalibratedTable, type CalibratedTableJSON, type GoldenRow, type TablePricing } from './table.js';

export interface PathPoint { readonly t: number; readonly price: number }
export interface RefitOptions {
  readonly market: MarketId;
  /** Trailing training window in hours (default 36). */
  readonly trainHours?: number;
  /** Unix seconds; samples after it are ignored, so a refit only sees what had been recorded. */
  readonly now?: number;
  /** Pricing stored with the table; golden x100 values are computed at it. */
  readonly pricing?: TablePricing;
  readonly source?: string;
  /** Fewer usable quote instants than this fails with insufficient-data (default 600). */
  readonly minRows?: number;
}
export const DEFAULT_REFIT = Object.freeze({ trainHours: 36, refitHours: 6, minRows: 600, goldenRows: 48, goldenStride: 977 });
export const REFIT_SOURCE = 'Maya-Live house server: recorded first-seen 1 s prices (rolling refit)';
export type RefitRejection = 'invalid-options' | 'invalid-path' | 'insufficient-data' | 'table-rejected';
export type RefitResult =
  | { readonly ok: true; readonly json: CalibratedTableJSON; readonly table: CalibratedTable; readonly rows: number; readonly observations: number }
  | { readonly ok: false; readonly reason: RefitRejection; readonly detail: string };
/** Bound on the dense path span (memory guard). */
export const MAX_REFIT_SPAN_S = 60 * 86_400;

/**
 * maya-observed-linear-v2 on 1 s points with floats (tooling/calibrate/market-log.mjs `touches`):
 * straight segments between adjacent seconds, inclusive band [L, U], half-open window [s, e).
 * 1 hit, 0 miss, −1 unresolved (a needed point is missing). Labels only; settlement stays exact.
 */
export function touchesFast(path: PathView, s: number, e: number, L: number, U: number): 1 | 0 | -1 {
  let missing = false;
  for (let k = s - 1; k < e; k++) {
    const pa = path.get(k), pb = path.get(k + 1);
    if (pa === undefined || pb === undefined) { missing = true; continue; }
    let enter = Math.max(0, s - k), exit = Math.min(1, e - k);
    const d = pb - pa;
    if (d === 0) { if (pa < L || pa > U) continue; }
    else { const a = (L - pa) / d, b = (U - pa) / d; enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b)); }
    if (enter <= exit && enter < e - k) return 1;
  }
  return missing ? -1 : 0;
}

/** Dense second-indexed path (NaN = missing) so a 36 h refit avoids hash lookups. */
class DensePath implements PathView {
  constructor(readonly t0: number, readonly prices: Float64Array) {}
  get length(): number { return this.prices.length; }
  get(t: number): number | undefined {
    const p = this.prices[t - this.t0];
    return p === undefined || Number.isNaN(p) ? undefined : p;
  }
}

/** fit.mjs `displacementVol`: prefix sums from the path's first second, so results are bit-identical. */
function displacementVol(path: DensePath, lag: number, windowS: number, minCount: number): (t: number) => number {
  const t0 = path.t0, n = path.length;
  const sq = new Float64Array(n + 1), cnt = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    const t = t0 + i - 1, a = path.get(t - lag), b = path.get(t);
    const r = a !== undefined && b !== undefined ? Math.log(b / a) : Number.NaN;
    sq[i] = sq[i - 1]! + (Number.isFinite(r) ? r * r : 0); cnt[i] = cnt[i - 1]! + (Number.isFinite(r) ? 1 : 0);
  }
  return (t) => {
    const hi = Math.min(n, t - t0 + 1), lo = Math.max(0, hi - windowS); if (hi <= 0) return Number.NaN;
    const c = cnt[hi]! - cnt[lo]!; return c >= minCount ? Math.sqrt((sq[hi]! - sq[lo]!) / c / lag) : Number.NaN;
  };
}

function toDensePath(path: Iterable<PathPoint> | Iterable<readonly [number, number]>, now: number | undefined): DensePath | string {
  // First valid value per second wins, as fit.mjs loadPath and the game's first-seen tape do.
  const firstSeen = new Map<number, number>();
  for (const item of path as Iterable<PathPoint | readonly [number, number]>) {
    const [t, price] = Array.isArray(item) ? item as readonly [number, number] : [(item as PathPoint).t, (item as PathPoint).price];
    if (!Number.isSafeInteger(t) || (now !== undefined && t > now) || firstSeen.has(t)) continue;
    if (Number.isFinite(price) && price > 0) firstSeen.set(t, price);
  }
  if (firstSeen.size === 0) return 'path holds no valid samples';
  let t0 = Infinity, t1 = -Infinity; for (const t of firstSeen.keys()) { if (t < t0) t0 = t; if (t > t1) t1 = t; }
  if (t1 - t0 + 1 > MAX_REFIT_SPAN_S) return `path spans more than ${MAX_REFIT_SPAN_S} s`;
  const prices = new Float64Array(t1 - t0 + 1).fill(Number.NaN);
  for (const [t, price] of firstSeen) prices[t - t0] = price;
  return new DensePath(t0, prices);
}

interface Row { readonly t: number; readonly start: number; readonly bucket: number; readonly s: number; readonly frac: number }

/**
 * Rolling refit (§3.3): the fit.mjs algorithm on the server's own first-seen path. Every recorded
 * second is a synthetic quote instant (start0 = ceil((t + 3) / 5) × 5, sigma = h10 with EWMA
 * fallback, exact band index); labels use the touch rule; the published table is fitted on the
 * trailing `trainHours` of usable instants and must pass its own golden-row verification.
 */
export function refitTable(path: Iterable<PathPoint> | Iterable<readonly [number, number]>, options: RefitOptions): RefitResult {
  const fail = (reason: RefitRejection, detail: string): RefitResult => ({ ok: false, reason, detail });
  const trainHours = options.trainHours ?? DEFAULT_REFIT.trainHours;
  const minRows = options.minRows ?? DEFAULT_REFIT.minRows;
  if (options.market !== 'btc-usd' && options.market !== 'eth-usd') return fail('invalid-options', 'unsupported market');
  if (!(typeof trainHours === 'number' && trainHours > 0 && trainHours <= 24 * 60)) return fail('invalid-options', 'trainHours must be in (0, 1440]');
  if (options.now !== undefined && !Number.isSafeInteger(options.now)) return fail('invalid-options', 'now must be integer Unix seconds');
  if (!Number.isSafeInteger(minRows) || minRows < V3_DIMS.sigmaBins) return fail('invalid-options', `minRows must be an integer ≥ ${V3_DIMS.sigmaBins}`);
  const pricing = options.pricing ?? DEFAULT_TABLE_PRICING;
  const definition = getMarket(options.market);
  const h = decimalToNumber(definition.bandHeight);
  const dense = toDensePath(path, options.now);
  if (typeof dense === 'string') return fail('invalid-path', dense);
  const t0 = dense.t0, lastT = dense.t0 + dense.length - 1;
  const h10 = displacementVol(dense, H10.lag, H10.windowS, H10.minPairs);
  const startOf = (t: number): number => Math.ceil((t + MIN_LEAD_S) / WINDOW_S) * WINDOW_S;
  const usableSigma = (t: number): number | undefined => {
    if (dense.get(t) === undefined || startOf(t) + WINDOW_S * WINDOWS + 1 > lastT) return undefined;
    const ewma = ewmaSigmaAt(dense, t);
    return ewma !== undefined && ewma > 0 ? ewma : undefined;
  };
  let tEnd: number | undefined;
  for (let t = lastT; t >= t0; t--) if (usableSigma(t) !== undefined) { tEnd = t; break; }
  if (tEnd === undefined) return fail('insufficient-data', 'no usable quote instant');

  const rows: Row[] = [];
  for (let t = Math.max(t0, Math.ceil(tEnd - trainHours * 3600)); t <= tEnd; t++) {
    const ewma = usableSigma(t); if (ewma === undefined) continue;
    const spot = dense.get(t)!;
    const bucket = Number(exactBucket(spot, definition.bandHeight));
    const v = h10(t); const sigma = Number.isFinite(v) && v > 0 ? v : ewma;
    rows.push({ t, start: startOf(t), bucket, s: (sigma * spot) / h, frac: spot / h - bucket });
  }
  if (rows.length < minRows) return fail('insufficient-data', `${rows.length} usable quote instants < ${minRows}`);

  const S = V3_DIMS.sigmaBins, F = V3_DIMS.fracBins;
  const sv = rows.map((r) => r.s).sort((a, b) => a - b);
  const edges = Array.from({ length: S - 1 }, (_, k) => sv[Math.floor(((k + 1) / S) * sv.length)]!);
  const { l0, l1, l2 } = tableSizes(V3_DIMS);
  const c = { h0: new Float64Array(l0), n0: new Float64Array(l0), h1: new Float64Array(l1), n1: new Float64Array(l1), h2: new Float64Array(l2), n2: new Float64Array(l2) };
  let observations = 0;
  for (const r of rows) {
    for (let w = 0; w < WINDOWS; w++) for (const b of BAND_OFFSETS) {
      const s0 = r.start + WINDOW_S * w; const L = (r.bucket + b) * h;
      const hit = touchesFast(dense, s0, s0 + WINDOW_S, L, L + h); if (hit < 0) continue;
      const k2 = cellKey({ s: r.s, frac: r.frac, tau: s0 - r.t, b }, edges); if (k2 < 0) continue;
      const k1 = Math.floor(k2 / F), k0 = Math.floor(k1 / S);
      c.n0[k0] = c.n0[k0]! + 1; c.h0[k0] = c.h0[k0]! + hit; c.n1[k1] = c.n1[k1]! + 1; c.h1[k1] = c.h1[k1]! + hit; c.n2[k2] = c.n2[k2]! + 1; c.h2[k2] = c.h2[k2]! + hit;
      observations++;
    }
  }
  const sm = smooth(c);
  const golden: GoldenRow[] = [];
  for (let i = 0; i < rows.length && golden.length < DEFAULT_REFIT.goldenRows; i += DEFAULT_REFIT.goldenStride) {
    const r = rows[i]!; const w = golden.length % WINDOWS, b = BAND_OFFSETS[golden.length % BAND_OFFSETS.length]!;
    const tau = r.start + WINDOW_S * w - r.t;
    const k = cellKey({ s: r.s, frac: r.frac, tau, b }, edges); if (k < 0) continue;
    golden.push({ s: r.s, frac: r.frac, tau, b, key: k, p: sm.p[k]!, se: sm.se[k]!, x100: multiplierX100(sm.p[k]!, sm.se[k]!, pricing) });
  }
  const json: CalibratedTableJSON = {
    modelId: TABLE_MODEL_ID, ruleVersion: OBSERVED_PATH_RULE_VERSION, ...V3_DIMS,
    sigmaMode: TABLE_SIGMA_MODE, sigmaDefinition: H10_DEFINITION, pricing: { ...pricing }, market: options.market, bandHeight: h,
    trainedFrom: new Date(rows[0]!.t * 1000).toISOString(), trainedThrough: new Date(tEnd * 1000).toISOString(),
    source: options.source ?? REFIT_SOURCE, sigmaEdges: edges,
    counts: { h0: [...c.h0], n0: [...c.n0], h1: [...c.h1], n1: [...c.n1], h2: [...c.h2], n2: [...c.n2] }, golden,
  };
  const parsed = parseCalibratedTable(json);
  if (!parsed.ok) return fail('table-rejected', `${parsed.reason}: ${parsed.detail}`);
  return { ok: true, json, table: parsed.table, rows: rows.length, observations };
}
