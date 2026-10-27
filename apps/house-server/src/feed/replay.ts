import { parseDecimal, type MarketId } from '@maya/contracts';
import { loadMarketRows, type LogRow } from './csv.js';
import type { Feed, FeedSample, FeedStatus } from './types.js';

/** Delivery delay cap: a row first seen later than this was backfilled after a recorder restart. */
export const MAX_REPLAY_LAG_MS = 3000;

export interface ReplayData {
  readonly market: MarketId;
  readonly rows: readonly LogRow[];
}

export interface ReplayOptions {
  readonly markets: readonly MarketId[];
  readonly fromMs: number;
  /** Exclusive end of replay; defaults to the end of the loaded data. */
  readonly toMs?: number;
  /** Seconds of recorded history before `fromMs` offered as warm-up path (not replayed). */
  readonly warmupS?: number;
  readonly speed?: number;
}

interface Delivery { readonly atMs: number; readonly market: MarketId; readonly row: LogRow }

/**
 * Deterministic replay of the recorded market log. The server clock is the feed clock: each row is
 * delivered at its source second plus its recorded first-sighting lag (capped, and never before the
 * previous row of that market), so the same log always yields the same sample/clock sequence.
 */
export class ReplayFeed implements Feed {
  readonly mode = 'replay' as const;
  readonly uncertaintyMs = 0;
  readonly markets: readonly MarketId[];
  readonly fromMs: number;
  readonly endMs: number;
  speed: number;
  private clock: number;
  private cursor = 0;
  private readonly deliveries: Delivery[];
  private readonly warm = new Map<MarketId, FeedSample[]>();
  private readonly future = new Map<MarketId, Map<number, LogRow>>();
  private readonly lastT = new Map<MarketId, number>();

  static load(root: string, options: ReplayOptions): ReplayFeed {
    const warmupMs = (options.warmupS ?? 0) * 1000;
    const toMs = options.toMs ?? Number.MAX_SAFE_INTEGER;
    const data = options.markets.map(market => ({ market, rows: loadMarketRows(root, market, options.fromMs - warmupMs, toMs) }));
    return new ReplayFeed(data, options);
  }

  constructor(data: readonly ReplayData[], options: ReplayOptions) {
    if (!Number.isSafeInteger(options.fromMs) || options.fromMs < 0) throw new RangeError('Replay start must be integer ms');
    this.markets = Object.freeze([...options.markets]);
    this.fromMs = options.fromMs;
    this.speed = options.speed ?? 20;
    this.clock = options.fromMs;
    const deliveries: Delivery[] = [];
    let lastRow = options.fromMs;
    for (const { market, rows } of data) {
      if (!this.markets.includes(market)) continue;
      const warm: FeedSample[] = []; const future = new Map<number, LogRow>();
      let prevAt = 0;
      for (const row of rows) {
        const atMs = Math.max(prevAt, row.t * 1000 + Math.min(Math.max(row.lagMs, 0), MAX_REPLAY_LAG_MS));
        prevAt = atMs;
        if (row.t * 1000 < options.fromMs) { warm.push(toSample(market, row, atMs)); continue; }
        if (options.toMs !== undefined && row.t * 1000 >= options.toMs) continue;
        deliveries.push({ atMs, market, row }); future.set(row.t, row);
        if (row.t * 1000 > lastRow) lastRow = row.t * 1000;
      }
      this.warm.set(market, warm); this.future.set(market, future);
    }
    const order = new Map(this.markets.map((m, i) => [m, i]));
    deliveries.sort((a, b) => a.atMs - b.atMs || order.get(a.market)! - order.get(b.market)! || a.row.t - b.row.t);
    this.deliveries = deliveries;
    this.endMs = options.toMs ?? lastRow + MAX_REPLAY_LAG_MS + 1000;
  }

  nowMs(): number { return this.clock; }
  get done(): boolean { return this.clock >= this.endMs; }
  get remaining(): number { return this.deliveries.length - this.cursor; }

  /** Recorded path before the replay start (warm-up for volatility and the first refit). */
  history(market: MarketId): readonly FeedSample[] { return this.warm.get(market) ?? []; }

  /** Replay-only lookahead used by the adversarial sniper strategy; the server never calls it. */
  peek(market: MarketId, t: number): number | undefined {
    const row = this.future.get(market)?.get(t);
    return row ? Number(row.priceText) : undefined;
  }

  advance(toMs?: number): readonly FeedSample[] {
    const target = toMs ?? this.clock;
    if (!Number.isFinite(target) || target < this.clock) return [];
    this.clock = Math.min(target, Math.max(this.endMs, this.clock));
    const out: FeedSample[] = [];
    while (this.cursor < this.deliveries.length && this.deliveries[this.cursor]!.atMs <= this.clock) {
      const d = this.deliveries[this.cursor++]!;
      out.push(toSample(d.market, d.row, d.atMs));
      this.lastT.set(d.market, d.row.t);
    }
    return out;
  }

  async start(): Promise<void> { /* data is preloaded; the app drives the clock */ }
  async stop(): Promise<void> { /* nothing to release */ }

  status(): FeedStatus {
    return { mode: 'replay', clockMs: this.clock, speed: this.speed, done: this.done, markets: this.markets.map(market => ({ market, ...(this.lastT.has(market) ? { lastT: this.lastT.get(market)! } : {}) })) };
  }
}

function toSample(market: MarketId, row: LogRow, atMs: number): FeedSample {
  return Object.freeze({ market, t: row.t, priceText: row.priceText, price: Object.freeze(parseDecimal(row.priceText)), value: Number(row.priceText), receivedAtMs: atMs });
}
