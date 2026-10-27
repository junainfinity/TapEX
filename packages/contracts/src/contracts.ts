export type MarketId = 'btc-usd' | 'eth-usd';
export type Cents = string;
export type GrossX100 = string;
export type Unsubscribe = () => void;

/** Exact coefficient × 10^exponent. Never infer settlement from display floats. */
export interface DecimalValue { readonly coefficient: string; readonly exponent: number }
export interface MarketDefinition {
  readonly id: MarketId;
  readonly symbol: 'BTC/USD' | 'ETH/USD';
  readonly pairId: 1 | 2;
  readonly feedId: string;
  readonly chain: 'bsc';
  readonly pricePath: string;
  readonly bandHeight: DecimalValue;
}
export interface CellTerms {
  readonly cellId: string;
  readonly marketId: MarketId;
  readonly startMs: number;
  readonly endMs: number;
  readonly lowerPrice: DecimalValue;
  readonly upperPrice: DecimalValue;
  readonly ruleVersion: string;
}
export interface PriceSample {
  readonly sampleId: string;
  readonly marketId: MarketId;
  readonly pairId: 1 | 2;
  readonly feedId: string;
  readonly sourceTimeMs: number;
  readonly receivedAtMs: number;
  readonly price: DecimalValue;
  readonly sourceHash?: string;
}
export type InputHealthStatus = 'loading' | 'ready' | 'stale' | 'recovering' | 'unavailable' | 'incompatible';
export interface InputHealth {
  readonly marketId: MarketId;
  readonly status: InputHealthStatus;
  readonly reason?: string;
  readonly lastSourceTimeMs?: number;
  readonly observedAtMs: number;
}
export interface ClockSnapshot {
  readonly nowMs: number;
  readonly uncertaintyMs: number;
  readonly ready: boolean;
}
export interface ModelProvenance {
  readonly modelId: string;
  readonly configId: string;
  readonly tableId: string;
  readonly policyId: string;
  readonly sourceSampleId: string;
}
export interface QuoteSnapshot extends CellTerms {
  readonly quoteId: string;
  readonly revision: number;
  readonly grossX100: GrossX100;
  readonly sourceTimeMs: number;
  readonly generatedAtMs: number;
  readonly validUntilMs: number;
  readonly provenance: ModelProvenance;
  readonly simulated: true;
}
/** A candidate set is independent of canvas/zoom; view geometry is a separate gate. */
export interface CandidateDemand {
  readonly marketId: MarketId;
  readonly cells: readonly CellTerms[];
  readonly clock: ClockSnapshot;
}
export interface ViewportQuoteDemand extends CandidateDemand {
  readonly viewRevision: number;
  readonly fullyVisibleCellIds: readonly string[];
}
export type QuoteUnavailableReason = 'warming-up' | 'stale-source' | 'clock-uncertain' | 'insufficient-history' | 'invalid-volatility' | 'out-of-domain' | 'below-minimum' | 'too-late' | 'model-incompatible' | 'unsafe-numeric-range';
export type QuoteResult = { readonly available: true; readonly quote: QuoteSnapshot } | { readonly available: false; readonly cellId: string; readonly reason: QuoteUnavailableReason };
export interface CoverageReport {
  readonly marketId: MarketId;
  readonly startMs: number;
  readonly endMs: number;
  readonly status: 'complete' | 'recovering' | 'unrecoverable';
  readonly sampleIds: readonly string[];
  readonly watermarkMs: number;
  readonly policyId: string;
  readonly reason?: string;
  readonly conflictSampleIds?: readonly string[];
}
/** Supplied by measured/explicit runtime policy, never inferred from UI. */
export interface SettlementPolicy {
  readonly policyId: string;
  readonly expectedSampleIntervalMs: number;
  readonly lateArrivalGraceMs: number;
  readonly recoveryDeadlineMs: number;
}
export interface PlacementIntent {
  readonly requestId: string;
  readonly pageLoadId: string;
  readonly quoteId: string;
  readonly revision?: number;
  readonly cellId: string;
  readonly stakeCents: Cents;
}
export type PositionStatus = 'open' | 'won' | 'lost' | 'refunded';
export interface PositionSnapshot extends CellTerms {
  readonly positionId: string;
  readonly requestId: string;
  readonly pageLoadId: string;
  readonly quoteId: string;
  readonly stakeCents: Cents;
  readonly grossX100: GrossX100;
  readonly grossReturnCents: Cents;
  readonly acceptedAtMs: number;
  readonly status: PositionStatus;
  readonly provenance: ModelProvenance;
  readonly settledAtMs?: number;
  /** Presentation timestamp of the exact observed-path touch; absent for older sampled positions. */
  readonly touchTimeMs?: number;
  readonly evidenceSampleIds?: readonly string[];
  readonly settlementReason?: string;
  readonly settlementPolicy?: SettlementPolicy;
}
export type RejectionReason = 'ALLOWANCE_EXHAUSTED' | 'INSUFFICIENT_BALANCE' | 'STAKE_NOT_ALLOWED' | 'CELL_CAP_EXCEEDED' | 'QUOTE_EXPIRED' | 'QUOTE_CHANGED' | 'TOO_LATE' | 'INPUT_NOT_READY' | 'UNSUPPORTED_CELL' | 'STATE_NOT_READY' | 'REQUEST_CONFLICT' | 'STORAGE_UNAVAILABLE';
export type PlacementResult = { readonly status: 'accepted'; readonly position: PositionSnapshot; readonly newlyCommitted: boolean } | { readonly status: 'rejected'; readonly reason: RejectionReason; readonly message?: string };
export interface PositionChanged { readonly position: PositionSnapshot; readonly creditedCents: Cents }
export interface PageAllowanceSnapshot {
  readonly pageLoadId: string;
  readonly acceptedCount: number;
  readonly remaining: number;
  readonly offerShown: boolean;
}
export interface OfferPresentationAck { readonly pageLoadId: string; readonly presentationId: string }
export interface PaperSnapshot {
  readonly revision: number;
  readonly balanceCents: Cents;
  readonly positions: readonly PositionSnapshot[];
  readonly ready: boolean;
  readonly error?: string;
}
export interface ClockPort { getClock(): ClockSnapshot }
export interface QuoteRegistryPort { getQuote(quoteId: string): QuoteSnapshot | undefined }
export interface MarketDataPort {
  getHealth(marketId: MarketId): InputHealth;
  getSamples(marketId: MarketId, fromMs?: number, toMs?: number): readonly PriceSample[];
  getCoverage(marketId: MarketId, startMs: number, endMs: number): CoverageReport;
  getConflictingSampleIds?(marketId: MarketId): readonly string[];
  subscribe(listener: (marketId: MarketId) => void): Unsubscribe;
}
export interface PaperEnginePort {
  getSnapshot(): PaperSnapshot;
  getAllowance(): PageAllowanceSnapshot;
  placeBet(intent: PlacementIntent): Promise<PlacementResult>;
  refill(requestId: string): Promise<void>;
  acknowledgeOfferShown(ack: OfferPresentationAck): PageAllowanceSnapshot;
  subscribe(listener: () => void): Unsubscribe;
}
export type LayoutMode = 'desktop' | 'tablet' | 'mobile';
export interface ViewportContext {
  readonly width: number;
  readonly height: number;
  readonly coarsePointer: boolean;
  readonly canHover?: boolean;
  readonly devicePixelRatio?: number;
  readonly reducedMotion?: boolean;
}
