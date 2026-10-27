import type { CellTerms, MarketId } from '@maya/contracts';
import { exceedsFraction, mulFloor, parseCenti, parseX100, type Centi, type X100 } from './units.js';
import { validMeta, type ChangeMeta } from './pricing.js';

export interface RiskLimits {
  /** Fractions of live house equity E. */
  readonly cellFraction: number;
  readonly columnFraction: number;
  readonly globalFraction: number;
  readonly accountFraction: number;
  readonly maxStakePerBetCenti?: Centi;
  readonly maxStakePerCellCenti?: Centi;
}
export const DEFAULT_RISK_LIMITS: RiskLimits = Object.freeze({ cellFraction: 0.001, columnFraction: 0.005, globalFraction: 0.02, accountFraction: 0.002 });

export type LimitKind = 'cell' | 'column' | 'account' | 'global';
export const LIMIT_ORDER: readonly LimitKind[] = Object.freeze(['cell', 'column', 'account', 'global']);
export interface LimitAmounts { readonly cell: bigint; readonly column: bigint; readonly account: bigint; readonly global: bigint }

export function validateRiskLimits(limits: RiskLimits): string | undefined {
  for (const key of ['cellFraction', 'columnFraction', 'globalFraction', 'accountFraction'] as const) {
    const value = limits[key];
    if (typeof value !== 'number' || !(value > 0 && value <= 1)) return `${key} must be in (0, 1]`;
  }
  for (const key of ['maxStakePerBetCenti', 'maxStakePerCellCenti'] as const) {
    const value = limits[key];
    if (value !== undefined && (typeof value !== 'string' || !/^\d{1,30}$/.test(value) || BigInt(value) <= 0n)) return `${key} must be a positive Centi string`;
  }
  return undefined;
}

/** Limits shrink with equity: floor(E × fraction); non-positive equity allows no liability at all. */
export function limitAmounts(equityCenti: bigint, limits: RiskLimits): LimitAmounts {
  if (equityCenti <= 0n) return Object.freeze({ cell: 0n, column: 0n, account: 0n, global: 0n });
  return Object.freeze({
    cell: mulFloor(equityCenti, limits.cellFraction), column: mulFloor(equityCenti, limits.columnFraction),
    account: mulFloor(equityCenti, limits.accountFraction), global: mulFloor(equityCenti, limits.globalFraction),
  });
}

export function columnKey(marketId: MarketId, startMs: number): string { return `${marketId}:${startMs}`; }

export interface LegExposure {
  readonly legId: string;
  readonly account: string;
  readonly marketId: MarketId;
  readonly cellId: string;
  readonly startMs: number;
  readonly stakeCenti: bigint;
  /** payout − stake. */
  readonly liabilityCenti: bigint;
}
export function legExposure(input: { readonly legId: string; readonly account: string; readonly cell: Pick<CellTerms, 'cellId' | 'marketId' | 'startMs'>; readonly stakeCenti: Centi; readonly x100: X100 }): LegExposure {
  const stake = parseCenti(input.stakeCenti); const m = parseX100(input.x100);
  return Object.freeze({ legId: input.legId, account: input.account, marketId: input.cell.marketId, cellId: input.cell.cellId, startMs: input.cell.startMs, stakeCenti: stake, liabilityCenti: (stake * m) / 100n - stake });
}

/** Read side used by the quote grid. */
export interface LiabilityView {
  cellLiability(cellId: string): bigint;
  columnLiability(marketId: MarketId, startMs: number): bigint;
  accountLiability(account: string): bigint;
  globalLiability(): bigint;
  cellStake(cellId: string): bigint;
  legCount(cellId: string): number;
}

export type AcceptCheck =
  | { readonly ok: true; readonly limits: LimitAmounts }
  | { readonly ok: false; readonly reason: 'LIABILITY_LIMIT'; readonly limit: LimitKind; readonly currentCenti: bigint; readonly addCenti: bigint; readonly limitCenti: bigint }
  | { readonly ok: false; readonly reason: 'STAKE_NOT_ALLOWED' | 'CELL_CAP_EXCEEDED'; readonly currentCenti: bigint; readonly addCenti: bigint; readonly limitCenti: bigint }
  | { readonly ok: false; readonly reason: 'DUPLICATE_LEG' | 'INVALID_LEG' | 'INVALID_LIMITS' };
export type ApplyResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'DUPLICATE_LEG' | 'INVALID_LEG' };
export type ReleaseResult = { readonly ok: true; readonly leg: LegExposure } | { readonly ok: false; readonly reason: 'UNKNOWN_LEG' };
export interface LiabilitySnapshot {
  readonly globalCenti: Centi;
  readonly legs: number;
  readonly cells: Readonly<Record<string, Centi>>;
  readonly columns: Readonly<Record<string, Centi>>;
  readonly accounts: Readonly<Record<string, Centi>>;
}
export interface LimitUsage { readonly global: number; readonly maxColumn: number; readonly maxCell: number; readonly maxAccount: number }

function validLeg(leg: LegExposure): boolean {
  return typeof leg?.legId === 'string' && leg.legId.length > 0 && typeof leg.account === 'string' && leg.account.length > 0 && typeof leg.cellId === 'string' && leg.cellId.length > 0
    && (leg.marketId === 'btc-usd' || leg.marketId === 'eth-usd') && Number.isSafeInteger(leg.startMs) && leg.startMs >= 0
    && typeof leg.stakeCenti === 'bigint' && leg.stakeCenti > 0n && typeof leg.liabilityCenti === 'bigint' && leg.liabilityCenti >= 0n;
}
function bump(map: Map<string, bigint>, key: string, delta: bigint): void {
  const next = (map.get(key) ?? 0n) + delta;
  if (next === 0n) map.delete(key); else map.set(key, next);
}
const toRecord = (map: Map<string, bigint>): Readonly<Record<string, Centi>> => Object.freeze(Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, v.toString()])));
const ratio = (value: bigint, limit: bigint): number => (limit > 0n ? Number(value) / Number(limit) : value > 0n ? Number.POSITIVE_INFINITY : 0);

/**
 * Open liability L = payout − stake per cell, column (market:start), account and globally, in exact
 * Centi. Legs are idempotent by id: a replayed apply or a second release changes nothing.
 */
export class LiabilityBook implements LiabilityView {
  private readonly legs = new Map<string, LegExposure>();
  private readonly cells = new Map<string, bigint>();
  private readonly cellStakes = new Map<string, bigint>();
  private readonly cellLegs = new Map<string, number>();
  private readonly columns = new Map<string, bigint>();
  private readonly accounts = new Map<string, bigint>();
  private total = 0n;

  cellLiability(cellId: string): bigint { return this.cells.get(cellId) ?? 0n; }
  columnLiability(marketId: MarketId, startMs: number): bigint { return this.columns.get(columnKey(marketId, startMs)) ?? 0n; }
  accountLiability(account: string): bigint { return this.accounts.get(account) ?? 0n; }
  globalLiability(): bigint { return this.total; }
  cellStake(cellId: string): bigint { return this.cellStakes.get(cellId) ?? 0n; }
  legCount(cellId: string): number { return this.cellLegs.get(cellId) ?? 0; }
  hasLeg(legId: string): boolean { return this.legs.has(legId); }
  get size(): number { return this.legs.size; }

  /** First failing check in order: stake caps, then cell → column → account → global. */
  canAccept(leg: LegExposure, equityCenti: bigint, limits: RiskLimits): AcceptCheck {
    if (!validLeg(leg) || typeof equityCenti !== 'bigint') return { ok: false, reason: 'INVALID_LEG' };
    if (validateRiskLimits(limits)) return { ok: false, reason: 'INVALID_LIMITS' };
    if (this.legs.has(leg.legId)) return { ok: false, reason: 'DUPLICATE_LEG' };
    if (limits.maxStakePerBetCenti !== undefined) {
      const cap = BigInt(limits.maxStakePerBetCenti);
      if (leg.stakeCenti > cap) return { ok: false, reason: 'STAKE_NOT_ALLOWED', currentCenti: 0n, addCenti: leg.stakeCenti, limitCenti: cap };
    }
    if (limits.maxStakePerCellCenti !== undefined) {
      const cap = BigInt(limits.maxStakePerCellCenti), current = this.cellStake(leg.cellId);
      if (current + leg.stakeCenti > cap) return { ok: false, reason: 'CELL_CAP_EXCEEDED', currentCenti: current, addCenti: leg.stakeCenti, limitCenti: cap };
    }
    const amounts = limitAmounts(equityCenti, limits);
    const current: Record<LimitKind, bigint> = {
      cell: this.cellLiability(leg.cellId), column: this.columnLiability(leg.marketId, leg.startMs),
      account: this.accountLiability(leg.account), global: this.total,
    };
    for (const limit of LIMIT_ORDER) {
      if (current[limit] + leg.liabilityCenti > amounts[limit]) return { ok: false, reason: 'LIABILITY_LIMIT', limit, currentCenti: current[limit], addCenti: leg.liabilityCenti, limitCenti: amounts[limit] };
    }
    return { ok: true, limits: amounts };
  }

  /** Unconditional apply, for rebuilding state from the journal. New acceptances use `tryAccept`. */
  apply(leg: LegExposure): ApplyResult {
    if (!validLeg(leg)) return { ok: false, reason: 'INVALID_LEG' };
    if (this.legs.has(leg.legId)) return { ok: false, reason: 'DUPLICATE_LEG' };
    const frozen = Object.freeze({ ...leg });
    this.legs.set(leg.legId, frozen);
    bump(this.cells, leg.cellId, leg.liabilityCenti);
    bump(this.cellStakes, leg.cellId, leg.stakeCenti);
    this.cellLegs.set(leg.cellId, (this.cellLegs.get(leg.cellId) ?? 0) + 1);
    bump(this.columns, columnKey(leg.marketId, leg.startMs), leg.liabilityCenti);
    bump(this.accounts, leg.account, leg.liabilityCenti);
    this.total += leg.liabilityCenti;
    return { ok: true };
  }

  /** Check and apply as one step. */
  tryAccept(leg: LegExposure, equityCenti: bigint, limits: RiskLimits): AcceptCheck {
    const check = this.canAccept(leg, equityCenti, limits);
    if (check.ok) this.apply(leg);
    return check;
  }

  /** Remove a settled (won, lost or refunded) leg. */
  release(legId: string): ReleaseResult {
    const leg = this.legs.get(legId);
    if (!leg) return { ok: false, reason: 'UNKNOWN_LEG' };
    this.legs.delete(legId);
    bump(this.cells, leg.cellId, -leg.liabilityCenti);
    bump(this.cellStakes, leg.cellId, -leg.stakeCenti);
    const count = (this.cellLegs.get(leg.cellId) ?? 1) - 1;
    if (count === 0) this.cellLegs.delete(leg.cellId); else this.cellLegs.set(leg.cellId, count);
    bump(this.columns, columnKey(leg.marketId, leg.startMs), -leg.liabilityCenti);
    bump(this.accounts, leg.account, -leg.liabilityCenti);
    this.total -= leg.liabilityCenti;
    return { ok: true, leg };
  }

  snapshot(): LiabilitySnapshot {
    return Object.freeze({ globalCenti: this.total.toString(), legs: this.legs.size, cells: toRecord(this.cells), columns: toRecord(this.columns), accounts: toRecord(this.accounts) });
  }

  /** Usage as a fraction of each limit (admin overview `limitUsage`). */
  usage(equityCenti: bigint, limits: RiskLimits): LimitUsage {
    const amounts = limitAmounts(equityCenti, limits);
    const max = (map: Map<string, bigint>): bigint => { let m = 0n; for (const v of map.values()) if (v > m) m = v; return m; };
    return Object.freeze({ global: ratio(this.total, amounts.global), maxColumn: ratio(max(this.columns), amounts.column), maxCell: ratio(max(this.cells), amounts.cell), maxAccount: ratio(max(this.accounts), amounts.account) });
  }
}

export type BreakerId = 'feedStale' | 'drawdown' | 'equityFloor' | 'manual';
export type BreakerState = 'ok' | 'tripped' | 'widened' | 'paused';
export interface BreakerConfig {
  /** No fresh price for longer than this pauses that market. */
  readonly feedStaleMs: number;
  readonly drawdownWindowMs: number;
  /** 1 h equity drop strictly above this widens the edge. */
  readonly drawdownWidenFraction: number;
  /** 1 h equity drop strictly above this pauses all quoting. */
  readonly drawdownPauseFraction: number;
  /** Quote nothing while E < floor. */
  readonly equityFloorCenti: Centi;
}
export const DEFAULT_BREAKER_CONFIG: BreakerConfig = Object.freeze({ feedStaleMs: 7000, drawdownWindowMs: 3_600_000, drawdownWidenFraction: 0.02, drawdownPauseFraction: 0.05, equityFloorCenti: '0' });
export interface BreakerStatus { readonly id: BreakerId; readonly market?: MarketId; readonly state: BreakerState; readonly since: number; readonly reason: string }
export interface BreakerEvent {
  readonly type: 'breaker-transition';
  readonly id: BreakerId;
  readonly market?: MarketId;
  readonly from: BreakerState;
  readonly to: BreakerState;
  readonly atMs: number;
  readonly reason: string;
  /** 'system' for automatic transitions. */
  readonly actor: string;
}
export type QuotingGate =
  | { readonly allowed: true; readonly drawdownWidened: boolean }
  | { readonly allowed: false; readonly reason: 'stale-source' | 'market-paused' | 'equity-floor'; readonly breaker: BreakerId };
export type BreakerAdminResult =
  | { readonly ok: true; readonly events: readonly BreakerEvent[] }
  | { readonly ok: false; readonly reason: 'invalid-meta' | 'unknown-market' | 'already-paused' | 'not-paused' };

interface Slot { state: BreakerState; since: number; reason: string }
const SYSTEM = 'system';

/**
 * Breaker state machine. Every transition is returned as an event for the journal. feedStale and
 * equityFloor recover automatically; drawdown and manual pauses only resume by admin action.
 */
export class Breakers {
  private readonly config: BreakerConfig;
  private readonly floor: bigint;
  private readonly markets: readonly MarketId[];
  private readonly feed = new Map<MarketId, Slot>();
  private readonly manualMarket = new Map<MarketId, Slot>();
  private manualGlobal: Slot;
  private drawdownSlot: Slot;
  private equitySlot: Slot;
  /** Sliding-max deque of (time, equity) over the drawdown window. */
  private peaks: { atMs: number; equity: bigint }[] = [];
  private lastEquity: bigint | undefined;
  private lastEquityMs = -Infinity;

  constructor(markets: readonly MarketId[], config: BreakerConfig = DEFAULT_BREAKER_CONFIG, atMs = 0) {
    if (!(config.feedStaleMs > 0) || !(config.drawdownWindowMs > 0) || !(config.drawdownWidenFraction > 0) || !(config.drawdownPauseFraction >= config.drawdownWidenFraction)) throw new RangeError('Invalid breaker config');
    this.config = Object.freeze({ ...config });
    this.floor = parseCenti(config.equityFloorCenti, true);
    this.markets = Object.freeze([...new Set(markets)]);
    // Fail closed: a market quotes only after its first fresh price, and nothing quotes before equity is known.
    for (const market of this.markets) {
      this.feed.set(market, { state: 'tripped', since: atMs, reason: 'awaiting first price' });
      this.manualMarket.set(market, { state: 'ok', since: atMs, reason: '' });
    }
    this.manualGlobal = { state: 'ok', since: atMs, reason: '' };
    this.drawdownSlot = { state: 'ok', since: atMs, reason: '' };
    this.equitySlot = { state: 'tripped', since: atMs, reason: 'awaiting first equity observation' };
  }

  private move(slot: Slot, id: BreakerId, to: BreakerState, atMs: number, reason: string, actor: string, market?: MarketId): BreakerEvent {
    const event: BreakerEvent = Object.freeze({ type: 'breaker-transition', id, ...(market ? { market } : {}), from: slot.state, to, atMs, reason, actor });
    slot.state = to; slot.since = atMs; slot.reason = reason;
    return event;
  }

  observeFeed(market: MarketId, lastPriceMs: number | undefined, nowMs: number): readonly BreakerEvent[] {
    const slot = this.feed.get(market);
    if (!slot || !Number.isFinite(nowMs)) return [];
    const ageMs = lastPriceMs === undefined ? Number.POSITIVE_INFINITY : nowMs - lastPriceMs;
    const stale = !(ageMs <= this.config.feedStaleMs);
    if (stale && slot.state === 'ok') return [this.move(slot, 'feedStale', 'tripped', nowMs, lastPriceMs === undefined ? 'no price' : `no fresh price for ${ageMs} ms`, SYSTEM, market)];
    if (!stale && slot.state === 'tripped') return [this.move(slot, 'feedStale', 'ok', nowMs, 'fresh price', SYSTEM, market)];
    return [];
  }

  /** Feed live equity (Centi). Drives the equity floor and the 1 h drawdown breaker. */
  observeEquity(equityCenti: bigint, nowMs: number): readonly BreakerEvent[] {
    if (typeof equityCenti !== 'bigint' || !Number.isFinite(nowMs) || nowMs < this.lastEquityMs) return [];
    this.lastEquity = equityCenti; this.lastEquityMs = nowMs;
    const events: BreakerEvent[] = [];
    const below = equityCenti < this.floor;
    if (below && this.equitySlot.state === 'ok') events.push(this.move(this.equitySlot, 'equityFloor', 'tripped', nowMs, `equity ${equityCenti} below floor ${this.floor}`, SYSTEM));
    if (!below && this.equitySlot.state === 'tripped') events.push(this.move(this.equitySlot, 'equityFloor', 'ok', nowMs, 'equity at or above floor', SYSTEM));
    while (this.peaks.length && this.peaks.at(-1)!.equity <= equityCenti) this.peaks.pop();
    this.peaks.push({ atMs: nowMs, equity: equityCenti });
    while (this.peaks.length && this.peaks[0]!.atMs <= nowMs - this.config.drawdownWindowMs) this.peaks.shift();
    const peak = this.peaks[0]!.equity;
    if (peak > 0n && this.drawdownSlot.state !== 'paused') {
      const drop = peak - equityCenti;
      const describe = (limit: number) => `1 h equity drop ${drop} of peak ${peak} exceeds ${limit * 100}%`;
      if (exceedsFraction(drop, peak, this.config.drawdownPauseFraction)) events.push(this.move(this.drawdownSlot, 'drawdown', 'paused', nowMs, describe(this.config.drawdownPauseFraction), SYSTEM));
      else if (this.drawdownSlot.state === 'ok' && exceedsFraction(drop, peak, this.config.drawdownWidenFraction)) events.push(this.move(this.drawdownSlot, 'drawdown', 'widened', nowMs, describe(this.config.drawdownWidenFraction), SYSTEM));
    }
    return events;
  }

  /**
   * House funding or surplus withdrawal changes equity without being P&L; shift the drawdown window
   * so a treasury move is not read as a drop (or a recovery).
   */
  recordTreasuryFlow(deltaCenti: bigint): void {
    if (typeof deltaCenti !== 'bigint') return;
    for (const entry of this.peaks) entry.equity += deltaCenti;
    if (this.lastEquity !== undefined) this.lastEquity += deltaCenti;
  }

  /** Current 1 h drop as a fraction of the window peak (0 before any observation). */
  drawdown(): number {
    const peak = this.peaks[0]?.equity; const last = this.lastEquity;
    if (peak === undefined || last === undefined || peak <= 0n) return 0;
    return Number(peak - last) / Number(peak);
  }

  pauseMarket(market: MarketId, meta: ChangeMeta): BreakerAdminResult {
    if (!validMeta(meta)) return { ok: false, reason: 'invalid-meta' };
    const slot = this.manualMarket.get(market);
    if (!slot) return { ok: false, reason: 'unknown-market' };
    if (slot.state === 'paused') return { ok: false, reason: 'already-paused' };
    return { ok: true, events: [this.move(slot, 'manual', 'paused', meta.atMs, meta.reason, meta.actor, market)] };
  }
  resumeMarket(market: MarketId, meta: ChangeMeta): BreakerAdminResult {
    if (!validMeta(meta)) return { ok: false, reason: 'invalid-meta' };
    const slot = this.manualMarket.get(market);
    if (!slot) return { ok: false, reason: 'unknown-market' };
    if (slot.state !== 'paused') return { ok: false, reason: 'not-paused' };
    return { ok: true, events: [this.move(slot, 'manual', 'ok', meta.atMs, meta.reason, meta.actor, market)] };
  }
  pauseAll(meta: ChangeMeta): BreakerAdminResult {
    if (!validMeta(meta)) return { ok: false, reason: 'invalid-meta' };
    if (this.manualGlobal.state === 'paused') return { ok: false, reason: 'already-paused' };
    return { ok: true, events: [this.move(this.manualGlobal, 'manual', 'paused', meta.atMs, meta.reason, meta.actor)] };
  }
  /** Clears the global manual pause and any drawdown state (both are admin-only resumes). */
  resumeAll(meta: ChangeMeta): BreakerAdminResult {
    if (!validMeta(meta)) return { ok: false, reason: 'invalid-meta' };
    const events: BreakerEvent[] = [];
    if (this.manualGlobal.state === 'paused') events.push(this.move(this.manualGlobal, 'manual', 'ok', meta.atMs, meta.reason, meta.actor));
    if (this.drawdownSlot.state !== 'ok') events.push(this.resetDrawdown(meta));
    return events.length ? { ok: true, events } : { ok: false, reason: 'not-paused' };
  }
  /** Admin resume from a widened or paused drawdown; the window restarts at current equity. */
  resumeDrawdown(meta: ChangeMeta): BreakerAdminResult {
    if (!validMeta(meta)) return { ok: false, reason: 'invalid-meta' };
    if (this.drawdownSlot.state === 'ok') return { ok: false, reason: 'not-paused' };
    return { ok: true, events: [this.resetDrawdown(meta)] };
  }
  private resetDrawdown(meta: ChangeMeta): BreakerEvent {
    this.peaks = this.lastEquity === undefined ? [] : [{ atMs: meta.atMs, equity: this.lastEquity }];
    return this.move(this.drawdownSlot, 'drawdown', 'ok', meta.atMs, meta.reason, meta.actor);
  }

  /** Gate for one market's quoting; priority: equity floor, manual, drawdown pause, stale feed. */
  quoting(market: MarketId): QuotingGate {
    if (this.equitySlot.state !== 'ok') return { allowed: false, reason: 'equity-floor', breaker: 'equityFloor' };
    const manual = this.manualMarket.get(market);
    if (!manual || this.manualGlobal.state === 'paused' || manual.state === 'paused') return { allowed: false, reason: 'market-paused', breaker: 'manual' };
    if (this.drawdownSlot.state === 'paused') return { allowed: false, reason: 'market-paused', breaker: 'drawdown' };
    if (this.feed.get(market)?.state !== 'ok') return { allowed: false, reason: 'stale-source', breaker: 'feedStale' };
    // The widening amount belongs to the edge schedule (EdgeScheduleConfig.drawdownWiden).
    return { allowed: true, drawdownWidened: this.drawdownSlot.state === 'widened' };
  }

  /** Admin overview `breakers[]`. */
  status(): readonly BreakerStatus[] {
    const view = (id: BreakerId, slot: Slot, market?: MarketId): BreakerStatus => Object.freeze({ id, ...(market ? { market } : {}), state: slot.state, since: slot.since, reason: slot.reason });
    return Object.freeze([
      ...this.markets.map((m) => view('feedStale', this.feed.get(m)!, m)),
      view('drawdown', this.drawdownSlot),
      view('equityFloor', this.equitySlot),
      view('manual', this.manualGlobal),
      ...this.markets.map((m) => view('manual', this.manualMarket.get(m)!, m)),
    ]);
  }
}
