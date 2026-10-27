import { validMeta, type ChangeMeta } from './pricing.js';
import { mulFloor, parseCenti, type Centi } from './units.js';

/**
 * Latency-arbitrage and model-drift defenses (SPEC-10). Pure configuration, validation and the
 * decision functions the house server applies; every state change they propose is returned to the
 * caller for journaling.
 */

/** §7 multiplier ranges (x100, lower inclusive, upper exclusive); 50× itself belongs to 20-50. */
export interface MultiplierRange { readonly key: string; readonly lo: number; readonly hi: number }
export const MULTIPLIER_RANGES: readonly MultiplierRange[] = Object.freeze([
  Object.freeze({ key: '1.01-2', lo: 101, hi: 200 }), Object.freeze({ key: '2-5', lo: 200, hi: 500 }), Object.freeze({ key: '5-10', lo: 500, hi: 1000 }),
  Object.freeze({ key: '10-20', lo: 1000, hi: 2000 }), Object.freeze({ key: '20-50', lo: 2000, hi: 5001 }), Object.freeze({ key: '50-100', lo: 5001, hi: Number.POSITIVE_INFINITY }),
]);
export const RANGE_KEYS: readonly string[] = Object.freeze(MULTIPLIER_RANGES.map(r => r.key));
export function rangeKeyOf(x100: number): string { return (MULTIPLIER_RANGES.find(r => x100 >= r.lo && x100 < r.hi) ?? MULTIPLIER_RANGES[0]!).key; }

export interface HoldConfig {
  readonly enabled: boolean;
  /** Longest a placement waits for the next first-seen sample after the request (ms). */
  readonly maxHoldMs: number;
  /**
   * Scale of the symmetric fair-value tolerance. 'relative': reject when |p_fresh − p_quote| >
   * max(tolAbs, tolRel × p_quote). 'logit': reject when |logit(p_fresh) − logit(p_quote)| > tolRel
   * (the same width for the player's and the house's probability, so the check binds as often
   * upward as downward even near p = 0 or 1).
   */
  readonly tolScale: 'relative' | 'logit';
  readonly tolRel: number;
  readonly tolAbs: number;
  /** No fresh sample within maxHoldMs: reject (fail closed) or accept at the original quote. */
  readonly onTimeout: 'reject' | 'accept';
  /** Relative tolerance for accounts the toxicity monitor has flagged (still symmetric; tighter). */
  readonly flaggedTolRel: number;
  /**
   * Trust ramp: an account uses `newAccountTolRel` until it has `newAccountHolds` held placements
   * and its latency evidence is at most `newAccountMaxZ` (0 holds disables the ramp).
   */
  readonly newAccountHolds: number;
  readonly newAccountTolRel: number;
  readonly newAccountMaxZ: number;
}
export interface QuoteValidityConfig {
  readonly enabled: boolean;
  /** A quote stays acceptable this long after a newer first-seen sample was observed. */
  readonly graceMs: number;
  /** Upper bound on a quote's life when no newer sample arrives (replaces the fixed 1.8 s TTL). */
  readonly maxTtlMs: number;
}
export interface RampConfig {
  readonly enabled: boolean;
  /** Liability limit of an account with no settled history. */
  readonly startCenti: Centi;
  /** Added per settled (won or lost) bet. */
  readonly perSettledBetCenti: Centi;
  /** Added per Centi of settled handle. */
  readonly handleFraction: number;
}
export interface ToxicityDefenseConfig {
  /** Graduated response; when false the Stage A monitor (flag only) applies. */
  readonly enabled: boolean;
  /** Never act on fewer settled bets or wins than this. */
  readonly minBets: number;
  readonly minWins: number;
  /** Excess-return z above which an account is flagged and priced with the surcharge. */
  readonly surchargeZ: number;
  readonly surchargeEdge: number;
  /** A flagged account above this z with at least blockMinBets settled bets is blocked. */
  readonly blockZ: number;
  readonly blockMinBets: number;
  /** A monitor-flagged account whose z falls below this is unflagged. */
  readonly unflagZ: number;
  /**
   * Latency evidence from the acceptance hold: the account's mean signed fair-value move between
   * request and the fresh sample (p_fresh / p_quote − 1, clamped, minus the population mean) in
   * population standard errors. Every held placement counts, rejected or not, so it builds far
   * faster than settled outcomes. Flag above holdZ after holdMinN holds; block above holdBlockZ
   * after holdBlockMinN.
   */
  readonly holdMinN: number;
  readonly holdZ: number;
  readonly holdBlockMinN: number;
  readonly holdBlockZ: number;
}
export interface ControllerConfig {
  readonly enabled: boolean;
  /** Rolling window of settled non-flagged flow per multiplier range. */
  readonly windowMs: number;
  readonly evalEveryMs: number;
  /** Minimum settled bets in the window before a range may move. */
  readonly minBets: number;
  /** Hysteresis: move only when |realized − target| > max(deadband, zGate × SE). */
  readonly zGate: number;
  readonly deadband: number;
  readonly maxStepPerEval: number;
  readonly maxStepPerHour: number;
  readonly minAdjust: number;
  readonly maxAdjust: number;
  /** Flow counts as clean only from accounts never flagged whose latency-evidence z is at most this. */
  readonly cleanHoldZ: number;
  /** Admin-pinned adjustments per range key (the controller never moves a pinned range). */
  readonly overrides: Readonly<Record<string, number>>;
}
export interface ReferenceGuardConfig {
  /** Invalidate a market's quotes early when the sub-second reference moves beyond moveSigma·σ·√Δt. */
  readonly enabled: boolean;
  readonly moveSigma: number;
}
export interface DefenseConfig {
  readonly hold: HoldConfig;
  readonly quoteValidity: QuoteValidityConfig;
  /** Minimum lead (s) between the quote instant and a square's start; the grid geometry is unchanged. */
  readonly minLeadS: number;
  readonly ramp: RampConfig;
  readonly toxicity: ToxicityDefenseConfig;
  readonly controller: ControllerConfig;
  readonly reference: ReferenceGuardConfig;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Production defaults (all defenses on); tuned by the SPEC-10 ablation. */
export const DEFAULT_DEFENSES: DefenseConfig = freezeDefenses({
  hold: { enabled: true, maxHoldMs: 1500, tolScale: 'logit', tolRel: 1.3, tolAbs: 0.002, onTimeout: 'reject', flaggedTolRel: 0.05, newAccountHolds: 10, newAccountTolRel: 0.12, newAccountMaxZ: 2 },
  quoteValidity: { enabled: true, graceMs: 500, maxTtlMs: 2500 },
  minLeadS: 4,
  ramp: { enabled: true, startCenti: '25000', perSettledBetCenti: '2500', handleFraction: 0.25 },
  toxicity: { enabled: true, minBets: 20, minWins: 5, surchargeZ: 3, surchargeEdge: 0.05, blockZ: 6, blockMinBets: 60, unflagZ: 1, holdMinN: 10, holdZ: 4, holdBlockMinN: 25, holdBlockZ: 6 },
  controller: { enabled: true, windowMs: 3 * HOUR_MS, evalEveryMs: 15 * MINUTE_MS, minBets: 1000, zGate: 2, deadband: 0.005, maxStepPerEval: 0.01, maxStepPerHour: 0.03, minAdjust: -0.02, maxAdjust: 0.05, cleanHoldZ: 2, overrides: {} },
  reference: { enabled: true, moveSigma: 4 },
});

/** Stage A behaviour: every defense off, 1.8 s TTL, 3 s lead. */
export const DEFENSES_OFF: DefenseConfig = freezeDefenses({
  ...DEFAULT_DEFENSES,
  hold: { ...DEFAULT_DEFENSES.hold, enabled: false },
  quoteValidity: { ...DEFAULT_DEFENSES.quoteValidity, enabled: false },
  minLeadS: 3,
  ramp: { ...DEFAULT_DEFENSES.ramp, enabled: false },
  toxicity: { ...DEFAULT_DEFENSES.toxicity, enabled: false },
  controller: { ...DEFAULT_DEFENSES.controller, enabled: false },
  reference: { ...DEFAULT_DEFENSES.reference, enabled: false },
});

export const DEFENSE_NAMES = Object.freeze(['hold', 'quoteValidity', 'ramp', 'toxicity', 'controller', 'reference'] as const);
export type DefenseName = (typeof DEFENSE_NAMES)[number];

export function freezeDefenses(c: DefenseConfig): DefenseConfig {
  return Object.freeze({
    hold: Object.freeze({ ...c.hold }), quoteValidity: Object.freeze({ ...c.quoteValidity }), minLeadS: c.minLeadS, ramp: Object.freeze({ ...c.ramp }),
    toxicity: Object.freeze({ ...c.toxicity }), controller: Object.freeze({ ...c.controller, overrides: Object.freeze({ ...c.controller.overrides }) }), reference: Object.freeze({ ...c.reference }),
  });
}

const num = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const int = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi;
const bool = (v: unknown): boolean => typeof v === 'boolean';
const centi = (v: unknown, positive: boolean): boolean => typeof v === 'string' && /^(0|[1-9]\d{0,17})$/.test(v) && (!positive || v !== '0');

/** Admin-validated ranges; returns a message naming the first invalid field. */
export function validateDefenses(c: DefenseConfig): string | undefined {
  const h = c.hold, v = c.quoteValidity, r = c.ramp, t = c.toxicity, k = c.controller, ref = c.reference;
  if (!h || !bool(h.enabled) || !int(h.maxHoldMs, 250, 5000) || (h.tolScale !== 'relative' && h.tolScale !== 'logit') || !num(h.tolRel, 0, 5) || !num(h.tolAbs, 0, 0.2) || (h.onTimeout !== 'reject' && h.onTimeout !== 'accept')
    || !num(h.flaggedTolRel, 0, 5) || !int(h.newAccountHolds, 0, 10_000) || !num(h.newAccountTolRel, 0, 5) || !num(h.newAccountMaxZ, -10, 100)) return 'hold: enabled boolean, maxHoldMs 250–5000 (integer), tolScale relative|logit, tolRel 0–5, tolAbs 0–0.2, onTimeout reject|accept, flaggedTolRel 0–5, newAccountHolds 0–10000 (integer), newAccountTolRel 0–5, newAccountMaxZ −10–100';
  if (!v || !bool(v.enabled) || !int(v.graceMs, 0, 2000) || !int(v.maxTtlMs, 500, 10_000)) return 'quoteValidity: enabled boolean, graceMs 0–2000, maxTtlMs 500–10000 (integers)';
  if (!int(c.minLeadS, 3, 10)) return 'minLeadS must be an integer within 3–10';
  if (!r || !bool(r.enabled) || !centi(r.startCenti, true) || !centi(r.perSettledBetCenti, false) || !num(r.handleFraction, 0, 10)) return 'ramp: enabled boolean, startCenti positive Centi, perSettledBetCenti Centi, handleFraction 0–10';
  if (!t || !bool(t.enabled) || !int(t.minBets, 5, 100_000) || !int(t.minWins, 0, 10_000) || !num(t.surchargeZ, 1, 20) || !num(t.surchargeEdge, 0, 0.25)
    || !num(t.blockZ, t.surchargeZ, 50) || !int(t.blockMinBets, t.minBets, 1_000_000) || !num(t.unflagZ, -10, t.surchargeZ - 0.5)
    || !int(t.holdMinN, 5, 100_000) || !num(t.holdZ, 1, 50) || !int(t.holdBlockMinN, t.holdMinN, 1_000_000) || !num(t.holdBlockZ, t.holdZ, 100)) return 'toxicity: minBets ≥ 5, minWins ≥ 0, surchargeZ 1–20, surchargeEdge 0–0.25, blockZ ≥ surchargeZ, blockMinBets ≥ minBets, unflagZ ≤ surchargeZ − 0.5, holdMinN ≥ 5, holdZ 1–50, holdBlockMinN ≥ holdMinN, holdBlockZ ≥ holdZ';
  if (!k || !bool(k.enabled) || !int(k.windowMs, 10 * MINUTE_MS, 7 * 24 * HOUR_MS) || !int(k.evalEveryMs, MINUTE_MS, 24 * HOUR_MS) || !int(k.minBets, 1, 10_000_000)
    || !num(k.zGate, 0, 10) || !num(k.deadband, 0, 0.2) || !num(k.maxStepPerEval, 0, 0.05) || !num(k.maxStepPerHour, k.maxStepPerEval, 0.2)
    || !num(k.minAdjust, -0.1, 0) || !num(k.maxAdjust, 0, 0.2) || !num(k.cleanHoldZ, 0, 100)) return 'controller: windowMs 10 min–7 d, evalEveryMs 1 min–1 d, minBets ≥ 1, zGate 0–10, deadband 0–0.2, maxStepPerEval 0–0.05, maxStepPerHour ≥ maxStepPerEval (≤ 0.2), minAdjust −0.1–0, maxAdjust 0–0.2, cleanHoldZ 0–100';
  if (!k.overrides || typeof k.overrides !== 'object' || Array.isArray(k.overrides)) return 'controller.overrides must be an object of range → adjustment';
  for (const [key, value] of Object.entries(k.overrides)) {
    if (!RANGE_KEYS.includes(key)) return `controller.overrides: unknown range ${key} (use ${RANGE_KEYS.join(', ')})`;
    if (!num(value, -0.1, 0.2)) return `controller.overrides.${key} must be within −0.1–0.2`;
  }
  if (!ref || !bool(ref.enabled) || !num(ref.moveSigma, 0.5, 50)) return 'reference: enabled boolean, moveSigma 0.5–50';
  return undefined;
}

/** Partial update: nested objects merge one level deep; an override set to null is removed. */
export interface DefensePatch {
  readonly hold?: Partial<HoldConfig>;
  readonly quoteValidity?: Partial<QuoteValidityConfig>;
  readonly minLeadS?: number;
  readonly ramp?: Partial<RampConfig>;
  readonly toxicity?: Partial<ToxicityDefenseConfig>;
  readonly controller?: Partial<Omit<ControllerConfig, 'overrides'>> & { readonly overrides?: Readonly<Record<string, number | null>> };
  readonly reference?: Partial<ReferenceGuardConfig>;
}
const PATCH_KEYS: Readonly<Record<keyof DefensePatch, readonly string[] | null>> = Object.freeze({
  hold: ['enabled', 'maxHoldMs', 'tolScale', 'tolRel', 'tolAbs', 'onTimeout', 'flaggedTolRel', 'newAccountHolds', 'newAccountTolRel', 'newAccountMaxZ'], quoteValidity: ['enabled', 'graceMs', 'maxTtlMs'], minLeadS: null,
  ramp: ['enabled', 'startCenti', 'perSettledBetCenti', 'handleFraction'], toxicity: ['enabled', 'minBets', 'minWins', 'surchargeZ', 'surchargeEdge', 'blockZ', 'blockMinBets', 'unflagZ', 'holdMinN', 'holdZ', 'holdBlockMinN', 'holdBlockZ'],
  controller: ['enabled', 'windowMs', 'evalEveryMs', 'minBets', 'zGate', 'deadband', 'maxStepPerEval', 'maxStepPerHour', 'minAdjust', 'maxAdjust', 'cleanHoldZ', 'overrides'], reference: ['enabled', 'moveSigma'],
});

export interface DefenseChangeEvent { readonly type: 'defenses-changed'; readonly actor: string; readonly atMs: number; readonly reason: string; readonly before: DefenseConfig; readonly after: DefenseConfig; readonly disabled: readonly DefenseName[] }
export type DefenseChangeResult =
  | { readonly ok: true; readonly config: DefenseConfig; readonly event: DefenseChangeEvent }
  | { readonly ok: false; readonly reason: 'invalid-meta' | 'no-change' | 'invalid-patch' | 'invalid-config'; readonly detail: string };

/** Pure admin change with strict keys; reports which defenses the change switches off. */
export function changeDefenses(config: DefenseConfig, patch: DefensePatch, meta: ChangeMeta): DefenseChangeResult {
  if (!validMeta(meta)) return { ok: false, reason: 'invalid-meta', detail: 'actor, reason and time are required' };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, reason: 'invalid-patch', detail: 'patch must be an object' };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in PATCH_KEYS)) return { ok: false, reason: 'invalid-patch', detail: `unknown section ${key}` };
    const allowed = PATCH_KEYS[key as keyof DefensePatch];
    if (allowed === null) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'invalid-patch', detail: `${key} must be an object` };
    for (const field of Object.keys(value)) if (!allowed.includes(field)) return { ok: false, reason: 'invalid-patch', detail: `unknown field ${key}.${field}` };
  }
  const overrides: Record<string, number> = { ...config.controller.overrides };
  for (const [key, value] of Object.entries(patch.controller?.overrides ?? {})) {
    if (value === null) delete overrides[key]; else overrides[key] = value;
  }
  const strip = <T extends object>(o: T | undefined): Partial<T> => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
  const { overrides: _o, ...controllerPatch } = patch.controller ?? {};
  const after = freezeDefenses({
    hold: { ...config.hold, ...strip(patch.hold) }, quoteValidity: { ...config.quoteValidity, ...strip(patch.quoteValidity) },
    minLeadS: patch.minLeadS ?? config.minLeadS, ramp: { ...config.ramp, ...strip(patch.ramp) }, toxicity: { ...config.toxicity, ...strip(patch.toxicity) },
    controller: { ...config.controller, ...strip(controllerPatch), overrides }, reference: { ...config.reference, ...strip(patch.reference) },
  });
  const error = validateDefenses(after);
  if (error) return { ok: false, reason: 'invalid-config', detail: error };
  if (JSON.stringify(after) === JSON.stringify(freezeDefenses(config))) return { ok: false, reason: 'no-change', detail: 'defenses already have these values' };
  const disabled = DEFENSE_NAMES.filter(name => config[name].enabled && !after[name].enabled);
  return { ok: true, config: after, event: Object.freeze({ type: 'defenses-changed', actor: meta.actor, atMs: meta.atMs, reason: meta.reason, before: freezeDefenses(config), after, disabled: Object.freeze(disabled) }) };
}

// ------------------------------------------------------------------ acceptance hold

export function fairValueTolerance(pQuote: number, hold: Pick<HoldConfig, 'tolRel' | 'tolAbs'> & { readonly tolScale?: HoldConfig['tolScale'] }): number {
  return hold.tolScale === 'logit' ? hold.tolRel : Math.max(hold.tolAbs, hold.tolRel * pQuote);
}
const LOGIT_EPS = 1e-6;
export function logit(p: number): number { const q = Math.min(1 - LOGIT_EPS, Math.max(LOGIT_EPS, p)); return Math.log(q / (1 - q)); }
/**
 * Tolerance width that applies to one account: flagged on latency evidence, then the trust ramp
 * (until `newAccountHolds` holds with latency evidence ≤ `newAccountMaxZ`), then the default.
 * Never looser than `tolRel`.
 */
export function holdTolRelFor(hold: HoldConfig, account: { readonly flagged: boolean; readonly holds: number; readonly latencyZ?: number }): number {
  if (account.flagged) return Math.min(hold.tolRel, hold.flaggedTolRel);
  if (hold.newAccountHolds > 0 && (account.holds < hold.newAccountHolds || (account.latencyZ ?? 0) > hold.newAccountMaxZ)) return Math.min(hold.tolRel, hold.newAccountTolRel);
  return hold.tolRel;
}
export type HoldVerdict =
  | { readonly ok: true; readonly delta: number; readonly tolerance: number }
  | { readonly ok: false; readonly reason: 'fair-value-moved' | 'fair-value-unavailable'; readonly delta?: number; readonly tolerance: number };

/**
 * Symmetric re-validation of a held placement: a move of the fair probability in either direction
 * beyond the tolerance rejects. `delta` and `tolerance` are in probability units ('relative') or
 * log-odds units ('logit').
 */
export function holdVerdict(pQuote: number, pFresh: number | undefined, hold: Pick<HoldConfig, 'tolRel' | 'tolAbs'> & { readonly tolScale?: HoldConfig['tolScale'] }): HoldVerdict {
  const tolerance = fairValueTolerance(pQuote, hold);
  if (pFresh === undefined || !Number.isFinite(pFresh) || !Number.isFinite(pQuote)) return { ok: false, reason: 'fair-value-unavailable', tolerance };
  const delta = hold.tolScale === 'logit' ? logit(pFresh) - logit(pQuote) : pFresh - pQuote;
  // A hair of float slack so an exactly-at-tolerance move is accepted deterministically.
  return Math.abs(delta) <= tolerance + 1e-12 ? { ok: true, delta, tolerance } : { ok: false, reason: 'fair-value-moved', delta, tolerance };
}

// ------------------------------------------------------------------ new-account ramp

export interface SettledHistory { readonly settledBets: number; readonly settledHandleCenti: bigint }
/** Per-account liability limit: grows from `startCenti` with settled history, never above the account limit. */
export function rampLimitCenti(accountLimitCenti: bigint, history: SettledHistory, ramp: RampConfig): bigint {
  if (!ramp.enabled) return accountLimitCenti;
  const bets = Number.isSafeInteger(history.settledBets) && history.settledBets > 0 ? BigInt(history.settledBets) : 0n;
  const handle = history.settledHandleCenti > 0n ? history.settledHandleCenti : 0n;
  const grown = parseCenti(ramp.startCenti) + parseCenti(ramp.perSettledBetCenti) * bets + mulFloor(handle, ramp.handleFraction);
  return grown < accountLimitCenti ? grown : accountLimitCenti;
}

// ------------------------------------------------------------------ graduated toxicity

export interface FlowStats {
  readonly settledBets: number;
  readonly wins: number;
  /** Excess-return z over settled bets. */
  readonly z: number;
  /** Held placements with a fresh fair value, and their latency-evidence z. */
  readonly holdN: number;
  readonly holdZ: number;
  readonly flagged: boolean;
  readonly blocked: boolean;
  readonly flaggedByMonitor: boolean;
}
export type ToxicityAction = 'none' | 'flag' | 'block' | 'unflag';
export type ToxicityEvidence = 'outcomes' | 'latency';
/**
 * Surcharge first, then block; never on too little data (settled bets and wins for outcome
 * evidence, held placements for latency evidence); the monitor only lifts its own flags, and only
 * when both kinds of evidence have faded.
 */
export function toxicityAction(stats: FlowStats, config: ToxicityDefenseConfig): ToxicityAction {
  return toxicityDecision(stats, config).action;
}
export function toxicityDecision(stats: FlowStats, config: ToxicityDefenseConfig): { readonly action: ToxicityAction; readonly evidence?: ToxicityEvidence } {
  if (!config.enabled || stats.blocked) return { action: 'none' };
  const z = Number.isFinite(stats.z) ? stats.z : 0, hz = Number.isFinite(stats.holdZ) ? stats.holdZ : 0;
  const outcomes = stats.settledBets >= config.minBets && stats.wins >= config.minWins;
  const latency = stats.holdN >= config.holdMinN;
  if (stats.flagged) {
    if (outcomes && stats.settledBets >= config.blockMinBets && z > config.blockZ) return { action: 'block', evidence: 'outcomes' };
    if (stats.holdN >= config.holdBlockMinN && hz > config.holdBlockZ) return { action: 'block', evidence: 'latency' };
    if (stats.flaggedByMonitor && z < config.unflagZ && (!latency || hz < config.unflagZ)) return { action: 'unflag' };
    return { action: 'none' };
  }
  if (outcomes && z > config.surchargeZ) return { action: 'flag', evidence: 'outcomes' };
  if (latency && hz > config.holdZ) return { action: 'flag', evidence: 'latency' };
  return { action: 'none' };
}

/**
 * Population baseline of the hold's relative fair-value move (EWMA mean and variance over every
 * account), so the latency evidence of one account is measured against how prices move for
 * everybody. Deterministic: fed in journal order.
 */
export class HoldMoveBaseline {
  mean = 0;
  variance = 0.04;
  n = 0;
  constructor(private readonly alpha = 1 / 2000) {}
  /** Clamp a raw move so one extreme square cannot dominate the evidence. */
  static clamp(move: number): number { return Math.min(1, Math.max(-0.5, move)); }
  observe(x: number): void {
    if (!Number.isFinite(x)) return;
    this.n++;
    const a = this.n < 1 / this.alpha ? 1 / this.n : this.alpha;
    const d = x - this.mean;
    this.mean += a * d;
    this.variance += a * (d * d - this.variance);
  }
  get sd(): number { return Math.sqrt(Math.max(this.variance, 1e-4)); }
}

// ------------------------------------------------------------------ adaptive edge controller

/** One settled (won/lost) non-flagged leg as the controller sees it. */
export interface ControllerLeg {
  readonly atMs: number;
  readonly x100: number;
  readonly stakeCenti: bigint;
  readonly creditCenti: bigint;
  /** Calibrated fair probability at issue. */
  readonly p: number;
  /** RTP the pricing policy promises for this leg: 1 − (phase edge + drawdown widening). */
  readonly policyRtp: number;
  /** Controller adjustment the leg was priced with. */
  readonly adjust: number;
}
export interface ControllerRangeState {
  readonly key: string;
  readonly adjust: number;
  readonly override?: number;
  readonly effective: number;
  readonly bets: number;
  readonly handleCenti: string;
  readonly realized: number | null;
  readonly target: number | null;
  readonly se: number | null;
  readonly avgAdjust: number | null;
  readonly lastChangeMs?: number;
}
export interface ControllerChange {
  readonly key: string;
  readonly before: number;
  readonly after: number;
  readonly realized: number;
  readonly target: number;
  readonly se: number;
  readonly bets: number;
  readonly avgAdjust: number;
}

interface Bucket { start: number; bets: number; handle: bigint; returned: bigint; policyReturn: number; variance: number; adjustWeighted: number }
interface RangeSlot { adjust: number; lastChangeMs?: number; buckets: Bucket[]; changes: { atMs: number; delta: number }[] }
const BUCKET_MS = 5 * MINUTE_MS;

/**
 * Self-correcting edge per multiplier range. It compares the realized RTP of settled non-flagged
 * flow over a rolling window with the RTP the pricing policy promises, and nudges the range's edge
 * adjustment toward (window-average adjustment + gap) with hysteresis, a per-evaluation and a
 * per-hour step bound, and hard bounds. Deterministic: window sums come from settlements, and every
 * adjustment it makes is returned for the journal (and replayed with `restore`).
 */
export class EdgeController {
  private readonly slots = new Map<string, RangeSlot>();
  constructor() { for (const key of RANGE_KEYS) this.slots.set(key, { adjust: 0, buckets: [], changes: [] }); }

  observe(leg: ControllerLeg): void {
    if (!(leg.stakeCenti > 0n) || !Number.isFinite(leg.p) || !Number.isFinite(leg.policyRtp) || !Number.isFinite(leg.adjust)) return;
    const slot = this.slots.get(rangeKeyOf(leg.x100))!;
    const start = Math.floor(leg.atMs / BUCKET_MS) * BUCKET_MS;
    let bucket = slot.buckets.at(-1);
    if (!bucket || bucket.start < start) { bucket = { start, bets: 0, handle: 0n, returned: 0n, policyReturn: 0, variance: 0, adjustWeighted: 0 }; slot.buckets.push(bucket); }
    else if (bucket.start > start) bucket = slot.buckets.find(b => b.start === start) ?? bucket; // late settlement: fold into the newest bucket
    const s = Number(leg.stakeCenti), m = leg.x100 / 100;
    bucket.bets++; bucket.handle += leg.stakeCenti; bucket.returned += leg.creditCenti;
    bucket.policyReturn += s * leg.policyRtp; bucket.variance += s * s * m * m * leg.p * (1 - leg.p); bucket.adjustWeighted += s * leg.adjust;
  }

  private prune(slot: RangeSlot, nowMs: number, windowMs: number): void {
    while (slot.buckets.length && slot.buckets[0]!.start + BUCKET_MS <= nowMs - windowMs) slot.buckets.shift();
    while (slot.changes.length && slot.changes[0]!.atMs <= nowMs - HOUR_MS) slot.changes.shift();
  }

  private window(slot: RangeSlot): { bets: number; handle: bigint; returned: bigint; policyReturn: number; variance: number; adjustWeighted: number } {
    let bets = 0, handle = 0n, returned = 0n, policyReturn = 0, variance = 0, adjustWeighted = 0;
    for (const b of slot.buckets) { bets += b.bets; handle += b.handle; returned += b.returned; policyReturn += b.policyReturn; variance += b.variance; adjustWeighted += b.adjustWeighted; }
    return { bets, handle, returned, policyReturn, variance, adjustWeighted };
  }

  /** Proposed adjustments at `nowMs` (the caller journals them and then calls `apply`). */
  evaluate(nowMs: number, config: ControllerConfig): readonly ControllerChange[] {
    if (!config.enabled) return [];
    const out: ControllerChange[] = [];
    for (const [key, slot] of this.slots) {
      this.prune(slot, nowMs, config.windowMs);
      if (config.overrides[key] !== undefined) continue;
      const w = this.window(slot);
      if (w.bets < config.minBets || w.handle <= 0n) continue;
      const h = Number(w.handle);
      const realized = Number(w.returned) / h, target = w.policyReturn / h, se = Math.sqrt(w.variance) / h, avgAdjust = w.adjustWeighted / h;
      const gap = realized - target;
      if (!(Math.abs(gap) > Math.max(config.deadband, config.zGate * se))) continue;
      // Raising the edge by Δ lowers RTP by ≈ Δ; aim at the adjustment that would have met the target.
      const desired = Math.min(config.maxAdjust, Math.max(config.minAdjust, avgAdjust + gap));
      let step = desired - slot.adjust;
      const usedHour = slot.changes.reduce((s, c) => s + Math.abs(c.delta), 0);
      const room = Math.max(0, config.maxStepPerHour - usedHour);
      const bound = Math.min(config.maxStepPerEval, room);
      if (step > bound) step = bound; else if (step < -bound) step = -bound;
      // Only move in the direction the gap asks for (hysteresis against window lag).
      if ((gap > 0 && step <= 0) || (gap < 0 && step >= 0)) continue;
      const after = Math.round((slot.adjust + step) * 1e6) / 1e6;
      if (after === slot.adjust) continue;
      out.push(Object.freeze({ key, before: slot.adjust, after, realized, target, se, bets: w.bets, avgAdjust }));
    }
    return Object.freeze(out);
  }

  /** Apply a (journaled) adjustment; also used when rebuilding from the journal. */
  apply(key: string, after: number, atMs: number): void {
    const slot = this.slots.get(key);
    if (!slot || !Number.isFinite(after)) return;
    slot.changes.push({ atMs, delta: after - slot.adjust });
    slot.adjust = after; slot.lastChangeMs = atMs;
  }

  adjust(key: string): number { return this.slots.get(key)?.adjust ?? 0; }

  /** Effective per-range adjustment handed to pricing: overrides win; automatic values apply only while enabled. */
  effective(config: ControllerConfig): Readonly<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const key of RANGE_KEYS) {
      const value = config.overrides[key] ?? (config.enabled ? this.adjust(key) : 0);
      if (value !== 0) out[key] = value;
    }
    return Object.freeze(out);
  }

  state(nowMs: number, config: ControllerConfig): readonly ControllerRangeState[] {
    return RANGE_KEYS.map(key => {
      const slot = this.slots.get(key)!;
      this.prune(slot, nowMs, config.windowMs);
      const w = this.window(slot); const h = Number(w.handle);
      const override = config.overrides[key];
      return Object.freeze({
        key, adjust: slot.adjust, ...(override !== undefined ? { override } : {}), effective: override ?? (config.enabled ? slot.adjust : 0),
        bets: w.bets, handleCenti: w.handle.toString(), realized: h > 0 ? Number(w.returned) / h : null, target: h > 0 ? w.policyReturn / h : null,
        se: h > 0 ? Math.sqrt(w.variance) / h : null, avgAdjust: h > 0 ? w.adjustWeighted / h : null, ...(slot.lastChangeMs !== undefined ? { lastChangeMs: slot.lastChangeMs } : {}),
      });
    });
  }
}
