import { OBSERVED_PATH_RULE_VERSION, decimalToNumber, type MarketId } from '@maya/contracts';
import { getMarket } from '@maya/config';
import { multiplierX100, type OfferParams } from './pricing.js';

export const TABLE_MODEL_ID = 'maya-calibrated-v3';
export const TABLE_SIGMA_MODE = 'h10';
export const H10_DEFINITION = 'RMS of 10 s log displacements over the trailing 600 s, divided by √10';
/** Golden rows must reproduce to this tolerance (SPEC §3.1). */
export const GOLDEN_TOLERANCE = 1e-9;

export interface TableDims {
  readonly tauMin: number;
  readonly tauMax: number;
  readonly bMax: number;
  readonly sigmaBins: number;
  readonly fracBins: number;
  readonly prior: number;
}
export const V3_DIMS: TableDims = Object.freeze({ tauMin: 3, tauMax: 32, bMax: 3, sigmaBins: 12, fracBins: 5, prior: 10 });
export type TablePricing = OfferParams;
export const DEFAULT_TABLE_PRICING: TablePricing = Object.freeze({ edge: 0.08, z: 0, minX100: 101, capX100: 5000, aboveCap: 'hide' });

export interface TableCounts<T extends ArrayLike<number> = readonly number[]> {
  readonly h0: T; readonly n0: T;
  readonly h1: T; readonly n1: T;
  readonly h2: T; readonly n2: T;
}
export interface GoldenRow {
  readonly s: number; readonly frac: number; readonly tau: number; readonly b: number;
  readonly key: number; readonly p: number; readonly se: number; readonly x100: number;
}
/** On-disk shape written by tooling/calibrate/fit.mjs (and by refitTable). */
export interface CalibratedTableJSON extends TableDims {
  readonly modelId: string;
  readonly ruleVersion: string;
  readonly sigmaMode: string;
  readonly sigmaDefinition: string;
  readonly pricing: TablePricing;
  readonly market: MarketId;
  readonly bandHeight: number;
  readonly trainedFrom: string;
  readonly trainedThrough: string;
  readonly source: string;
  readonly sigmaEdges: readonly number[];
  readonly counts: TableCounts;
  readonly golden: readonly GoldenRow[];
}
export interface CalibratedTable {
  /** Content-derived identity carried in quote provenance; a refit always gets a new id. */
  readonly id: string;
  readonly modelId: string;
  readonly ruleVersion: string;
  readonly sigmaMode: string;
  readonly market: MarketId;
  readonly bandHeight: number;
  readonly dims: TableDims;
  readonly pricing: TablePricing;
  readonly trainedFrom: string;
  readonly trainedThrough: string;
  readonly source: string;
  readonly sigmaEdges: readonly number[];
  readonly counts: TableCounts;
  readonly golden: readonly GoldenRow[];
  /** Smoothed fair probability and its standard error per key. */
  readonly p: readonly number[];
  readonly se: readonly number[];
}
export interface CellFeatures { readonly s: number; readonly frac: number; readonly tau: number; readonly b: number }
export interface TableLookup { readonly key: number; readonly p: number; readonly se: number; readonly n: number }

export function tableSizes(dims: TableDims): { readonly taus: number; readonly bands: number; readonly l0: number; readonly l1: number; readonly l2: number } {
  const taus = dims.tauMax - dims.tauMin + 1, bands = dims.bMax + 1;
  const l0 = taus * bands, l1 = l0 * dims.sigmaBins, l2 = l1 * dims.fracBins;
  return { taus, bands, l0, l1, l2 };
}

/** Number of edges ≤ s (edges are sorted). */
export function sigmaBin(edges: readonly number[], s: number): number {
  let i = 0; while (i < edges.length && s >= edges[i]!) i++; return i;
}

/** Table key for one cell (fit.mjs `cellKey`), or −1 outside the table's domain or for non-finite input. */
export function cellKey(features: CellFeatures, edges: readonly number[], dims: TableDims = V3_DIMS): number {
  const { s, frac, tau, b } = features;
  if (!Number.isFinite(s) || !Number.isFinite(frac) || !Number.isInteger(tau) || !Number.isInteger(b)) return -1;
  if (tau < dims.tauMin || tau > dims.tauMax || Math.abs(b) > dims.bMax) return -1;
  const bands = dims.bMax + 1, bins = dims.sigmaBins, fracs = dims.fracBins;
  const bAbs = Math.abs(b); const f = b < 0 ? 1 - frac : frac;
  return ((((tau - dims.tauMin) * bands + bAbs) * bins + sigmaBin(edges, s)) * fracs) + Math.min(fracs - 1, Math.floor(Math.min(0.999999, Math.max(0, f)) * fracs));
}

/**
 * fit.mjs `smooth`: hierarchical prior (tau×band → sigma bin → frac bin), then monotone
 * non-increasing in band distance, then the binomial standard error. Same operation order, so the
 * result is bit-identical to the reference.
 */
export function smooth(counts: TableCounts<ArrayLike<number>>, dims: TableDims = V3_DIMS): { readonly p: Float64Array; readonly se: Float64Array } {
  const { taus, bands, l2 } = tableSizes(dims);
  const S = dims.sigmaBins, F = dims.fracBins, prior = dims.prior;
  const p = new Float64Array(l2), se = new Float64Array(l2);
  for (let k2 = 0; k2 < l2; k2++) {
    const k1 = Math.floor(k2 / F), k0 = Math.floor(k1 / S);
    const p0 = counts.n0[k0]! ? counts.h0[k0]! / counts.n0[k0]! : 0.5;
    const p1 = (counts.h1[k1]! + prior * p0) / (counts.n1[k1]! + prior);
    p[k2] = (counts.h2[k2]! + prior * p1) / (counts.n2[k2]! + prior);
  }
  for (let tau = 0; tau < taus; tau++) for (let s = 0; s < S; s++) for (let f = 0; f < F; f++) for (let b = 1; b < bands; b++) {
    const k = ((tau * bands + b) * S + s) * F + f, prev = ((tau * bands + b - 1) * S + s) * F + f;
    if (p[k]! > p[prev]!) p[k] = p[prev]!;
  }
  for (let k = 0; k < l2; k++) se[k] = Math.sqrt((p[k]! * (1 - p[k]!)) / (counts.n2[k]! + prior));
  return { p, se };
}

/**
 * Fair probability for one cell, or undefined when the cell is outside the domain or the table holds
 * no observation at its tau×band level: the 0.5 fallback prior there is an invented price, so the
 * house fails closed instead of offering it.
 */
export function lookup(table: CalibratedTable, features: CellFeatures): TableLookup | undefined {
  const key = cellKey(features, table.sigmaEdges, table.dims);
  if (key < 0) return undefined;
  const k0 = Math.floor(Math.floor(key / table.dims.fracBins) / table.dims.sigmaBins);
  if (!(table.counts.n0[k0]! > 0)) return undefined;
  return { key, p: table.p[key]!, se: table.se[key]!, n: table.counts.n2[key]! };
}

export type TableRejection =
  | 'not-an-object' | 'unsupported-model' | 'unsupported-rule' | 'invalid-dimensions' | 'unsupported-sigma-mode'
  | 'unsupported-market' | 'band-height-mismatch' | 'invalid-pricing' | 'invalid-sigma-edges' | 'invalid-counts'
  | 'inconsistent-counts' | 'invalid-training-window' | 'invalid-metadata' | 'invalid-golden' | 'golden-mismatch';
export type TableParseResult =
  | { readonly ok: true; readonly table: CalibratedTable }
  | { readonly ok: false; readonly reason: TableRejection; readonly detail: string };
export class TableValidationError extends Error {
  constructor(readonly reason: TableRejection, detail: string) { super(`${reason}: ${detail}`); this.name = 'TableValidationError'; }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const MAX_GOLDEN = 1000;

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

function checkCounts(value: unknown, dims: TableDims): { counts: TableCounts } | { reason: TableRejection; detail: string } {
  if (!isRecord(value)) return { reason: 'invalid-counts', detail: 'counts must be an object' };
  const { l0, l1, l2 } = tableSizes(dims);
  const sizes = { h0: l0, n0: l0, h1: l1, n1: l1, h2: l2, n2: l2 } as const;
  const out: Record<string, readonly number[]> = {};
  for (const [name, size] of Object.entries(sizes)) {
    const array = value[name];
    if (!Array.isArray(array) || array.length !== size) return { reason: 'invalid-counts', detail: `${name} must have ${size} entries` };
    for (const n of array) if (!isInt(n, 0, Number.MAX_SAFE_INTEGER)) return { reason: 'invalid-counts', detail: `${name} entries must be non-negative integers` };
    out[name] = Object.freeze([...array] as number[]);
  }
  const counts = out as unknown as TableCounts;
  for (const level of ['0', '1', '2'] as const) {
    const h = counts[`h${level}`], n = counts[`n${level}`];
    for (let k = 0; k < h.length; k++) if (h[k]! > n[k]!) return { reason: 'inconsistent-counts', detail: `h${level}[${k}] exceeds n${level}[${k}]` };
  }
  // Every observation increments all three levels, so each parent is the exact sum of its children.
  const S = dims.sigmaBins, F = dims.fracBins;
  for (const [parentH, parentN, childH, childN, fan] of [[counts.h1, counts.n1, counts.h2, counts.n2, F], [counts.h0, counts.n0, counts.h1, counts.n1, S]] as const) {
    for (let k = 0; k < parentN.length; k++) {
      let hs = 0, ns = 0;
      for (let c = 0; c < fan; c++) { hs += childH[k * fan + c]!; ns += childN[k * fan + c]!; }
      if (hs !== parentH[k] || ns !== parentN[k]) return { reason: 'inconsistent-counts', detail: `level sums disagree at parent ${k}` };
    }
  }
  return { counts };
}

/** Validates a `maya-calibrated-v3` JSON document and fails closed on anything malformed. */
export function parseCalibratedTable(json: unknown, options: { readonly verifyGolden?: boolean } = {}): TableParseResult {
  const fail = (reason: TableRejection, detail: string): TableParseResult => ({ ok: false, reason, detail });
  if (!isRecord(json)) return fail('not-an-object', 'table must be a JSON object');
  if (json.modelId !== TABLE_MODEL_ID) return fail('unsupported-model', `modelId must be ${TABLE_MODEL_ID}`);
  if (json.ruleVersion !== OBSERVED_PATH_RULE_VERSION) return fail('unsupported-rule', `ruleVersion must be ${OBSERVED_PATH_RULE_VERSION}`);
  if (!isInt(json.tauMin, 0, 3600) || !isInt(json.tauMax, 0, 3600) || json.tauMax < json.tauMin || !isInt(json.bMax, 0, 16) || !isInt(json.sigmaBins, 1, 256) || !isInt(json.fracBins, 1, 256) || !isFiniteNumber(json.prior) || json.prior <= 0) return fail('invalid-dimensions', 'tau/band/bin dimensions or prior out of range');
  const dims: TableDims = Object.freeze({ tauMin: json.tauMin, tauMax: json.tauMax, bMax: json.bMax, sigmaBins: json.sigmaBins, fracBins: json.fracBins, prior: json.prior });
  if (tableSizes(dims).l2 > 1_000_000) return fail('invalid-dimensions', 'table too large');
  if (json.sigmaMode !== TABLE_SIGMA_MODE) return fail('unsupported-sigma-mode', `sigmaMode must be ${TABLE_SIGMA_MODE}`);
  if (json.market !== 'btc-usd' && json.market !== 'eth-usd') return fail('unsupported-market', 'market must be btc-usd or eth-usd');
  const market: MarketId = json.market;
  if (json.bandHeight !== decimalToNumber(getMarket(market).bandHeight)) return fail('band-height-mismatch', `bandHeight must match the ${market} market definition`);
  const pricing = json.pricing;
  if (!isRecord(pricing) || !isFiniteNumber(pricing.edge) || pricing.edge < 0 || pricing.edge >= 1 || !isFiniteNumber(pricing.z) || pricing.z < 0 || !isInt(pricing.minX100, 100, 1_000_000) || !isInt(pricing.capX100, 100, 1_000_000) || pricing.capX100 < pricing.minX100 || (pricing.aboveCap !== 'hide' && pricing.aboveCap !== 'cap')) return fail('invalid-pricing', 'pricing must hold edge, z, minX100, capX100, aboveCap');
  const tablePricing: TablePricing = Object.freeze({ edge: pricing.edge, z: pricing.z, minX100: pricing.minX100, capX100: pricing.capX100, aboveCap: pricing.aboveCap });
  const edges = json.sigmaEdges;
  if (!Array.isArray(edges) || edges.length !== dims.sigmaBins - 1 || edges.some((e, i) => !isFiniteNumber(e) || e < 0 || (i > 0 && e < (edges[i - 1] as number)))) return fail('invalid-sigma-edges', `sigmaEdges must be ${dims.sigmaBins - 1} sorted finite non-negative numbers`);
  const checked = checkCounts(json.counts, dims);
  if ('reason' in checked) return fail(checked.reason, checked.detail);
  if (typeof json.trainedFrom !== 'string' || typeof json.trainedThrough !== 'string') return fail('invalid-training-window', 'trainedFrom/trainedThrough must be ISO strings');
  const from = Date.parse(json.trainedFrom), through = Date.parse(json.trainedThrough);
  if (!Number.isFinite(from) || !Number.isFinite(through) || from > through) return fail('invalid-training-window', 'training window must be ordered ISO timestamps');
  if (typeof json.source !== 'string' || typeof json.sigmaDefinition !== 'string') return fail('invalid-metadata', 'source and sigmaDefinition must be strings');
  const golden = json.golden;
  if (!Array.isArray(golden) || golden.length < 1 || golden.length > MAX_GOLDEN) return fail('invalid-golden', `golden must hold 1..${MAX_GOLDEN} rows`);
  const rows: GoldenRow[] = [];
  for (const row of golden) {
    if (!isRecord(row) || !isFiniteNumber(row.s) || !isFiniteNumber(row.frac) || !isInt(row.tau, -1e9, 1e9) || !isInt(row.b, -1e3, 1e3) || !isInt(row.key, 0, 1e9) || !isFiniteNumber(row.p) || !isFiniteNumber(row.se) || !isInt(row.x100, -1, 1e9)) return fail('invalid-golden', 'golden rows need numeric s, frac, tau, b, key, p, se, x100');
    rows.push(Object.freeze({ s: row.s, frac: row.frac, tau: row.tau, b: row.b, key: row.key, p: row.p, se: row.se, x100: row.x100 }));
  }
  const sigmaEdges = Object.freeze([...edges] as number[]);
  const smoothed = smooth(checked.counts, dims);
  const id = `${TABLE_MODEL_ID}:${market}:${json.trainedThrough}:${fnv1a(JSON.stringify([dims, sigmaEdges, checked.counts]))}`;
  const table: CalibratedTable = Object.freeze({
    id, modelId: TABLE_MODEL_ID, ruleVersion: OBSERVED_PATH_RULE_VERSION, sigmaMode: TABLE_SIGMA_MODE, market, bandHeight: json.bandHeight, dims,
    pricing: tablePricing, trainedFrom: json.trainedFrom, trainedThrough: json.trainedThrough, source: json.source, sigmaEdges,
    counts: Object.freeze(checked.counts), golden: Object.freeze(rows), p: Object.freeze(Array.from(smoothed.p)), se: Object.freeze(Array.from(smoothed.se)),
  });
  if (options.verifyGolden ?? true) {
    for (const [i, row] of rows.entries()) {
      const mismatch = verifyGoldenRow(table, row);
      if (mismatch) return fail('golden-mismatch', `golden[${i}]: ${mismatch}`);
    }
  }
  return { ok: true, table };
}

/** Recomputes one golden row (key, p, se, x100 at the table's pricing); returns a description of any mismatch. */
export function verifyGoldenRow(table: CalibratedTable, row: GoldenRow): string | undefined {
  const key = cellKey(row, table.sigmaEdges, table.dims);
  if (key !== row.key) return `key ${key} ≠ ${row.key}`;
  const p = table.p[key]!, se = table.se[key]!;
  if (!(Math.abs(p - row.p) <= GOLDEN_TOLERANCE)) return `p ${p} ≠ ${row.p}`;
  if (!(Math.abs(se - row.se) <= GOLDEN_TOLERANCE)) return `se ${se} ≠ ${row.se}`;
  const x100 = multiplierX100(p, se, table.pricing);
  if (x100 !== row.x100) return `x100 ${x100} ≠ ${row.x100}`;
  return undefined;
}

export function loadCalibratedTable(json: unknown, options?: { readonly verifyGolden?: boolean }): CalibratedTable {
  const result = parseCalibratedTable(json, options);
  if (!result.ok) throw new TableValidationError(result.reason, result.detail);
  return result.table;
}
