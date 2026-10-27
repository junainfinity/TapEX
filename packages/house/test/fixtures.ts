import { readFileSync } from 'node:fs';
import { loadCalibratedTable, type CalibratedTable, type CalibratedTableJSON } from '../src/index.js';
import type { MarketId } from '@maya/contracts';

export const MARKETS: readonly MarketId[] = ['btc-usd', 'eth-usd'];
export const TOOLING = new URL('../../../tooling/calibrate/', import.meta.url);

export function tableJson(market: MarketId): CalibratedTableJSON {
  return JSON.parse(readFileSync(new URL(`../data/maya-calibrated-v3-${market}.json`, import.meta.url), 'utf8')) as CalibratedTableJSON;
}
const cache = new Map<MarketId, CalibratedTable>();
export function table(market: MarketId): CalibratedTable {
  let t = cache.get(market);
  if (!t) { t = loadCalibratedTable(tableJson(market)); cache.set(market, t); }
  return t;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gaussian(random: () => number): () => number {
  return () => {
    const u = Math.max(random(), 1e-12), v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}
export const roundTo = (value: number, tick: number): number => {
  const decimals = Math.round(-Math.log10(tick));
  return Number((Math.round(value / tick) * tick).toFixed(decimals));
};

export interface WalkOptions {
  readonly t0: number;
  readonly seconds: number;
  readonly start: number;
  /** Per-second log-return volatility. */
  readonly sigma: number;
  readonly tick: number;
  readonly seed: number;
  /** Probability a second is missing. */
  readonly gapRate?: number;
  /** Probability the price repeats (flat segment). */
  readonly flatRate?: number;
  /** Seconds [from, to) removed entirely (a feed outage). */
  readonly outages?: readonly (readonly [number, number])[];
}
/** First-seen 1 s path on a decimal tick grid, with optional gaps, flats and outages. */
export function randomWalk(options: WalkOptions): Map<number, number> {
  const random = rng(options.seed); const normal = gaussian(random);
  const path = new Map<number, number>();
  let price = options.start;
  for (let i = 0; i < options.seconds; i++) {
    const t = options.t0 + i;
    if (random() >= (options.flatRate ?? 0)) price = roundTo(price * Math.exp(options.sigma * normal()), options.tick);
    if (random() < (options.gapRate ?? 0)) continue;
    if (options.outages?.some(([a, b]) => t >= a && t < b)) continue;
    path.set(t, price);
  }
  return path;
}
