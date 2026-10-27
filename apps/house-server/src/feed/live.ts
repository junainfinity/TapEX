import { compareDecimal, parseDecimal, type DecimalValue, type MarketDefinition, type MarketId } from '@maya/contracts';
import { getMarket } from '@maya/config';
import type { Feed, FeedSample, FeedStatus } from './types.js';

export const RELAY_MAX_BYTES = 2_000_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LiveFeedOptions {
  /** Base URL of apps/feed-relay (default http://127.0.0.1:8787). */
  readonly relayUrl: string;
  readonly markets: readonly MarketId[];
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly uncertaintyMs?: number;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

export interface RelayPrice { readonly t: number; readonly priceText: string; readonly price: DecimalValue }

/**
 * Parse a relay `/api/prices/<pair>` body (packages/market-data normalization.ts contract):
 * `{ chain: 'bsc', pair, feedId, count, prices: [{ t: epoch seconds, p }] }`, keeping each price's
 * exact source lexeme. Throws on any authority or shape mismatch.
 */
export function parseRelayPrices(text: string, market: MarketDefinition): RelayPrice[] {
  if (text.length > RELAY_MAX_BYTES) throw new Error('Source JSON exceeds size bound');
  // JSON.parse source-text access (Node 24) preserves numeric lexemes before any Number conversion.
  const reviver = (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' ? { lexeme: context?.source ?? String(value) } : value;
  const data = JSON.parse(text, reviver as (key: string, value: unknown) => unknown) as Record<string, unknown>;
  const int = (v: unknown): number => {
    const lexeme = (v as { lexeme?: unknown })?.lexeme;
    if (typeof lexeme !== 'string' || !/^\d{1,15}$/.test(lexeme)) throw new Error('Expected source integer');
    return Number(lexeme);
  };
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected object');
  if (data['chain'] !== 'bsc' || int(data['pair']) !== market.pairId || typeof data['feedId'] !== 'string' || data['feedId'].toLowerCase() !== market.feedId) throw new Error('Price buffer authority mismatch');
  const prices = data['prices'];
  if (!Array.isArray(prices) || prices.length < 2 || prices.length > 1000 || int(data['count']) !== prices.length) throw new Error('Invalid price buffer size');
  return prices.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Expected price object');
    const row = entry as Record<string, unknown>;
    const lexeme = (row['p'] as { lexeme?: unknown })?.lexeme;
    if (typeof lexeme !== 'string') throw new Error('Source price must be a numeric lexeme');
    const price = parseDecimal(lexeme);
    if (compareDecimal(price, { coefficient: '0', exponent: 0 }) <= 0) throw new Error('Source price must be positive');
    return { t: int(row['t']), priceText: lexeme, price };
  }).sort((a, b) => a.t - b.t);
}

/**
 * Polls the local relay once per second per market and emits each source second the first time it
 * is seen (first-seen pin: later revisions of a second are ignored). The clock is the wall clock.
 */
export class LiveFeed implements Feed {
  readonly mode = 'live' as const;
  readonly markets: readonly MarketId[];
  readonly uncertaintyMs: number;
  speed = 1;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly seen = new Map<MarketId, Map<number, true>>();
  private readonly lastT = new Map<MarketId, number>();
  private readonly errors = new Map<MarketId, string>();
  private buffer: FeedSample[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly inflight = new Set<MarketId>();

  constructor(private readonly options: LiveFeedOptions) {
    this.markets = Object.freeze([...options.markets]);
    this.uncertaintyMs = options.uncertaintyMs ?? 500;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    for (const m of this.markets) this.seen.set(m, new Map());
  }

  nowMs(): number { return this.now(); }

  async start(): Promise<void> {
    await Promise.all(this.markets.map(m => this.pollMarket(m)));
    this.timer = setInterval(() => { for (const m of this.markets) void this.pollMarket(m); }, this.options.pollMs ?? 1000);
    this.timer.unref?.();
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  advance(): readonly FeedSample[] {
    const out = this.buffer; this.buffer = [];
    return out;
  }

  /** One poll; exposed for tests. Errors are recorded per market and never throw. */
  async pollMarket(market: MarketId): Promise<void> {
    if (this.inflight.has(market)) return;
    this.inflight.add(market);
    try {
      const def = getMarket(market);
      const url = `${this.options.relayUrl.replace(/\/+$/, '')}/api/prices/${def.pairId}`;
      const response = await this.fetchImpl(url, { method: 'GET', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 3000) });
      if (!response.ok) throw new Error(`relay HTTP ${response.status}`);
      const text = await response.text();
      this.ingest(market, parseRelayPrices(text, def), this.now());
      this.errors.delete(market);
    } catch (error) {
      this.errors.set(market, error instanceof Error ? error.message : String(error));
    } finally { this.inflight.delete(market); }
  }

  /** Pin first-seen seconds; prune the seen-set to the trailing 30 minutes. */
  ingest(market: MarketId, prices: readonly RelayPrice[], receivedAtMs: number): void {
    const seen = this.seen.get(market)!;
    for (const p of prices) {
      if (seen.has(p.t) || p.t * 1000 > receivedAtMs + 5000) continue;
      seen.set(p.t, true);
      this.buffer.push(Object.freeze({ market, t: p.t, priceText: p.priceText, price: Object.freeze(p.price), value: Number(p.priceText), receivedAtMs }));
      if (p.t > (this.lastT.get(market) ?? 0)) this.lastT.set(market, p.t);
    }
    const floor = (this.lastT.get(market) ?? 0) - 1800;
    if (seen.size > 4000) for (const t of seen.keys()) { if (t < floor) seen.delete(t); else break; }
  }

  status(): FeedStatus {
    return { mode: 'live', clockMs: this.now(), speed: 1, markets: this.markets.map(market => ({ market, ...(this.lastT.has(market) ? { lastT: this.lastT.get(market)! } : {}), ...(this.errors.has(market) ? { lastError: this.errors.get(market)! } : {}) })) };
  }
}
