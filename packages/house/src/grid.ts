import { OBSERVED_PATH_RULE_VERSION, compareDecimal, createCell, decimalToNumber, multiplyDecimalInteger, normalizeDecimal, type CellTerms, type DecimalValue, type MarketId, type QuoteUnavailableReason } from '@maya/contracts';
import { getMarket } from '@maya/config';
import { rangeKeyOf } from './defenses.js';
import { BAND_OFFSETS, GRID_CELLS, MIN_LEAD_S, exactBucket, quoteSigma, scaledFeatures, windowGrid, type PathView, type SigmaSource } from './features.js';
import { SIGNED_EDGE_MIN, offerX100, offerX100Signed, priceImpact, resolveEdge, type AboveCapPolicy, type EdgeScheduleConfig, type ResolvedEdge } from './pricing.js';
import { isTierId, type TierId } from './promo.js';
import { DEFAULT_BREAKER_CONFIG, limitAmounts, validateRiskLimits, type LiabilityView, type QuotingGate, type RiskLimits } from './risk.js';
import { lookup, type CalibratedTable } from './table.js';
import { maxStakeForLiability, type Centi } from './units.js';

export interface HousePricingConfig {
  readonly z: number;
  readonly minX100: number;
  readonly capX100: number;
  readonly aboveCap: AboveCapPolicy;
  /** Price-impact coefficient: a cell at its full liability limit adds impactK to q. */
  readonly impactK: number;
}
export const DEFAULT_PRICING_CONFIG: HousePricingConfig = Object.freeze({ z: 0, minX100: 101, capX100: 5000, aboveCap: 'hide', impactK: 0.02 });
/** Admin-validated ranges (§7). */
export const CAP_RANGE = Object.freeze({ min: 200, max: 10_000 });

export type HouseQuoteUnavailableReason = QuoteUnavailableReason | 'liability-limit' | 'market-paused' | 'equity-floor' | 'hidden-above-cap';

export interface QuoteGridInput {
  readonly market: MarketId;
  /** Quote instant: integer Unix seconds of the latest first-seen sample. */
  readonly t: number;
  /** Exact first-seen price at t. */
  readonly spot: DecimalValue;
  readonly path: PathView;
  readonly table: CalibratedTable;
  readonly pricing: HousePricingConfig;
  readonly schedule: EdgeScheduleConfig;
  readonly registeredPlayers: number;
  /** Build a flagged-account variant carrying the flow surcharge. */
  readonly flagged?: boolean;
  readonly limits: RiskLimits;
  readonly book: LiabilityView;
  readonly equityCenti: bigint;
  /** Breakers.quoting(market). Omitted means no breaker is tripped. */
  readonly gate?: QuotingGate;
  /** When given, a quote instant older than the feed-stale limit fails closed. */
  readonly nowMs?: number;
  readonly feedStaleMs?: number;
  /** Minimum lead (s): cells whose tau is below it are unavailable ('too-late'); the grid geometry stays §3.1. */
  readonly minLeadS?: number;
  /** Adaptive edge adjustment per multiplier range key (by the cell's unadjusted offer), added to the edge. */
  readonly rangeAdjust?: Readonly<Record<string, number>>;
  /**
   * SPEC-12 promo pricing. When given it replaces the legacy launch/standard phase of `schedule`: the grid's base
   * edge is `baseEdge` (negative for a boosted tier: −lossBudget + guard adjustment), the flow surcharge and
   * drawdown widening still add on top, and boosted cells below `minWinX100` are hidden ('below-minimum').
   */
  readonly promo?: GridPromoPricing;
}

export interface GridPromoPricing {
  readonly tier: TierId;
  readonly boosted: boolean;
  readonly baseEdge: number;
  /** Minimum offered multiplier ×100 for boosted cells (the tier's minimum win). */
  readonly minWinX100?: number;
}

interface GridCellBase {
  /** w × 7 + (b + 3). */
  readonly index: number;
  readonly window: number;
  readonly bandOffset: number;
  readonly tau: number;
  readonly cell: CellTerms;
  readonly liabilityCenti: Centi;
  readonly limitCenti: Centi;
  readonly legs: number;
  readonly key?: number;
  readonly p?: number;
  readonly se?: number;
  readonly impact?: number;
  readonly q?: number;
}
export interface OfferedGridCell extends GridCellBase {
  readonly available: true;
  readonly x100: number;
  readonly capped: boolean;
  /** Edge this cell was priced with (grid edge plus any range adjustment). */
  readonly cellEdge: number;
  /** Adaptive range adjustment included in cellEdge (0 when none). */
  readonly rangeAdjust: number;
  /** Largest stake whose liability fits the cell, column and global headroom and stake caps. */
  readonly maxStakeCenti: Centi;
}
export interface UnavailableGridCell extends GridCellBase {
  readonly available: false;
  readonly reason: HouseQuoteUnavailableReason;
}
export type QuoteGridCell = OfferedGridCell | UnavailableGridCell;

export interface QuoteGrid {
  readonly market: MarketId;
  readonly t: number;
  readonly tableId: string;
  readonly spot: DecimalValue;
  readonly bucket: string;
  readonly start0: number;
  readonly sigma?: number;
  readonly sigmaSource?: SigmaSource;
  readonly s?: number;
  readonly frac?: number;
  readonly edge: ResolvedEdge;
  readonly equityCenti: Centi;
  /** Set when the whole grid is unavailable; every cell then carries the same reason. */
  readonly reason?: HouseQuoteUnavailableReason;
  readonly cells: readonly QuoteGridCell[];
}

function validAdjust(adjust: Readonly<Record<string, number>> | undefined): boolean {
  return adjust === undefined || Object.values(adjust).every(v => typeof v === 'number' && Number.isFinite(v) && v >= -0.5 && v <= 0.5);
}
/** Edge with a range adjustment, kept inside [0, 0.99]. */
export function adjustedEdge(edge: number, adjust: number): number { return adjust === 0 ? edge : Math.min(0.99, Math.max(0, edge + adjust)); }
/** SPEC-12: a promo edge (possibly negative) with a range adjustment, kept inside [SIGNED_EDGE_MIN, 0.99]. */
export function adjustedEdgeSigned(edge: number, adjust: number): number { return adjust === 0 ? edge : Math.min(0.99, Math.max(SIGNED_EDGE_MIN, edge + adjust)); }

function validPromo(promo: GridPromoPricing | undefined, pricing: HousePricingConfig): boolean {
  if (promo === undefined) return true;
  if (!isTierId(promo.tier) || typeof promo.boosted !== 'boolean' || !Number.isFinite(promo.baseEdge) || promo.baseEdge < SIGNED_EDGE_MIN || promo.baseEdge >= 0.99) return false;
  if (promo.boosted && (promo.tier === 'standard' || !Number.isSafeInteger(promo.minWinX100) || promo.minWinX100! < 101 || promo.minWinX100! > pricing.capX100)) return false;
  return true;
}

/** Grid edge in promo mode: the tier's base edge plus the flow surcharge and drawdown widening of the schedule. */
function promoEdge(promo: GridPromoPricing, schedule: EdgeScheduleConfig, flagged: boolean, widened: boolean): ResolvedEdge {
  const flow = flagged ? schedule.flowEdge : 0;
  const widen = widened ? schedule.drawdownWiden : 0;
  return Object.freeze({ edge: promo.baseEdge + flow + widen, phase: promo.boosted ? 'launch' : 'standard', base: promo.baseEdge, flow, widen, tier: promo.tier, boosted: promo.boosted });
}

function validPricing(pricing: HousePricingConfig): boolean {
  return Number.isFinite(pricing.z) && pricing.z >= 0 && Number.isSafeInteger(pricing.minX100) && pricing.minX100 >= 101
    && Number.isSafeInteger(pricing.capX100) && pricing.capX100 >= pricing.minX100 && (pricing.aboveCap === 'hide' || pricing.aboveCap === 'cap')
    && Number.isFinite(pricing.impactK) && pricing.impactK >= 0;
}

/**
 * Immutable 6 × 7 grid for one market and quote instant (§3): every cell carries either an offered
 * x100 with its stake headroom, or a typed reason. Fails closed on stale feed, breakers, equity,
 * missing volatility, unknown table cells and exhausted limits.
 */
export function buildQuoteGrid(input: QuoteGridInput): QuoteGrid {
  const { market, t, table, pricing, limits, book, equityCenti } = input;
  const definition = getMarket(market);
  const spot = Object.freeze(normalizeDecimal(input.spot));
  const gate: QuotingGate = input.gate ?? { allowed: true, drawdownWidened: false };
  const widened = gate.allowed && gate.drawdownWidened;
  const promo = input.promo;
  const edge = promo && validPromo(promo, pricing) ? promoEdge(promo, input.schedule, input.flagged ?? false, widened) : resolveEdge(input.schedule, { registeredPlayers: input.registeredPlayers, flagged: input.flagged ?? false, drawdownWidened: widened });
  if (!Number.isSafeInteger(t) || t < 0 || compareDecimal(spot, { coefficient: '0', exponent: 0 }) <= 0) {
    return Object.freeze({ market, t, tableId: table.id, spot, bucket: '0', start0: 0, edge, equityCenti: equityCenti.toString(), reason: 'model-incompatible', cells: Object.freeze([]) });
  }
  const bucket = exactBucket(spot, definition.bandHeight);
  const h = decimalToNumber(definition.bandHeight);
  const { start0, windows } = windowGrid(t);
  const amounts = limitAmounts(equityCenti, limits);
  const minLeadS = input.minLeadS ?? MIN_LEAD_S;

  let reason: HouseQuoteUnavailableReason | undefined;
  if (table.market !== market || table.bandHeight !== h || !validPricing(pricing) || validateRiskLimits(limits) || !Number.isSafeInteger(minLeadS) || minLeadS < MIN_LEAD_S || !validAdjust(input.rangeAdjust) || !validPromo(promo, pricing)) reason = 'model-incompatible';
  else if (equityCenti <= 0n) reason = 'equity-floor';
  else if (!gate.allowed) reason = gate.reason;
  else if (input.nowMs !== undefined && !(input.nowMs - t * 1000 <= (input.feedStaleMs ?? DEFAULT_BREAKER_CONFIG.feedStaleMs))) reason = 'stale-source';
  const sigma = quoteSigma(input.path, t);
  if (!reason && !sigma.ok) reason = sigma.reason;
  const spotNumber = decimalToNumber(spot);
  const features = sigma.ok ? scaledFeatures(sigma.sigma, spotNumber, h, Number(bucket)) : undefined;

  const columnHeadroom = new Map<number, bigint>();
  const headroomGlobal = amounts.global - book.globalLiability();
  const cells: QuoteGridCell[] = [];
  for (const window of windows) {
    const startMs = window.start * 1000;
    if (!columnHeadroom.has(startMs)) columnHeadroom.set(startMs, amounts.column - book.columnLiability(market, startMs));
    for (const [bi, b] of BAND_OFFSETS.entries()) {
      const index = window.w * BAND_OFFSETS.length + bi;
      const lowerIndex = bucket + BigInt(b);
      const cell = createCell(market, startMs, multiplyDecimalInteger(definition.bandHeight, lowerIndex), multiplyDecimalInteger(definition.bandHeight, lowerIndex + 1n), OBSERVED_PATH_RULE_VERSION);
      const cellLiability = book.cellLiability(cell.cellId);
      const base = { index, window: window.w, bandOffset: b, tau: window.tau, cell, liabilityCenti: cellLiability.toString(), limitCenti: amounts.cell.toString(), legs: book.legCount(cell.cellId) };
      const unavailable = (why: HouseQuoteUnavailableReason, extra: Partial<GridCellBase> = {}): UnavailableGridCell => Object.freeze({ ...base, ...extra, available: false, reason: why });
      if (reason) { cells.push(unavailable(reason)); continue; }
      if (window.tau < minLeadS) { cells.push(unavailable('too-late')); continue; }
      if (lowerIndex < 0n) { cells.push(unavailable('out-of-domain')); continue; }
      const fair = lookup(table, { s: features!.s, frac: features!.frac, tau: window.tau, b });
      if (!fair) { cells.push(unavailable('out-of-domain')); continue; }
      const impact = priceImpact(pricing.impactK, cellLiability, limits.cellFraction, equityCenti);
      // SPEC-12: in promo mode the signed edge applies and boosted cells below the tier's minimum win are hidden.
      const offerFn = promo ? offerX100Signed : offerX100;
      const adjustFn = promo ? adjustedEdgeSigned : adjustedEdge;
      const minX100 = promo?.boosted ? Math.max(pricing.minX100, promo.minWinX100!) : pricing.minX100;
      const params = { edge: edge.edge, z: pricing.z, minX100, capX100: pricing.capX100, aboveCap: pricing.aboveCap };
      let offer = offerFn(fair.p, fair.se, params, impact);
      let adjust = 0;
      if (offer.ok && input.rangeAdjust) {
        adjust = input.rangeAdjust[rangeKeyOf(offer.x100)] ?? 0;
        if (adjust !== 0) offer = offerFn(fair.p, fair.se, { ...params, edge: adjustFn(edge.edge, adjust) }, impact);
      }
      const priced = { key: fair.key, p: fair.p, se: fair.se, impact, ...(offer.q !== undefined ? { q: offer.q } : {}) };
      if (!offer.ok) { cells.push(unavailable(offer.reason, priced)); continue; }
      let headroom = amounts.cell - cellLiability;
      const column = columnHeadroom.get(startMs)!;
      if (column < headroom) headroom = column;
      if (headroomGlobal < headroom) headroom = headroomGlobal;
      let maxStake = maxStakeForLiability(headroom, offer.x100);
      if (limits.maxStakePerBetCenti !== undefined) { const cap = BigInt(limits.maxStakePerBetCenti); if (cap < maxStake) maxStake = cap; }
      if (limits.maxStakePerCellCenti !== undefined) { const left = BigInt(limits.maxStakePerCellCenti) - book.cellStake(cell.cellId); if (left < maxStake) maxStake = left; }
      if (maxStake < 1n) { cells.push(unavailable('liability-limit', priced)); continue; }
      cells.push(Object.freeze({ ...base, ...priced, available: true, x100: offer.x100, capped: offer.capped, cellEdge: adjustFn(edge.edge, adjust), rangeAdjust: adjust, maxStakeCenti: maxStake.toString() }));
    }
  }
  if (cells.length !== GRID_CELLS) throw new Error('Quote grid must hold 42 cells');
  return Object.freeze({
    market, t, tableId: table.id, spot, bucket: bucket.toString(), start0,
    ...(sigma.ok ? { sigma: sigma.sigma, sigmaSource: sigma.source, s: features!.s, frac: features!.frac } : {}),
    edge, equityCenti: equityCenti.toString(), ...(reason ? { reason } : {}), cells: Object.freeze(cells),
  });
}

export interface CellFairValueInput {
  readonly market: MarketId;
  /** Instant (integer seconds of a first-seen sample) to value the cell at. */
  readonly t: number;
  readonly spot: DecimalValue;
  readonly path: PathView;
  readonly table: CalibratedTable;
  readonly startMs: number;
  /** Absolute band index of the cell (lowerPrice / bandHeight). */
  readonly bandIndex: bigint;
  /** Volatility at t when already known (e.g. from the grid published at t). */
  readonly sigma?: number;
}
export type CellFairValue =
  | { readonly ok: true; readonly p: number; readonly se: number; readonly key: number; readonly tau: number; readonly b: number; readonly sigma: number }
  | { readonly ok: false; readonly reason: 'out-of-domain' | 'insufficient-history' | 'invalid-volatility' | 'model-incompatible' };

/**
 * Calibrated fair probability of one fixed cell at instant t (the acceptance-hold re-validation):
 * the grid's features and table lookup for a cell identified by its start and absolute band.
 */
export function cellFairValue(input: CellFairValueInput): CellFairValue {
  const definition = getMarket(input.market);
  const h = decimalToNumber(definition.bandHeight);
  if (input.table.market !== input.market || input.table.bandHeight !== h || !Number.isSafeInteger(input.t) || compareDecimal(input.spot, { coefficient: '0', exponent: 0 }) <= 0) return { ok: false, reason: 'model-incompatible' };
  let sigma = input.sigma;
  if (sigma === undefined) {
    const estimate = quoteSigma(input.path, input.t);
    if (!estimate.ok) return { ok: false, reason: estimate.reason };
    sigma = estimate.sigma;
  }
  if (!(sigma > 0) || !Number.isFinite(sigma)) return { ok: false, reason: 'invalid-volatility' };
  const bucket = exactBucket(input.spot, definition.bandHeight);
  const b = input.bandIndex - bucket;
  if (b < -3n || b > 3n) return { ok: false, reason: 'out-of-domain' };
  const tau = input.startMs / 1000 - input.t;
  if (!Number.isSafeInteger(tau)) return { ok: false, reason: 'out-of-domain' };
  const features = scaledFeatures(sigma, decimalToNumber(input.spot), h, Number(bucket));
  const fair = lookup(input.table, { s: features.s, frac: features.frac, tau, b: Number(b) });
  if (!fair) return { ok: false, reason: 'out-of-domain' };
  return { ok: true, p: fair.p, se: fair.se, key: fair.key, tau, b: Number(b), sigma };
}
