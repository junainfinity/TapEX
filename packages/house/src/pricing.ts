export type AboveCapPolicy = 'hide' | 'cap';
export interface OfferParams {
  readonly edge: number;
  readonly z: number;
  readonly minX100: number;
  readonly capX100: number;
  readonly aboveCap: AboveCapPolicy;
}
export type OfferRejection = 'below-minimum' | 'hidden-above-cap' | 'out-of-domain';
export type OfferResult =
  | { readonly ok: true; readonly x100: number; readonly q: number; readonly capped: boolean }
  | { readonly ok: false; readonly reason: OfferRejection; readonly q?: number };

/**
 * Float division can land a hair under an integer (92 / 0.92 → 99.999…). fit.mjs adds this before
 * flooring and every golden x100 was produced with it, so the live offer must too.
 */
export const X100_EPSILON = 1e-9;

/** Most generous edge a promo tier may price at (SPEC-12): −0.5, i.e. a nominal expected return of 150 %. */
export const SIGNED_EDGE_MIN = -0.5;

function validOfferParams(params: OfferParams, signed = false): boolean {
  return Number.isFinite(params.edge) && params.edge >= (signed ? SIGNED_EDGE_MIN : 0) && params.edge < 1 && Number.isFinite(params.z) && params.z >= 0
    && Number.isSafeInteger(params.minX100) && params.minX100 >= 100 && Number.isSafeInteger(params.capX100) && params.capX100 >= params.minX100
    && (params.aboveCap === 'hide' || params.aboveCap === 'cap');
}

/** §3.2: q = min(1, p + z·se + impact); x100 = floor(100·(1 − edge) / q), then minimum and cap rules. */
export function offerX100(p: number, se: number, params: OfferParams, impact = 0): OfferResult {
  return offerCore(p, se, params, impact, false);
}

/**
 * SPEC-12 promo pricing: the §3.2 offer with a signed edge (a promo tier prices at −lossBudget, so the
 * player's expected return 1 − edge exceeds 1). Same flooring, minimum and cap rules; the edge may be as
 * low as SIGNED_EDGE_MIN. `offerX100` keeps refusing negative edges.
 */
export function offerX100Signed(p: number, se: number, params: OfferParams, impact = 0): OfferResult {
  return offerCore(p, se, params, impact, true);
}

function offerCore(p: number, se: number, params: OfferParams, impact: number, signed: boolean): OfferResult {
  if (!validOfferParams(params, signed) || !(p >= 0 && p <= 1) || !(se >= 0) || !Number.isFinite(se) || !(impact >= 0)) return { ok: false, reason: 'out-of-domain' };
  const q = Math.min(1, p + params.z * se + impact);
  if (!(q > 0)) return { ok: false, reason: 'out-of-domain', q };
  const m = Math.floor((100 * (1 - params.edge)) / q + X100_EPSILON);
  if (m < params.minX100) return { ok: false, reason: 'below-minimum', q };
  if (m > params.capX100) return params.aboveCap === 'cap' ? { ok: true, x100: params.capX100, q, capped: true } : { ok: false, reason: 'hidden-above-cap', q };
  return { ok: true, x100: m, q, capped: false };
}

/** fit.mjs `multiplierX100` contract: the offered x100, or −1 when the cell is not offered. */
export function multiplierX100(p: number, se: number, params: OfferParams): number {
  const offer = offerX100(p, se, params);
  return offer.ok ? offer.x100 : -1;
}

/**
 * Price impact: impactK × cellLiability / (cellFraction × equity). Crowded cells pay less on the next
 * quote; issued quotes stay firm. Non-positive equity makes every cell unpriceable (q → 1).
 */
export function priceImpact(impactK: number, cellLiabilityCenti: bigint, cellFraction: number, equityCenti: bigint): number {
  if (!(impactK >= 0) || !Number.isFinite(impactK) || !(cellFraction > 0)) return Number.NaN;
  if (cellLiabilityCenti <= 0n || impactK === 0) return 0;
  if (equityCenti <= 0n) return Number.POSITIVE_INFINITY;
  return (impactK * Number(cellLiabilityCenti)) / (cellFraction * Number(equityCenti));
}

export interface LaunchBoost {
  readonly enabled: boolean;
  readonly edge: number;
  readonly untilPlayers: number;
}
export interface EdgeScheduleConfig {
  readonly standard: number;
  readonly launch: LaunchBoost;
  /** Surcharge for accounts flagged by the toxicity monitor. */
  readonly flowEdge: number;
  /** Added while the drawdown breaker is in its widened state. */
  readonly drawdownWiden: number;
}
export const DEFAULT_EDGE_SCHEDULE: EdgeScheduleConfig = Object.freeze({
  standard: 0.08,
  launch: Object.freeze({ enabled: true, edge: 0.03, untilPlayers: 10_000 }),
  flowEdge: 0,
  drawdownWiden: 0.02,
});
/** Admin-validated range for the standard and launch edges (§7). */
export const EDGE_RANGE = Object.freeze({ min: 0.01, max: 0.25 });
export const FLOW_EDGE_MAX = 0.25;
export const DRAWDOWN_WIDEN_MAX = 0.1;

export type EdgePhase = 'launch' | 'standard';
export interface EdgeContext {
  readonly registeredPlayers: number;
  readonly flagged?: boolean;
  readonly drawdownWidened?: boolean;
}
export interface ResolvedEdge {
  readonly edge: number;
  readonly phase: EdgePhase;
  readonly base: number;
  readonly flow: number;
  readonly widen: number;
  /** SPEC-12 promo tier the grid was priced in (absent in legacy launch-boost mode). */
  readonly tier?: import('./promo.js').TierId;
  /** SPEC-12: priced at the tier's boosted odds (phase 'launch' then means "promo-priced"). */
  readonly boosted?: boolean;
}

export type EdgeScheduleError = 'invalid-standard-edge' | 'invalid-launch-edge' | 'invalid-threshold' | 'invalid-flow-edge' | 'invalid-drawdown-widen' | 'invalid-enabled';
function inEdgeRange(value: unknown): boolean { return typeof value === 'number' && Number.isFinite(value) && value >= EDGE_RANGE.min && value <= EDGE_RANGE.max; }
export function validateEdgeSchedule(config: EdgeScheduleConfig): EdgeScheduleError | undefined {
  if (!inEdgeRange(config.standard)) return 'invalid-standard-edge';
  if (typeof config.launch?.enabled !== 'boolean') return 'invalid-enabled';
  if (!inEdgeRange(config.launch.edge)) return 'invalid-launch-edge';
  if (!Number.isSafeInteger(config.launch.untilPlayers) || config.launch.untilPlayers < 0) return 'invalid-threshold';
  if (typeof config.flowEdge !== 'number' || !(config.flowEdge >= 0 && config.flowEdge <= FLOW_EDGE_MAX)) return 'invalid-flow-edge';
  if (typeof config.drawdownWiden !== 'number' || !(config.drawdownWiden >= 0 && config.drawdownWiden <= DRAWDOWN_WIDEN_MAX)) return 'invalid-drawdown-widen';
  return undefined;
}

/** Launch boost applies while enabled and strictly fewer than `untilPlayers` players are registered. */
export function isLaunchActive(config: EdgeScheduleConfig, registeredPlayers: number): boolean {
  return config.launch.enabled && Number.isSafeInteger(registeredPlayers) && registeredPlayers >= 0 && registeredPlayers < config.launch.untilPlayers;
}

/** An invalid player count fails closed to the standard (higher) edge. */
export function resolveEdge(config: EdgeScheduleConfig, context: EdgeContext): ResolvedEdge {
  const phase: EdgePhase = isLaunchActive(config, context.registeredPlayers) ? 'launch' : 'standard';
  const base = phase === 'launch' ? config.launch.edge : config.standard;
  const flow = context.flagged ? config.flowEdge : 0;
  const widen = context.drawdownWidened ? config.drawdownWiden : 0;
  return Object.freeze({ edge: base + flow + widen, phase, base, flow, widen });
}

export interface EdgeScheduleChange {
  readonly standard?: number;
  readonly launch?: Partial<LaunchBoost>;
  readonly flowEdge?: number;
  readonly drawdownWiden?: number;
}
export interface ChangeMeta { readonly actor: string; readonly atMs: number; readonly reason: string }
export interface EdgeScheduleEvent {
  readonly type: 'edge-schedule-changed';
  readonly actor: string;
  readonly atMs: number;
  readonly reason: string;
  readonly before: EdgeScheduleConfig;
  readonly after: EdgeScheduleConfig;
}
export type EdgeChangeResult =
  | { readonly ok: true; readonly config: EdgeScheduleConfig; readonly event: EdgeScheduleEvent }
  | { readonly ok: false; readonly reason: EdgeScheduleError | 'invalid-meta' | 'no-change' };

export function validMeta(meta: ChangeMeta): boolean {
  return typeof meta?.actor === 'string' && meta.actor.trim().length > 0 && typeof meta.reason === 'string' && meta.reason.trim().length > 0 && Number.isSafeInteger(meta.atMs) && meta.atMs >= 0;
}
function freezeSchedule(config: EdgeScheduleConfig): EdgeScheduleConfig {
  return Object.freeze({ standard: config.standard, launch: Object.freeze({ enabled: config.launch.enabled, edge: config.launch.edge, untilPlayers: config.launch.untilPlayers }), flowEdge: config.flowEdge, drawdownWiden: config.drawdownWiden });
}
function sameSchedule(a: EdgeScheduleConfig, b: EdgeScheduleConfig): boolean {
  return a.standard === b.standard && a.flowEdge === b.flowEdge && a.drawdownWiden === b.drawdownWiden && a.launch.enabled === b.launch.enabled && a.launch.edge === b.launch.edge && a.launch.untilPlayers === b.launch.untilPlayers;
}

/** Pure admin change: returns the new frozen config and the journal event (actor, time, before/after). */
export function changeEdgeSchedule(config: EdgeScheduleConfig, change: EdgeScheduleChange, meta: ChangeMeta): EdgeChangeResult {
  if (!validMeta(meta)) return { ok: false, reason: 'invalid-meta' };
  const after = freezeSchedule({
    standard: change.standard ?? config.standard,
    launch: { ...config.launch, ...stripUndefined(change.launch ?? {}) },
    flowEdge: change.flowEdge ?? config.flowEdge,
    drawdownWiden: change.drawdownWiden ?? config.drawdownWiden,
  });
  const error = validateEdgeSchedule(after);
  if (error) return { ok: false, reason: error };
  if (sameSchedule(config, after)) return { ok: false, reason: 'no-change' };
  const before = freezeSchedule(config);
  return { ok: true, config: after, event: Object.freeze({ type: 'edge-schedule-changed', actor: meta.actor, atMs: meta.atMs, reason: meta.reason, before, after }) };
}
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Stateful holder for the live schedule; every accepted change yields one journal event. */
export class EdgeSchedule {
  private current: EdgeScheduleConfig;
  constructor(config: EdgeScheduleConfig = DEFAULT_EDGE_SCHEDULE) {
    const error = validateEdgeSchedule(config);
    if (error) throw new RangeError(`Invalid edge schedule: ${error}`);
    this.current = freezeSchedule(config);
  }
  get config(): EdgeScheduleConfig { return this.current; }
  isLaunchActive(registeredPlayers: number): boolean { return isLaunchActive(this.current, registeredPlayers); }
  resolve(context: EdgeContext): ResolvedEdge { return resolveEdge(this.current, context); }
  change(change: EdgeScheduleChange, meta: ChangeMeta): EdgeChangeResult {
    const result = changeEdgeSchedule(this.current, change, meta);
    if (result.ok) this.current = result.config;
    return result;
  }
  endLaunch(meta: ChangeMeta): EdgeChangeResult { return this.change({ launch: { enabled: false } }, meta); }
  extendLaunch(untilPlayers: number, meta: ChangeMeta): EdgeChangeResult { return this.change({ launch: { enabled: true, untilPlayers } }, meta); }
}
