import { addDecimal, assertTimestamp, cellId, compareDecimal, grossReturn, integer, multiplyDecimalInteger, normalizeDecimal, priceBucket, sampleId, sampleTouchesCell, segmentTouchesCell, observedSampleId, OBSERVED_PATH_POLICY, OBSERVED_PATH_RULE_VERSION, OBSERVED_SAMPLE_PREFIX } from '@maya/contracts';
import type { ClockPort, ClockSnapshot, MarketDataPort, MarketId, OfferPresentationAck, PageAllowanceSnapshot, PaperEnginePort, PaperSnapshot, PlacementIntent, PlacementResult, PositionSnapshot, PriceSample, QuoteRegistryPort, QuoteSnapshot, RejectionReason, SettlementPolicy, Unsubscribe } from '@maya/contracts';
import { DEMO_CONFIG, getMarket } from '@maya/config';
import { LedgerStorage, type LedgerState } from './storage.js';

export interface PaperEngineOptions {
  readonly pageLoadId?: string;
  readonly databaseName?: string;
  /** Isolate a fresh playable demo session while preserving earlier audit records. */
  readonly ledgerKey?: string;
  readonly indexedDB?: IDBFactory;
  readonly clock: ClockPort;
  readonly quotes: QuoteRegistryPort;
  readonly marketData: MarketDataPort;
  /** Raw validated provider observations; the durable ledger pins each timestamp's first value for v2. */
  readonly observedSamples?: () => readonly PriceSample[];
  readonly settlementPolicy: SettlementPolicy;
  readonly minLeadMs?: () => number;
  readonly broadcast?: boolean;
  /** Only override to create explicit deterministic test fixtures. */
  readonly startingBalanceCents?: string;
}
const clone = <T>(value: T): T => structuredClone(value);
export { OBSERVED_PATH_POLICY };
const LEGACY_RULE = 'maya-sampled-v1';
const LEGACY_POLICY = 'maya-lynx-sampled-1s-stabilized-3s-v1';
type AuditSnapshot = Pick<LedgerState, 'positions' | 'entries' | 'samples' | 'balanceCents'>;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) if (item && typeof item === 'object' && !Object.isFrozen(item)) freeze(item); }
  return value;
}
function id(): string { return globalThis.crypto.randomUUID(); }
function rejection(reason: RejectionReason, message?: string): PlacementResult { return message === undefined ? { status: 'rejected', reason } : { status: 'rejected', reason, message }; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function receiptKey(requestId: string): string { return `request:${requestId}`; }
function sameIntent(a: PlacementIntent, b: PlacementIntent): boolean { return a.requestId === b.requestId && a.pageLoadId === b.pageLoadId && a.quoteId === b.quoteId && a.cellId === b.cellId && a.stakeCents === b.stakeCents && a.revision === b.revision; }

export class PaperEngine implements PaperEnginePort {
  readonly pageLoadId: string;
  private readonly storage: LedgerStorage;
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private current: PaperSnapshot = freeze({ revision: 0, balanceCents: '0', positions: [], ready: false });
  private gameSamples: readonly PriceSample[] = Object.freeze([]);
  private audit: AuditSnapshot = { positions: {}, entries: {}, samples: {}, balanceCents: '0' };
  private acceptedCount = 0;
  private offerShown = false;
  private ready = false;
  private closed = false;
  private unsubscribeData?: Unsubscribe;
  private channel?: BroadcastChannel;
  private initialization?: Promise<void>;
  private readonly onFocus = () => { void this.tick(); };
  constructor(private readonly options: PaperEngineOptions) {
    this.pageLoadId = options.pageLoadId ?? id();
    this.storage = new LedgerStorage(options.indexedDB ?? globalThis.indexedDB, options.databaseName ?? 'maya-paper-v1', options.startingBalanceCents ?? DEMO_CONFIG.startingBalanceCents, options.ledgerKey);
    integer(options.startingBalanceCents ?? DEMO_CONFIG.startingBalanceCents);
    const policy = options.settlementPolicy;
    if (!policy.policyId || ![policy.expectedSampleIntervalMs, policy.lateArrivalGraceMs, policy.recoveryDeadlineMs].every(value => Number.isSafeInteger(value) && value >= 0) || policy.expectedSampleIntervalMs === 0 || policy.recoveryDeadlineMs < policy.lateArrivalGraceMs) throw new TypeError('Invalid settlement policy.');
    if (policy.policyId === OBSERVED_PATH_POLICY.policyId && (policy.expectedSampleIntervalMs !== OBSERVED_PATH_POLICY.expectedSampleIntervalMs || policy.lateArrivalGraceMs !== OBSERVED_PATH_POLICY.lateArrivalGraceMs || policy.recoveryDeadlineMs !== OBSERVED_PATH_POLICY.recoveryDeadlineMs)) throw new TypeError('Observed path policy parameters do not match its pinned version.');
  }
  async initialize(): Promise<void> {
    this.initialization ??= this.enqueue(async () => {
      try {
        await this.storage.open();
        const observed = this.options.observedSamples?.() ?? [];
        const result = await this.storage.mutate(state => ({ value: undefined, changed: this.mergeObservedSamples(state, observed, this.options.clock.getClock()) }));
        this.ready = true; this.publish(result.state);
        this.unsubscribeData = this.options.marketData.subscribe(() => { void this.tick(); });
        if (this.options.broadcast !== false && typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
          this.channel = new BroadcastChannel(`${this.options.databaseName ?? 'maya-paper-v1'}${this.options.ledgerKey ? ':'+this.options.ledgerKey : ''}:changes`);
          this.channel.onmessage = () => { void this.refresh(); };
          window.addEventListener('focus', this.onFocus);
        }
      } catch (error) { this.fail(error); }
    });
    await this.initialization;
  }
  getSnapshot(): PaperSnapshot { return this.current; }
  getGameSamples(marketId: MarketId): readonly PriceSample[] { return freeze(clone(this.gameSamples.filter(sample => sample.marketId === marketId))); }
  getAuditSnapshot(): Readonly<AuditSnapshot> { return freeze(clone(this.audit)); }
  snapshot(): PaperSnapshot { return this.getSnapshot(); }
  getAllowance(): PageAllowanceSnapshot { return Object.freeze({ pageLoadId: this.pageLoadId, acceptedCount: this.acceptedCount, remaining: Math.max(0, DEMO_CONFIG.maxNewBetsPerPage - this.acceptedCount), offerShown: this.offerShown }); }
  subscribe(listener: () => void): Unsubscribe { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  place(intent: PlacementIntent): Promise<PlacementResult> { return this.placeBet(intent); }
  placeBet(intent: PlacementIntent): Promise<PlacementResult> {
    const frozenIntent = clone(intent);
    return this.enqueue(async () => {
      if (!this.ready || this.closed) return rejection('STATE_NOT_READY');
      if (!frozenIntent.requestId || frozenIntent.requestId.length > 256 || frozenIntent.pageLoadId !== this.pageLoadId) return rejection('REQUEST_CONFLICT');
      try {
        const result = await this.storage.mutate<PlacementResult>(state => {
          const receipt = state.receipts[receiptKey(frozenIntent.requestId)];
          if (receipt) return { value: sameIntent(receipt.intent, frozenIntent) ? { status: 'accepted', position: state.positions[receipt.positionId]!, newlyCommitted: false } : rejection('REQUEST_CONFLICT'), changed: false };
          if (this.acceptedCount >= DEMO_CONFIG.maxNewBetsPerPage) return { value: rejection('ALLOWANCE_EXHAUSTED'), changed: false };
          const checked = this.validateQuote(frozenIntent, state);
          if ('status' in checked) return { value: checked, changed: false };
          const { quote, nowMs } = checked;
          const stake = integer(frozenIntent.stakeCents);
          if (integer(state.balanceCents) < stake) return { value: rejection('INSUFFICIENT_BALANCE'), changed: false };
          const exposure = integer(state.exposures[quote.cellId] ?? '0');
          if (exposure + stake > integer(DEMO_CONFIG.maxAcceptedStakePerCellCents)) return { value: rejection('CELL_CAP_EXCEEDED'), changed: false };
          const positionId = `position:${frozenIntent.requestId}`;
          const position: PositionSnapshot = {
            positionId, requestId: frozenIntent.requestId, pageLoadId: this.pageLoadId,
            quoteId: quote.quoteId, cellId: quote.cellId, marketId: quote.marketId, startMs: quote.startMs, endMs: quote.endMs,
            lowerPrice: clone(quote.lowerPrice), upperPrice: clone(quote.upperPrice), ruleVersion: quote.ruleVersion,
            stakeCents: stake.toString(), grossX100: quote.grossX100, grossReturnCents: grossReturn(stake.toString(), quote.grossX100),
            acceptedAtMs: nowMs, status: 'open', provenance: clone(quote.provenance), settlementPolicy: clone(this.options.settlementPolicy)
          };
          state.balanceCents = (integer(state.balanceCents) - stake).toString();
          state.exposures[quote.cellId] = (exposure + stake).toString();
          state.positions[positionId] = position;
          state.receipts[receiptKey(frozenIntent.requestId)] = { intent: frozenIntent, positionId };
          state.entries[`debit:${positionId}`] = { id: `debit:${positionId}`, amountCents: (-stake).toString(), kind: 'debit', positionId };
          return { value: { status: 'accepted', position, newlyCommitted: true }, changed: true };
        });
        if (result.value.status === 'accepted' && result.value.newlyCommitted) this.acceptedCount += 1;
        this.publish(result.state);
        if (result.value.status === 'accepted' && result.value.newlyCommitted) this.broadcast();
        return freeze(clone(result.value));
      } catch (error) { this.fail(error); return rejection('STORAGE_UNAVAILABLE', errorText(error)); }
    });
  }
  async refill(requestId = id()): Promise<void> {
    return this.enqueue(async () => {
      if (!this.ready || this.closed) return;
      if (!requestId || requestId.length > 256) throw new TypeError('Invalid refill request.');
      try {
        const result = await this.storage.mutate(state => {
          const key = `refill:${requestId}`;
          if (state.refills[key]) return { value: false, changed: false };
          state.balanceCents = (integer(state.balanceCents) + integer(DEMO_CONFIG.refillCents)).toString();
          state.refills[key] = true;
          state.entries[key] = { id: key, amountCents: DEMO_CONFIG.refillCents, kind: 'refill' };
          return { value: true, changed: true };
        });
        this.publish(result.state); if (result.value) this.broadcast();
      } catch (error) { this.fail(error); }
    });
  }
  acknowledgeOfferShown(ack: OfferPresentationAck): PageAllowanceSnapshot {
    if (ack.pageLoadId !== this.pageLoadId || !ack.presentationId || this.acceptedCount !== DEMO_CONFIG.maxNewBetsPerPage) throw new Error('Offer acknowledgement does not match an exhausted page allowance.');
    if (!this.offerShown) { this.offerShown = true; this.notify(); }
    return this.getAllowance();
  }
  async tick(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.ready || this.closed) return;
      try {
        const received = DEMO_CONFIG.markets.flatMap(market => [...this.options.marketData.getSamples(market.id)]);
        const observed = this.options.observedSamples?.() ?? [];
        const providerConflicts = DEMO_CONFIG.markets.flatMap(market => [...(this.options.marketData.getConflictingSampleIds?.(market.id) ?? [])]);
        const result = await this.storage.mutate(state => {
          let changed = this.mergeSamples(state, received);
          const clock = this.options.clock.getClock();
          changed = this.mergeObservedSamples(state, observed, clock) || changed;
          for (const sampleId of providerConflicts) if (!sampleId.startsWith(OBSERVED_SAMPLE_PREFIX) && !state.conflicts[sampleId]) { state.conflicts[sampleId] = true; changed = true; }
          const clockUsable = clock.ready && Number.isSafeInteger(clock.nowMs) && clock.nowMs >= 0 && Number.isFinite(clock.uncertaintyMs) && clock.uncertaintyMs >= 0;
          const samples = Object.values(state.samples).sort((a, b) => a.sourceTimeMs - b.sourceTimeMs || a.sampleId.localeCompare(b.sampleId));
          const confirmed = samples.filter(sample => !sample.sampleId.startsWith(OBSERVED_SAMPLE_PREFIX));
          const observedPath = Object.values(state.observedSamples ?? {}).filter(sample => sample.sourceTimeMs <= clock.nowMs + clock.uncertaintyMs).sort((a, b) => a.sourceTimeMs - b.sourceTimeMs || a.sampleId.localeCompare(b.sampleId));
          for (const position of Object.values(state.positions)) {
            if (position.status !== 'open') continue;
            const policy = position.settlementPolicy;
            if (!policy || !clockUsable) continue;
            if (position.ruleVersion === OBSERVED_PATH_RULE_VERSION && policy.policyId === OBSERVED_PATH_POLICY.policyId) {
              changed = this.settleObservedPosition(state, position, observedPath, clock) || changed;
              continue;
            }
            const legacyPolicyKnown = policy.policyId === LEGACY_POLICY || (this.options.settlementPolicy.policyId !== OBSERVED_PATH_POLICY.policyId && policy.policyId === this.options.settlementPolicy.policyId);
            if (position.ruleVersion !== LEGACY_RULE || !legacyPolicyKnown) continue;
            const coverage = this.options.marketData.getCoverage(position.marketId, position.startMs, position.endMs);
            for (const sampleId of coverage.conflictSampleIds ?? []) if (!sampleId.startsWith(OBSERVED_SAMPLE_PREFIX) && !state.conflicts[sampleId]) { state.conflicts[sampleId] = true; changed = true; }
            const hit = confirmed.find(sample => !state.conflicts[sample.sampleId] && sample.sourceTimeMs <= clock.nowMs + clock.uncertaintyMs && sampleTouchesCell(sample, position));
            if (hit) { this.settle(state, position, 'won', [hit.sampleId], 'Sampled price touched your square.', Math.max(hit.sourceTimeMs, clock.nowMs)); changed = true; continue; }
            if (clock.nowMs - clock.uncertaintyMs < position.endMs) continue;
            const intervalSamples = confirmed.filter(sample => sample.marketId === position.marketId && sample.sourceTimeMs >= position.startMs && sample.sourceTimeMs < position.endMs);
            const conflict = intervalSamples.some(sample => state.conflicts[sample.sampleId]);
            const matching = coverage.marketId === position.marketId && coverage.startMs === position.startMs && coverage.endMs === position.endMs && coverage.policyId === policy.policyId;
            // A refreshed source buffer can lose older observations which the ledger retained.
            // Reconstruct the exact same pinned cadence predicate from that durable evidence.
            const coveredTimes = new Set(intervalSamples.filter(sample => !state.conflicts[sample.sampleId]).map(sample => sample.sourceTimeMs));
            let everySlotCovered = true;
            for (let time = position.startMs; time < position.endMs; time += policy.expectedSampleIntervalMs) if (!coveredTimes.has(time)) { everySlotCovered = false; break; }
            const complete = matching && coverage.watermarkMs >= position.endMs && coverage.sampleIds.every(sampleId => state.samples[sampleId] && !state.conflicts[sampleId]) && everySlotCovered && !conflict && !(coverage.conflictSampleIds?.length) && !coverage.reason?.toLowerCase().includes('conflict');
            if (complete && clock.nowMs - clock.uncertaintyMs >= position.endMs + policy.lateArrivalGraceMs) { this.settle(state, position, 'lost', intervalSamples.map(sample => sample.sampleId), 'No sampled touch in the completed window.', clock.nowMs); changed = true; }
            else if (clock.nowMs - clock.uncertaintyMs >= position.endMs + policy.recoveryDeadlineMs) { this.settle(state, position, 'refunded', intervalSamples.map(sample => sample.sampleId), 'Price history could not be recovered; stake refunded.', clock.nowMs); changed = true; }
          }
          if (clockUsable) changed = this.pruneEvidence(state, clock.nowMs) || changed;
          return { value: changed, changed };
        });
        this.publish(result.state); if (result.value) this.broadcast();
      } catch (error) { this.fail(error); }
    });
  }
  async refresh(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.ready || this.closed) return;
      try { const result = await this.storage.mutate(() => ({ value: undefined, changed: false })); this.publish(result.state); } catch (error) { this.fail(error); }
    });
  }
  dispose(): void { this.closed = true; this.unsubscribeData?.(); this.channel?.close(); if (typeof window !== 'undefined') window.removeEventListener('focus', this.onFocus); this.storage.close(); this.listeners.clear(); }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> { const result = this.chain.then(operation); this.chain = result.catch(() => undefined); return result; }
  private validateQuote(intent: PlacementIntent, state: LedgerState): { quote: QuoteSnapshot; nowMs: number } | PlacementResult {
    if (!DEMO_CONFIG.stakeMenuCents.includes(intent.stakeCents)) return rejection('STAKE_NOT_ALLOWED');
    const quote = this.options.quotes.getQuote(intent.quoteId);
    if (!quote || quote.cellId !== intent.cellId || (intent.revision !== undefined && intent.revision !== quote.revision)) return rejection('QUOTE_CHANGED');
    try {
      const canonical = cellId(quote);
      const market = getMarket(quote.marketId);
      const observedRule = this.options.settlementPolicy.policyId === OBSERVED_PATH_POLICY.policyId;
      const expectedRule = observedRule ? OBSERVED_PATH_RULE_VERSION : LEGACY_RULE;
      const width = addDecimal(quote.upperPrice, multiplyDecimalInteger(quote.lowerPrice, -1n));
      if (canonical !== quote.cellId || quote.endMs - quote.startMs !== DEMO_CONFIG.windowMs || quote.startMs % DEMO_CONFIG.windowMs !== 0 || compareDecimal(width, market.bandHeight) !== 0 || compareDecimal(priceBucket(quote.lowerPrice, market.bandHeight).lowerPrice, quote.lowerPrice) !== 0 || quote.ruleVersion !== expectedRule || quote.simulated !== true || integer(quote.grossX100) < 101n) return rejection('UNSUPPORTED_CELL');
      assertTimestamp(quote.generatedAtMs); assertTimestamp(quote.validUntilMs); assertTimestamp(quote.sourceTimeMs);
      if (!quote.provenance.modelId || !quote.provenance.configId || !quote.provenance.tableId || quote.provenance.policyId !== this.options.settlementPolicy.policyId) return rejection('INPUT_NOT_READY');
      const observation = observedRule ? state.observedSamples?.[quote.provenance.sourceSampleId] : this.options.marketData.getSamples(quote.marketId).find(sample => sample.sampleId === quote.provenance.sourceSampleId && sample.sourceTimeMs === quote.sourceTimeMs);
      if (!observation || observation.sourceTimeMs !== quote.sourceTimeMs || observation.marketId !== quote.marketId || observation.feedId !== market.feedId || quote.sourceTimeMs > quote.generatedAtMs || (observedRule ? observation.sampleId !== observedSampleId(observation) : this.options.marketData.getConflictingSampleIds?.(quote.marketId).includes(observation.sampleId))) return rejection('INPUT_NOT_READY');
    } catch { return rejection('UNSUPPORTED_CELL'); }
    const clock = this.options.clock.getClock();
    if (!clock.ready || !Number.isSafeInteger(clock.nowMs) || !Number.isFinite(clock.uncertaintyMs) || clock.uncertaintyMs < 0 || this.options.marketData.getHealth(quote.marketId).status !== 'ready') return rejection('INPUT_NOT_READY');
    if (clock.nowMs + clock.uncertaintyMs >= quote.validUntilMs || quote.generatedAtMs > clock.nowMs + clock.uncertaintyMs) return rejection('QUOTE_EXPIRED');
    const minLeadMs = this.options.minLeadMs?.() ?? 3000;
    if (!Number.isFinite(minLeadMs) || minLeadMs < 0 || quote.startMs - (clock.nowMs + clock.uncertaintyMs) < minLeadMs) return rejection('TOO_LATE');
    return { quote: clone(quote), nowMs: clock.nowMs };
  }
  private pruneEvidence(state: LedgerState, nowMs: number): boolean {
    // Idle market polling must not grow the durable ledger forever. Keep the
    // recent recovery buffer, open-window evidence and every recorded result.
    const positions = Object.values(state.positions);
    const resultEvidence = new Set(positions.flatMap(position => [...(position.evidenceSampleIds ?? [])]));
    const open = positions.filter(position => position.status === 'open');
    let changed = false;
    for (const sampleBag of [state.samples, state.observedSamples ?? {}]) for (const [id, sample] of Object.entries(sampleBag)) {
      if (sample.sourceTimeMs >= nowMs - 120_000 || resultEvidence.has(id) || open.some(position => position.marketId === sample.marketId && sample.sourceTimeMs >= position.startMs && (position.ruleVersion === OBSERVED_PATH_RULE_VERSION ? sample.sourceTimeMs <= position.endMs : sample.sourceTimeMs < position.endMs))) continue;
      delete sampleBag[id]; delete state.conflicts[id]; changed = true;
    }
    return changed;
  }
  private mergeSamples(state: LedgerState, incoming: readonly PriceSample[]): boolean {
    let changed = false;
    for (const sample of incoming) {
      try {
        const market = getMarket(sample.marketId);
        assertTimestamp(sample.sourceTimeMs); assertTimestamp(sample.receivedAtMs); normalizeDecimal(sample.price);
        if (sample.pairId !== market.pairId || sample.feedId !== market.feedId || sample.sampleId !== sampleId(sample.feedId, sample.sourceTimeMs) || compareDecimal(sample.price, { coefficient: '0', exponent: 0 }) <= 0) continue;
        const previous = state.samples[sample.sampleId];
        if (previous && (previous.marketId !== sample.marketId || previous.sourceTimeMs !== sample.sourceTimeMs || compareDecimal(previous.price, sample.price) !== 0)) { if (!state.conflicts[sample.sampleId]) { state.conflicts[sample.sampleId] = true; changed = true; } }
        else if (!previous) { state.samples[sample.sampleId] = clone(sample); changed = true; }
      } catch { /* A malformed observation cannot settle a paper position. */ }
    }
    return changed;
  }
  private mergeObservedSamples(state: LedgerState, incoming: readonly PriceSample[], clock: ClockSnapshot): boolean {
    if (!clock.ready || !Number.isSafeInteger(clock.nowMs) || !Number.isFinite(clock.uncertaintyMs) || clock.uncertaintyMs < 0) return false;
    let changed = false;
    for (const sample of incoming) {
      try {
        const market = getMarket(sample.marketId);
        assertTimestamp(sample.sourceTimeMs); assertTimestamp(sample.receivedAtMs); normalizeDecimal(sample.price);
        if (sample.pairId !== market.pairId || sample.feedId !== market.feedId || sample.sampleId !== sampleId(sample.feedId, sample.sourceTimeMs) || sample.sourceTimeMs % 1000 !== 0 || sample.sourceTimeMs > clock.nowMs + clock.uncertaintyMs || compareDecimal(sample.price, { coefficient: '0', exponent: 0 }) <= 0) continue;
        const id = observedSampleId(sample);
        // Never overwrite an observed-path price. The readwrite transaction
        // makes the first committed observation the same in every tab/reload.
        if (!state.observedSamples?.[id]) { (state.observedSamples ??= {})[id] = { ...clone(sample), sampleId: id }; changed = true; }
      } catch { /* Invalid provider observations cannot enter the playable path. */ }
    }
    return changed;
  }
  private settleObservedPosition(state: LedgerState, position: PositionSnapshot, allSamples: readonly PriceSample[], clock: ClockSnapshot): boolean {
    const policy = position.settlementPolicy!;
    if (policy.expectedSampleIntervalMs !== OBSERVED_PATH_POLICY.expectedSampleIntervalMs || policy.lateArrivalGraceMs !== OBSERVED_PATH_POLICY.lateArrivalGraceMs || policy.recoveryDeadlineMs !== OBSERVED_PATH_POLICY.recoveryDeadlineMs) return false;
    const samples = allSamples.filter(sample => sample.marketId === position.marketId);
    for (let index = 0; index < samples.length; index++) {
      const a = samples[index]!;
      if (a.sourceTimeMs >= position.endMs) break;
      if (sampleTouchesCell(a, position)) {
        this.settle(state, position, 'won', [a.sampleId], 'The recorded price path touched your square.', clock.nowMs, a.sourceTimeMs);
        return true;
      }
      const b = samples[index + 1];
      if (!b || b.sourceTimeMs - a.sourceTimeMs !== policy.expectedSampleIntervalMs) continue;
      const hit = segmentTouchesCell(a, b, position, policy.expectedSampleIntervalMs);
      if (hit) {
        this.settle(state, position, 'won', [a.sampleId, b.sampleId], 'The recorded price path touched your square.', clock.nowMs, hit.firstTouchTimeMs);
        return true;
      }
    }
    if (clock.nowMs - clock.uncertaintyMs < position.endMs) return false;
    const evidence = samples.filter(sample => sample.sourceTimeMs >= position.startMs && sample.sourceTimeMs <= position.endMs);
    const times = new Set(evidence.map(sample => sample.sourceTimeMs));
    let complete = true;
    for (let time = position.startMs; time <= position.endMs; time += policy.expectedSampleIntervalMs) if (!times.has(time)) { complete = false; break; }
    if (complete && clock.nowMs - clock.uncertaintyMs >= position.endMs + policy.lateArrivalGraceMs) {
      this.settle(state, position, 'lost', evidence.map(sample => sample.sampleId), 'The completed recorded path missed your square.', clock.nowMs);
      return true;
    }
    if (clock.nowMs - clock.uncertaintyMs >= position.endMs + policy.recoveryDeadlineMs) {
      this.settle(state, position, 'refunded', evidence.map(sample => sample.sampleId), 'Price history could not be recovered; stake refunded.', clock.nowMs);
      return true;
    }
    return false;
  }
  private settle(state: LedgerState, position: PositionSnapshot, status: 'won' | 'lost' | 'refunded', sampleIds: readonly string[], reason: string, nowMs: number, touchTimeMs?: number): void {
    const key = `terminal:${position.positionId}`;
    if (state.positions[position.positionId]?.status !== 'open' || state.entries[key]) return;
    const credit = status === 'won' ? position.grossReturnCents : status === 'refunded' ? position.stakeCents : '0';
    state.positions[position.positionId] = { ...position, status, settledAtMs: nowMs, ...(touchTimeMs === undefined ? {} : { touchTimeMs }), evidenceSampleIds: [...sampleIds], settlementReason: reason };
    state.balanceCents = (integer(state.balanceCents) + integer(credit)).toString();
    state.entries[key] = { id: key, amountCents: credit, kind: status === 'won' ? 'win' : status === 'refunded' ? 'refund' : 'loss', positionId: position.positionId };
  }
  private publish(state: LedgerState): void {
    this.audit = { positions: state.positions, entries: state.entries, samples: { ...state.samples, ...state.observedSamples }, balanceCents: state.balanceCents };
    this.gameSamples = freeze(clone(Object.values(state.observedSamples ?? {}).sort((a, b) => a.sourceTimeMs - b.sourceTimeMs || a.sampleId.localeCompare(b.sampleId))));
    this.current = freeze({ revision: state.revision, balanceCents: state.balanceCents, positions: clone(Object.values(state.positions).sort((a, b) => b.acceptedAtMs - a.acceptedAtMs || a.positionId.localeCompare(b.positionId))), ready: this.ready }); this.notify();
  }
  private notify(): void { for (const listener of this.listeners) { try { listener(); } catch { /* View errors cannot reverse committed ledger/count state. */ } } }
  private broadcast(): void { try { this.channel?.postMessage({ revision: this.current.revision }); } catch { /* Cross-tab notification is optional; transactions remain authoritative. */ } }
  private fail(error: unknown): void { this.ready = false; this.current = freeze({ ...this.current, ready: false, error: errorText(error) }); this.notify(); }
}
