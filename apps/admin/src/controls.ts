/**
 * Pure logic behind every admin write: field parsing, before → after diffs,
 * danger classification and the typed-confirmation gate. The UI only renders
 * what these functions return, so the safety rules are unit-tested here.
 */
import { writes, type WriteMeta, type WriteRequest, type PlayerAction } from './api.js';
import { formatAge, formatInt, formatPct, isEvmAddress, marketLabel, shortAddress } from './format.js';
import { isBreakerActive } from './health.js';
import { formatOpen, formatWeiOpen, formatX100, parseCenti, parseOpenAmount, OPEN_AMOUNT_MESSAGES } from './money.js';
import type { Breaker, Centi, ChainState, LaunchState, LimitsConfig, MarketState, PlayerRow, PricingConfig, SimState } from './types.js';

/** Exact action names the server expects in `confirm` for dangerous actions (SPEC §7, SPEC-10, SPEC-11). */
export const CONFIRM_NAMES = Object.freeze({
  pauseAll: 'pause-all',
  vaultPause: 'vault-pause',
  withdrawSurplus: 'withdraw-surplus',
  edgeChange: 'edge-change',
  defensesDisable: 'defenses-disable',
  signerPropose: 'signer-propose',
  signerAccept: 'signer-accept',
  sweepExcess: 'sweep-excess',
  promoEndTier: 'promo-end-tier',
  promoResume: 'promo-resume',
} as const);

/** "edge change > 2 pts" is dangerous. */
export const EDGE_DANGER_DELTA = 0.02;
export const REASON_MIN = 8;
export const REASON_MAX = 500;

/** `minutes`: typed in whole minutes, sent in ms (durations such as the controller window). `multiplier`: typed as 1.25 (×), sent as the integer ×100. */
export type FieldKind = 'percent' | 'integer' | 'decimal' | 'enum' | 'boolean' | 'open' | 'minutes' | 'multiplier';

export interface FieldSpec {
  readonly key: string;
  readonly label: string;
  readonly kind: FieldKind;
  /** Inclusive bounds on the API value (fractions for percent fields, ms for minutes fields). */
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly string[];
  readonly help: string;
  /** Display decimals for percent fields. */
  readonly decimals?: number;
  readonly format?: 'x100';
  /** Unit shown after integer/decimal labels and values ('ms', 's', 'σ', …). */
  readonly unit?: string;
  /** Allow a leading minus sign (decimal and percent fields). */
  readonly signed?: boolean;
  /** Allow 0 for OPEN amounts. */
  readonly allowZero?: boolean;
}

export const PRICING_FIELDS: readonly FieldSpec[] = Object.freeze([
  { key: 'standardEdge', label: 'Standard edge', kind: 'percent', min: 0.01, max: 0.25, help: 'House edge once the launch boost ends. Range 1–25 %.' },
  { key: 'capX100', label: 'Multiplier cap', kind: 'integer', min: 200, max: 10_000, format: 'x100', help: 'Highest multiplier offered, ×100 (5000 = 50.00×). Range 200–10000.' },
  { key: 'aboveCap', label: 'Above the cap', kind: 'enum', options: ['hide', 'cap'], help: 'Hide squares priced above the cap, or offer them at the cap.' },
  { key: 'impactK', label: 'Price impact k', kind: 'decimal', min: 0, max: 10, help: 'Crowded cells pay less on the next quote. 0 disables impact.' },
  { key: 'z', label: 'Uncertainty z', kind: 'decimal', min: 0, max: 5, help: 'Standard errors added to the calibrated probability.' },
] satisfies FieldSpec[]);

export const LAUNCH_FIELDS: readonly FieldSpec[] = Object.freeze([
  { key: 'enabled', label: 'Launch boost', kind: 'boolean', help: 'Turning the boost off ends it immediately for new quotes.' },
  { key: 'edge', label: 'Launch edge', kind: 'percent', min: 0.01, max: 0.25, help: 'House edge while the boost is active. Range 1–25 %.' },
  { key: 'untilPlayers', label: 'Ends at players', kind: 'integer', min: 0, max: 10_000_000, help: 'The boost ends when registered players reach this number.' },
] satisfies FieldSpec[]);

export const LIMIT_FIELDS: readonly FieldSpec[] = Object.freeze([
  { key: 'cellFraction', label: 'Per cell', kind: 'percent', min: 0.00001, max: 0.25, decimals: 3, help: 'Open liability per square as a share of house equity.' },
  { key: 'columnFraction', label: 'Per column', kind: 'percent', min: 0.00001, max: 0.25, decimals: 3, help: 'Per market window (all bands) as a share of equity.' },
  { key: 'globalFraction', label: 'Global', kind: 'percent', min: 0.00001, max: 0.5, decimals: 3, help: 'All open liability as a share of equity.' },
  { key: 'accountFraction', label: 'Per account', kind: 'percent', min: 0.00001, max: 0.25, decimals: 3, help: 'Open liability for one player as a share of equity.' },
  { key: 'maxStakePerBetCenti', label: 'Max stake per bet', kind: 'open', help: 'Largest single stake, in OPEN.' },
  { key: 'maxStakePerCellCenti', label: 'Max stake per cell', kind: 'open', help: 'Largest total stake one player may hold on one square, in OPEN.' },
] satisfies FieldSpec[]);

export const SIM_FIELDS: readonly FieldSpec[] = Object.freeze([
  { key: 'running', label: 'Simulation running', kind: 'boolean', help: 'Synthetic players keep arriving and betting while running.' },
  { key: 'speed', label: 'Replay speed', kind: 'decimal', min: 0.1, max: 1000, help: 'Feed replay multiplier.' },
  { key: 'arrivalsPerMin', label: 'Arrivals per minute', kind: 'integer', min: 0, max: 100_000, help: 'New synthetic players per simulated minute.' },
] satisfies FieldSpec[]);

export type FieldValue = number | string | boolean;
export type ParseResult = { readonly ok: true; readonly value: FieldValue } | { readonly ok: false; readonly error: string };

/** Exact decimal text → nearest double of the exact value shifted by `shift` powers of ten. */
function decimalText(text: string, shift: number, signed = false): number | null {
  const match = (signed ? /^([-−]?)(\d+)(?:\.(\d+))?$/ : /^()(\d+)(?:\.(\d+))?$/).exec(text);
  if (!match) return null;
  const fraction = match[3] ?? '';
  if (fraction.length > 8) return null;
  const value = Number(`${match[1] ? '-' : ''}${match[2]}${fraction}e${-fraction.length + shift}`);
  return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
}

/** Parse one raw form value into the API value for its field. */
export function parseField(spec: FieldSpec, raw: string): ParseResult {
  const text = raw.trim().replace(/,/g, '');
  if (text === '') return { ok: false, error: `${spec.label}: enter a value.` };
  let value: FieldValue;
  switch (spec.kind) {
    case 'boolean':
      if (text !== 'true' && text !== 'false') return { ok: false, error: `${spec.label}: choose on or off.` };
      return { ok: true, value: text === 'true' };
    case 'enum':
      if (!spec.options?.includes(text)) return { ok: false, error: `${spec.label}: choose one of ${spec.options?.join(', ')}.` };
      return { ok: true, value: text };
    case 'open': {
      if (spec.allowZero && /^0+(\.0{1,2})?$/.test(text.replace(/\s+OPEN$/i, ''))) return { ok: true, value: '0' };
      const parsed = parseOpenAmount(text);
      if (!parsed.ok) return { ok: false, error: `${spec.label}: ${OPEN_AMOUNT_MESSAGES[parsed.reason]}` };
      return { ok: true, value: parsed.centi.toString() };
    }
    case 'integer':
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) return { ok: false, error: `${spec.label}: whole numbers only.` };
      value = Number(text);
      break;
    case 'minutes':
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text) * 60_000)) return { ok: false, error: `${spec.label}: whole minutes only.` };
      value = Number(text) * 60_000;
      break;
    case 'multiplier': {
      const x = decimalText(text.replace(/[×xX]$/, '').trim(), 2);
      if (x === null || !Number.isSafeInteger(x)) return { ok: false, error: `${spec.label}: enter a multiplier with at most 2 decimals, such as 1.25.` };
      value = x;
      break;
    }
    case 'percent': {
      const fraction = decimalText(text.replace(/%$/, '').trim(), -2, spec.signed);
      if (fraction === null) return { ok: false, error: `${spec.label}: enter a percentage such as ${spec.signed ? '-1.5 or ' : ''}3.5.` };
      value = fraction;
      break;
    }
    case 'decimal': {
      const n = decimalText(text, 0, spec.signed);
      if (n === null) return { ok: false, error: `${spec.label}: enter a number such as ${spec.signed ? '-2 or ' : ''}1.5.` };
      value = n;
      break;
    }
  }
  if (spec.min !== undefined && value < spec.min) return { ok: false, error: `${spec.label}: minimum is ${displayField(spec, spec.min)}.` };
  if (spec.max !== undefined && value > spec.max) return { ok: false, error: `${spec.label}: maximum is ${displayField(spec, spec.max)}.` };
  return { ok: true, value };
}

/** Display an API value for a field ("3.00%", "50.00×", "1,000.00 OPEN", "On"). */
export function displayField(spec: FieldSpec, value: unknown): string {
  if (value === undefined || value === null) return 'not reported';
  switch (spec.kind) {
    case 'boolean': return value === true ? 'On' : value === false ? 'Off' : String(value);
    case 'enum': return String(value);
    case 'open': return typeof value === 'string' || typeof value === 'bigint' ? formatOpen(value) : String(value);
    case 'percent': return typeof value === 'number' ? formatPct(value, spec.decimals ?? 2) : String(value);
    case 'integer': return typeof value === 'number' ? (spec.format === 'x100' ? `${formatX100(value)} (${value})` : `${formatInt(value)}${spec.unit ? ` ${spec.unit}` : ''}`) : String(value);
    case 'decimal': return typeof value === 'number' ? `${value < 0 ? '−' : ''}${Math.abs(value)}${spec.unit ? ` ${spec.unit}` : ''}` : String(value);
    case 'minutes': return typeof value === 'number' ? formatMinutes(value) : String(value);
    case 'multiplier': return typeof value === 'number' ? formatX100(value) : String(value);
  }
}

/** 10_800_000 → "3 h", 900_000 → "15 min", 5_400_000 → "1 h 30 min". */
export function formatMinutes(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60); const rest = minutes % 60;
  if (hours < 48 || rest !== 0) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  return `${hours / 24} d`;
}

/** Raw form text for a known value, used to prefill inputs. */
export function rawField(spec: FieldSpec, value: unknown): string {
  if (value === undefined || value === null) return '';
  switch (spec.kind) {
    case 'boolean': return value ? 'true' : 'false';
    case 'percent': return typeof value === 'number' ? String(Number((value * 100).toPrecision(12))) : '';
    case 'minutes': return typeof value === 'number' ? String(Math.round(value / 60_000)) : '';
    case 'multiplier': return typeof value === 'number' ? (value / 100).toFixed(2) : '';
    case 'open': {
      const c = parseCenti(value); if (c === null) return '';
      const neg = c < 0n; const m = neg ? -c : c;
      return `${neg ? '-' : ''}${m / 100n}.${(m % 100n).toString().padStart(2, '0')}`;
    }
    default: return String(value);
  }
}

export interface Change {
  readonly key: string;
  readonly label: string;
  readonly before: string;
  readonly after: string;
  /** false when the server did not report the current value. */
  readonly beforeKnown: boolean;
}

export type Draft = Readonly<Record<string, string>>;

export type PatchResult =
  | { readonly ok: true; readonly patch: Readonly<Record<string, FieldValue>>; readonly changes: readonly Change[] }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

function sameValue(spec: FieldSpec, a: unknown, b: FieldValue): boolean {
  if (spec.kind === 'open') { const x = parseCenti(a); const y = parseCenti(b); return x !== null && y !== null && x === y; }
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-12;
  return a === b;
}

/**
 * Diff a form draft against the server-reported values. Blank fields are
 * unchanged; only changed fields enter the patch.
 */
export function buildPatch(fields: readonly FieldSpec[], before: Readonly<Record<string, unknown>> | undefined, draft: Draft): PatchResult {
  const errors: Record<string, string> = {};
  const patch: Record<string, FieldValue> = {};
  const changes: Change[] = [];
  for (const spec of fields) {
    const raw = draft[spec.key];
    if (raw === undefined || raw.trim() === '') continue;
    const parsed = parseField(spec, raw);
    if (!parsed.ok) { errors[spec.key] = parsed.error; continue; }
    const prior = before?.[spec.key];
    const known = prior !== undefined && prior !== null;
    if (known && sameValue(spec, prior, parsed.value)) continue;
    patch[spec.key] = parsed.value;
    changes.push({ key: spec.key, label: spec.label, before: known ? displayField(spec, prior) : 'not reported', after: displayField(spec, parsed.value), beforeKnown: known });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (changes.length === 0) return { ok: false, errors: { _form: 'Nothing to change: every value matches the current setting.' } };
  return { ok: true, patch, changes };
}

/** Limits must nest: cell ≤ column ≤ global and account ≤ global (checked on known values). */
export function validateLimitHierarchy(before: Partial<LimitsConfig> | undefined, patch: Readonly<Record<string, FieldValue>>): string | null {
  const merged = { ...before, ...patch } as Partial<Record<keyof LimitsConfig, unknown>>;
  const n = (k: keyof LimitsConfig) => (typeof merged[k] === 'number' ? (merged[k] as number) : undefined);
  const cell = n('cellFraction'); const column = n('columnFraction'); const global = n('globalFraction'); const account = n('accountFraction');
  if (cell !== undefined && column !== undefined && cell > column) return 'Per-cell limit cannot exceed the per-column limit.';
  if (column !== undefined && global !== undefined && column > global) return 'Per-column limit cannot exceed the global limit.';
  if (account !== undefined && global !== undefined && account > global) return 'Per-account limit cannot exceed the global limit.';
  const bet = parseCenti(merged.maxStakePerBetCenti); const cellStake = parseCenti(merged.maxStakePerCellCenti);
  if (bet !== null && cellStake !== null && bet > cellStake) return 'Max stake per bet cannot exceed max stake per cell.';
  return null;
}

/** Edge actually charged on new quotes. */
export function effectiveEdge(launch: Pick<LaunchState, 'enabled' | 'edge' | 'untilPlayers' | 'standardEdge'>, registeredPlayers: number): number {
  return launch.enabled && registeredPlayers < launch.untilPlayers ? launch.edge : launch.standardEdge;
}

function exceeds(delta: number): boolean { return Math.abs(delta) > EDGE_DANGER_DELTA + 1e-12; }

/**
 * An edge change is dangerous when it moves an edge by more than 2 pts, or
 * when the current value is unknown (fail closed: confirm anyway).
 */
export function pricingNeedsConfirm(before: Partial<PricingConfig> | undefined, patch: Readonly<Record<string, FieldValue>>): boolean {
  const next = patch['standardEdge'];
  if (typeof next !== 'number') return false;
  const prior = before?.standardEdge;
  return typeof prior !== 'number' || exceeds(next - prior);
}

export function launchNeedsConfirm(before: LaunchState | undefined, registeredPlayers: number, patch: Readonly<Record<string, FieldValue>>): boolean {
  if (!('edge' in patch) && !('enabled' in patch) && !('untilPlayers' in patch)) return false;
  if (!before) return true;
  if (typeof patch['edge'] === 'number' && exceeds(patch['edge'] - before.edge)) return true;
  const after = {
    enabled: typeof patch['enabled'] === 'boolean' ? patch['enabled'] : before.enabled,
    edge: typeof patch['edge'] === 'number' ? patch['edge'] : before.edge,
    untilPlayers: typeof patch['untilPlayers'] === 'number' ? patch['untilPlayers'] : before.untilPlayers,
    standardEdge: before.standardEdge,
  };
  // Ending the boost early (or restarting it) swings the charged edge, e.g. 3 % → 8 %.
  return exceeds(effectiveEdge(after, registeredPlayers) - effectiveEdge(before, registeredPlayers));
}

export type ActionId =
  | 'market-pause' | 'market-resume' | 'pause-all' | 'resume-all' | 'pricing' | 'launch' | 'limits' | 'refit'
  | 'player-flag' | 'player-unflag' | 'player-block' | 'player-unblock'
  | 'treasury-fund' | 'withdraw-surplus' | 'attest' | 'vault-pause' | 'vault-unpause' | 'sim'
  | 'defenses' | 'signer-propose' | 'signer-accept' | 'signer-cancel' | 'sweep-excess'
  | 'promo' | 'promo-end-tier' | 'promo-resume';

/** Everything the confirm dialog needs; `build` turns the operator's reason into the exact request. */
export interface ActionPlan {
  readonly id: ActionId;
  readonly title: string;
  readonly summary: string;
  readonly changes: readonly Change[];
  /** Exact phrase the operator must type, or null when not dangerous. */
  readonly confirmName: string | null;
  readonly warnings: readonly string[];
  /** An on-chain transaction: the dialog names the network and chain id it will hit. */
  readonly onChain: boolean;
  readonly method: 'POST' | 'PUT';
  readonly path: string;
  readonly build: (meta: WriteMeta) => WriteRequest;
}

export type PlanResult = { readonly ok: true; readonly plan: ActionPlan } | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/** Actions that submit a vault transaction from the operator or the ledger signer. */
export const ON_CHAIN_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>(['treasury-fund', 'withdraw-surplus', 'attest', 'vault-pause', 'vault-unpause', 'signer-propose', 'signer-accept', 'signer-cancel', 'sweep-excess']);

export function plan(id: ActionId, title: string, summary: string, changes: readonly Change[], confirmName: string | null, warnings: readonly string[], build: (meta: WriteMeta) => WriteRequest): ActionPlan {
  const probe = build({ reason: 'probe' });
  return Object.freeze({ id, title, summary, changes: Object.freeze([...changes]), confirmName, warnings: Object.freeze([...warnings]), onChain: ON_CHAIN_ACTIONS.has(id), method: probe.method, path: probe.path, build });
}

export function change(key: string, label: string, before: string, after: string, beforeKnown = true): Change {
  return { key, label, before, after, beforeKnown };
}

/** Launch-boost state the pricing dialog needs to say when a standard-edge change takes effect. */
export interface PricingContext {
  readonly launch: LaunchState;
  readonly registeredPlayers: number;
}

export function pricingPlan(before: PricingConfig | undefined, draft: Draft, context?: PricingContext): PlanResult {
  const result = buildPatch(PRICING_FIELDS, before as Readonly<Record<string, unknown>> | undefined, draft);
  if (!result.ok) return result;
  const dangerous = pricingNeedsConfirm(before, result.patch);
  const next = result.patch['standardEdge'];
  const changes = [...result.changes];
  // While the launch boost is active new quotes charge the launch edge: a standard-edge change waits for the boost to end.
  const boost = context && typeof next === 'number' && context.launch.enabled && context.registeredPlayers < context.launch.untilPlayers ? context : null;
  const warnings: string[] = [];
  if (context && typeof next === 'number') {
    const edgeBefore = effectiveEdge(context.launch, context.registeredPlayers);
    const edgeAfter = effectiveEdge({ ...context.launch, standardEdge: next }, context.registeredPlayers);
    changes.push(change('effectiveEdge', 'Edge on new quotes now', formatPct(edgeBefore), formatPct(edgeAfter)));
  }
  if (boost) {
    const left = boost.launch.untilPlayers - boost.registeredPlayers;
    warnings.push(`The launch boost is active: new quotes charge the ${formatPct(boost.launch.edge)} launch edge. The standard edge applies when the boost ends at ${formatInt(boost.launch.untilPlayers)} registered players (${formatInt(left)} more), or when an admin ends it.`);
  }
  if (dangerous) {
    warnings.push(!before ? 'The current standard edge was not reported, so this is treated as a large edge change.'
      : boost ? 'Standard edge moves by more than 2 pts: quotes reprice by that much when the launch boost ends.'
        : 'Standard edge moves by more than 2 pts: new quotes reprice immediately.');
  }
  if (!before) warnings.push('The server did not report current pricing; "before" values are unknown.');
  return { ok: true, plan: plan('pricing', 'Update pricing', 'Applies to quotes issued after the server acknowledges; issued quotes stay firm.', changes, dangerous ? CONFIRM_NAMES.edgeChange : null, warnings, meta => writes.pricing(result.patch as Partial<PricingConfig>, meta)) };
}

export function launchPlan(before: LaunchState | undefined, registeredPlayers: number, draft: Draft): PlanResult {
  const known = before ? { enabled: before.enabled, edge: before.edge, untilPlayers: before.untilPlayers } : undefined;
  const result = buildPatch(LAUNCH_FIELDS, known, draft);
  if (!result.ok) return result;
  const warnings: string[] = [];
  const changes = [...result.changes];
  if (before) {
    const after = { ...before, ...result.patch } as LaunchState;
    const edgeBefore = effectiveEdge(before, registeredPlayers); const edgeAfter = effectiveEdge(after, registeredPlayers);
    if (edgeBefore !== edgeAfter) changes.push(change('effectiveEdge', 'Edge on new quotes', formatPct(edgeBefore), formatPct(edgeAfter)));
    if (typeof result.patch['untilPlayers'] === 'number' && result.patch['untilPlayers'] <= registeredPlayers && after.enabled) warnings.push(`Threshold is at or below the current ${formatInt(registeredPlayers)} registered players: the boost ends immediately.`);
  }
  const dangerous = launchNeedsConfirm(before, registeredPlayers, result.patch);
  if (dangerous) warnings.push('The edge charged on new quotes moves by more than 2 pts (or the current value is unknown).');
  return { ok: true, plan: plan('launch', 'Update launch boost', 'Journaled with your reason; applies to new quotes only.', changes, dangerous ? CONFIRM_NAMES.edgeChange : null, warnings, meta => writes.launch(result.patch as Partial<{ enabled: boolean; edge: number; untilPlayers: number }>, meta)) };
}

export function limitsPlan(before: LimitsConfig | undefined, draft: Draft): PlanResult {
  const result = buildPatch(LIMIT_FIELDS, before as Readonly<Record<string, unknown>> | undefined, draft);
  if (!result.ok) return result;
  const hierarchy = validateLimitHierarchy(before, result.patch);
  if (hierarchy) return { ok: false, errors: { _form: hierarchy } };
  const warnings: string[] = [];
  if (!before) warnings.push('The server did not report current limits; "before" values are unknown.');
  const tightening = before ? LIMIT_FIELDS.filter(f => f.kind === 'percent' && typeof result.patch[f.key] === 'number' && (result.patch[f.key] as number) < ((before as unknown as Record<string, number>)[f.key] ?? 0)) : [];
  if (tightening.length) warnings.push(`Tightening ${tightening.map(f => f.label.toLowerCase()).join(', ')}: open legs stay, new bets over the limit are rejected.`);
  return { ok: true, plan: plan('limits', 'Update risk limits', 'Limits are fractions of live house equity.', result.changes, null, warnings, meta => writes.limits(result.patch as Partial<LimitsConfig>, meta)) };
}

export function simPlan(before: SimState | undefined, draft: Draft): PlanResult {
  const result = buildPatch(SIM_FIELDS, before as Readonly<Record<string, unknown>> | undefined, draft);
  if (!result.ok) return result;
  return { ok: true, plan: plan('sim', 'Update simulation', 'Synthetic players use off-chain sim credits only.', result.changes, null, [], meta => writes.sim(result.patch as Partial<SimState>, meta)) };
}

/**
 * A market row on Controls. `markets[].paused` is the server's quoting gate, which is also closed by the
 * global manual pause, a drawdown pause and the equity floor, so the per-market action follows the
 * market's own manual breaker and every other cause is named.
 */
export interface MarketControl {
  /** This market's own manual pause is on (POST /markets/:id/resume clears it). */
  readonly ownPause: boolean;
  /** Other causes holding the market: 'pause-all', 'drawdown pause', 'equity floor', 'feed stale'. */
  readonly heldBy: readonly string[];
  /** The server's gate is closed (quoting stopped for any reason). */
  readonly gateClosed: boolean;
  readonly action: 'pause' | 'resume';
  readonly label: string;
  /** False when the server reports no per-market manual breaker (older server): `paused` is then the only signal. */
  readonly fromBreakers: boolean;
}

export function marketControl(market: MarketState, breakers: readonly Breaker[] | undefined): MarketControl {
  const list = breakers ?? [];
  const is = (id: string) => (b: Breaker) => b.id.toLowerCase() === id && isBreakerActive(b);
  const perMarket = list.filter(b => b.id.toLowerCase() === 'manual' && b.market === market.id);
  const fromBreakers = perMarket.length > 0;
  const ownPause = fromBreakers ? perMarket.some(isBreakerActive) : market.paused;
  const heldBy = [
    list.some(b => is('manual')(b) && !b.market) ? 'pause-all' : null,
    list.some(b => b.id.toLowerCase() === 'drawdown' && b.state.toLowerCase() === 'paused') ? 'drawdown pause' : null,
    list.some(is('equityfloor')) ? 'equity floor' : null,
    list.some(b => is('feedstale')(b) && (b.market === undefined || b.market === market.id)) ? 'feed stale' : null,
  ].filter((x): x is string => x !== null);
  const gateClosed = market.paused || ownPause || heldBy.length > 0;
  const label = !market.enabled ? 'Disabled'
    : ownPause ? (heldBy.length ? `Paused (manual) · also ${heldBy.join(', ')}` : 'Paused (manual)')
      : heldBy.length ? `Held by ${heldBy.join(', ')}`
        : market.paused ? 'Paused' : 'Quoting';
  return { ownPause, heldBy, gateClosed, action: ownPause ? 'resume' : 'pause', label, fromBreakers };
}

export function marketPlan(market: MarketState, action: 'pause' | 'resume', breakers?: readonly Breaker[]): ActionPlan {
  const name = marketLabel(market.id);
  if (breakers === undefined) {
    // No breaker list: the quoting gate is the only signal (kept for callers without an overview).
    const label = (paused: boolean) => (paused ? 'Paused' : 'Quoting');
    return action === 'pause'
      ? plan('market-pause', `Pause ${name}`, 'Stops new quotes for this market; open legs still settle.', [change('paused', `${name} quoting`, label(market.paused), 'Paused')], null, market.paused ? ['This market is already paused.'] : [], meta => writes.pauseMarket(market.id, meta))
      : plan('market-resume', `Resume ${name}`, 'Resumes quoting if no other breaker holds the market.', [change('paused', `${name} quoting`, label(market.paused), 'Quoting')], null, market.paused ? [] : ['This market is not paused.'], meta => writes.resumeMarket(market.id, meta));
  }
  const state = marketControl(market, breakers);
  const onOff = (on: boolean) => (on ? 'On' : 'Off');
  const others = state.heldBy.length ? state.heldBy.join(', ') : null;
  const warnings: string[] = [];
  if (action === 'pause') {
    if (state.ownPause) warnings.push('This market is already paused by its own manual breaker.');
    if (others) warnings.push(`Quoting is already stopped by ${others}; this per-market pause stays on after that clears, until an admin resumes ${name}.`);
    return plan('market-pause', `Pause ${name}`, 'Stops new quotes for this market (its own manual breaker); open legs still settle.',
      [change('ownPause', `${name} manual pause`, onOff(state.ownPause), 'On'), change('quoting', `${name} quoting`, state.gateClosed ? 'Stopped' : 'Quoting', 'Stopped')], null, warnings, meta => writes.pauseMarket(market.id, meta));
  }
  if (!state.ownPause) warnings.push(`${name} has no manual pause of its own: the server will answer NOT_PAUSED.${others ? ` It is held by ${others}.` : ''}`);
  else if (others) warnings.push(`Quoting stays stopped while ${others} holds${state.heldBy.includes('pause-all') || state.heldBy.includes('drawdown pause') ? ' (Resume all… clears pause-all and drawdown)' : ''}.`);
  return plan('market-resume', `Resume ${name}`, 'Clears this market’s own manual pause; quoting restarts only if no other breaker holds it.',
    [change('ownPause', `${name} manual pause`, onOff(state.ownPause), 'Off'), change('quoting', `${name} quoting`, state.gateClosed ? 'Stopped' : 'Quoting', others ? `Stopped (${others})` : 'Quoting')], null, warnings, meta => writes.resumeMarket(market.id, meta));
}

export function pauseAllPlan(markets: readonly MarketState[]): ActionPlan {
  const quoting = markets.filter(m => !m.paused).map(m => m.id);
  return plan('pause-all', 'Pause all markets', 'Global manual breaker: no market quotes until an admin resumes. Open legs still settle.',
    [change('global', 'Quoting markets', quoting.length ? quoting.join(', ') : 'none', 'none')], CONFIRM_NAMES.pauseAll, ['Players cannot place any bet until resume-all.'], meta => writes.pauseAll(meta));
}

export function resumeAllPlan(markets: readonly MarketState[]): ActionPlan {
  const paused = markets.filter(m => m.paused).map(m => m.id);
  return plan('resume-all', 'Resume all markets', 'Clears the global manual pause. Feed, drawdown and equity breakers still apply.',
    [change('global', 'Paused markets', paused.length ? paused.join(', ') : 'none', 'none (subject to other breakers)')], null, [], meta => writes.resumeAll(meta));
}

export function refitPlan(tables: readonly { readonly market: string; readonly tableId: string }[]): ActionPlan {
  return plan('refit', 'Refit tables now', 'Builds new tables from the trailing recorded path. Issued quotes never change.',
    tables.map(t => change(t.market, `${t.market} table`, t.tableId, 'new table on completion')), null, ['Refit runs in the background; progress streams below.'], meta => writes.refit(meta));
}

export function playerPlan(player: PlayerRow, action: PlayerAction): ActionPlan {
  const titles: Record<PlayerAction, string> = { flag: 'Flag player', unflag: 'Remove flag', block: 'Block player', unblock: 'Unblock player' };
  const id = `player-${action}` as ActionId;
  const flagChange = action === 'flag' || action === 'unflag';
  const before = flagChange ? (player.flagged ? 'Flagged' : 'Not flagged') : (player.blocked ? 'Blocked' : 'Active');
  const after = action === 'flag' ? 'Flagged' : action === 'unflag' ? 'Not flagged' : action === 'block' ? 'Blocked' : 'Active';
  const warnings: string[] = [];
  if (action === 'block') warnings.push('Blocked players cannot place new bets; open legs still settle and balances stay withdrawable.');
  if (action === 'flag') warnings.push('Flagged accounts may pay the per-account flow surcharge.');
  return plan(id, titles[action], player.account, [change(flagChange ? 'flagged' : 'blocked', flagChange ? 'Toxicity flag' : 'Betting', before, after)], null, warnings, meta => writes.player(player.account, action, meta));
}

function amountOrErrors(text: string): { ok: true; centi: bigint } | { ok: false; errors: Record<string, string> } {
  const parsed = parseOpenAmount(text);
  return parsed.ok ? parsed : { ok: false, errors: { amount: OPEN_AMOUNT_MESSAGES[parsed.reason] } };
}

export function fundPlan(chain: ChainState, amountText: string): PlanResult {
  const amount = amountOrErrors(amountText);
  if (!amount.ok) return amount;
  const balance = parseCenti(chain.operator.tokenCenti) ?? 0n;
  if (amount.centi > balance) return { ok: false, errors: { amount: `Exceeds the operator's ${formatOpen(balance)} balance.` } };
  const funded = parseCenti(chain.vault.houseFundedCenti) ?? 0n;
  const centi: Centi = amount.centi.toString();
  return { ok: true, plan: plan('treasury-fund', 'Fund the house', 'Operator → vault fundHouse(amount), an on-chain transaction.', [
    change('houseFunded', 'Vault house funded', formatOpen(funded), formatOpen(funded + amount.centi)),
    change('operatorToken', 'Operator tOPEN', formatOpen(balance), formatOpen(balance - amount.centi)),
  ], null, ['On-chain: the transaction cannot be reversed once mined.'], meta => writes.fundHouse(centi, meta)) };
}

export function attestationAgeMs(chain: ChainState, nowMs: number): number | null {
  return chain.lastAttestation ? Math.max(0, nowMs - chain.lastAttestation.asOfMs) : null;
}

/**
 * Most the house can withdraw now by the vault's own rules: `houseWithdrawable` (surplus less the SPEC-11
 * obligations buffer, within the daily house cap) when the server reports it, else the SPEC §5 surplus.
 */
export function houseWithdrawableCenti(chain: ChainState): bigint {
  const surplus = parseCenti(chain.vault.surplusCenti) ?? 0n;
  const withdrawable = parseCenti(chain.vault.houseWithdrawableCenti);
  return withdrawable !== null && withdrawable < surplus ? withdrawable : surplus;
}

/**
 * The server attests immediately before withdrawHouse (house-server treasury rule), so a stale or
 * missing attestation does not block the request; it adds an attest transaction first.
 */
export function withdrawSurplusPlan(chain: ChainState, amountText: string, nowMs: number): PlanResult {
  const amount = amountOrErrors(amountText);
  if (!amount.ok) return amount;
  if (chain.vault.escape?.mode) return { ok: false, errors: { amount: 'The vault is in escape mode: house withdrawals are stopped for good.' } };
  const surplus = parseCenti(chain.vault.surplusCenti) ?? 0n;
  if (amount.centi > surplus) return { ok: false, errors: { amount: `Exceeds the attested surplus of ${formatOpen(surplus)}.` } };
  const limit = houseWithdrawableCenti(chain);
  if (amount.centi > limit) return { ok: false, errors: { amount: `Exceeds what the vault lets the house withdraw now (${formatOpen(limit)}): a ${formatBps(chain.vault.houseBufferBps)} buffer on obligations stays and the daily house cap applies.` } };
  const age = attestationAgeMs(chain, nowMs);
  const maxAge = (chain.vault.maxAttestationAgeSec ?? 600) * 1000;
  const warnings = ['On-chain: moves tOPEN out of the vault.', 'The server first submits a fresh attestation (its own transaction), then withdrawHouse; the vault re-checks surplus, buffer and daily cap.'];
  if (age === null || age > maxAge) warnings.push(`The last attestation is ${age === null ? 'missing' : 'older than the vault allows'}; the pre-withdrawal attestation replaces it.`);
  const centi: Centi = amount.centi.toString();
  const changes = [change('surplus', 'Vault surplus', formatOpen(surplus), formatOpen(surplus - amount.centi))];
  if (chain.vault.houseWithdrawableCenti !== undefined) changes.push(change('withdrawable', 'House withdrawable now', formatOpen(limit), formatOpen(limit - amount.centi)));
  changes.push(change('operatorToken', 'Operator tOPEN', formatOpen(chain.operator.tokenCenti), formatOpen((parseCenti(chain.operator.tokenCenti) ?? 0n) + amount.centi)));
  return { ok: true, plan: plan('withdraw-surplus', 'Withdraw house surplus', 'Vault withdrawHouse(amount) to the operator. Player liabilities are never withdrawable.', changes, CONFIRM_NAMES.withdrawSurplus, warnings, meta => writes.withdrawSurplus(centi, meta)) };
}

function formatBps(bps: number | undefined): string {
  return bps === undefined ? 'buffer' : `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)} %`;
}

const ZERO_ADDRESS = /^0x0{40}$/i;
const sameAddress = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** SPEC-11: propose a timelocked ledger-signer rotation (confirm "signer-propose"). */
export function signerProposePlan(chain: ChainState, addressText: string, operator: string | undefined): PlanResult {
  const address = addressText.trim();
  if (!isEvmAddress(address)) return { ok: false, errors: { address: 'Enter a 0x address (40 hex digits).' } };
  if (ZERO_ADDRESS.test(address)) return { ok: false, errors: { address: 'The signer cannot be the zero address.' } };
  if (sameAddress(address, operator)) return { ok: false, errors: { address: 'The ledger signer must differ from the vault owner (the operator).' } };
  if (sameAddress(address, chain.vault.ledgerSigner)) return { ok: false, errors: { address: 'This address is already the ledger signer.' } };
  if (chain.vault.escape?.mode) return { ok: false, errors: { address: 'The vault is in escape mode; the signer no longer matters.' } };
  const delay = chain.vault.signerChangeDelaySec;
  const pending = chain.vault.pendingSigner;
  const warnings = [
    `The rotation can be accepted ${delay === undefined ? 'after the signer-change delay' : `${formatAge(delay * 1000)} after it is mined`}; until then the current signer keeps signing.`,
    'Accepting later invalidates every outstanding voucher, and this server fails closed (SIGNER_MISMATCH) until it restarts with the new key.',
  ];
  if (pending) warnings.unshift(`Replaces the pending proposal for ${shortAddress(pending.address)} and restarts the clock.`);
  return { ok: true, plan: plan('signer-propose', 'Propose a new ledger signer', 'Vault proposeLedgerSigner(address), an on-chain transaction from the operator.', [
    change('pendingSigner', 'Pending signer', pending ? pending.address : 'none', address.toLowerCase()),
    change('ledgerSigner', 'Ledger signer (unchanged until accepted)', chain.vault.ledgerSigner ?? 'not reported', chain.vault.ledgerSigner ?? 'not reported', chain.vault.ledgerSigner !== undefined),
  ], CONFIRM_NAMES.signerPropose, warnings, meta => writes.signerPropose(address.toLowerCase(), meta)) };
}

/** SPEC-11: accept the pending rotation once due (confirm "signer-accept"). The vault checks the eta against chain time. */
export function signerAcceptPlan(chain: ChainState): PlanResult {
  const pending = chain.vault.pendingSigner;
  if (!pending) return { ok: false, errors: { _form: 'No ledger-signer rotation is pending.' } };
  if (!pending.due) return { ok: false, errors: { _form: 'The rotation is not due yet: the vault would revert with TimelockNotElapsed.' } };
  const vouchers = chain.pendingVouchers.count;
  const warnings = [
    `${formatInt(vouchers)} outstanding voucher${vouchers === 1 ? '' : 's'} become${vouchers === 1 ? 's' : ''} unredeemable; the amounts return to balances once they expire.`,
    'Unless this server already holds the new key, vouchers and attestations fail with SIGNER_MISMATCH until it restarts with that key.',
  ];
  return { ok: true, plan: plan('signer-accept', 'Accept the ledger-signer rotation', 'Vault acceptLedgerSigner(), an on-chain transaction from the operator.', [
    change('ledgerSigner', 'Ledger signer', chain.vault.ledgerSigner ?? 'not reported', pending.address, chain.vault.ledgerSigner !== undefined),
    change('pendingSigner', 'Pending signer', pending.address, 'none'),
  ], CONFIRM_NAMES.signerAccept, warnings, meta => writes.signerAccept(meta)) };
}

/** SPEC-11: cancel the pending rotation (reduces risk, so a reason is enough). */
export function signerCancelPlan(chain: ChainState): PlanResult {
  const pending = chain.vault.pendingSigner;
  if (!pending) return { ok: false, errors: { _form: 'No ledger-signer rotation is pending.' } };
  return { ok: true, plan: plan('signer-cancel', 'Cancel the signer rotation', 'Vault cancelLedgerSigner(), an on-chain transaction from the operator.', [
    change('pendingSigner', 'Pending signer', pending.address, 'none'),
  ], null, [], meta => writes.signerCancel(meta)) };
}

/** SPEC-11: move tokens held above accounted assets to `to` (confirm "sweep-excess"). Accounted assets never move. */
export function sweepExcessPlan(chain: ChainState, toText: string): PlanResult {
  const to = toText.trim();
  if (!isEvmAddress(to)) return { ok: false, errors: { to: 'Enter a 0x recipient address (40 hex digits).' } };
  if (ZERO_ADDRESS.test(to)) return { ok: false, errors: { to: 'The recipient cannot be the zero address.' } };
  if (sameAddress(to, chain.vault.address)) return { ok: false, errors: { to: 'The recipient cannot be the vault itself.' } };
  const excess = chain.vault.excessWei === undefined ? null : BigInt(chain.vault.excessWei);
  if (excess === null) return { ok: false, errors: { to: 'The server does not report the vault excess; refresh and try again.' } };
  if (excess === 0n) return { ok: false, errors: { to: 'Nothing to sweep: the vault holds no tokens above its accounted assets.' } };
  return { ok: true, plan: plan('sweep-excess', 'Sweep excess tokens', 'Vault sweepExcess(to): only balanceOf(vault) − assets moves; player and house accounting are untouched.', [
    change('excess', 'Vault excess', formatWeiOpen(excess), formatWeiOpen(0n)),
    change('to', 'Recipient', '—', to.toLowerCase()),
  ], CONFIRM_NAMES.sweepExcess, ['On-chain: the transfer cannot be reversed once mined.', 'Only tokens sent to the vault outside deposit()/fundHouse() are swept.'], meta => writes.sweepExcess(to.toLowerCase(), meta)) };
}

export function attestPlan(chain: ChainState): ActionPlan {
  const seq = chain.lastAttestation?.seq;
  return plan('attest', 'Attest liabilities now', 'Signs and submits attest(liabilities, ledgerRoot, asOf, seq) from the ledger signer.',
    [change('seq', 'Attestation sequence', seq === undefined ? 'none' : String(seq), seq === undefined ? '1' : String(seq + 1))], null, [], meta => writes.attest(meta));
}

export function vaultPlan(chain: ChainState, action: 'pause' | 'unpause'): ActionPlan {
  const state = (paused: boolean) => (paused ? 'Paused' : 'Open');
  return action === 'pause'
    ? plan('vault-pause', 'Pause the vault', 'Blocks on-chain withdrawals for every player until unpaused.', [change('paused', 'Vault', state(chain.vault.paused), 'Paused')], CONFIRM_NAMES.vaultPause, ['Players cannot withdraw while the vault is paused.'], meta => writes.vaultPause(meta))
    : plan('vault-unpause', 'Unpause the vault', 'Re-enables on-chain withdrawals.', [change('paused', 'Vault', state(chain.vault.paused), 'Open')], null, [], meta => writes.vaultUnpause(meta));
}

export type SubmissionResult =
  | { readonly ok: true; readonly request: WriteRequest }
  | { readonly ok: false; readonly errors: { readonly reason?: string; readonly confirm?: string } };

/** Gate a submission: reason length, and the exact typed action name for dangerous plans. */
export function prepareSubmission(actionPlan: ActionPlan, reason: string, typedConfirm: string): SubmissionResult {
  const errors: { reason?: string; confirm?: string } = {};
  const trimmed = reason.trim();
  if (trimmed.length < REASON_MIN) errors.reason = `Give a reason of at least ${REASON_MIN} characters; it is journaled with this action.`;
  else if (trimmed.length > REASON_MAX) errors.reason = `Keep the reason under ${REASON_MAX} characters.`;
  if (actionPlan.confirmName !== null && typedConfirm.trim() !== actionPlan.confirmName) errors.confirm = `Type ${actionPlan.confirmName} exactly to confirm.`;
  if (errors.reason || errors.confirm) return { ok: false, errors };
  const meta: WriteMeta = actionPlan.confirmName === null ? { reason: trimmed } : { reason: trimmed, confirm: actionPlan.confirmName };
  return { ok: true, request: actionPlan.build(meta) };
}
