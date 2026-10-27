import { validMeta, type ChangeMeta } from './pricing.js';
import type { Centi } from './units.js';

/**
 * SPEC-12 promo tiers: the operator's acquisition budget. Ordered tiers (launch → growth → scale) each end
 * when the registered-player count or the cumulative turnover (accepted stake since launch, never reset)
 * reaches the tier's threshold, whichever comes first; after the last tier the house prices at its standard
 * edge. While a tier is current the house prices at a negative edge of −lossBudget (players' expected return
 * 1 + lossBudget), hides squares whose multiplier would fall below the tier's minimum win, caps how much
 * turnover each account may place at boosted odds, and guards the realized loss against the budget.
 *
 * Everything here is pure: configuration, validation, admin changes (returned as journal events), tier
 * resolution, pricing parameters, and the deterministic per-tier ledger and budget guard the house server
 * feeds from journaled events (so a rebuild reproduces it exactly).
 */

export const PROMO_TIER_IDS = Object.freeze(['launch', 'growth', 'scale'] as const);
export type PromoTierId = (typeof PROMO_TIER_IDS)[number];
export type TierId = PromoTierId | 'standard';
export const TIER_IDS: readonly TierId[] = Object.freeze([...PROMO_TIER_IDS, 'standard'] as TierId[]);
export function isPromoTierId(value: unknown): value is PromoTierId { return typeof value === 'string' && (PROMO_TIER_IDS as readonly string[]).includes(value); }
export function isTierId(value: unknown): value is TierId { return value === 'standard' || isPromoTierId(value); }

export interface PromoTierConfig {
  readonly id: PromoTierId;
  readonly label: string;
  /** A disabled tier is skipped (ending a tier early disables it). */
  readonly enabled: boolean;
  /** The tier ends once this many players are registered… */
  readonly untilPlayers: number;
  /** …or once cumulative turnover (accepted stake since launch) reaches this, whichever comes first. */
  readonly untilTurnoverCenti: Centi;
  /** Acceptable house loss on the tier's boosted turnover: target house margin −lossBudget (players' expected return 1 + lossBudget). */
  readonly lossBudget: number;
  /** Squares whose tier multiplier would fall below this (×100) are hidden. */
  readonly minWinX100: number;
  /** Turnover one account may place at this tier's boosted odds; beyond it the account is quoted at standard pricing. */
  readonly perAccountBoostCapCenti: Centi;
}

export interface PromoGuardConfig {
  readonly enabled: boolean;
  /** Cadence of the budget check (feed clock). */
  readonly evalEveryMs: number;
  /** Settled boosted turnover of the tier before the guard may act. */
  readonly minTurnoverCenti: Centi;
  /** Tighten only when the loss rate exceeds the budget by more than max(deadband, zGate × SE). */
  readonly zGate: number;
  readonly deadband: number;
  /** Largest change of the tier's guard adjustment per evaluation. */
  readonly maxStepPerEval: number;
  /** The guard adjustment (added to the tier's edge) stays within [0, maxTighten]: never looser than the tier's nominal pricing. */
  readonly maxTighten: number;
  /**
   * Breaker: cumulative realized loss − lossBudget × settled boosted turnover > tripMarginRel × turnover + tripZ × SD
   * falls back to standard pricing for new quotes until an admin resumes.
   */
  readonly tripMarginRel: number;
  readonly tripZ: number;
  /**
   * Also act on the expected loss rate at acceptance (Σ stake × (multiplier × p_fresh) over accepted boosted legs, p_fresh =
   * the calibrated fair value re-validated at the end of the acceptance hold). It measures the hold's selection effect
   * (SPEC-10 §9.5, ≈ +2 pts of return on near squares) with far less noise than settled outcomes, so a short tier is
   * corrected within minutes. Tightening follows whichever signal is higher; relaxing needs both to agree.
   */
  readonly acceptanceSignal: boolean;
}

export interface PromoConfig {
  /** Master switch: disabled means standard pricing for everybody (tier `standard`). */
  readonly enabled: boolean;
  /** Exactly launch, growth, scale, in this order, with non-decreasing thresholds. */
  readonly tiers: readonly PromoTierConfig[];
  readonly standardLabel: string;
  readonly guard: PromoGuardConfig;
}

const OPEN = 100n;
const centiOf = (open: bigint) => (open * OPEN).toString();

/** The operator's decisions of 2026-09-27 (SPEC-12 §1). */
export const DEFAULT_PROMO: PromoConfig = freezePromo({
  enabled: true,
  tiers: [
    { id: 'launch', label: 'Launch boost', enabled: true, untilPlayers: 10_000, untilTurnoverCenti: centiOf(1_000_000n), lossBudget: 0.10, minWinX100: 125, perAccountBoostCapCenti: centiOf(1_000n) },
    { id: 'growth', label: 'Growth boost', enabled: true, untilPlayers: 100_000, untilTurnoverCenti: centiOf(10_000_000n), lossBudget: 0.05, minWinX100: 110, perAccountBoostCapCenti: centiOf(5_000n) },
    { id: 'scale', label: 'Scale boost', enabled: true, untilPlayers: 1_000_000, untilTurnoverCenti: centiOf(100_000_000n), lossBudget: 0.01, minWinX100: 101, perAccountBoostCapCenti: centiOf(20_000n) },
  ],
  standardLabel: 'Standard odds',
  guard: { enabled: true, evalEveryMs: 5 * 60_000, minTurnoverCenti: centiOf(20_000n), zGate: 2, deadband: 0.005, maxStepPerEval: 0.01, maxTighten: 0.1, tripMarginRel: 0.02, tripZ: 3, acceptanceSignal: true },
});

export function freezePromo(c: PromoConfig): PromoConfig {
  return Object.freeze({
    enabled: c.enabled,
    tiers: Object.freeze(c.tiers.map(t => Object.freeze({ id: t.id, label: t.label, enabled: t.enabled, untilPlayers: t.untilPlayers, untilTurnoverCenti: t.untilTurnoverCenti, lossBudget: t.lossBudget, minWinX100: t.minWinX100, perAccountBoostCapCenti: t.perAccountBoostCapCenti }))),
    standardLabel: c.standardLabel,
    guard: Object.freeze({ ...c.guard }),
  });
}

/**
 * Thresholds scaled for a compressed simulation (players × playersFactor, turnover × turnoverFactor, rounded
 * down, at least 1). Caps, budgets and minimum wins are unchanged. Simulation only: never a production setting.
 */
export function scalePromoThresholds(c: PromoConfig, playersFactor: number, turnoverFactor: number): PromoConfig {
  if (!(playersFactor > 0) || !(turnoverFactor > 0) || !Number.isFinite(playersFactor) || !Number.isFinite(turnoverFactor)) throw new RangeError('scale factors must be positive and finite');
  const scaleBig = (v: string, f: number) => { const n = BigInt(Math.max(1, Math.floor(Number(v) * f))); return n.toString(); };
  return freezePromo({ ...c, tiers: c.tiers.map(t => ({ ...t, untilPlayers: Math.max(1, Math.floor(t.untilPlayers * playersFactor)), untilTurnoverCenti: scaleBig(t.untilTurnoverCenti, turnoverFactor) })) });
}

const num = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const int = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi;
const centi = (v: unknown, positive: boolean): boolean => typeof v === 'string' && /^(0|[1-9]\d{0,20})$/.test(v) && (!positive || v !== '0');
const label = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0 && v.length <= 40;

export const LOSS_BUDGET_MAX = 0.25;
export const MIN_WIN_RANGE = Object.freeze({ min: 101, max: 1000 });

/** Admin-validated ranges; returns a message naming the first invalid field. */
export function validatePromo(c: PromoConfig): string | undefined {
  if (!c || typeof c.enabled !== 'boolean') return 'enabled must be a boolean';
  if (!Array.isArray(c.tiers) || c.tiers.length !== PROMO_TIER_IDS.length || c.tiers.some((t, i) => t?.id !== PROMO_TIER_IDS[i])) return `tiers must be exactly ${PROMO_TIER_IDS.join(', ')} in this order`;
  for (const t of c.tiers) {
    const p = `tiers.${t.id}`;
    if (!label(t.label)) return `${p}.label must be 1–40 characters`;
    if (typeof t.enabled !== 'boolean') return `${p}.enabled must be a boolean`;
    if (!int(t.untilPlayers, 0, 1_000_000_000)) return `${p}.untilPlayers must be an integer within 0–1,000,000,000`;
    if (!centi(t.untilTurnoverCenti, false)) return `${p}.untilTurnoverCenti must be a Centi integer string`;
    if (!num(t.lossBudget, 0, LOSS_BUDGET_MAX)) return `${p}.lossBudget must be within 0–${LOSS_BUDGET_MAX}`;
    if (!int(t.minWinX100, MIN_WIN_RANGE.min, MIN_WIN_RANGE.max)) return `${p}.minWinX100 must be an integer within ${MIN_WIN_RANGE.min}–${MIN_WIN_RANGE.max}`;
    if (!centi(t.perAccountBoostCapCenti, true)) return `${p}.perAccountBoostCapCenti must be a positive Centi integer string`;
  }
  for (let i = 1; i < c.tiers.length; i++) {
    const a = c.tiers[i - 1]!, b = c.tiers[i]!;
    if (b.untilPlayers < a.untilPlayers) return `tiers.${b.id}.untilPlayers must be at least tiers.${a.id}.untilPlayers (thresholds are cumulative since launch)`;
    if (BigInt(b.untilTurnoverCenti) < BigInt(a.untilTurnoverCenti)) return `tiers.${b.id}.untilTurnoverCenti must be at least tiers.${a.id}.untilTurnoverCenti (thresholds are cumulative since launch)`;
  }
  if (!label(c.standardLabel)) return 'standardLabel must be 1–40 characters';
  const g = c.guard;
  if (!g || typeof g.enabled !== 'boolean' || !int(g.evalEveryMs, 60_000, 86_400_000) || !centi(g.minTurnoverCenti, false) || !num(g.zGate, 0, 10) || !num(g.deadband, 0, 0.2)
    || !num(g.maxStepPerEval, 0, 0.05) || !num(g.maxTighten, 0, LOSS_BUDGET_MAX) || !num(g.tripMarginRel, 0, 0.5) || !num(g.tripZ, 0, 20) || typeof g.acceptanceSignal !== 'boolean') {
    return 'guard: enabled boolean, evalEveryMs 1 min–1 d (integer), minTurnoverCenti Centi, zGate 0–10, deadband 0–0.2, maxStepPerEval 0–0.05, maxTighten 0–0.25, tripMarginRel 0–0.5, tripZ 0–20, acceptanceSignal boolean';
  }
  return undefined;
}

// ------------------------------------------------------------------ admin changes

export type PromoTierPatch = Partial<Omit<PromoTierConfig, 'id'>>;
export interface PromoPatch {
  readonly enabled?: boolean;
  readonly standardLabel?: string;
  readonly tiers?: Partial<Record<PromoTierId, PromoTierPatch>>;
  readonly guard?: Partial<PromoGuardConfig>;
}
const TIER_KEYS: readonly string[] = ['label', 'enabled', 'untilPlayers', 'untilTurnoverCenti', 'lossBudget', 'minWinX100', 'perAccountBoostCapCenti'];
const GUARD_KEYS: readonly string[] = ['enabled', 'evalEveryMs', 'minTurnoverCenti', 'zGate', 'deadband', 'maxStepPerEval', 'maxTighten', 'tripMarginRel', 'tripZ', 'acceptanceSignal'];
const PATCH_KEYS: readonly string[] = ['enabled', 'standardLabel', 'tiers', 'guard'];

export interface PromoChangeEvent { readonly type: 'promo-changed'; readonly actor: string; readonly atMs: number; readonly reason: string; readonly before: PromoConfig; readonly after: PromoConfig }
export type PromoChangeResult =
  | { readonly ok: true; readonly config: PromoConfig; readonly event: PromoChangeEvent }
  | { readonly ok: false; readonly reason: 'invalid-meta' | 'invalid-patch' | 'invalid-config' | 'no-change'; readonly detail: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strip = <T extends object>(o: T | undefined): Partial<T> => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Pure admin change with strict keys (nested too): returns the frozen config and the journal event (actor, time, before/after). */
export function changePromo(config: PromoConfig, patch: PromoPatch, meta: ChangeMeta): PromoChangeResult {
  if (!validMeta(meta)) return { ok: false, reason: 'invalid-meta', detail: 'actor, reason and time are required' };
  const raw: unknown = patch;
  if (!isObj(raw)) return { ok: false, reason: 'invalid-patch', detail: 'patch must be an object' };
  for (const key of Object.keys(raw)) if (!PATCH_KEYS.includes(key)) return { ok: false, reason: 'invalid-patch', detail: `unknown field ${key}` };
  if (patch.tiers !== undefined) {
    const tiersRaw: unknown = patch.tiers;
    if (!isObj(tiersRaw)) return { ok: false, reason: 'invalid-patch', detail: 'tiers must be an object of tier → fields' };
    for (const [id, fields] of Object.entries(tiersRaw)) {
      if (!isPromoTierId(id)) return { ok: false, reason: 'invalid-patch', detail: `unknown tier ${id} (use ${PROMO_TIER_IDS.join(', ')})` };
      if (!isObj(fields)) return { ok: false, reason: 'invalid-patch', detail: `tiers.${id} must be an object` };
      for (const f of Object.keys(fields)) if (!TIER_KEYS.includes(f)) return { ok: false, reason: 'invalid-patch', detail: `unknown field tiers.${id}.${f}` };
    }
  }
  if (patch.guard !== undefined) {
    const guardRaw: unknown = patch.guard;
    if (!isObj(guardRaw)) return { ok: false, reason: 'invalid-patch', detail: 'guard must be an object' };
    for (const f of Object.keys(guardRaw)) if (!GUARD_KEYS.includes(f)) return { ok: false, reason: 'invalid-patch', detail: `unknown field guard.${f}` };
  }
  const after = freezePromo({
    enabled: patch.enabled ?? config.enabled,
    standardLabel: patch.standardLabel ?? config.standardLabel,
    tiers: config.tiers.map(t => ({ ...t, ...strip(patch.tiers?.[t.id]), id: t.id })),
    guard: { ...config.guard, ...strip(patch.guard) },
  });
  const error = validatePromo(after);
  if (error) return { ok: false, reason: 'invalid-config', detail: error };
  const before = freezePromo(config);
  if (JSON.stringify(after) === JSON.stringify(before)) return { ok: false, reason: 'no-change', detail: 'promo already has these values' };
  return { ok: true, config: after, event: Object.freeze({ type: 'promo-changed', actor: meta.actor, atMs: meta.atMs, reason: meta.reason, before, after }) };
}

// ------------------------------------------------------------------ tier resolution and pricing

export interface PromoProgress {
  /** Registered players (first deposit or sign-in). */
  readonly players: number;
  /** Cumulative accepted stake since launch (never reset). */
  readonly turnoverCenti: bigint;
}
export interface ResolvedTier {
  readonly tier: TierId;
  readonly label: string;
  /** The current tier's configuration (absent for `standard`). */
  readonly config?: PromoTierConfig;
  readonly untilPlayers: number | null;
  readonly untilTurnoverCenti: bigint | null;
}

/** Whether a tier's thresholds are reached (players or turnover, whichever first). */
export function tierReached(t: Pick<PromoTierConfig, 'untilPlayers' | 'untilTurnoverCenti'>, progress: PromoProgress): boolean {
  return progress.players >= t.untilPlayers || progress.turnoverCenti >= BigInt(t.untilTurnoverCenti);
}

function validProgress(p: PromoProgress): boolean {
  return Number.isSafeInteger(p?.players) && p.players >= 0 && typeof p.turnoverCenti === 'bigint' && p.turnoverCenti >= 0n;
}

/**
 * The current tier: the first enabled tier (in order) whose thresholds are not reached, else `standard`.
 * A disabled promo or an invalid progress reading fails closed to `standard` (the house's own edge).
 */
export function resolveTier(config: PromoConfig, progress: PromoProgress): ResolvedTier {
  const standard: ResolvedTier = Object.freeze({ tier: 'standard', label: config.standardLabel, untilPlayers: null, untilTurnoverCenti: null });
  if (!config.enabled || !validProgress(progress)) return standard;
  for (const t of config.tiers) {
    if (!t.enabled || tierReached(t, progress)) continue;
    return Object.freeze({ tier: t.id, label: t.label, config: t, untilPlayers: t.untilPlayers, untilTurnoverCenti: BigInt(t.untilTurnoverCenti) });
  }
  return standard;
}

export function tierConfig(config: PromoConfig, tier: TierId): PromoTierConfig | undefined { return tier === 'standard' ? undefined : config.tiers.find(t => t.id === tier); }

export interface GuardState {
  /** Added to the tier's edge (≥ 0): the guard's tightening. */
  readonly adjust: number;
  /** Budget breaker: new quotes fall back to standard pricing until an admin resumes. */
  readonly tripped: boolean;
  readonly since?: number;
  readonly reason?: string;
  readonly lastChangeMs?: number;
}
export const GUARD_OK: GuardState = Object.freeze({ adjust: 0, tripped: false });

export interface TierPricing {
  readonly tier: TierId;
  readonly label: string;
  /** Priced at the tier's promo edge (false: the standard edge, including a tier whose budget breaker tripped). */
  readonly boosted: boolean;
  /** Edge before the flow surcharge, drawdown widening and controller adjustment: −lossBudget + guard adjust, or the standard edge. */
  readonly baseEdge: number;
  /** Minimum offered multiplier ×100 for boosted pricing (squares below it are hidden). */
  readonly minWinX100?: number;
  readonly lossBudget?: number;
  readonly guardAdjust: number;
  /** Set when the tier is current but priced at standard because its budget breaker tripped. */
  readonly fallback?: 'budget-breaker';
}

/** Pricing parameters for new quotes in the resolved tier. */
export function tierPricing(resolved: ResolvedTier, standardEdge: number, guard: GuardState = GUARD_OK): TierPricing {
  if (resolved.tier === 'standard' || !resolved.config) return Object.freeze({ tier: 'standard', label: resolved.label, boosted: false, baseEdge: standardEdge, guardAdjust: 0 });
  const t = resolved.config;
  if (guard.tripped) return Object.freeze({ tier: t.id, label: t.label, boosted: false, baseEdge: standardEdge, guardAdjust: guard.adjust, fallback: 'budget-breaker' as const });
  return Object.freeze({ tier: t.id, label: t.label, boosted: true, baseEdge: -t.lossBudget + guard.adjust, minWinX100: t.minWinX100, lossBudget: t.lossBudget, guardAdjust: guard.adjust });
}

/** Boosted turnover an account may still place in a tier: cap − used − reserved by held placements (never negative). */
export function boostRemainingCenti(capCenti: bigint, usedCenti: bigint, pendingCenti = 0n): bigint {
  const left = capCenti - usedCenti - pendingCenti;
  return left > 0n ? left : 0n;
}

// ------------------------------------------------------------------ per-tier ledger and budget guard

/**
 * Where a settled leg's outcome is shared: its square (every leg on one square wins or loses together) and a time block
 * (market × window-start minute: squares of one path segment move together).
 */
export interface OutcomeCluster { readonly cell: string; readonly block: string; readonly minute: number }
interface OpenBlock { minute: number; dev: number; cells: Map<string, { sm: number; smp: number }> }

/**
 * Settled (won/lost) aggregate; refunds are counted apart and excluded. Three variance estimates of the realized return:
 * - `variance`: independent legs, Σ s²m²p(1−p) (what a per-leg model would say);
 * - `clusteredVariance`: legs on one square share one outcome, Σ_square (Σ s·m)² p̄(1−p̄);
 * - `blockVariance`: empirical, Σ_block (Σ credit − s·m·p)², over market × minute blocks (captures path correlation and model error).
 * The SE used for decisions and intervals is the largest of the three: a crowd betting the same squares makes the
 * independent-legs SE far too small.
 */
export class PromoAgg {
  bets = 0;
  wins = 0;
  refunds = 0;
  handle = 0n;
  returned = 0n;
  /** Σ stake·m·p, Σ stake²·m²·p(1−p) (model expectation and independent-legs variance of the return). */
  expectedReturn = 0;
  variance = 0;
  clusteredVariance = 0;
  blockVariance = 0;
  /** Σ stake × guard adjustment the leg was priced with (anti-windup for the guard). */
  guardWeighted = 0;
  private readonly open = new Map<string, OpenBlock>();
  add(stake: bigint, x100: number, p: number, credit: bigint, status: 'won' | 'lost' | 'refunded', guardAdjust = 0, cluster?: OutcomeCluster): void {
    if (status === 'refunded') { this.refunds++; return; }
    const s = Number(stake), m = x100 / 100;
    this.bets++; if (status === 'won') this.wins++;
    this.handle += stake; this.returned += credit;
    this.expectedReturn += s * m * p; this.variance += s * s * m * m * p * (1 - p);
    this.guardWeighted += s * guardAdjust;
    const dev = Number(credit) - s * m * p;
    if (!cluster) { this.clusteredVariance += s * s * m * m * p * (1 - p); this.blockVariance += dev * dev; return; }
    // Settlements arrive in window order: blocks two minutes behind this one are complete.
    for (const [key, b] of this.open) if (b.minute < cluster.minute - 2) this.closeBlock(key, b);
    let block = this.open.get(cluster.block);
    if (!block) { block = { minute: cluster.minute, dev: 0, cells: new Map() }; this.open.set(cluster.block, block); }
    block.dev += dev;
    const cell = block.cells.get(cluster.cell) ?? { sm: 0, smp: 0 };
    cell.sm += s * m; cell.smp += s * m * p;
    block.cells.set(cluster.cell, cell);
  }
  private closeBlock(key: string, b: OpenBlock): void {
    this.clusteredVariance += blockModelVariance(b);
    this.blockVariance += b.dev * b.dev;
    this.open.delete(key);
  }
  /** Clustered and block variance including blocks still open. */
  private variances(): { clustered: number; block: number } {
    let clustered = this.clusteredVariance, block = this.blockVariance;
    for (const b of this.open.values()) { clustered += blockModelVariance(b); block += b.dev * b.dev; }
    return { clustered, block };
  }
  /** House P&L (stake − credit) of the settled legs, Centi. */
  get housePnl(): bigint { return this.handle - this.returned; }
  /** Realized house loss rate (negative when the house won). */
  get lossRate(): number | null { return this.handle > 0n ? Number(this.returned - this.handle) / Number(this.handle) : null; }
  /** Standard error of the realized return rate (= of the loss rate): the largest of the independent, clustered and block estimates. */
  get se(): number | null {
    if (this.handle <= 0n) return null;
    const v = this.variances();
    return Math.sqrt(Math.max(this.variance, v.clustered, v.block)) / Number(this.handle);
  }
  snapshot(budget?: number): PromoAggView {
    const h = Number(this.handle), lr = this.lossRate, se = this.se, v = this.variances();
    return Object.freeze({
      bets: this.bets, wins: this.wins, refunds: this.refunds, handleCenti: this.handle.toString(), returnedCenti: this.returned.toString(), housePnlCenti: this.housePnl.toString(),
      rtp: h > 0 ? Number(this.returned) / h : null, expectedRtp: h > 0 ? this.expectedReturn / h : null, lossRate: lr, se,
      seIndependent: h > 0 ? Math.sqrt(this.variance) / h : null, seClustered: h > 0 ? Math.sqrt(v.clustered) / h : null, seBlock: h > 0 ? Math.sqrt(v.block) / h : null,
      lossRateLow: lr !== null && se !== null ? lr - 1.96 * se : null, lossRateHigh: lr !== null && se !== null ? lr + 1.96 * se : null,
      ...(budget !== undefined ? { budget, budgetUsed: lr !== null && budget > 0 ? lr / budget : null, budgetCenti: budgetCenti(this.handle, budget).toString() } : {}),
    });
  }
  /** Canonical state for rebuild comparison. */
  state(): Record<string, unknown> {
    return {
      bets: this.bets, wins: this.wins, refunds: this.refunds, handle: this.handle.toString(), returned: this.returned.toString(), expectedReturn: this.expectedReturn, variance: this.variance,
      clusteredVariance: this.clusteredVariance, blockVariance: this.blockVariance, guardWeighted: this.guardWeighted,
      open: [...this.open].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, b]) => [k, b.minute, b.dev, [...b.cells].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))]),
    };
  }
}
function blockModelVariance(b: OpenBlock): number {
  let v = 0;
  for (const c of b.cells.values()) { if (c.sm <= 0) continue; const p = c.smp / c.sm; v += c.sm * c.sm * p * (1 - p); }
  return v;
}
export interface PromoAggView {
  readonly bets: number; readonly wins: number; readonly refunds: number;
  readonly handleCenti: string; readonly returnedCenti: string; readonly housePnlCenti: string;
  readonly rtp: number | null; readonly expectedRtp: number | null;
  /** Realized house loss rate with a 95 % confidence interval (±1.96 SE, SE = the largest of the three estimates). */
  readonly lossRate: number | null; readonly se: number | null; readonly lossRateLow: number | null; readonly lossRateHigh: number | null;
  readonly seIndependent: number | null; readonly seClustered: number | null; readonly seBlock: number | null;
  readonly budget?: number; readonly budgetUsed?: number | null; readonly budgetCenti?: string;
}
/** lossBudget × handle, floored to whole Centi. */
export function budgetCenti(handle: bigint, lossBudget: number): bigint { return BigInt(Math.floor(Number(handle) * lossBudget)); }

export interface TierBook {
  /** Accepted stake quoted while this tier was current (boosted and standard-priced). */
  turnover: bigint;
  bets: number;
  /** Accepted stake priced at the tier's boosted odds. */
  boostedTurnover: bigint;
  boostedBets: number;
  /** Boosted turnover per account (the per-account cap). */
  readonly accounts: Map<string, bigint>;
  /** Accepted boosted legs: Σ stake·m·p at issue, Σ stake·m·p_fresh at acceptance, Σ stake × guard adjustment (the guard's acceptance signal). */
  readonly boostedAccepted: AcceptedAgg;
  /** Settled boosted legs: all of them, and the clean flow (the controller's rule). */
  readonly boosted: PromoAgg;
  readonly boostedClean: PromoAgg;
  /** Settled legs of the tier quoted at standard pricing (capped or flagged accounts, breaker fallback). */
  readonly standardPriced: PromoAgg;
  readonly all: PromoAgg;
}

export interface AcceptedAgg { bets: number; handle: bigint; expQuote: number; expAccept: number; guardWeighted: number }
export interface PromoBetFacts {
  readonly tier: TierId; readonly boosted: boolean; readonly account: string; readonly stakeCenti: bigint;
  /** Multiplier, fair value at issue and at acceptance (p_fresh after a hold; else p), guard adjustment priced in. */
  readonly x100?: number; readonly p?: number; readonly pAccept?: number; readonly guardAdjust?: number;
}
export interface PromoSettleFacts {
  readonly tier: TierId; readonly boosted: boolean; readonly clean: boolean;
  readonly stakeCenti: bigint; readonly creditCenti: bigint; readonly x100: number; readonly p: number; readonly guardAdjust: number;
  readonly status: 'won' | 'lost' | 'refunded';
  /** Shared-outcome cluster of the leg (omitted: the leg is its own cluster). */
  readonly cluster?: OutcomeCluster;
}

export type PromoGuardAction = 'tighten' | 'relax' | 'trip' | 'resume';
/** One guard decision (journaled by the caller, then applied with `applyGuard`, also on rebuild). */
export interface PromoGuardChange {
  readonly tier: PromoTierId;
  readonly action: PromoGuardAction;
  readonly before: { readonly adjust: number; readonly tripped: boolean };
  readonly after: { readonly adjust: number; readonly tripped: boolean };
  readonly reason: string;
  readonly handleCenti?: string;
  readonly housePnlCenti?: string;
  readonly lossRate?: number;
  readonly budget?: number;
  readonly se?: number;
  readonly bets?: number;
  /** Which signal drove the decision, and the acceptance-time estimate (expected loss rate at p_fresh over accepted boosted legs). */
  readonly basis?: 'realized' | 'acceptance' | 'both';
  readonly expectedLossRate?: number;
  readonly acceptedCenti?: string;
}

/**
 * Deterministic per-tier accounting and budget guard. The house server feeds it from applied journal events
 * (bets, settlements, guard decisions), so a rebuild reproduces it exactly.
 */
export class PromoLedger {
  private readonly books = new Map<TierId, TierBook>();
  private readonly guards = new Map<PromoTierId, GuardState>();

  constructor() {
    for (const id of TIER_IDS) this.books.set(id, { turnover: 0n, bets: 0, boostedTurnover: 0n, boostedBets: 0, accounts: new Map(), boostedAccepted: { bets: 0, handle: 0n, expQuote: 0, expAccept: 0, guardWeighted: 0 }, boosted: new PromoAgg(), boostedClean: new PromoAgg(), standardPriced: new PromoAgg(), all: new PromoAgg() });
    for (const id of PROMO_TIER_IDS) this.guards.set(id, GUARD_OK);
  }

  book(tier: TierId): TierBook { return this.books.get(tier)!; }
  guard(tier: TierId): GuardState { return tier === 'standard' ? GUARD_OK : this.guards.get(tier)!; }

  onBet(b: PromoBetFacts): void {
    const book = this.books.get(b.tier);
    if (!book || !(b.stakeCenti > 0n)) return;
    book.turnover += b.stakeCenti; book.bets++;
    if (b.boosted && b.tier !== 'standard') {
      book.boostedTurnover += b.stakeCenti; book.boostedBets++;
      book.accounts.set(b.account, (book.accounts.get(b.account) ?? 0n) + b.stakeCenti);
      if (b.x100 !== undefined && b.p !== undefined && Number.isFinite(b.p)) {
        const s = Number(b.stakeCenti), m = b.x100 / 100, pa = b.pAccept !== undefined && Number.isFinite(b.pAccept) ? b.pAccept : b.p;
        const a = book.boostedAccepted;
        a.bets++; a.handle += b.stakeCenti; a.expQuote += s * m * b.p; a.expAccept += s * m * pa; a.guardWeighted += s * (b.guardAdjust ?? 0);
      }
    }
  }

  onSettle(s: PromoSettleFacts): void {
    const book = this.books.get(s.tier);
    if (!book) return;
    const add = (agg: PromoAgg) => agg.add(s.stakeCenti, s.x100, s.p, s.creditCenti, s.status, s.guardAdjust, s.cluster);
    add(book.all);
    if (s.boosted && s.tier !== 'standard') { add(book.boosted); if (s.clean) add(book.boostedClean); } else add(book.standardPriced);
  }

  /** Boosted turnover the account has placed in the tier. */
  boostUsed(tier: TierId, account: string): bigint { return this.books.get(tier)?.accounts.get(account) ?? 0n; }

  /** Accounts that placed boosted turnover in the tier, and those whose remaining allowance is below `minStake`. */
  accountCounts(tier: TierId, capCenti: bigint | undefined, minStakeCenti: bigint): { boosted: number; capped: number } {
    const book = this.books.get(tier);
    if (!book) return { boosted: 0, capped: 0 };
    let capped = 0;
    if (capCenti !== undefined) for (const used of book.accounts.values()) if (boostRemainingCenti(capCenti, used) < minStakeCenti) capped++;
    return { boosted: book.accounts.size, capped };
  }

  /** Apply a journaled guard decision (live and on rebuild). */
  applyGuard(change: PromoGuardChange, atMs: number): void {
    const prior = this.guards.get(change.tier);
    if (!prior) return;
    const tripped = change.after.tripped;
    this.guards.set(change.tier, Object.freeze({
      adjust: change.after.adjust, tripped, lastChangeMs: atMs,
      ...(tripped ? { since: change.action === 'trip' ? atMs : prior.since ?? atMs, reason: change.action === 'trip' ? change.reason : prior.reason ?? change.reason } : {}),
    }));
  }

  /**
   * Budget check for one tier (live only; the caller journals the result and applies it). Signals:
   * - realized: the settled boosted legs' realized loss rate, acted on only beyond max(deadband, zGate × SE);
   * - acceptance (when `acceptanceSignal`): the expected loss rate at acceptance (p_fresh) over accepted boosted legs,
   *   acted on beyond the deadband (its noise is the choice of squares, not the outcomes).
   * Order:
   * 1. breaker: realized excess loss over the budget beyond the trip margin → `trip` (standard pricing for new quotes);
   * 2. tighten: either signal above budget → raise the guard adjustment toward the higher of (turnover-weighted average
   *    adjustment + gap), at most maxStepPerEval per evaluation, within [0, maxTighten];
   * 3. relax: no signal above budget and the acceptance signal (else the realized one) below it → lower the adjustment
   *    toward the more conservative aim (never below 0: never looser than the tier's nominal pricing).
   * A signal needs `minTurnoverCenti` of its own turnover (settled for realized, accepted for acceptance).
   */
  evaluateGuard(tier: PromoTierConfig, guard: PromoGuardConfig): PromoGuardChange | undefined {
    if (!guard.enabled) return undefined;
    const state = this.guards.get(tier.id)!;
    const book = this.books.get(tier.id)!;
    const settled = book.boosted, acc = book.boostedAccepted;
    const min = BigInt(guard.minTurnoverCenti);
    const before = { adjust: state.adjust, tripped: state.tripped };
    let realized: { gap: number; band: number; aim: number; lossRate: number; se: number } | undefined;
    let facts: Partial<PromoGuardChange> = { budget: tier.lossBudget };
    if (settled.handle > 0n && settled.handle >= min) {
      const h = Number(settled.handle), loss = Number(settled.returned - settled.handle);
      const se = settled.se!, sd = se * h, lossRate = loss / h;
      facts = { ...facts, handleCenti: settled.handle.toString(), housePnlCenti: settled.housePnl.toString(), lossRate, se, bets: settled.bets };
      const excess = loss - tier.lossBudget * h;
      const margin = guard.tripMarginRel * h + guard.tripZ * sd;
      if (!state.tripped && excess > margin) {
        return Object.freeze({ tier: tier.id, action: 'trip', before, after: { adjust: state.adjust, tripped: true }, ...facts, basis: 'realized',
          reason: `realized loss ${pct(lossRate)} of ${fmtCenti(settled.handle)} settled boosted turnover exceeds the ${pct(tier.lossBudget)} budget by ${fmtCenti(BigInt(Math.round(excess)))} (> margin ${fmtCenti(BigInt(Math.round(margin)))} = ${pct(guard.tripMarginRel)} of turnover + ${guard.tripZ} SD)` });
      }
      realized = { gap: lossRate - tier.lossBudget, band: Math.max(guard.deadband, guard.zGate * se), aim: settled.guardWeighted / h + (lossRate - tier.lossBudget), lossRate, se };
    }
    let expected: { gap: number; aim: number; lossRate: number } | undefined;
    if (guard.acceptanceSignal && acc.handle > 0n && acc.handle >= min) {
      const h = Number(acc.handle), lossRate = acc.expAccept / h - 1;
      facts = { ...facts, expectedLossRate: lossRate, acceptedCenti: acc.handle.toString() };
      expected = { gap: lossRate - tier.lossBudget, aim: acc.guardWeighted / h + (lossRate - tier.lossBudget), lossRate };
    }
    const rHigh = !!realized && realized.gap > realized.band, rLow = !!realized && realized.gap < -realized.band;
    const eHigh = !!expected && expected.gap > guard.deadband, eLow = !!expected && expected.gap < -guard.deadband;
    let aim: number, action: 'tighten' | 'relax', basis: 'realized' | 'acceptance' | 'both';
    if (rHigh || eHigh) {
      action = 'tighten';
      aim = Math.max(rHigh ? realized!.aim : -Infinity, eHigh ? expected!.aim : -Infinity);
      basis = rHigh && eHigh ? 'both' : rHigh ? 'realized' : 'acceptance';
    } else if ((expected ? eLow : rLow) && (!realized || realized.gap <= 0)) {
      // Relax only while the realized loss rate is not above the budget even as a point estimate (never beyond budget).
      action = 'relax';
      aim = Math.max(expected ? expected.aim : -Infinity, rLow ? realized!.aim : -Infinity);
      basis = expected && rLow ? 'both' : expected ? 'acceptance' : 'realized';
    } else return undefined;
    const desired = Math.min(guard.maxTighten, Math.max(0, aim));
    let step = desired - state.adjust;
    if (step > guard.maxStepPerEval) step = guard.maxStepPerEval; else if (step < -guard.maxStepPerEval) step = -guard.maxStepPerEval;
    if ((action === 'tighten' && step <= 0) || (action === 'relax' && step >= 0)) return undefined;
    const after = Math.round((state.adjust + step) * 1e6) / 1e6;
    if (after === state.adjust) return undefined;
    const parts = [
      ...(realized ? [`realized loss ${pct(realized.lossRate)} over ${fmtCenti(settled.handle)} settled (SE ${pct(realized.se)})`] : []),
      ...(expected ? [`expected loss at acceptance ${pct(expected.lossRate)} over ${fmtCenti(acc.handle)} accepted`] : []),
    ];
    return Object.freeze({ tier: tier.id, action, before, after: { adjust: after, tripped: state.tripped }, ...facts, basis,
      reason: `${parts.join('; ')} vs budget ${pct(tier.lossBudget)} (${basis}); guard adjustment ${pct(state.adjust)} → ${pct(after)}` });
  }

  /** Canonical state for rebuild comparison (plain data, bigint as decimal strings, accounts sorted). */
  snapshot(): Record<string, unknown> {
    const agg = (a: PromoAgg) => a.state();
    const books: Record<string, unknown> = {};
    for (const [id, b] of this.books) {
      books[id] = {
        turnover: b.turnover.toString(), bets: b.bets, boostedTurnover: b.boostedTurnover.toString(), boostedBets: b.boostedBets,
        accounts: [...b.accounts].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => [k, v.toString()]),
        boostedAccepted: { ...b.boostedAccepted, handle: b.boostedAccepted.handle.toString() },
        boosted: agg(b.boosted), boostedClean: agg(b.boostedClean), standardPriced: agg(b.standardPriced), all: agg(b.all),
      };
    }
    return { books, guards: Object.fromEntries([...this.guards].map(([k, v]) => [k, { ...v }])) };
  }

  /** Admin resume of a tripped tier (the caller journals it). */
  resumeChange(tier: PromoTierId, reason: string): PromoGuardChange | undefined {
    const state = this.guards.get(tier)!;
    if (!state.tripped) return undefined;
    return Object.freeze({ tier, action: 'resume', before: { adjust: state.adjust, tripped: true }, after: { adjust: state.adjust, tripped: false }, reason });
  }
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
function fmtCenti(c: bigint): string { const neg = c < 0n; const a = neg ? -c : c; return `${neg ? '-' : ''}${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(a % 100n).toString().padStart(2, '0')} OPEN`; }
