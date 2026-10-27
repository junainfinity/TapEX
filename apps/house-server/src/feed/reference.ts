import type { MarketId } from '@maya/contracts';
import { getMarket } from '@maya/config';

/**
 * Sub-second reference price (SPEC-10 §7). It never prices or settles anything: the house uses it
 * only to stop standing quotes early when the market has clearly moved since the last first-seen
 * sample (`HouseEngine.observeReference`). Live mode only; replay has no reference.
 */
export interface ReferencePrice {
  readonly market: MarketId;
  /** Model value (float) of the reference price. */
  readonly value: number;
  /** Publisher time of the price (ms). */
  readonly publishTimeMs: number;
  /** Local receive time (ms). */
  readonly receivedAtMs: number;
  /** Confidence interval half-width as a value, when the source reports one. */
  readonly conf?: number;
}

export interface ReferenceStatus {
  readonly source: string;
  readonly connected: boolean;
  readonly messages: number;
  readonly prices: number;
  readonly reconnects: number;
  readonly lastMessageMs?: number;
  readonly lastError?: string;
  readonly markets: readonly { readonly market: MarketId; readonly lastPublishMs?: number; readonly value?: number }[];
}

export interface ReferenceFeed {
  readonly source: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onPrice(listener: (p: ReferencePrice) => void): () => void;
  status(): ReferenceStatus;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HermesOptions {
  /** Hermes base URL (default https://hermes.pyth.network). */
  readonly baseUrl?: string;
  readonly markets: readonly MarketId[];
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  /** First reconnect delay (doubles to maxBackoffMs, ±20 % jitter). */
  readonly backoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Treat a stream silent this long as stalled and reconnect. */
  readonly stallMs?: number;
  readonly log?: (line: string) => void;
}

export const HERMES_BASE_URL = 'https://hermes.pyth.network';
/** A Hermes SSE event is one JSON document; anything larger is refused. */
export const HERMES_MAX_EVENT_BYTES = 256 * 1024;

/** Stream URL for the markets' Pyth feed ids (packages/config MARKETS `feedId`), parsed prices only. */
export function hermesStreamUrl(baseUrl: string, markets: readonly MarketId[]): string {
  const ids = markets.map(m => `ids[]=${getMarket(m).feedId.replace(/^0x/, '')}`).join('&');
  return `${baseUrl.replace(/\/+$/, '')}/v2/updates/price/stream?${ids}&parsed=true&allow_unordered=false&benchmarks_only=false`;
}

/**
 * Parse one Hermes `price_update` event body: `{ parsed: [{ id, price: { price, conf, expo, publish_time } }] }`.
 * Integer mantissas are strings; value = price × 10^expo. Unknown ids, malformed entries and
 * non-positive prices are skipped (never guessed).
 */
export function parseHermesEvent(data: string, idToMarket: ReadonlyMap<string, MarketId>, receivedAtMs: number): ReferencePrice[] {
  if (data.length > HERMES_MAX_EVENT_BYTES) throw new Error('Hermes event exceeds size bound');
  const doc = JSON.parse(data) as { parsed?: unknown };
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.parsed)) return [];
  const out: ReferencePrice[] = [];
  for (const entry of doc.parsed as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { id?: unknown; price?: { price?: unknown; conf?: unknown; expo?: unknown; publish_time?: unknown } };
    const market = typeof e.id === 'string' ? idToMarket.get(e.id.toLowerCase().replace(/^0x/, '')) : undefined;
    const p = e.price;
    if (!market || !p || typeof p.price !== 'string' || !/^-?\d{1,30}$/.test(p.price) || typeof p.expo !== 'number' || !Number.isSafeInteger(p.expo) || Math.abs(p.expo) > 30
      || typeof p.publish_time !== 'number' || !Number.isSafeInteger(p.publish_time) || p.publish_time <= 0) continue;
    const value = Number(p.price) * 10 ** p.expo;
    if (!(value > 0) || !Number.isFinite(value)) continue;
    const conf = typeof p.conf === 'string' && /^\d{1,30}$/.test(p.conf) ? Number(p.conf) * 10 ** p.expo : undefined;
    out.push(Object.freeze({ market, value, publishTimeMs: p.publish_time * 1000, receivedAtMs, ...(conf !== undefined ? { conf } : {}) }));
  }
  return out;
}

/** Incremental SSE decoder (text/event-stream): yields each event's joined `data:` lines. */
export class SseDecoder {
  private buffer = '';
  private data: string[] = [];
  private event = 'message';
  push(chunk: string): { event: string; data: string }[] {
    this.buffer += chunk;
    if (this.buffer.length > HERMES_MAX_EVENT_BYTES * 2) { this.buffer = ''; this.data = []; throw new Error('SSE line exceeds size bound'); }
    const out: { event: string; data: string }[] = [];
    let nl: number;
    while ((nl = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buffer.slice(0, nl);
      const sep = this.buffer.startsWith('\r\n', nl) ? 2 : 1;
      this.buffer = this.buffer.slice(nl + sep);
      if (line === '') {
        if (this.data.length) out.push({ event: this.event, data: this.data.join('\n') });
        this.data = []; this.event = 'message';
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') this.data.push(value);
      else if (field === 'event') this.event = value;
    }
    return out;
  }
}

/**
 * Pyth Hermes SSE reference feed. Reconnects with capped exponential backoff and jitter, treats a
 * silent stream as stalled, and bounds every event. Errors never throw into the engine.
 */
export class HermesSseReference implements ReferenceFeed {
  readonly source = 'pyth-hermes-sse';
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly idToMarket: Map<string, MarketId>;
  private readonly listeners = new Set<(p: ReferencePrice) => void>();
  private readonly last = new Map<MarketId, ReferencePrice>();
  private controller: AbortController | undefined;
  private running = false;
  private loop: Promise<void> | undefined;
  private connected = false;
  private messages = 0;
  private prices = 0;
  private reconnects = 0;
  private lastMessageMs: number | undefined;
  private lastError: string | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly options: HermesOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.idToMarket = new Map(options.markets.map(m => [getMarket(m).feedId.toLowerCase().replace(/^0x/, ''), m]));
  }

  onPrice(listener: (p: ReferencePrice) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.controller?.abort();
    this.wake?.();
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
  }

  status(): ReferenceStatus {
    return {
      source: this.source, connected: this.connected, messages: this.messages, prices: this.prices, reconnects: this.reconnects,
      ...(this.lastMessageMs !== undefined ? { lastMessageMs: this.lastMessageMs } : {}), ...(this.lastError ? { lastError: this.lastError } : {}),
      markets: this.options.markets.map(market => { const p = this.last.get(market); return { market, ...(p ? { lastPublishMs: p.publishTimeMs, value: p.value } : {}) }; }),
    };
  }

  /** Feed one SSE event body (exposed for tests and for the stream loop). */
  ingest(data: string): number {
    this.messages++;
    this.lastMessageMs = this.now();
    let prices: ReferencePrice[];
    try { prices = parseHermesEvent(data, this.idToMarket, this.lastMessageMs); }
    catch (error) { this.lastError = `malformed event: ${error instanceof Error ? error.message : String(error)}`; return 0; }
    for (const p of prices) {
      const prior = this.last.get(p.market);
      if (prior && p.publishTimeMs < prior.publishTimeMs) continue; // never step back in publisher time
      this.last.set(p.market, p);
      this.prices++;
      for (const l of this.listeners) { try { l(p); } catch { /* listeners never break the feed */ } }
    }
    return prices.length;
  }

  private async run(): Promise<void> {
    let backoff = this.options.backoffMs ?? 1000;
    const maxBackoff = this.options.maxBackoffMs ?? 30_000;
    while (this.running) {
      try {
        await this.streamOnce();
        backoff = this.options.backoffMs ?? 1000;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.options.log?.(`reference: ${this.lastError}`);
      }
      this.connected = false;
      if (!this.running) break;
      this.reconnects++;
      const wait = Math.round(backoff * (0.8 + Math.random() * 0.4));
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, wait); this.wake = () => { clearTimeout(timer); resolve(); }; });
      backoff = Math.min(maxBackoff, backoff * 2);
    }
  }

  private async streamOnce(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const url = hermesStreamUrl(this.options.baseUrl ?? HERMES_BASE_URL, this.options.markets);
    const response = await this.fetchImpl(url, { method: 'GET', headers: { Accept: 'text/event-stream' }, redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Hermes HTTP ${response.status}`);
    this.connected = true;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const sse = new SseDecoder();
    const stallMs = this.options.stallMs ?? 15_000;
    let stall: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { if (stall) clearTimeout(stall); stall = setTimeout(() => controller.abort(), stallMs); };
    arm();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        for (const ev of sse.push(decoder.decode(value, { stream: true }))) this.ingest(ev.data);
      }
    } finally {
      if (stall) clearTimeout(stall);
      reader.releaseLock();
    }
    if (this.running) throw new Error('Hermes stream closed');
  }
}
