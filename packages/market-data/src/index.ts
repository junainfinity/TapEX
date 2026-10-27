import { compareDecimal, decimalToString, type ClockSnapshot, type CoverageReport, type InputHealth, type MarketDataPort, type MarketId, type PriceSample, type SettlementPolicy } from '@maya/contracts';
import { MARKETS, getMarket } from '@maya/config';
import { SourceClock } from './clock.js';
import { parsePriceBuffer } from './normalization.js';
import { LIVE_POLICY, SETTLEMENT_POLICY } from './policy.js';
export { SourceClock, parsePriceBuffer, LIVE_POLICY, SETTLEMENT_POLICY };
export { parseLosslessJson } from './normalization.js';

export interface PricingConfiguration {
  readonly configId: string;
  readonly formulaVersion: string;
  readonly houseEdge: number;
  readonly minPayoutX: number;
  readonly minDelayMs: number;
}
export interface LynxMarketDataOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  monotonic?: () => number;
}
interface MarketState {
  samples: Map<string, PriceSample>;
  provisional: Map<number, Map<string, PriceSample>>;
  conflicts: Set<string>;
  lastError?: string;
  lastReceivedAtMs: number;
  lastSourceTimeMs: number;
  revision: number;
  rawResponses: { receivedAtMs: number; hash: string; body: string }[];
}
const newState = (): MarketState => ({ samples: new Map(), provisional: new Map(), conflicts: new Set(), lastReceivedAtMs: 0, lastSourceTimeMs: 0, revision: 0, rawResponses: [] });
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
export function validateProviderConfig(body: string, configId: string): PricingConfiguration {
  const c = JSON.parse(body);
  if (c.chain !== 'bsc' || !Array.isArray(c.boxSecondsWidths) || !c.boxSecondsWidths.includes(5) || !Number.isFinite(c.minDelay) || c.minDelay < 1 || c.minDelay > 30) throw new Error('Incompatible public configuration');
  for (const market of MARKETS) {
    const p = c.pairs?.[String(market.pairId)];
    if (p?.symbol !== market.symbol || p?.feedId?.toLowerCase() !== market.feedId) throw new Error('Config market authority mismatch');
  }
  if (c.pricing?.formulaVersion !== '3.0.0' || !Number.isFinite(c.pricing.houseEdge) || c.pricing.houseEdge < 0 || c.pricing.houseEdge >= 1 || !Number.isFinite(c.pricing.minPayoutX) || c.pricing.minPayoutX < 1) throw new Error('Incompatible public pricing configuration');
  return Object.freeze({ configId, formulaVersion: c.pricing.formulaVersion, houseEdge: c.pricing.houseEdge, minPayoutX: c.pricing.minPayoutX, minDelayMs: c.minDelay * 1000 });
}

/** Same-provider read-only client. Both markets remain subscribed for this two-market demo. */
export class LynxMarketData implements MarketDataPort {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly mono: () => number;
  private readonly sourceClock: SourceClock;
  private readonly states = new Map<MarketId, MarketState>(MARKETS.map((m) => [m.id, newState()]));
  private readonly listeners = new Set<(marketId: MarketId) => void>();
  private readonly pending = new Map<MarketId, Promise<void>>();
  private generation = 0;
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private lastConfigMono = 0;
  private config?: PricingConfiguration;
  private modelTable: unknown;
  private modelTableId = '';
  private globalError?: string;
  private retainedWindows: { marketId: MarketId; startMs: number; endMs: number }[] = [];
  constructor(options: LynxMarketDataOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '/api').replace(/\/$/, '');
    // Native browser fetch requires its Window/global receiver. Injected test
    // functions remain unchanged so callers can deliberately control them.
    this.fetcher = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.mono = options.monotonic ?? (() => performance.now());
    this.sourceClock = new SourceClock(this.mono);
  }
  getClock(): ClockSnapshot { return this.sourceClock.getClock(); }
  getConfig(): PricingConfiguration { if (!this.config) throw new Error('Configuration not loaded'); return this.config; }
  getMinLeadMs(): number { return this.getConfig().minDelayMs; }
  getTable(): unknown { if (!this.modelTable) throw new Error('Model table not loaded'); return this.modelTable; }
  getTableId(): string { return this.modelTableId; }
  getSettlementPolicy(): SettlementPolicy { return SETTLEMENT_POLICY; }
  getRevision(marketId: MarketId): number { return this.states.get(marketId)!.revision; }
  getConflictingSampleIds(marketId: MarketId): readonly string[] { return [...this.states.get(marketId)!.conflicts]; }
  subscribe(listener: (marketId: MarketId) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish(marketId: MarketId): void { for (const listener of this.listeners) { try { listener(marketId); } catch (error) { console.error('Maya source listener failed', error); } } }
  getSamples(marketId: MarketId, fromMs = 0, toMs = Infinity): readonly PriceSample[] {
    const state = this.states.get(marketId)!;
    return [...state.samples.values()].filter((s) => !state.conflicts.has(s.sampleId) && s.sourceTimeMs >= fromMs && s.sourceTimeMs < toMs).sort((a, b) => a.sourceTimeMs - b.sourceTimeMs);
  }
  /** Display preview only: recent source revisions must never enter quotes or settlement. */
  getDisplaySamples(marketId: MarketId): readonly PriceSample[] {
    const state = this.states.get(marketId)!;
    const samples = [...this.getSamples(marketId)];
    let confirmedFrontier = 0;
    for (const sample of state.samples.values()) confirmedFrontier = Math.max(confirmedFrontier, sample.sourceTimeMs);
    for (const [timeMs, variants] of state.provisional) {
      if (timeMs <= confirmedFrontier) continue;
      let latest: PriceSample | undefined;
      for (const sample of variants.values()) {
        if (state.conflicts.has(sample.sampleId) || state.samples.has(sample.sampleId)) continue;
        if (!latest || sample.receivedAtMs >= latest.receivedAtMs) latest = sample;
      }
      if (latest) samples.push(latest);
    }
    return samples.sort((a, b) => a.sourceTimeMs - b.sourceTimeMs);
  }
  getHealth(marketId: MarketId): InputHealth {
    const state = this.states.get(marketId)!;
    const clock = this.getClock();
    const common = { marketId, observedAtMs: clock.nowMs, ...(state.lastSourceTimeMs ? { lastSourceTimeMs: state.lastSourceTimeMs } : {}) };
    if (this.globalError) return { ...common, status: 'incompatible', reason: this.globalError };
    if (!this.config || !this.modelTable) return { ...common, status: 'loading', reason: 'Loading public market inputs' };
    if (!clock.ready) return { ...common, status: 'recovering', reason: 'Reconnecting to the source clock' };
    if (state.lastError) return { ...common, status: 'recovering', reason: state.lastError };
    if (!state.lastSourceTimeMs) return { ...common, status: 'loading', reason: 'Waiting for stabilized price observations' };
    if (clock.nowMs + clock.uncertaintyMs - state.lastSourceTimeMs > LIVE_POLICY.staleAfterMs) return { ...common, status: 'stale', reason: 'Price source is delayed' };
    const cutoff = state.lastSourceTimeMs - 70_000;
    if ([...state.samples.values()].some((s) => s.sourceTimeMs >= cutoff && state.conflicts.has(s.sampleId))) return { ...common, status: 'unavailable', reason: 'Conflicting finalized price observations' };
    if (this.getSamples(marketId, cutoff).length < LIVE_POLICY.historyWarmupSamples) return { ...common, status: 'loading', reason: 'Warming up the price model' };
    return { ...common, status: 'ready' };
  }
  getCoverage(marketId: MarketId, startMs: number, endMs: number): CoverageReport {
    const state = this.states.get(marketId)!;
    const samples = this.getSamples(marketId, startMs, endMs);
    const watermarkMs = state.lastSourceTimeMs - LIVE_POLICY.lateArrivalGraceMs;
    const conflictSampleIds = [...state.samples.values()].filter((s) => s.sourceTimeMs >= startMs && s.sourceTimeMs < endMs && state.conflicts.has(s.sampleId)).map((s) => s.sampleId);
    const common = { marketId, startMs, endMs, sampleIds: samples.map((s) => s.sampleId), watermarkMs, policyId: LIVE_POLICY.policyId, conflictSampleIds };
    const conflicted = conflictSampleIds.length > 0;
    const expected = new Set<number>();
    for (let t = startMs; t < endMs; t += LIVE_POLICY.expectedSampleIntervalMs) expected.add(t);
    const full = !conflicted && expected.size === samples.length && samples.every((s) => expected.has(s.sourceTimeMs));
    if (full && watermarkMs >= endMs) return { ...common, status: 'complete' };
    const clock = this.getClock();
    if (clock.nowMs - clock.uncertaintyMs >= endMs + LIVE_POLICY.recoveryDeadlineMs) return { ...common, status: 'unrecoverable', reason: conflicted ? 'Finalized source conflict' : 'Price observations unavailable after recovery deadline' };
    return { ...common, status: 'recovering', reason: conflicted ? 'Finalized source conflict' : 'Waiting for complete stabilized observations' };
  }
  /** Root composition supplies unresolved windows; their evidence is exempt from bounded pruning. */
  retainWindows(windows: readonly { marketId: MarketId; startMs: number; endMs: number }[]): void { this.retainedWindows = [...windows]; }
  getDiagnostics(marketId: MarketId): unknown {
    const s = this.states.get(marketId)!;
    return { policy: LIVE_POLICY, revision: s.revision, provisionalVariants: [...s.provisional].map(([timeMs, variants]) => ({ timeMs, variants: [...variants.values()] })), conflicts: [...s.conflicts], rawResponses: [...s.rawResponses] };
  }
  private async read(route: string): Promise<{ text: string; hash: string; response: Response; rttMs: number }> {
    const start = this.mono();
    const response = await this.fetcher(`${this.baseUrl}/${route}`, { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Public data unavailable (${response.status})`);
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('Public response exceeds limit');
    return { text, hash: await sha256(text), response, rttMs: this.mono() - start };
  }
  private async bootstrap(): Promise<void> {
    const [config, table] = await Promise.all([this.read('config'), this.read('table')]);
    const next = validateProviderConfig(config.text, config.hash);
    if (this.config && this.config.configId !== next.configId) throw new Error('Public config changed; refresh to validate new quotes');
    if (this.modelTableId && this.modelTableId !== table.hash) throw new Error('Public model table changed; refresh to validate');
    this.config = next; this.modelTable = JSON.parse(table.text); this.modelTableId = table.hash;
    this.globalError = undefined; this.lastConfigMono = this.mono();
  }
  async pollMarket(marketId: MarketId): Promise<void> {
    const existing = this.pending.get(marketId);
    if (existing) return existing;
    const task = this.pollMarketInner(marketId, this.generation);
    this.pending.set(marketId, task);
    try { await task; } finally { if (this.pending.get(marketId) === task) this.pending.delete(marketId); }
  }
  private async pollMarketInner(marketId: MarketId, generation: number): Promise<void> {
    const state = this.states.get(marketId)!;
    try {
      const market = getMarket(marketId);
      const result = await this.read(`prices/${market.pairId}`);
      if (generation !== this.generation) return;
      const headers = result.response.headers;
      const date = headers.get('x-maya-upstream-date');
      const upstreamRtt = headers.get('x-maya-upstream-rtt-ms');
      const upstreamAge = headers.get('x-maya-upstream-age-ms');
      if (!date || upstreamRtt === null || upstreamAge === null || upstreamRtt.trim() === '' || upstreamAge.trim() === '') throw new Error('Source clock metadata unavailable');
      this.sourceClock.observe(date, Number(upstreamRtt), Number(upstreamAge), result.rttMs);
      const clock = this.getClock();
      const incoming = parsePriceBuffer(result.text, market, clock.nowMs, result.hash);
      const latest = incoming.at(-1)!.sourceTimeMs;
      if (latest > clock.nowMs + clock.uncertaintyMs) throw new Error('Future source timestamp');
      const frontier = latest - LIVE_POLICY.stabilizationMs;
      for (const sample of incoming) {
        const variants = state.provisional.get(sample.sourceTimeMs) ?? new Map<string, PriceSample>();
        const priceKey = decimalToString(sample.price);
        // Reinsert repeated values so equal receive timestamps still resolve to
        // the most recently observed revision, including an A -> B -> A return.
        variants.delete(priceKey); variants.set(priceKey, sample); state.provisional.set(sample.sourceTimeMs, variants);
        if (sample.sourceTimeMs > frontier) continue;
        const previous = state.samples.get(sample.sampleId);
        if (previous && compareDecimal(previous.price, sample.price) !== 0) state.conflicts.add(sample.sampleId);
        else if (!previous) { state.samples.set(sample.sampleId, sample); state.revision++; }
      }
      state.lastSourceTimeMs = Math.max(0, ...[...state.samples.values()].filter((s) => !state.conflicts.has(s.sampleId)).map((s) => s.sourceTimeMs));
      state.lastReceivedAtMs = clock.nowMs; state.lastError = undefined;
      state.rawResponses.push({ receivedAtMs: clock.nowMs, hash: result.hash, body: result.text });
      const before = state.lastSourceTimeMs - LIVE_POLICY.historyRetentionMs;
      const retain = (t: number) => t >= before || this.retainedWindows.some((w) => w.marketId === marketId && t >= w.startMs && t < w.endMs);
      for (const [id, sample] of state.samples) if (!retain(sample.sourceTimeMs)) { state.samples.delete(id); state.conflicts.delete(id); }
      for (const time of state.provisional.keys()) if (!retain(time)) state.provisional.delete(time);
      state.rawResponses = state.rawResponses.filter((r) => r.receivedAtMs >= before || this.retainedWindows.some((w) => w.marketId === marketId && r.receivedAtMs >= w.startMs - 1000 && r.receivedAtMs <= w.endMs + LIVE_POLICY.recoveryDeadlineMs));
    } catch (error) { if (generation === this.generation) state.lastError = String((error as Error).message ?? error); }
    finally { if (generation === this.generation) this.publish(marketId); }
  }
  async revalidate(): Promise<void> {
    this.generation++;
    this.sourceClock.invalidate();
    for (const market of MARKETS) this.publish(market.id);
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all(MARKETS.map((m) => this.pollMarket(m.id)));
  }
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.sourceClock.invalidate();
    try { await this.bootstrap(); } catch (error) { this.globalError = String((error as Error).message ?? error); }
    await Promise.all(MARKETS.map((m) => this.pollMarket(m.id)));
    const cycle = async () => {
      if (!this.running) return;
      if (!this.config || this.mono() - this.lastConfigMono >= 60_000) { try { await this.bootstrap(); } catch (error) { this.globalError = String((error as Error).message ?? error); } }
      await Promise.all(MARKETS.map((m) => this.pollMarket(m.id)));
      if (this.running) this.timer = setTimeout(cycle, LIVE_POLICY.pollIntervalMs);
    };
    if (this.running) this.timer = setTimeout(cycle, LIVE_POLICY.pollIntervalMs);
  }
  stop(): void { this.running = false; this.generation++; this.sourceClock.invalidate(); if (this.timer) clearTimeout(this.timer); }
}
