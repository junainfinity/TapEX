import { OBSERVED_PATH_RULE_VERSION, parseDecimal, type MarketId, type PriceSample, type QuoteSnapshot } from '@maya/contracts';
import { getMarket } from '@maya/config';
import { HouseError, type HouseApi, type QuotesResponse } from './house-api.js';

/** Seconds of pinned path kept for the chart (the board shows about two minutes of history). */
const KEEP_SECONDS = 600;
/** The house calls a feed stale after 7 s without a fresh second (SPEC §4); the chart says so too. */
export const STALE_AFTER_MS = 7_000;

export interface FeedHealth { readonly status: 'loading' | 'ready' | 'stale' | 'unavailable'; readonly message: string }

/**
 * The house's own view of the market: its pinned first-seen path (GET /v1/path, the exact path settlement uses) and
 * its quote grid (GET /v1/quotes, immutable server quotes). Nothing here prices anything: the browser only draws and
 * names quotes the house issued. The clock is the house clock, extrapolated between answers.
 */
export class HouseMarketFeed {
  private market: MarketId;
  private readonly samples = new Map<MarketId, PriceSample[]>();
  private quoteByCell = new Map<string, QuoteSnapshot>();
  private quotesInfo: QuotesResponse | undefined;
  private clockBase: { serverMs: number; perfMs: number; speed: number } | undefined;
  private lastNow = 0;
  private pathTimer: ReturnType<typeof setTimeout> | undefined;
  private quoteTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private pathError: string | undefined;
  private quoteError: string | undefined;
  private readonly listeners = new Set<() => void>();
  private generation = 0;

  constructor(private readonly api: HouseApi, market: MarketId) { this.market = market; }

  start(): void { if (!this.stopped) return; this.stopped = false; void this.pollPath(); void this.pollQuotes(); }
  stop(): void { this.stopped = true; if (this.pathTimer) clearTimeout(this.pathTimer); if (this.quoteTimer) clearTimeout(this.quoteTimer); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { for (const l of this.listeners) l(); }

  setMarket(market: MarketId): void {
    if (market === this.market) return;
    this.market = market;
    this.generation++;
    this.quoteByCell = new Map();
    this.quotesInfo = undefined;
    if (!this.stopped) { if (this.pathTimer) clearTimeout(this.pathTimer); if (this.quoteTimer) clearTimeout(this.quoteTimer); void this.pollPath(); void this.pollQuotes(); }
    this.emit();
  }
  get selected(): MarketId { return this.market; }

  /** House clock now (ms), monotone except for a jump back of more than 5 s (a new house run). */
  nowMs(): number {
    const b = this.clockBase;
    if (!b) return 0;
    const now = b.serverMs + (performance.now() - b.perfMs) * b.speed;
    if (now >= this.lastNow || this.lastNow - now > 5_000) this.lastNow = now;
    return this.lastNow;
  }
  get clockReady(): boolean { return !!this.clockBase; }
  private observeClock(serverMs: number | undefined, speed: number | undefined): void {
    if (typeof serverMs !== 'number' || !Number.isFinite(serverMs)) return;
    this.clockBase = { serverMs, perfMs: performance.now(), speed: typeof speed === 'number' && speed > 0 ? speed : this.clockBase?.speed ?? 1 };
  }

  getSamples(market: MarketId = this.market): readonly PriceSample[] { return this.samples.get(market) ?? []; }
  quoteFor(cellId: string): QuoteSnapshot | undefined { return this.quoteByCell.get(cellId); }
  /** SPEC-10: squares closer than this are not offered. */
  get minLeadS(): number { return this.quotesInfo?.acceptance?.minLeadS ?? 4; }
  get maxHoldMs(): number { return this.quotesInfo?.acceptance?.maxHoldMs ?? 1_500; }
  get phase(): string | undefined { return this.quotesInfo?.phase; }

  health(): FeedHealth {
    const latest = this.getSamples().at(-1);
    if (!this.clockBase || !latest) return this.pathError ? { status: 'unavailable', message: this.pathError } : { status: 'loading', message: 'Connecting to the house price path' };
    if (this.pathError) return { status: 'unavailable', message: this.pathError };
    const age = this.nowMs() - latest.sourceTimeMs;
    if (age > STALE_AFTER_MS) return { status: 'stale', message: `House prices are ${Math.round(age / 1000)} s old · no new squares until they resume` };
    if (this.quoteError) return { status: 'unavailable', message: this.quoteError };
    const q = this.quotesInfo;
    if (q && (q.available === false || q.reason)) return { status: 'stale', message: q.reason === 'warming-up' ? 'The house is warming up its odds' : `The house is not quoting (${q.reason ?? 'unavailable'})` };
    return { status: 'ready', message: `Live · house price path · ${Math.round(Math.max(0, age) / 1000)} s` };
  }

  private async pollPath(): Promise<void> {
    const market = this.market, gen = this.generation;
    let delay = 1_000;
    try {
      const list = this.samples.get(market) ?? [];
      const last = list.at(-1);
      const r = await this.api.path(market, last ? last.sourceTimeMs : undefined);
      if (gen !== this.generation || this.stopped) return;
      this.observeClock(r.clockMs, r.speed);
      const def = getMarket(market);
      const merged = last ? list.slice() : [];
      for (const s of r.samples) {
        if (last && s.sourceTimeMs <= merged.at(-1)!.sourceTimeMs) continue;
        merged.push(Object.freeze({ sampleId: s.sampleId, marketId: market, pairId: def.pairId, feedId: def.feedId, sourceTimeMs: s.sourceTimeMs, receivedAtMs: s.receivedAtMs, price: Object.freeze(parseDecimal(s.price)) }));
      }
      const floor = (merged.at(-1)?.sourceTimeMs ?? 0) - KEEP_SECONDS * 1000;
      this.samples.set(market, merged.filter(s => s.sourceTimeMs >= floor));
      this.pathError = undefined;
      // Replays run faster than real time: poll in proportion so the chart keeps up.
      delay = Math.max(200, Math.min(1_000, 1_000 / Math.max(1, r.speed || 1)));
    } catch (error) {
      this.pathError = error instanceof HouseError ? `House price path unavailable (${error.code})` : 'House price path unavailable';
      delay = 2_000;
    }
    this.emit();
    if (!this.stopped && gen === this.generation) this.pathTimer = setTimeout(() => void this.pollPath(), delay);
  }

  private async pollQuotes(): Promise<void> {
    const market = this.market, gen = this.generation;
    let delay = 350;
    try {
      const r = await this.api.quotes(market);
      if (gen !== this.generation || this.stopped) return;
      this.observeClock(r.clockMs, this.clockBase?.speed);
      this.quotesInfo = r;
      const next = new Map<string, QuoteSnapshot>();
      for (const c of r.cells) {
        if (!c.available || !c.quoteId || c.x100 === undefined || c.validUntilMs === undefined || c.revision === undefined) continue;
        next.set(c.cellId, Object.freeze({
          cellId: c.cellId, marketId: market, startMs: c.start, endMs: c.end, lowerPrice: Object.freeze(parseDecimal(c.lower)), upperPrice: Object.freeze(parseDecimal(c.upper)), ruleVersion: OBSERVED_PATH_RULE_VERSION,
          quoteId: c.quoteId, revision: c.revision, grossX100: String(c.x100), sourceTimeMs: (r.t ?? 0) * 1000, generatedAtMs: r.generatedAtMs ?? 0, validUntilMs: c.validUntilMs,
          provenance: Object.freeze({ modelId: 'maya-house', configId: `${r.phase ?? 'house'}:${r.edge ?? ''}`, tableId: r.tableId ?? '', policyId: OBSERVED_PATH_RULE_VERSION, sourceSampleId: `t:${r.t ?? ''}` }),
          // Required by the shared QuoteSnapshot type; the live UI never reads it. These are real house quotes.
          simulated: true as const,
        }));
      }
      this.quoteByCell = next;
      this.quoteError = undefined;
    } catch (error) {
      this.quoteByCell = new Map(); // fail closed: no stale quotes on the board
      this.quoteError = error instanceof HouseError ? `House odds unavailable (${error.code})` : 'House odds unavailable';
      delay = 1_500;
    }
    this.emit();
    if (!this.stopped && gen === this.generation) this.quoteTimer = setTimeout(() => void this.pollQuotes(), delay);
  }
}
