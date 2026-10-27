/**
 * Response decoders. The console renders money and risk, so a malformed
 * payload must fail visibly (BAD_RESPONSE) rather than render as zero.
 * Decoders validate what the UI depends on, normalise tolerated variants and
 * return deeply frozen snapshots.
 */
import { isCenti } from './money.js';
import type {
  AccountProof, AuditEntry, BetLeg, BetPage, Breaker, ChainAlertView, ChainState, ControllerRangeView, DefenseConfig, DefenseFlags, DefensesView,
  EscapeState, Exposure, ExposureBand, ExposureCell, MarketState, MetricsSeries, Overview, OverviewPromo, PlayerDetail, PlayerPage, PlayerRow,
  PromoAggView, PromoConfig, PromoGuardConfig, PromoGuardState, PromoLegacyView, PromoProgress, PromoTierConfig, PromoTierId, PromoTierStatus, PromoTierView, PromoView,
  ReferenceFeedStatus, RtpReport, RtpRow, StreamEvent, StreamEventType, TierId, WithdrawalAnomaly, WriteAck,
} from './types.js';

export class DecodeFailure extends Error {
  constructor(readonly path: string, expected: string) { super(`${path}: expected ${expected}`); }
}

type Obj = Record<string, unknown>;

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Obj)) deepFreeze(item);
  }
  return value;
}

function obj(value: unknown, path: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DecodeFailure(path, 'object');
  return value as Obj;
}
function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new DecodeFailure(path, 'array');
  return value;
}
function str(o: Obj, key: string, path: string): string {
  const v = o[key]; if (typeof v !== 'string') throw new DecodeFailure(`${path}.${key}`, 'string'); return v;
}
function optStr(o: Obj, key: string, path: string): string | undefined {
  const v = o[key]; if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new DecodeFailure(`${path}.${key}`, 'string'); return v;
}
function num(o: Obj, key: string, path: string): number {
  const v = o[key]; if (typeof v !== 'number' || !Number.isFinite(v)) throw new DecodeFailure(`${path}.${key}`, 'finite number'); return v;
}
function optNum(o: Obj, key: string, path: string): number | undefined {
  const v = o[key]; if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new DecodeFailure(`${path}.${key}`, 'finite number'); return v;
}
function nullableNum(o: Obj, key: string, path: string): number | null {
  const v = o[key]; if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new DecodeFailure(`${path}.${key}`, 'number or null'); return v;
}
function bool(o: Obj, key: string, path: string): boolean {
  const v = o[key]; if (typeof v !== 'boolean') throw new DecodeFailure(`${path}.${key}`, 'boolean'); return v;
}
function centi(o: Obj, key: string, path: string): string {
  const v = o[key]; if (!isCenti(v)) throw new DecodeFailure(`${path}.${key}`, 'Centi integer string'); return v;
}
function optCenti(o: Obj, key: string, path: string): string | undefined {
  const v = o[key]; if (v === undefined || v === null) return undefined;
  if (!isCenti(v)) throw new DecodeFailure(`${path}.${key}`, 'Centi integer string'); return v;
}
function optBool(o: Obj, key: string, path: string): boolean | undefined {
  const v = o[key]; if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new DecodeFailure(`${path}.${key}`, 'boolean'); return v;
}
/** Present-but-null means "no data yet"; absent means "not reported". */
function optNullableNum(o: Obj, key: string, path: string): number | null | undefined {
  if (!(key in o) || o[key] === undefined) return undefined;
  return nullableNum(o, key, path);
}
/** Non-negative integer wei amount as a decimal string. */
function wei(o: Obj, key: string, path: string): string {
  const v = o[key]; if (typeof v !== 'string' || !/^\d{1,78}$/.test(v)) throw new DecodeFailure(`${path}.${key}`, 'wei integer string'); return v;
}
function optWei(o: Obj, key: string, path: string): string | undefined {
  const v = o[key]; if (v === undefined || v === null) return undefined; return wei(o, key, path);
}
function nullableWei(o: Obj, key: string, path: string): string | null {
  return o[key] === null || o[key] === undefined ? null : wei(o, key, path);
}
type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> };
/** Keep only defined fields so frozen snapshots carry no `undefined` keys. */
function defined<T extends Record<string, unknown>>(fields: T): Defined<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Defined<T>;
}

/** Multipliers may arrive as integer numbers or integer strings. */
function x100(o: Obj, key: string, path: string): number {
  const v = o[key];
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw new DecodeFailure(`${path}.${key}`, 'integer x100');
  return n;
}
/** List endpoints: accept `{ rows }` (spec) or a bare array. */
function rowsOf(raw: unknown, path: string): { rows: unknown[]; o: Obj } {
  if (Array.isArray(raw)) return { rows: raw, o: {} };
  const o = obj(raw, path);
  return { rows: arr(o['rows'] ?? o['items'], `${path}.rows`), o };
}
function cursorOf(o: Obj): string | null { const c = o['nextCursor'] ?? o['cursor']; return typeof c === 'string' && c !== '' ? c : null; }

function breaker(raw: unknown, path: string): Breaker {
  const o = obj(raw, path);
  const market = optStr(o, 'market', path);
  const from = optStr(o, 'from', path); const actor = optStr(o, 'actor', path); const tier = optStr(o, 'tier', path);
  return { id: str(o, 'id', path), ...(market === undefined ? {} : { market }), state: str(o, 'state', path), since: num(o, 'since', path), reason: typeof o['reason'] === 'string' ? o['reason'] : '', ...(from === undefined ? {} : { from }), ...(actor === undefined ? {} : { actor }), ...(tier === undefined ? {} : { tier }) };
}

function market(raw: unknown, path: string): MarketState {
  const o = obj(raw, path);
  const spot = o['spot'];
  return {
    id: str(o, 'id', path), enabled: bool(o, 'enabled', path), paused: bool(o, 'paused', path),
    lastPriceMs: num(o, 'lastPriceMs', path),
    spot: typeof spot === 'number' ? String(spot) : typeof spot === 'string' ? spot : '—',
    sigma: typeof o['sigma'] === 'number' ? o['sigma'] : Number.NaN,
    tableId: typeof o['tableId'] === 'string' ? o['tableId'] : '—',
  };
}

export function decodeOverview(raw: unknown): Overview {
  const p = 'overview';
  const o = obj(raw, p);
  const launch = obj(o['launch'], `${p}.launch`);
  const usage = obj(o['limitUsage'], `${p}.limitUsage`);
  const result: Overview = {
    network: str(o, 'network', p), chainId: num(o, 'chainId', p), operator: str(o, 'operator', p), vault: str(o, 'vault', p), token: str(o, 'token', p),
    feedMode: o['feedMode'] === 'live' ? 'live' : 'replay', speed: typeof o['speed'] === 'number' ? o['speed'] : 1, clockMs: num(o, 'clockMs', p),
    equityCenti: centi(o, 'equityCenti', p), playerBalancesCenti: centi(o, 'playerBalancesCenti', p), openLiabilityCenti: centi(o, 'openLiabilityCenti', p),
    limitUsage: { global: num(usage, 'global', `${p}.limitUsage`), maxColumn: num(usage, 'maxColumn', `${p}.limitUsage`), maxCell: num(usage, 'maxCell', `${p}.limitUsage`) },
    registeredPlayers: num(o, 'registeredPlayers', p), activePlayers5m: num(o, 'activePlayers5m', p),
    launch: {
      enabled: bool(launch, 'enabled', `${p}.launch`), active: bool(launch, 'active', `${p}.launch`), edge: num(launch, 'edge', `${p}.launch`),
      untilPlayers: num(launch, 'untilPlayers', `${p}.launch`), standardEdge: num(launch, 'standardEdge', `${p}.launch`),
    },
    breakers: arr(o['breakers'], `${p}.breakers`).map((b, i) => breaker(b, `${p}.breakers[${i}]`)),
    markets: arr(o['markets'], `${p}.markets`).map((m, i) => market(m, `${p}.markets[${i}]`)),
    handle24hCenti: centi(o, 'handle24hCenti', p), ggr24hCenti: centi(o, 'ggr24hCenti', p),
    rtp24h: typeof o['rtp24h'] === 'number' ? o['rtp24h'] : Number.NaN, betsPerMin: num(o, 'betsPerMin', p),
  };
  const extras: { -readonly [K in 'pricing' | 'limits' | 'sim']?: Overview[K] } = {};
  if (o['pricing'] && typeof o['pricing'] === 'object') {
    const q = obj(o['pricing'], `${p}.pricing`);
    extras.pricing = { standardEdge: num(q, 'standardEdge', `${p}.pricing`), capX100: num(q, 'capX100', `${p}.pricing`), aboveCap: q['aboveCap'] === 'cap' ? 'cap' : 'hide', impactK: num(q, 'impactK', `${p}.pricing`), z: num(q, 'z', `${p}.pricing`) };
  }
  if (o['limits'] && typeof o['limits'] === 'object') {
    const l = obj(o['limits'], `${p}.limits`); const lp = `${p}.limits`;
    extras.limits = { cellFraction: num(l, 'cellFraction', lp), columnFraction: num(l, 'columnFraction', lp), globalFraction: num(l, 'globalFraction', lp), accountFraction: num(l, 'accountFraction', lp), maxStakePerBetCenti: centi(l, 'maxStakePerBetCenti', lp), maxStakePerCellCenti: centi(l, 'maxStakePerCellCenti', lp) };
  }
  if (o['sim'] && typeof o['sim'] === 'object') {
    const s = obj(o['sim'], `${p}.sim`);
    extras.sim = { running: bool(s, 'running', `${p}.sim`), speed: num(s, 'speed', `${p}.sim`), arrivalsPerMin: num(s, 'arrivalsPerMin', `${p}.sim`) };
  }
  return deepFreeze({ ...result, ...extras, ...overviewDefenseExtras(o, p) });
}

function controllerRange(raw: unknown, path: string): ControllerRangeView {
  const o = obj(raw, path);
  return {
    key: str(o, 'key', path), adjust: num(o, 'adjust', path), effective: num(o, 'effective', path), bets: num(o, 'bets', path),
    realized: nullableNum(o, 'realized', path), target: nullableNum(o, 'target', path),
    ...defined({ override: optNum(o, 'override', path), handleCenti: optCenti(o, 'handleCenti', path), se: optNullableNum(o, 'se', path), avgAdjust: optNullableNum(o, 'avgAdjust', path), lastChangeMs: optNum(o, 'lastChangeMs', path) }),
  };
}

function chainAlert(raw: unknown, path: string): ChainAlertView {
  const o = obj(raw, path);
  const level = o['level'] === 'critical' || o['level'] === 'warning' ? o['level'] : 'info';
  return { code: str(o, 'code', path), level, message: str(o, 'message', path), ...defined({ atMs: optNum(o, 'atMs', path) }) };
}

/** SPEC-10 / SPEC-11 overview additions; each is validated when present and left out when not reported. */
function overviewDefenseExtras(o: Obj, p: string): Partial<Overview> {
  const out: { -readonly [K in keyof Overview]?: Overview[K] } = {};
  const signer = optStr(o, 'ledgerSigner', p); if (signer !== undefined) out.ledgerSigner = signer;
  const runId = optStr(o, 'runId', p); if (runId !== undefined) out.runId = runId;
  const journalSeq = optNum(o, 'journalSeq', p); if (journalSeq !== undefined) out.journalSeq = journalSeq;
  const pending = optNum(o, 'holdPending', p); if (pending !== undefined) out.holdPending = pending;
  const reject = optNullableNum(o, 'holdRejectRate', p); if (reject !== undefined) out.holdRejectRate = reject;
  const p95 = optNullableNum(o, 'holdLatencyP95Ms', p); if (p95 !== undefined) out.holdLatencyP95Ms = p95;
  const toxic = optNullableNum(o, 'toxicFlowShare', p); if (toxic !== undefined) out.toxicFlowShare = toxic;
  if (o['defenses'] !== undefined && o['defenses'] !== null) {
    const d = obj(o['defenses'], `${p}.defenses`); const dp = `${p}.defenses`;
    const flags: DefenseFlags = {
      hold: bool(d, 'hold', dp), quoteValidity: bool(d, 'quoteValidity', dp), minLeadS: num(d, 'minLeadS', dp), ramp: bool(d, 'ramp', dp),
      toxicity: d['toxicity'] === 'graduated' ? 'graduated' : 'monitor', controller: bool(d, 'controller', dp), reference: bool(d, 'reference', dp),
    };
    out.defenses = flags;
  }
  if (o['controller'] !== undefined && o['controller'] !== null) {
    const c = obj(o['controller'], `${p}.controller`);
    out.controller = { enabled: bool(c, 'enabled', `${p}.controller`), ranges: arr(c['ranges'], `${p}.controller.ranges`).map((r, i) => controllerRange(r, `${p}.controller.ranges[${i}]`)) };
  }
  if (o['chainAlerts'] !== undefined && o['chainAlerts'] !== null) out.chainAlerts = arr(o['chainAlerts'], `${p}.chainAlerts`).map((a, i) => chainAlert(a, `${p}.chainAlerts[${i}]`));
  // SPEC-12: a legacy launch-boost server sends promo: null (left out, like any absent extension).
  if (o['promo'] !== undefined && o['promo'] !== null) out.promo = overviewPromo(o['promo'], `${p}.promo`);
  return out;
}

// ---------------------------------------------------------------- SPEC-12 promo tiers

const PROMO_TIERS: readonly PromoTierId[] = ['launch', 'growth', 'scale'];
const TIER_STATUSES: readonly PromoTierStatus[] = ['current', 'ended', 'skipped', 'upcoming', 'disabled'];

/** Non-negative Centi (turnover, caps, thresholds): a negative figure there is a server bug, never rendered. */
function posCenti(o: Obj, key: string, path: string): string {
  const v = centi(o, key, path); if (v.startsWith('-')) throw new DecodeFailure(`${path}.${key}`, 'non-negative Centi'); return v;
}
function nullablePosCenti(o: Obj, key: string, path: string): string | null {
  return o[key] === null || o[key] === undefined ? null : posCenti(o, key, path);
}
function nullableInt(o: Obj, key: string, path: string): number | null {
  const v = nullableNum(o, key, path); if (v !== null && !Number.isSafeInteger(v)) throw new DecodeFailure(`${path}.${key}`, 'integer or null'); return v;
}
function tierId(v: unknown, path: string): TierId {
  if (v === 'standard' || (typeof v === 'string' && (PROMO_TIERS as readonly string[]).includes(v))) return v as TierId;
  throw new DecodeFailure(path, 'launch|growth|scale|standard');
}

function promoGuardState(raw: unknown, p: string): PromoGuardState {
  const o = obj(raw, p);
  return { adjust: num(o, 'adjust', p), tripped: bool(o, 'tripped', p), ...defined({ since: optNum(o, 'since', p), reason: optStr(o, 'reason', p), lastChangeMs: optNum(o, 'lastChangeMs', p) }) };
}

function promoTierConfig(raw: unknown, p: string, expected: PromoTierId): PromoTierConfig {
  const o = obj(raw, p);
  if (o['id'] !== expected) throw new DecodeFailure(`${p}.id`, expected);
  const untilPlayers = num(o, 'untilPlayers', p); const minWin = num(o, 'minWinX100', p);
  if (!Number.isSafeInteger(untilPlayers) || untilPlayers < 0) throw new DecodeFailure(`${p}.untilPlayers`, 'non-negative integer');
  if (!Number.isSafeInteger(minWin)) throw new DecodeFailure(`${p}.minWinX100`, 'integer x100');
  return {
    id: expected, label: str(o, 'label', p), enabled: bool(o, 'enabled', p), untilPlayers, untilTurnoverCenti: posCenti(o, 'untilTurnoverCenti', p),
    lossBudget: num(o, 'lossBudget', p), minWinX100: minWin, perAccountBoostCapCenti: posCenti(o, 'perAccountBoostCapCenti', p),
  };
}

function promoGuardConfig(raw: unknown, p: string): PromoGuardConfig {
  const o = obj(raw, p);
  return {
    enabled: bool(o, 'enabled', p), evalEveryMs: num(o, 'evalEveryMs', p), minTurnoverCenti: posCenti(o, 'minTurnoverCenti', p), zGate: num(o, 'zGate', p), deadband: num(o, 'deadband', p),
    maxStepPerEval: num(o, 'maxStepPerEval', p), maxTighten: num(o, 'maxTighten', p), tripMarginRel: num(o, 'tripMarginRel', p), tripZ: num(o, 'tripZ', p), acceptanceSignal: bool(o, 'acceptanceSignal', p),
  };
}

function promoConfig(raw: unknown, p: string): PromoConfig {
  const o = obj(raw, p);
  const tiers = arr(o['tiers'], `${p}.tiers`);
  if (tiers.length !== PROMO_TIERS.length) throw new DecodeFailure(`${p}.tiers`, 'exactly launch, growth, scale');
  return {
    enabled: bool(o, 'enabled', p), tiers: tiers.map((t, i) => promoTierConfig(t, `${p}.tiers[${i}]`, PROMO_TIERS[i]!)), standardLabel: str(o, 'standardLabel', p),
    guard: promoGuardConfig(o['guard'], `${p}.guard`),
  };
}

function promoAgg(raw: unknown, p: string): PromoAggView {
  const o = obj(raw, p);
  return {
    bets: num(o, 'bets', p), wins: num(o, 'wins', p), refunds: num(o, 'refunds', p), handleCenti: posCenti(o, 'handleCenti', p), returnedCenti: posCenti(o, 'returnedCenti', p), housePnlCenti: centi(o, 'housePnlCenti', p),
    rtp: nullableNum(o, 'rtp', p), expectedRtp: nullableNum(o, 'expectedRtp', p), lossRate: nullableNum(o, 'lossRate', p), se: nullableNum(o, 'se', p),
    seIndependent: nullableNum(o, 'seIndependent', p), seClustered: nullableNum(o, 'seClustered', p), seBlock: nullableNum(o, 'seBlock', p),
    lossRateLow: nullableNum(o, 'lossRateLow', p), lossRateHigh: nullableNum(o, 'lossRateHigh', p),
    ...defined({ budget: optNum(o, 'budget', p), budgetUsed: optNullableNum(o, 'budgetUsed', p), budgetCenti: o['budgetCenti'] === undefined || o['budgetCenti'] === null ? undefined : posCenti(o, 'budgetCenti', p) }),
  };
}

function promoProgress(o: Obj, p: string): PromoProgress {
  return { players: num(o, 'players', p), untilPlayers: nullableInt(o, 'untilPlayers', p), turnoverCenti: posCenti(o, 'turnoverCenti', p), untilTurnoverCenti: nullablePosCenti(o, 'untilTurnoverCenti', p) };
}

function promoTierView(raw: unknown, p: string, expected: TierId): PromoTierView {
  const o = obj(raw, p);
  const id = tierId(o['id'], `${p}.id`);
  if (id !== expected) throw new DecodeFailure(`${p}.id`, expected);
  const status = o['status'];
  if (typeof status !== 'string' || !(TIER_STATUSES as readonly string[]).includes(status)) throw new DecodeFailure(`${p}.status`, TIER_STATUSES.join('|'));
  const r = obj(o['realized'], `${p}.realized`); const rp = `${p}.realized`;
  const a = obj(o['accounts'], `${p}.accounts`); const ap = `${p}.accounts`;
  let grid: PromoTierView['grid'] = null;
  if (o['grid'] !== null && o['grid'] !== undefined) {
    const g = obj(o['grid'], `${p}.grid`); const gp = `${p}.grid`;
    grid = { grids: num(g, 'grids', gp), priced: num(g, 'priced', gp), offered: num(g, 'offered', gp), hiddenMinWin: num(g, 'hiddenMinWin', gp), lowestX100: nullableInt(g, 'lowestX100', gp) };
  }
  return {
    id, label: str(o, 'label', p), status: status as PromoTierStatus,
    config: id === 'standard' || o['config'] === null ? null : promoTierConfig(o['config'], `${p}.config`, id),
    startedMs: nullableNum(o, 'startedMs', p), endedMs: nullableNum(o, 'endedMs', p), startPlayers: nullableInt(o, 'startPlayers', p), startTurnoverCenti: nullablePosCenti(o, 'startTurnoverCenti', p),
    turnoverCenti: posCenti(o, 'turnoverCenti', p), bets: num(o, 'bets', p), boostedTurnoverCenti: posCenti(o, 'boostedTurnoverCenti', p), boostedBets: num(o, 'boostedBets', p),
    realized: { boosted: promoAgg(r['boosted'], `${rp}.boosted`), boostedClean: promoAgg(r['boostedClean'], `${rp}.boostedClean`), standardPriced: promoAgg(r['standardPriced'], `${rp}.standardPriced`), all: promoAgg(r['all'], `${rp}.all`) },
    promoCostCenti: centi(o, 'promoCostCenti', p),
    accounts: { boosted: num(a, 'boosted', ap), capped: num(a, 'capped', ap), capCenti: nullablePosCenti(a, 'capCenti', ap) },
    guard: promoGuardState(o['guard'], `${p}.guard`), grid,
  };
}

function overviewPromo(raw: unknown, p: string): OverviewPromo {
  const o = obj(raw, p);
  const pr = obj(o['progress'], `${p}.progress`); const pp = `${p}.progress`;
  const b = obj(o['budget'], `${p}.budget`); const bp = `${p}.budget`;
  return {
    enabled: bool(o, 'enabled', p), tier: tierId(o['tier'], `${p}.tier`), label: str(o, 'label', p), boosted: bool(o, 'boosted', p), ...defined({ fallback: optStr(o, 'fallback', p) }),
    baseEdge: num(o, 'baseEdge', p), minWinX100: num(o, 'minWinX100', p),
    progress: { ...promoProgress(pr, pp), playersShare: nullableNum(pr, 'playersShare', pp), turnoverShare: nullableNum(pr, 'turnoverShare', pp) },
    budget: {
      lossBudget: nullableNum(b, 'lossBudget', bp), tierTurnoverCenti: posCenti(b, 'tierTurnoverCenti', bp), settledBoostedCenti: posCenti(b, 'settledBoostedCenti', bp), housePnlCenti: centi(b, 'housePnlCenti', bp),
      lossRate: nullableNum(b, 'lossRate', bp), lossRateLow: nullableNum(b, 'lossRateLow', bp), lossRateHigh: nullableNum(b, 'lossRateHigh', bp), budgetUsed: nullableNum(b, 'budgetUsed', bp),
    },
    guard: promoGuardState(o['guard'], `${p}.guard`),
  };
}

/** GET /admin-api/promo: the tier configuration and live state, or `{ configured: false }` on a legacy launch-boost server. */
export function decodePromo(raw: unknown): PromoView | PromoLegacyView {
  const p = 'promo';
  const o = obj(raw, p);
  if (o['configured'] === false) return deepFreeze({ configured: false, mode: typeof o['mode'] === 'string' ? o['mode'] : 'legacy', clockMs: num(o, 'clockMs', p) } satisfies PromoLegacyView);
  if (o['configured'] !== true) throw new DecodeFailure(`${p}.configured`, 'boolean');
  const c = obj(o['current'], `${p}.current`); const cp = `${p}.current`;
  const g = obj(o['guard'], `${p}.guard`); const gp = `${p}.guard`;
  const confirm = obj(o['confirm'] ?? {}, `${p}.confirm`);
  const tiers = arr(o['tiers'], `${p}.tiers`);
  const order: readonly TierId[] = [...PROMO_TIERS, 'standard'];
  if (tiers.length !== order.length) throw new DecodeFailure(`${p}.tiers`, 'launch, growth, scale, standard');
  const tripped = arr(g['tripped'] ?? [], `${gp}.tripped`).map((t, i) => { const id = tierId(t, `${gp}.tripped[${i}]`); if (id === 'standard') throw new DecodeFailure(`${gp}.tripped[${i}]`, 'promo tier'); return id; });
  const phrase = (key: string, fallback: string) => (typeof confirm[key] === 'string' ? confirm[key] as string : fallback);
  return deepFreeze({
    configured: true, enabled: bool(o, 'enabled', p), config: promoConfig(o['config'], `${p}.config`), standardEdge: num(o, 'standardEdge', p), minStakeCenti: posCenti(o, 'minStakeCenti', p),
    current: {
      tier: tierId(c['tier'], `${cp}.tier`), label: str(c, 'label', cp), boosted: bool(c, 'boosted', cp), ...defined({ fallback: optStr(c, 'fallback', cp) }), baseEdge: num(c, 'baseEdge', cp),
      lossBudget: nullableNum(c, 'lossBudget', cp), minWinX100: num(c, 'minWinX100', cp), guardAdjust: num(c, 'guardAdjust', cp),
    },
    progress: promoProgress(obj(o['progress'], `${p}.progress`), `${p}.progress`),
    tiers: tiers.map((t, i) => promoTierView(t, `${p}.tiers[${i}]`, order[i]!)),
    tierLog: arr(o['tierLog'] ?? [], `${p}.tierLog`).map((e, i) => {
      const q = obj(e, `${p}.tierLog[${i}]`); const ep = `${p}.tierLog[${i}]`;
      return { atMs: num(q, 'atMs', ep), tier: tierId(q['tier'], `${ep}.tier`), players: num(q, 'players', ep), turnoverCenti: posCenti(q, 'turnoverCenti', ep), cause: typeof q['cause'] === 'string' ? q['cause'] : '' };
    }),
    guard: { config: promoGuardConfig(g['config'], `${gp}.config`), nextEvalMs: nullableNum(g, 'nextEvalMs', gp), tripped },
    confirm: { endTier: phrase('endTier', 'promo-end-tier'), resume: phrase('resume', 'promo-resume'), edgeChange: phrase('edgeChange', 'edge-change') },
    clockMs: num(o, 'clockMs', p),
  } satisfies PromoView);
}

function defenseConfig(raw: unknown, p: string): DefenseConfig {
  const c = obj(raw, p);
  const h = obj(c['hold'], `${p}.hold`); const hp = `${p}.hold`;
  const v = obj(c['quoteValidity'], `${p}.quoteValidity`); const vp = `${p}.quoteValidity`;
  const r = obj(c['ramp'], `${p}.ramp`); const rp = `${p}.ramp`;
  const t = obj(c['toxicity'], `${p}.toxicity`); const tp = `${p}.toxicity`;
  const k = obj(c['controller'], `${p}.controller`); const kp = `${p}.controller`;
  const f = obj(c['reference'], `${p}.reference`); const fp = `${p}.reference`;
  const tolScale = h['tolScale']; const onTimeout = h['onTimeout'];
  if (tolScale !== 'relative' && tolScale !== 'logit') throw new DecodeFailure(`${hp}.tolScale`, 'relative|logit');
  if (onTimeout !== 'reject' && onTimeout !== 'accept') throw new DecodeFailure(`${hp}.onTimeout`, 'reject|accept');
  const overrides = obj(k['overrides'] ?? {}, `${kp}.overrides`);
  return {
    hold: {
      enabled: bool(h, 'enabled', hp), maxHoldMs: num(h, 'maxHoldMs', hp), tolScale, tolRel: num(h, 'tolRel', hp), tolAbs: num(h, 'tolAbs', hp), onTimeout,
      flaggedTolRel: num(h, 'flaggedTolRel', hp), newAccountHolds: num(h, 'newAccountHolds', hp), newAccountTolRel: num(h, 'newAccountTolRel', hp), newAccountMaxZ: num(h, 'newAccountMaxZ', hp),
    },
    quoteValidity: { enabled: bool(v, 'enabled', vp), graceMs: num(v, 'graceMs', vp), maxTtlMs: num(v, 'maxTtlMs', vp) },
    minLeadS: num(c, 'minLeadS', p),
    ramp: { enabled: bool(r, 'enabled', rp), startCenti: centi(r, 'startCenti', rp), perSettledBetCenti: centi(r, 'perSettledBetCenti', rp), handleFraction: num(r, 'handleFraction', rp) },
    toxicity: {
      enabled: bool(t, 'enabled', tp), minBets: num(t, 'minBets', tp), minWins: num(t, 'minWins', tp), surchargeZ: num(t, 'surchargeZ', tp), surchargeEdge: num(t, 'surchargeEdge', tp),
      blockZ: num(t, 'blockZ', tp), blockMinBets: num(t, 'blockMinBets', tp), unflagZ: num(t, 'unflagZ', tp), holdMinN: num(t, 'holdMinN', tp), holdZ: num(t, 'holdZ', tp),
      holdBlockMinN: num(t, 'holdBlockMinN', tp), holdBlockZ: num(t, 'holdBlockZ', tp),
    },
    controller: {
      enabled: bool(k, 'enabled', kp), windowMs: num(k, 'windowMs', kp), evalEveryMs: num(k, 'evalEveryMs', kp), minBets: num(k, 'minBets', kp), zGate: num(k, 'zGate', kp),
      deadband: num(k, 'deadband', kp), maxStepPerEval: num(k, 'maxStepPerEval', kp), maxStepPerHour: num(k, 'maxStepPerHour', kp), minAdjust: num(k, 'minAdjust', kp),
      maxAdjust: num(k, 'maxAdjust', kp), cleanHoldZ: num(k, 'cleanHoldZ', kp),
      overrides: Object.fromEntries(Object.keys(overrides).map(key => [key, num(overrides, key, `${kp}.overrides`)])),
    },
    reference: { enabled: bool(f, 'enabled', fp), moveSigma: num(f, 'moveSigma', fp) },
  };
}

function referenceFeed(raw: unknown, p: string): ReferenceFeedStatus | null {
  if (raw === null || raw === undefined) return null;
  const o = obj(raw, p);
  return {
    source: str(o, 'source', p), connected: bool(o, 'connected', p), messages: num(o, 'messages', p), prices: num(o, 'prices', p), reconnects: num(o, 'reconnects', p),
    ...defined({ lastMessageMs: optNum(o, 'lastMessageMs', p), lastError: optStr(o, 'lastError', p) }),
    markets: arr(o['markets'] ?? [], `${p}.markets`).map((m, i) => { const q = obj(m, `${p}.markets[${i}]`); const mp = `${p}.markets[${i}]`; return { market: str(q, 'market', mp), ...defined({ lastPublishMs: optNum(q, 'lastPublishMs', mp), value: optNum(q, 'value', mp) }) }; }),
  };
}

/** GET /admin-api/defenses. */
export function decodeDefenses(raw: unknown): DefensesView {
  const p = 'defenses';
  const o = obj(raw, p);
  const hold = obj(o['hold'], `${p}.hold`); const hp = `${p}.hold`;
  const lat = obj(hold['latencyMs'] ?? {}, `${hp}.latencyMs`);
  const byDetail = obj(hold['byDetail'] ?? {}, `${hp}.byDetail`);
  const tox = obj(o['toxicity'], `${p}.toxicity`); const tp = `${p}.toxicity`;
  const ctl = obj(o['controller'], `${p}.controller`); const cp = `${p}.controller`;
  const ref = obj(o['reference'], `${p}.reference`); const fp = `${p}.reference`;
  const ramp = obj(o['ramp'] ?? {}, `${p}.ramp`);
  return deepFreeze({
    config: defenseConfig(o['config'], `${p}.config`),
    hold: {
      enabled: bool(hold, 'enabled', hp), pending: num(hold, 'pending', hp), created: num(hold, 'created', hp), accepted: num(hold, 'accepted', hp), rejected: num(hold, 'rejected', hp),
      byDetail: Object.fromEntries(Object.keys(byDetail).map(k => [k, num(byDetail, k, `${hp}.byDetail`)])),
      rejectRate1h: nullableNum(hold, 'rejectRate1h', hp), rejectRateAll: nullableNum(hold, 'rejectRateAll', hp),
      latencyMs: { p50: nullableNum(lat, 'p50', `${hp}.latencyMs`), p95: nullableNum(lat, 'p95', `${hp}.latencyMs`), max: nullableNum(lat, 'max', `${hp}.latencyMs`), n: typeof lat['n'] === 'number' ? lat['n'] : 0 },
    },
    ramp: defined({ accountLimitCenti: optCenti(ramp, 'accountLimitCenti', `${p}.ramp`) }),
    toxicity: {
      mode: tox['mode'] === 'graduated' ? 'graduated' : 'monitor', flowEdge: num(tox, 'flowEdge', tp), flagged: num(tox, 'flagged', tp), flaggedByMonitor: num(tox, 'flaggedByMonitor', tp),
      blocked: num(tox, 'blocked', tp), blockedByMonitor: num(tox, 'blockedByMonitor', tp), toxicFlowShare1h: nullableNum(tox, 'toxicFlowShare1h', tp), toxicFlowShareAll: nullableNum(tox, 'toxicFlowShareAll', tp),
    },
    controller: { enabled: bool(ctl, 'enabled', cp), nextEvalMs: nullableNum(ctl, 'nextEvalMs', cp), ranges: arr(ctl['ranges'], `${cp}.ranges`).map((r, i) => controllerRange(r, `${cp}.ranges[${i}]`)) },
    reference: { enabled: bool(ref, 'enabled', fp), moveSigma: num(ref, 'moveSigma', fp), invalidations: typeof ref['invalidations'] === 'number' ? ref['invalidations'] : 0, lastObservationMs: nullableNum(ref, 'lastObservationMs', fp) },
    referenceFeed: referenceFeed(o['referenceFeed'], `${p}.referenceFeed`),
    clockMs: num(o, 'clockMs', p),
  } satisfies DefensesView);
}

function escapeState(raw: unknown, p: string): EscapeState {
  const o = obj(raw, p);
  return {
    mode: bool(o, 'mode', p), available: bool(o, 'available', p), lastAttestationAtMs: num(o, 'lastAttestationAtMs', p), escapeDelaySec: num(o, 'escapeDelaySec', p),
    availableAtMs: num(o, 'availableAtMs', p), secondsUntilAvailable: num(o, 'secondsUntilAvailable', p), poolWei: wei(o, 'poolWei', p), claimedWei: wei(o, 'claimedWei', p),
    ...defined({ poolCenti: optCenti(o, 'poolCenti', p), claimedCenti: optCenti(o, 'claimedCenti', p), entitlementWei: optWei(o, 'entitlementWei', p) }),
  };
}

function withdrawalAnomaly(raw: unknown, p: string): WithdrawalAnomaly {
  const o = obj(raw, p);
  return { key: str(o, 'key', p), player: str(o, 'player', p), nonce: String(o['nonce'] ?? ''), amountWei: wei(o, 'amountWei', p), txHash: str(o, 'txHash', p), outcome: str(o, 'outcome', p), ms: num(o, 'ms', p), ...defined({ voucherId: optStr(o, 'voucherId', p) }) };
}

/**
 * GET /v1/account/:address/proof (player API). A 503 PROOF_UNAVAILABLE body still carries the
 * attestation and escape status; it decodes with `unavailable` set and no proof.
 */
export function decodeProof(raw: unknown): AccountProof {
  const p = 'proof';
  const o = obj(raw, p);
  const err = o['error'] && typeof o['error'] === 'object' ? o['error'] as Obj : null;
  const a = o['attestation'];
  let attestation: AccountProof['attestation'] = null;
  if (a !== null && a !== undefined) {
    const q = obj(a, `${p}.attestation`); const ap = `${p}.attestation`;
    const seq = q['seq'];
    if (typeof seq !== 'string' && typeof seq !== 'number') throw new DecodeFailure(`${ap}.seq`, 'sequence');
    attestation = { seq: String(seq), root: str(q, 'root', ap), asOfMs: num(q, 'asOfMs', ap), liabilitiesWei: wei(q, 'liabilitiesWei', ap), source: q['source'] === 'journal' ? 'journal' : 'vault', ...defined({ txHash: optStr(q, 'txHash', ap) }) };
  }
  const escape = o['escape'] === null || o['escape'] === undefined ? null : escapeState(o['escape'], `${p}.escape`);
  const head = { account: str(o, 'account', p), chainId: num(o, 'chainId', p), vault: str(o, 'vault', p), attestation, escape };
  if (err) {
    return deepFreeze({ ...head, included: false, balanceWei: '0', proof: [], unavailable: { code: typeof err['code'] === 'string' ? err['code'] : 'PROOF_UNAVAILABLE', message: typeof err['message'] === 'string' ? err['message'] : 'The proof is not available.' } });
  }
  const proof = arr(o['proof'] ?? [], `${p}.proof`).map((x, i) => { if (typeof x !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(x)) throw new DecodeFailure(`${p}.proof[${i}]`, 'bytes32 hex'); return x; });
  let claim: AccountProof['claim'];
  if (o['claim'] && typeof o['claim'] === 'object') {
    const c = obj(o['claim'], `${p}.claim`);
    claim = { function: str(c, 'function', `${p}.claim`), attestedBalance: wei(c, 'attestedBalance', `${p}.claim`), proof: arr(c['proof'] ?? [], `${p}.claim.proof`).map(String) };
  }
  return deepFreeze({
    ...head, included: bool(o, 'included', p), balanceWei: wei(o, 'balanceWei', p), proof,
    ...defined({ currentOwedWei: optWei(o, 'currentOwedWei', p), claim, note: optStr(o, 'note', p) }),
  });
}

export function decodeMetrics(raw: unknown): MetricsSeries {
  const p = 'metrics';
  const o = obj(raw, p);
  const t = arr(o['t'], `${p}.t`);
  const n = t.length;
  const nums = (key: string): number[] => {
    const a = arr(o[key] ?? [], `${p}.${key}`);
    if (a.length !== n) throw new DecodeFailure(`${p}.${key}`, `${n} values aligned with t[]`);
    return a.map((v, i) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new DecodeFailure(`${p}.${key}[${i}]`, 'number'); return v; });
  };
  const centis = (key: string): string[] => {
    const a = arr(o[key] ?? [], `${p}.${key}`);
    if (a.length !== n) throw new DecodeFailure(`${p}.${key}`, `${n} values aligned with t[]`);
    return a.map((v, i) => { if (!isCenti(v)) throw new DecodeFailure(`${p}.${key}[${i}]`, 'Centi'); return v; });
  };
  const rtp = arr(o['rtp'] ?? [], `${p}.rtp`);
  if (rtp.length !== n) throw new DecodeFailure(`${p}.rtp`, `${n} values aligned with t[]`);
  return deepFreeze({
    t: t.map((v, i) => { if (typeof v !== 'number') throw new DecodeFailure(`${p}.t[${i}]`, 'ms epoch'); return v; }),
    equity: centis('equity'), ggr: centis('ggr'), handle: centis('handle'),
    rtp: rtp.map(v => (typeof v === 'number' && Number.isFinite(v) ? v : null)),
    openLiability: centis('openLiability'), players: nums('players'), betsPerMin: nums('betsPerMin'),
  });
}

function rtpRow(raw: unknown, path: string): RtpRow {
  const o = obj(raw, path);
  const key = typeof o['key'] === 'string' ? o['key'] : typeof o['range'] === 'string' ? o['range'] : typeof o['market'] === 'string' ? o['market'] : typeof o['phase'] === 'string' ? o['phase'] : undefined;
  if (key === undefined) throw new DecodeFailure(`${path}.key`, 'string');
  const phase = o['phase'] === 'launch' || o['phase'] === 'standard' ? o['phase'] : undefined;
  const handle = optCenti(o, 'handleCenti', path); const returned = optCenti(o, 'returnedCenti', path);
  const low = optNum(o, 'expectedLow', path); const high = optNum(o, 'expectedHigh', path);
  return {
    key, ...(phase ? { phase } : {}), bets: num(o, 'bets', path),
    ...(handle === undefined ? {} : { handleCenti: handle }), ...(returned === undefined ? {} : { returnedCenti: returned }),
    expected: num(o, 'expected', path), realized: nullableNum(o, 'realized', path),
    ...(low === undefined ? {} : { expectedLow: low }), ...(high === undefined ? {} : { expectedHigh: high }),
  };
}

export function decodeRtp(raw: unknown): RtpReport {
  const p = 'rtp';
  const o = obj(raw, p);
  const rows = (key: string): RtpRow[] => arr(o[key] ?? [], `${p}.${key}`).map((r, i) => rtpRow(r, `${p}.${key}[${i}]`));
  const report: { -readonly [K in keyof RtpReport]: RtpReport[K] } = { byRange: rows('byRange'), byMarket: rows('byMarket'), byPhase: rows('byPhase') };
  if (Array.isArray(o['calibration'])) {
    report.calibration = o['calibration'].map((c, i) => { const q = obj(c, `${p}.calibration[${i}]`); return { predicted: num(q, 'predicted', `${p}.calibration[${i}]`), observed: num(q, 'observed', `${p}.calibration[${i}]`), n: num(q, 'n', `${p}.calibration[${i}]`) }; });
  }
  if (Array.isArray(o['tables'])) {
    report.tables = o['tables'].map((t, i) => {
      const q = obj(t, `${p}.tables[${i}]`); const built = optNum(q, 'builtMs', `${p}.tables[${i}]`); const prev = optStr(q, 'previousTableId', `${p}.tables[${i}]`);
      return { market: str(q, 'market', `${p}.tables[${i}]`), tableId: str(q, 'tableId', `${p}.tables[${i}]`), ...(built === undefined ? {} : { builtMs: built }), ...(prev === undefined ? {} : { previousTableId: prev }) };
    });
  }
  const last = optNum(o, 'lastRefitMs', p); if (last !== undefined) report.lastRefitMs = last;
  return deepFreeze(report);
}

export function decodeExposure(raw: unknown): Exposure {
  const p = 'exposure';
  const o = obj(raw, p);
  const windows = arr(o['windows'], `${p}.windows`).map((w, i) => {
    if (typeof w === 'number') return w;
    const q = obj(w, `${p}.windows[${i}]`); return num(q, 'start', `${p}.windows[${i}]`);
  });
  const bands: ExposureBand[] = arr(o['bands'], `${p}.bands`).map((b, i) => {
    if (typeof b === 'number') return { index: b };
    const q = obj(b, `${p}.bands[${i}]`);
    const lower = q['lower']; const upper = q['upper'];
    return { index: num(q, 'index', `${p}.bands[${i}]`), ...(lower === undefined ? {} : { lower: String(lower) }), ...(upper === undefined ? {} : { upper: String(upper) }) };
  });
  const cells: ExposureCell[] = arr(o['cells'], `${p}.cells`).map((c, i) => {
    const q = obj(c, `${p}.cells[${i}]`); const cp = `${p}.cells[${i}]`;
    return { start: num(q, 'start', cp), bandIndex: num(q, 'bandIndex', cp), x100: q['x100'] === null || q['x100'] === undefined ? null : x100(q, 'x100', cp), liabilityCenti: centi(q, 'liabilityCenti', cp), limitCenti: centi(q, 'limitCenti', cp), legs: num(q, 'legs', cp), ...defined({ reason: optStr(q, 'reason', cp) }) };
  });
  const columnLimit = optCenti(o, 'columnLimitCenti', p);
  return deepFreeze({ market: typeof o['market'] === 'string' ? o['market'] : '', windows, bands, cells, ...(columnLimit === undefined ? {} : { columnLimitCenti: columnLimit }), ...defined({ generatedAtMs: optNum(o, 'generatedAtMs', p) }) });
}

export function decodePlayerRow(raw: unknown, path = 'player'): PlayerRow {
  const o = obj(raw, path);
  const strategy = optStr(o, 'strategy', path);
  return {
    account: str(o, 'account', path), kind: o['kind'] === 'onchain' ? 'onchain' : 'sim', ...(strategy === undefined ? {} : { strategy }),
    balanceCenti: centi(o, 'balanceCenti', path), handleCenti: centi(o, 'handleCenti', path), pnlCenti: centi(o, 'pnlCenti', path),
    bets: num(o, 'bets', path), rtp: nullableNum(o, 'rtp', path), flagged: bool(o, 'flagged', path), blocked: bool(o, 'blocked', path),
    firstSeenMs: num(o, 'firstSeenMs', path),
    ...defined({ holds: optNum(o, 'holds', path), latencyZ: optNullableNum(o, 'latencyZ', path), excessReturnZ: optNullableNum(o, 'excessReturnZ', path) }),
  };
}

export function decodePlayers(raw: unknown): PlayerPage {
  const { rows, o } = rowsOf(raw, 'players');
  const total = typeof o['total'] === 'number' ? o['total'] : undefined;
  return deepFreeze({ rows: rows.map((r, i) => decodePlayerRow(r, `players.rows[${i}]`)), nextCursor: cursorOf(o), ...(total === undefined ? {} : { total }) });
}

export function decodeBet(raw: unknown, path = 'bet'): BetLeg {
  const o = obj(raw, path);
  const status = o['status'];
  if (status !== 'open' && status !== 'won' && status !== 'lost' && status !== 'refunded') throw new DecodeFailure(`${path}.status`, 'open|won|lost|refunded');
  const end = optNum(o, 'end', path); const settled = optNum(o, 'settledMs', path);
  const kind = o['kind'] === 'onchain' || o['kind'] === 'sim' ? o['kind'] : undefined;
  const phase = o['phase'] === 'launch' || o['phase'] === 'standard' ? o['phase'] : undefined;
  const lower = o['lower'] === undefined || o['lower'] === null ? undefined : String(o['lower']);
  const upper = o['upper'] === undefined || o['upper'] === null ? undefined : String(o['upper']);
  return {
    legId: typeof o['legId'] === 'string' ? o['legId'] : str(o, 'id', path), account: str(o, 'account', path), ...(kind ? { kind } : {}),
    market: str(o, 'market', path), start: num(o, 'start', path), ...(end === undefined ? {} : { end }), bandIndex: num(o, 'bandIndex', path),
    ...(lower === undefined ? {} : { lower }), ...(upper === undefined ? {} : { upper }),
    stakeCenti: centi(o, 'stakeCenti', path), x100: x100(o, 'x100', path), payoutCenti: centi(o, 'payoutCenti', path), status,
    placedMs: num(o, 'placedMs', path), ...(settled === undefined ? {} : { settledMs: settled }), ...(phase ? { phase } : {}),
    ...defined({ heldMs: optNum(o, 'heldMs', path), strategy: optStr(o, 'strategy', path) }),
  };
}

export function decodeBets(raw: unknown): BetPage {
  const { rows, o } = rowsOf(raw, 'bets');
  return deepFreeze({ rows: rows.map((r, i) => decodeBet(r, `bets.rows[${i}]`)), nextCursor: cursorOf(o) });
}

function movement(raw: unknown, path: string) {
  const o = obj(raw, path);
  const tx = optStr(o, 'txHash', path); const status = optStr(o, 'status', path); const dust = optStr(o, 'dustWei', path);
  const id = typeof o['id'] === 'string' ? o['id'] : tx ?? `${path}`;
  const nonce = o['nonce'];
  return {
    id, amountCenti: centi(o, 'amountCenti', path), ms: num(o, 'ms', path), ...(tx === undefined ? {} : { txHash: tx }), ...(status === undefined ? {} : { status }), ...(dust === undefined ? {} : { dustWei: dust }),
    ...defined({
      nonce: typeof nonce === 'string' || typeof nonce === 'number' ? String(nonce) : undefined, expiryMs: optNum(o, 'expiryMs', path), submittedTxHash: optStr(o, 'submittedTxHash', path),
      claimSource: optStr(o, 'claimSource', path), claimNote: optStr(o, 'claimNote', path), releaseReason: optStr(o, 'releaseReason', path),
    }),
  };
}

export function decodePlayerDetail(raw: unknown): PlayerDetail {
  const p = 'playerDetail';
  const o = obj(raw, p);
  const player = decodePlayerRow(o['player'] ?? o, `${p}.player`);
  const list = (key: string) => arr(o[key] ?? [], `${p}.${key}`);
  return deepFreeze({
    player,
    bets: list('bets').map((b, i) => decodeBet(b, `${p}.bets[${i}]`)),
    deposits: list('deposits').map((d, i) => movement(d, `${p}.deposits[${i}]`)),
    withdrawals: list('withdrawals').map((d, i) => movement(d, `${p}.withdrawals[${i}]`)),
    flags: list('flags').map((f, i) => { const q = obj(f, `${p}.flags[${i}]`); return { ms: num(q, 'ms', `${p}.flags[${i}]`), actor: typeof q['actor'] === 'string' ? q['actor'] : '—', action: typeof q['action'] === 'string' ? q['action'] : 'flag', reason: typeof q['reason'] === 'string' ? q['reason'] : '' }; }),
  });
}

export function decodeChain(raw: unknown): ChainState {
  const p = 'chain';
  const o = obj(raw, p);
  const v = obj(o['vault'], `${p}.vault`); const vp = `${p}.vault`;
  const op = obj(o['operator'], `${p}.operator`);
  const pv = obj(o['pendingVouchers'] ?? { count: 0, totalCenti: '0' }, `${p}.pendingVouchers`);
  const ix = obj(o['indexer'] ?? {}, `${p}.indexer`);
  const att = o['lastAttestation'];
  const optional = <K extends string>(key: K, value: unknown) => (value === undefined ? {} : { [key]: value });
  let lastAttestation: ChainState['lastAttestation'] = null;
  if (att !== null && att !== undefined) {
    const a = obj(att, `${p}.lastAttestation`); const ap = `${p}.lastAttestation`;
    let tree: NonNullable<ChainState['lastAttestation']>['tree'];
    if (a['tree'] !== undefined && a['tree'] !== null) {
      const t = obj(a['tree'], `${ap}.tree`); const tp = `${ap}.tree`;
      tree = { leaves: nullableNum(t, 'leaves', tp), leafTotalWei: nullableWei(t, 'leafTotalWei', tp), treeFile: optStr(t, 'treeFile', tp) ?? null, treeSha256: optStr(t, 'treeSha256', tp) ?? null };
    }
    lastAttestation = { seq: num(a, 'seq', ap), asOfMs: num(a, 'asOfMs', ap), liabilitiesCenti: centi(a, 'liabilitiesCenti', ap), ledgerRoot: str(a, 'ledgerRoot', ap), ...optional('txHash', optStr(a, 'txHash', ap)), ...optional('blockNumber', optNum(a, 'blockNumber', ap)), ...optional('tree', tree) };
  }
  const ethWei = op['ethWei'];
  const objOrNull = (value: unknown, path: string): Obj | null | undefined => (value === null || value === undefined ? (value as null | undefined) : obj(value, path));
  const ps = objOrNull(v['pendingSigner'], `${vp}.pendingSigner`);
  const pd = objOrNull(v['pendingSignerChangeDelay'], `${vp}.pendingSignerChangeDelay`);
  const ph = objOrNull(v['pendingHouseLimits'], `${vp}.pendingHouseLimits`);
  const pendingOf = <T>(q: Obj | null | undefined, build: (q: Obj) => T): T | null | undefined => (q === undefined ? undefined : q === null ? null : build(q));
  const alerts = o['alerts'] === undefined || o['alerts'] === null ? undefined : arr(o['alerts'], `${p}.alerts`).map((x, i) => chainAlert(x, `${p}.alerts[${i}]`));
  let withdrawals: ChainState['withdrawals'];
  if (o['withdrawals'] !== undefined && o['withdrawals'] !== null) {
    const w = obj(o['withdrawals'], `${p}.withdrawals`);
    withdrawals = { indexed: typeof w['indexed'] === 'number' ? w['indexed'] : 0, anomalies: arr(w['anomalies'] ?? [], `${p}.withdrawals.anomalies`).map((x, i) => withdrawalAnomaly(x, `${p}.withdrawals.anomalies[${i}]`)) };
  }
  let reconciliation: ChainState['reconciliation'];
  if (o['reconciliation'] === null) reconciliation = null;
  else if (o['reconciliation'] !== undefined) {
    const r = obj(o['reconciliation'], `${p}.reconciliation`); const rp = `${p}.reconciliation`;
    const delta = r['deltaWei'];
    if (typeof delta !== 'string' || !/^-?\d+$/.test(delta)) throw new DecodeFailure(`${rp}.deltaWei`, 'signed wei integer string');
    reconciliation = { match: bool(r, 'match', rp), vaultAssetsWei: wei(r, 'vaultAssetsWei', rp), ledgerAssetsWei: wei(r, 'ledgerAssetsWei', rp), deltaWei: delta, dustWei: optWei(r, 'dustWei', rp) ?? '0' };
  }
  return deepFreeze({
    network: typeof o['network'] === 'string' ? o['network'] : '', chainId: num(o, 'chainId', p),
    vault: {
      address: str(v, 'address', vp), token: typeof v['token'] === 'string' ? v['token'] : '', paused: bool(v, 'paused', vp),
      assetsCenti: centi(v, 'assetsCenti', vp), houseFundedCenti: centi(v, 'houseFundedCenti', vp),
      totalPlayerDepositsCenti: centi(v, 'totalPlayerDepositsCenti', vp), totalPlayerWithdrawalsCenti: centi(v, 'totalPlayerWithdrawalsCenti', vp),
      surplusCenti: centi(v, 'surplusCenti', vp),
      ...optional('houseWithdrawnCenti', optCenti(v, 'houseWithdrawnCenti', vp)), ...optional('maxVoucherAmountCenti', optCenti(v, 'maxVoucherAmountCenti', vp)),
      ...optional('dailyOutflowCapCenti', optCenti(v, 'dailyOutflowCapCenti', vp)), ...optional('maxAttestationAgeSec', optNum(v, 'maxAttestationAgeSec', vp)),
      ...optional('ledgerSigner', optStr(v, 'ledgerSigner', vp)),
      ...optional('serverSigner', v['serverSigner'] === null ? null : optStr(v, 'serverSigner', vp)), ...optional('signerMismatch', optBool(v, 'signerMismatch', vp)),
      ...optional('pendingSigner', pendingOf(ps, q => ({ address: str(q, 'address', `${vp}.pendingSigner`), etaMs: num(q, 'etaMs', `${vp}.pendingSigner`), due: bool(q, 'due', `${vp}.pendingSigner`) }))),
      ...optional('signerChangeDelaySec', optNum(v, 'signerChangeDelaySec', vp)),
      ...optional('pendingSignerChangeDelay', pendingOf(pd, q => ({ delaySec: num(q, 'delaySec', `${vp}.pendingSignerChangeDelay`), etaMs: num(q, 'etaMs', `${vp}.pendingSignerChangeDelay`) }))),
      ...optional('houseBufferBps', optNum(v, 'houseBufferBps', vp)), ...optional('houseDailyCapCenti', optCenti(v, 'houseDailyCapCenti', vp)),
      ...optional('pendingHouseLimits', pendingOf(ph, q => ({ houseBufferBps: num(q, 'houseBufferBps', `${vp}.pendingHouseLimits`), houseDailyCapCenti: centi(q, 'houseDailyCapCenti', `${vp}.pendingHouseLimits`), etaMs: num(q, 'etaMs', `${vp}.pendingHouseLimits`) }))),
      ...optional('houseWithdrawableCenti', optCenti(v, 'houseWithdrawableCenti', vp)), ...optional('excessWei', optWei(v, 'excessWei', vp)), ...optional('excessCenti', optCenti(v, 'excessCenti', vp)),
      ...optional('escape', v['escape'] === undefined || v['escape'] === null ? undefined : escapeState(v['escape'], `${vp}.escape`)),
      ...optional('unavailable', v['unavailable'] === true ? true : undefined),
    },
    lastAttestation,
    operator: { address: str(op, 'address', `${p}.operator`), ethWei: typeof ethWei === 'string' && /^\d+$/.test(ethWei) ? ethWei : '0', tokenCenti: centi(op, 'tokenCenti', `${p}.operator`) },
    pendingVouchers: {
      count: num(pv, 'count', `${p}.pendingVouchers`), totalCenti: centi(pv, 'totalCenti', `${p}.pendingVouchers`),
      ...optional('items', Array.isArray(pv['items']) ? pv['items'].map((it, i) => {
        const q = obj(it, `${p}.pendingVouchers.items[${i}]`); const ip = `${p}.pendingVouchers.items[${i}]`;
        return { account: str(q, 'account', ip), amountCenti: centi(q, 'amountCenti', ip), nonce: String(q['nonce'] ?? ''), expiryMs: num(q, 'expiryMs', ip), ...defined({ voucherId: optStr(q, 'voucherId', ip), status: optStr(q, 'status', ip), submittedTxHash: optStr(q, 'submittedTxHash', ip) }) };
      }) : undefined),
    },
    indexer: { lagBlocks: typeof ix['lagBlocks'] === 'number' ? ix['lagBlocks'] : Number.NaN, ...optional('lastBlock', optNum(ix, 'lastBlock', `${p}.indexer`)), ...optional('headBlock', optNum(ix, 'headBlock', `${p}.indexer`)), ...optional('confirmations', optNum(ix, 'confirmations', `${p}.indexer`)) },
    ...optional('alerts', alerts), ...optional('withdrawals', withdrawals), ...optional('reconciliation', reconciliation),
  } as ChainState);
}

export function decodeAuditEntry(raw: unknown, path = 'audit'): AuditEntry {
  const o = obj(raw, path);
  const kind = o['kind'] === 'breaker' || o['kind'] === 'system' ? o['kind'] : 'admin';
  const id = o['id'] ?? o['seq'];
  const target = optStr(o, 'target', path); const reason = optStr(o, 'reason', path); const result = optStr(o, 'result', path);
  return {
    id: typeof id === 'string' || typeof id === 'number' ? String(id) : `${num(o, 'ms', path)}:${str(o, 'action', path)}`,
    ms: num(o, 'ms', path), kind, actor: typeof o['actor'] === 'string' ? o['actor'] : kind === 'admin' ? 'admin' : 'system', action: str(o, 'action', path),
    ...(target === undefined ? {} : { target }), ...('before' in o ? { before: o['before'] } : {}), ...('after' in o ? { after: o['after'] } : {}),
    ...(reason === undefined ? {} : { reason }), ...(result === undefined ? {} : { result }),
  };
}

export function decodeAudit(raw: unknown): readonly AuditEntry[] {
  const { rows } = rowsOf(raw, 'audit');
  return deepFreeze(rows.map((r, i) => decodeAuditEntry(r, `audit.rows[${i}]`)));
}

export function decodeWriteAck(raw: unknown): WriteAck {
  if (raw === null || raw === undefined || raw === '') return deepFreeze({ ok: true });
  return deepFreeze({ ...obj(raw, 'ack') });
}

const STREAM_TYPES: readonly StreamEventType[] = ['overview', 'bet', 'settlement', 'breaker', 'admin-action', 'alert', 'refit'];

export function isStreamEventType(value: string): value is StreamEventType {
  return (STREAM_TYPES as readonly string[]).includes(value);
}

/** Decode one SSE message into a typed event; unknown event names are ignored (null). */
export function decodeStreamEvent(type: string, data: unknown): StreamEvent | null {
  if (!isStreamEventType(type)) return null;
  switch (type) {
    case 'overview': return { type, data: decodeOverview(data) };
    case 'bet': return { type, data: deepFreeze(decodeBet(data)) };
    case 'settlement': return { type, data: deepFreeze(decodeBet(data)) };
    case 'breaker': return { type, data: deepFreeze(breaker(data, 'breaker')) };
    case 'admin-action': return { type, data: deepFreeze(decodeAuditEntry(data)) };
    case 'alert': {
      const o = obj(data, 'alert');
      const level = o['level'] === 'critical' || o['level'] === 'warning' ? o['level'] : 'info';
      const code = optStr(o, 'code', 'alert');
      return { type, data: deepFreeze({ level, message: str(o, 'message', 'alert'), ms: typeof o['ms'] === 'number' ? o['ms'] : Date.now(), ...(code === undefined ? {} : { code }) }) };
    }
    case 'refit': {
      const o = obj(data, 'refit');
      const state = o['state'] === 'queued' || o['state'] === 'done' || o['state'] === 'failed' ? o['state'] : 'running';
      const marketId = optStr(o, 'market', 'refit'); const tableId = optStr(o, 'tableId', 'refit'); const message = optStr(o, 'message', 'refit');
      return { type, data: deepFreeze({ jobId: str(o, 'jobId', 'refit'), progress: typeof o['progress'] === 'number' ? o['progress'] : 0, state, ...(marketId === undefined ? {} : { market: marketId }), ...(tableId === undefined ? {} : { tableId }), ...(message === undefined ? {} : { message }) }) };
    }
  }
}
