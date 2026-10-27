import { bucketIndex, cellId, compareDecimal, createCell, decimalToNumber, multiplyDecimalInteger, type CellTerms, type ClockSnapshot, type InputHealth, type MarketId, type PriceSample, type QuoteRegistryPort, type QuoteResult, type QuoteSnapshot, type QuoteUnavailableReason } from '@maya/contracts';
import { DEMO_CONFIG, getMarket } from '@maya/config';
import { TouchProbabilityModel, ewmaSigma, type ModelInputs, type PreviewResult } from './model.js';
export { TouchProbabilityModel, ewmaSigma, floorGrossHundredths, validateProbabilityTable } from './model.js';
export type { ProbabilityTableJSON, ModelInputs, PreviewResult } from './model.js';
export { sampledBandProbability } from './sampled-probability.js';
export { linearBandProbability } from './linear-probability.js';

export interface PaperQuoteBookOptions {
  table: unknown;
  tableId: string;
  getConfig: () => { configId: string; formulaVersion: string; houseEdge: number; minPayoutX: number; minDelayMs: number };
  policyId: string;
  quoteTtlMs?: number;
  /** Optional background-model adapter. Undefined means its result is still pending. */
  preview?: (params: ModelInputs) => PreviewResult | undefined;
}
interface MarketModel {
  samples: readonly PriceSample[];
  health: InputHealth;
  clock: ClockSnapshot;
  sigma: number;
  revision: number;
  cache: Map<string, PreviewResult>;
}
/** Local immutable indicative quote registry. No provider execution or RNG. */
export class PaperQuoteBook implements QuoteRegistryPort {
  private readonly model: TouchProbabilityModel;
  private readonly options: PaperQuoteBookOptions;
  private readonly markets = new Map<MarketId, MarketModel>();
  private readonly quotes = new Map<string, QuoteSnapshot>();
  private readonly byCell = new Map<string, QuoteSnapshot>();
  private serial = 0;
  constructor(options: PaperQuoteBookOptions) { this.options = options; this.model = new TouchProbabilityModel(options.table); }
  updateMarket(marketId: MarketId, samples: readonly PriceSample[], health: InputHealth, clock: ClockSnapshot): void {
    const previous = this.markets.get(marketId);
    const history = samples.slice(-68);
    // Earlier gaps may be filled without advancing the last timestamp or the
    // bounded history length. Every persisted point contributes to volatility.
    const changed = history.length !== previous?.samples.length || history.some((sample, index) => sample.sampleId !== previous?.samples[index]?.sampleId);
    const sigma = changed ? ewmaSigma(history.map((s) => ({ sourceTimeMs: s.sourceTimeMs, value: decimalToNumber(s.price) }))) : previous?.sigma ?? 0;
    this.markets.set(marketId, { samples: history, health, clock, sigma, revision: changed ? (previous?.revision ?? 0) + 1 : previous?.revision ?? 0, cache: changed ? new Map() : previous?.cache ?? new Map() });
    const historicalChange = changed && history.at(-1)?.sampleId === previous?.samples.at(-1)?.sampleId;
    if (historicalChange) for (const [id, quote] of this.byCell) if (quote.marketId === marketId) this.byCell.delete(id);
    // Retain recent immutable IDs for pending/accepted acknowledgement, never indefinitely.
    for (const [id, quote] of this.quotes) if (quote.validUntilMs < clock.nowMs - 60_000) this.quotes.delete(id);
    for (const [id, quote] of this.byCell) if (quote.endMs < clock.nowMs - 5000) this.byCell.delete(id);
  }
  getQuote(quoteId: string): QuoteSnapshot | undefined { return this.quotes.get(quoteId); }
  getSigma(marketId: MarketId): number { return this.markets.get(marketId)?.sigma ?? 0; }
  quoteCell(cell: CellTerms, currentClock?: ClockSnapshot): QuoteResult {
    const unavailable = (reason: QuoteUnavailableReason): QuoteResult => ({ available: false, cellId: cell.cellId, reason });
    const state = this.markets.get(cell.marketId);
    if (!state) return unavailable('warming-up');
    const clock = currentClock ?? state.clock;
    if (!clock.ready) return unavailable('clock-uncertain');
    if (state.health.status !== 'ready') return unavailable(state.health.status === 'loading' ? 'warming-up' : state.health.status === 'incompatible' ? 'model-incompatible' : 'stale-source');
    const config = this.options.getConfig();
    const latest = state.samples.at(-1);
    if (!latest || state.samples.length < 30) return unavailable('insufficient-history');
    if (clock.nowMs + clock.uncertaintyMs - latest.sourceTimeMs > 7000) return unavailable('stale-source');
    if (state.samples.some((s, i) => i > 0 && s.sourceTimeMs - state.samples[i - 1]!.sourceTimeMs !== 1000)) return unavailable('insufficient-history');
    const market = getMarket(cell.marketId);
    const bucket = bucketIndex(cell.lowerPrice, market.bandHeight);
    if (cell.cellId !== cellId(cell) || cell.endMs - cell.startMs !== 5000 || cell.startMs % 5000 !== 0 || cell.ruleVersion !== DEMO_CONFIG.ruleVersion || compareDecimal(cell.lowerPrice, multiplyDecimalInteger(market.bandHeight, bucket)) !== 0 || compareDecimal(cell.upperPrice, multiplyDecimalInteger(market.bandHeight, bucket + 1n)) !== 0) return unavailable('model-incompatible');
    if (config.formulaVersion !== '3.0.0') return unavailable('model-incompatible');
    const deadline = Math.min(latest.receivedAtMs + (this.options.quoteTtlMs ?? 1800), cell.startMs - config.minDelayMs, latest.sourceTimeMs + 7000);
    if (clock.nowMs + clock.uncertaintyMs >= deadline) return unavailable('too-late');
    const existing = this.byCell.get(cell.cellId);
    const reusable = existing && existing.provenance.configId === config.configId && existing.provenance.policyId === this.options.policyId && existing.ruleVersion === cell.ruleVersion && existing.validUntilMs > clock.nowMs + clock.uncertaintyMs;
    if (reusable && existing.provenance.sourceSampleId === latest.sampleId && existing.validUntilMs === deadline) return { available: true, quote: existing };
    const cacheKey = `${cell.cellId}:${config.configId}:${this.options.policyId}`;
    const params: ModelInputs = {
      spot: decimalToNumber(latest.price), lower: decimalToNumber(cell.lowerPrice), upper: decimalToNumber(cell.upperPrice),
      timeToStartS: (cell.startMs - latest.sourceTimeMs) / 1000, widthS: 5,
      sigmaPerSqrtSec: state.sigma, settleDtS: 1, houseEdge: config.houseEdge, minimumGross: config.minPayoutX,
    };
    const preview = state.cache.get(cacheKey) ?? (this.options.preview ? this.options.preview(params) : this.model.previewLinear(params));
    if (preview === undefined) return reusable ? { available: true, quote: existing } : unavailable('warming-up');
    state.cache.set(cacheKey, preview);
    if (!preview.available) {
      const reason: QuoteUnavailableReason = preview.reason === 'invalid-input' ? 'model-incompatible' : preview.reason === 'unreachable' ? 'out-of-domain' : preview.reason;
      return unavailable(reason);
    }
    const quote: QuoteSnapshot = Object.freeze({
      ...cell, lowerPrice: Object.freeze({ ...cell.lowerPrice }), upperPrice: Object.freeze({ ...cell.upperPrice }),
      quoteId: `maya-quote-${crypto.randomUUID()}`, revision: ++this.serial, grossX100: preview.grossX100,
      sourceTimeMs: latest.sourceTimeMs, generatedAtMs: latest.receivedAtMs, validUntilMs: deadline,
      provenance: Object.freeze({ modelId: 'maya-gaussian-linear-six-v2', configId: config.configId, tableId: this.options.tableId, policyId: this.options.policyId, sourceSampleId: latest.sampleId }), simulated: true,
    });
    this.quotes.set(quote.quoteId, quote); this.byCell.set(cell.cellId, quote);
    return { available: true, quote };
  }
  candidates(marketId: MarketId, clock?: ClockSnapshot): readonly CellTerms[] {
    const state = this.markets.get(marketId);
    const last = state?.samples.at(-1);
    const current = clock ?? state?.clock;
    if (!last || !current?.ready) return [];
    const step = getMarket(marketId).bandHeight;
    const middle = bucketIndex(last.price, step);
    const threshold = current.nowMs + current.uncertaintyMs + this.options.getConfig().minDelayMs;
    const firstStart = (Math.floor(threshold / 5000) + 1) * 5000;
    const cells: CellTerms[] = [];
    for (let column = 0; column < 6; column++) for (let offset = -3; offset <= 3; offset++) {
      const index = middle + BigInt(offset);
      cells.push(createCell(marketId, firstStart + column * 5000, multiplyDecimalInteger(step, index), multiplyDecimalInteger(step, index + 1n), DEMO_CONFIG.ruleVersion));
    }
    return cells;
  }
}
