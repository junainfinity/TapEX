import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseDecimal, type MarketId } from '@maya/contracts';
import { DEFAULT_EDGE_SCHEDULE, DEFAULT_PRICING_CONFIG, DEFENSES_OFF, type EdgeScheduleConfig } from '@maya/house';
import { DEFAULT_ENGINE_LIMITS, HouseEngine, type EngineConfig, type EngineLimits } from '../src/engine/engine.js';
import type { FeedSample } from '../src/feed/types.js';
import type { LogRow } from '../src/feed/csv.js';
import { MemoryJournal, type JournalSink } from '../src/ledger/journal.js';
import type { HouseQuote } from '../src/quotes/quote-book.js';
import { TableRegistry } from '../src/refit/tables.js';

export const T0 = 1_790_000_000; // 2026-09-21T13:46:40Z
export const LAG_MS = 500;

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

/** Random-walk prices on a 0.01 tick; returns decimal text per second. */
export function walk(options: { t0: number; seconds: number; start: number; sigma: number; seed: number; gaps?: readonly (readonly [number, number])[] }): Map<number, string> {
  const random = rng(options.seed);
  const out = new Map<number, string>();
  let price = options.start;
  for (let i = 0; i < options.seconds; i++) {
    const u = Math.max(random(), 1e-12), v = random();
    price *= Math.exp(options.sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
    const t = options.t0 + i;
    if (options.gaps?.some(([a, b]) => t >= a && t < b)) continue;
    out.set(t, price.toFixed(2));
  }
  return out;
}

export function sample(market: MarketId, t: number, priceText: string, receivedAtMs = t * 1000 + LAG_MS): FeedSample {
  return Object.freeze({ market, t, priceText, price: Object.freeze(parseDecimal(priceText)), value: Number(priceText), receivedAtMs });
}

export const tables = (() => { const r = new TableRegistry(); r.loadPublished(['btc-usd', 'eth-usd']); return r; })();

export interface TestEngineOptions {
  readonly markets?: readonly MarketId[];
  readonly limits?: Partial<EngineLimits>;
  readonly schedule?: EdgeScheduleConfig;
  readonly journal?: JournalSink;
  readonly bankrollCenti?: string;
  readonly config?: Partial<EngineConfig>;
  readonly records?: Parameters<HouseEngine['open']>[0];
  readonly warm?: boolean;
}

/** 20 minutes of warm-up history ending at T0 − 1 (h10 needs 600 s). */
export const HISTORY = walk({ t0: T0 - 1200, seconds: 1200, start: 60_000, sigma: 3e-5, seed: 7 });
export const HISTORY_ETH = walk({ t0: T0 - 1200, seconds: 1200, start: 2_500, sigma: 4e-5, seed: 8 });

export function warmSamples(markets: readonly MarketId[] = ['btc-usd']): FeedSample[] {
  const out: FeedSample[] = [];
  for (const m of markets) for (const [t, p] of m === 'btc-usd' ? HISTORY : HISTORY_ETH) out.push(sample(m, t, p));
  return out;
}

export function makeEngine(options: TestEngineOptions = {}): { engine: HouseEngine; journal: JournalSink } {
  const markets = options.markets ?? ['btc-usd'];
  const journal = options.journal ?? new MemoryJournal();
  const engine = new HouseEngine({
    // Stage A engine tests run with the SPEC-10 defenses off unless a test opts in through config.defenses.
    config: { markets, pricing: DEFAULT_PRICING_CONFIG, schedule: options.schedule ?? DEFAULT_EDGE_SCHEDULE, limits: { ...DEFAULT_ENGINE_LIMITS, ...options.limits }, defenses: DEFENSES_OFF, ...options.config },
    journal, tables, runId: 'test-run', bootId: 'b1', startMs: (T0 - 1) * 1000,
  });
  if (options.warm !== false) engine.warm(warmSamples(markets));
  engine.open(options.records ?? []);
  if (!options.records?.length) engine.recordTreasury('sync', options.bankrollCenti ?? '100000000');
  return { engine, journal };
}

/** Deliver second `t` (and nothing else) at t·1000 + LAG_MS. */
export function deliver(engine: HouseEngine, market: MarketId, t: number, price: string, atMs = t * 1000 + LAG_MS) {
  return engine.step(atMs, [sample(market, t, price, atMs)]);
}

/** Continue the warm-up walk for n seconds from T0, delivering each second. */
export function run(engine: HouseEngine, from: number, prices: ReadonlyMap<number, string>, to: number, market: MarketId = 'btc-usd'): void {
  for (let t = from; t <= to; t++) {
    const p = prices.get(t);
    if (p !== undefined) deliver(engine, market, t, p); else engine.step(t * 1000 + LAG_MS, []);
  }
}

export function offered(engine: HouseEngine, market: MarketId = 'btc-usd', flagged = false): HouseQuote[] {
  return (engine.latestGrid(market, flagged)?.quotes ?? []).filter((q): q is HouseQuote => q !== null);
}

let simSeq = 0;
export function simPlayer(engine: HouseEngine, creditCenti = '1000000', strategy = 'casual'): string {
  const account = `sim:t${String(++simSeq).padStart(5, '0')}`;
  const r = engine.register(account, 'sim', strategy);
  if (!r.ok) throw new Error('register failed');
  engine.grantSimCredit(account, creditCenti, `grant:${account}`);
  return account;
}

export function tempDir(prefix = 'house-test-'): string { return mkdtempSync(join(tmpdir(), prefix)); }

/** Write a synthetic market log (gz CSV segments named like the recorder's) for the given paths. */
export function writeMarketLog(root: string, paths: Readonly<Partial<Record<MarketId, ReadonlyMap<number, string>>>>, lagMs = 800): void {
  const dir = join(root, '2026-09'); mkdirSync(dir, { recursive: true });
  for (const [market, path] of Object.entries(paths) as [MarketId, ReadonlyMap<number, string>][]) {
    const bySegment = new Map<number, string[]>();
    for (const [t, p] of [...path].sort((a, b) => a[0] - b[0])) {
      const seg = Math.floor((t * 1000) / (5 * 3_600_000)) * 5 * 3_600_000;
      let rows = bySegment.get(seg); if (!rows) { rows = []; bySegment.set(seg, rows); }
      rows.push(`${t},${p},${p},${lagMs}`);
    }
    for (const [seg, rows] of bySegment) {
      const d = new Date(seg);
      const name = `prices-${market}-${d.toISOString().slice(0, 13).replace(/[-:]/g, '').replace('T', 'T')}00Z.csv.gz`;
      writeFileSync(join(dir, name), gzipSync(`t,first,final,lag_ms\n${rows.join('\n')}\n`));
    }
  }
}

export function logRows(path: ReadonlyMap<number, string>, lagMs = 800): LogRow[] {
  return [...path].sort((a, b) => a[0] - b[0]).map(([t, p]) => ({ t, priceText: p, lagMs }));
}
