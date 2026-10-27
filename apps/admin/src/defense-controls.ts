/**
 * Pure logic behind the SPEC-10 defenses controls: field specs (the server's validated ranges),
 * before → after diffs on the nested config, cross-field rules, and the confirmation class the server
 * enforces on PUT /admin-api/defenses:
 *   - switching any defense off           → confirm "defenses-disable" (it also covers the edge move it causes);
 *   - moving an edge on new quotes > 2 pts → confirm "edge-change" (controller effective adjustment per range,
 *     or the flow surcharge charged to flagged accounts).
 * The UI renders what these functions return; the rules are unit-tested here.
 */
import { writes } from './api.js';
import { buildPatch, change, CONFIRM_NAMES, displayField, EDGE_DANGER_DELTA, parseField, plan, type Change, type Draft, type FieldSpec, type FieldValue, type PlanResult } from './controls.js';
import { formatPct, formatPts } from './format.js';
import type { ControllerRangeView, DefenseConfig, DefensePatch, DefensesView } from './types.js';

export const DEFENSE_TOGGLES = Object.freeze(['hold', 'quoteValidity', 'ramp', 'toxicity', 'controller', 'reference'] as const);
export type DefenseToggle = (typeof DEFENSE_TOGGLES)[number];

export const DEFENSE_TITLES: Readonly<Record<DefenseToggle, string>> = Object.freeze({
  hold: 'Acceptance hold', quoteValidity: 'Quote validity', ramp: 'New-account ramp', toxicity: 'Graduated toxicity', controller: 'Adaptive edge controller', reference: 'Reference-feed invalidation',
});

export interface DefenseSection {
  readonly id: string;
  readonly title: string;
  readonly sub: string;
  readonly fields: readonly FieldSpec[];
}

/** Field keys are dotted paths into DefenseConfig (e.g. "hold.tolRel"); bounds are the server's validateDefenses ranges. */
export const DEFENSE_SECTIONS: readonly DefenseSection[] = Object.freeze([
  {
    id: 'hold', title: 'Acceptance hold', sub: 'Bets are answered pending and decided at the next first-seen sample: the fair value is re-checked with a symmetric tolerance and the bet is accepted at the original quote.',
    fields: [
      { key: 'hold.enabled', label: 'Acceptance hold', kind: 'boolean', help: 'The one defense that matters on its own (SPEC-10 ablation). Turning it off needs typed confirmation.' },
      { key: 'hold.maxHoldMs', label: 'Longest hold', kind: 'integer', unit: 'ms', min: 250, max: 5000, help: 'Longest wait for the next first-seen sample. Range 250–5000 ms.' },
      { key: 'hold.onTimeout', label: 'No fresh sample in time', kind: 'enum', options: ['reject', 'accept'], help: 'reject fails closed; accept takes the bet at the original quote.' },
      { key: 'hold.tolScale', label: 'Tolerance scale', kind: 'enum', options: ['logit', 'relative'], help: 'logit binds as often up as down near p = 0 or 1; relative only binds one way there.' },
      { key: 'hold.tolRel', label: 'Tolerance width', kind: 'decimal', min: 0, max: 5, help: 'Log-odds width (logit) or relative band (relative). Range 0–5.' },
      { key: 'hold.tolAbs', label: 'Absolute floor', kind: 'decimal', min: 0, max: 0.2, help: 'Relative scale only: smallest band in probability. Range 0–0.2.' },
      { key: 'hold.flaggedTolRel', label: 'Flagged-account tolerance', kind: 'decimal', min: 0, max: 5, help: 'Tighter tolerance for accounts the toxicity monitor flagged. Range 0–5.' },
      { key: 'hold.newAccountHolds', label: 'Trust ramp holds', kind: 'integer', min: 0, max: 10_000, help: 'Holds an account makes at the tight tolerance first (0 disables the trust ramp).' },
      { key: 'hold.newAccountTolRel', label: 'Trust ramp tolerance', kind: 'decimal', min: 0, max: 5, help: 'Tolerance during the trust ramp and while latency evidence is high. Range 0–5.' },
      { key: 'hold.newAccountMaxZ', label: 'Trust ramp max latency z', kind: 'decimal', signed: true, unit: 'σ', min: -10, max: 100, help: 'An account stays on the tight tolerance while its latency evidence exceeds this. Range −10–100.' },
    ],
  },
  {
    id: 'quotes', title: 'Quote validity and lead time', sub: 'A quote stands until the next sample plus the grace period, capped by the longest life. Squares closer than the minimum lead are not offered.',
    fields: [
      { key: 'quoteValidity.enabled', label: 'Quote validity', kind: 'boolean', help: 'Off restores the Stage A fixed 1.8 s quote life.' },
      { key: 'quoteValidity.graceMs', label: 'Grace after a newer sample', kind: 'integer', unit: 'ms', min: 0, max: 2000, help: 'A quote stays acceptable this long after a newer first-seen sample. Range 0–2000 ms.' },
      { key: 'quoteValidity.maxTtlMs', label: 'Longest quote life', kind: 'integer', unit: 'ms', min: 500, max: 10_000, help: 'Upper bound when no newer sample arrives. Range 500–10000 ms.' },
      { key: 'minLeadS', label: 'Minimum lead', kind: 'integer', unit: 's', min: 3, max: 10, help: 'Seconds between the quote instant and a square’s start. Range 3–10 s.' },
    ],
  },
  {
    id: 'ramp', title: 'New-account liability ramp', sub: 'An account’s liability limit starts small and grows with settled history, up to the per-account limit.',
    fields: [
      { key: 'ramp.enabled', label: 'Liability ramp', kind: 'boolean', help: 'Off gives every account the full per-account limit from its first bet.' },
      { key: 'ramp.startCenti', label: 'Starting limit', kind: 'open', help: 'Liability limit with no settled history, in OPEN.' },
      { key: 'ramp.perSettledBetCenti', label: 'Added per settled bet', kind: 'open', allowZero: true, help: 'Added for each won or lost bet, in OPEN (0 allowed).' },
      { key: 'ramp.handleFraction', label: 'Added per OPEN of handle', kind: 'decimal', min: 0, max: 10, help: 'Share of settled handle added to the limit. Range 0–10.' },
    ],
  },
  {
    id: 'toxicity', title: 'Graduated toxicity', sub: 'Surcharge first, then block. Outcome evidence (excess return) and latency evidence from holds, both in standard errors.',
    fields: [
      { key: 'toxicity.enabled', label: 'Graduated response', kind: 'boolean', help: 'Off falls back to the Stage A monitor (flag only, no surcharge or automatic block).' },
      { key: 'toxicity.surchargeEdge', label: 'Surcharge edge', kind: 'percent', min: 0, max: 0.25, help: 'Extra edge on quotes to flagged accounts. Range 0–25 %; a move over 2 pts needs typed confirmation.' },
      { key: 'toxicity.surchargeZ', label: 'Surcharge at excess-return z', kind: 'decimal', unit: 'σ', min: 1, max: 20, help: 'Flag and surcharge above this. Range 1–20.' },
      { key: 'toxicity.blockZ', label: 'Block at excess-return z', kind: 'decimal', unit: 'σ', min: 1, max: 50, help: 'At least the surcharge z. Up to 50.' },
      { key: 'toxicity.unflagZ', label: 'Unflag below z', kind: 'decimal', signed: true, unit: 'σ', min: -10, max: 19.5, help: 'At most the surcharge z − 0.5.' },
      { key: 'toxicity.minBets', label: 'Minimum settled bets', kind: 'integer', min: 5, max: 100_000, help: 'Never act on fewer settled bets. At least 5.' },
      { key: 'toxicity.minWins', label: 'Minimum wins', kind: 'integer', min: 0, max: 10_000, help: 'Never act on fewer wins.' },
      { key: 'toxicity.blockMinBets', label: 'Block needs settled bets', kind: 'integer', min: 5, max: 1_000_000, help: 'At least the minimum settled bets.' },
      { key: 'toxicity.holdZ', label: 'Flag at latency z', kind: 'decimal', unit: 'σ', min: 1, max: 50, help: 'Latency evidence above which an account is flagged. Range 1–50.' },
      { key: 'toxicity.holdMinN', label: 'Latency flag needs holds', kind: 'integer', min: 5, max: 100_000, help: 'Holds before latency evidence can flag. At least 5.' },
      { key: 'toxicity.holdBlockZ', label: 'Block at latency z', kind: 'decimal', unit: 'σ', min: 1, max: 100, help: 'At least the latency flag z. Up to 100.' },
      { key: 'toxicity.holdBlockMinN', label: 'Latency block needs holds', kind: 'integer', min: 5, max: 1_000_000, help: 'At least the latency flag holds.' },
    ],
  },
  {
    id: 'controller', title: 'Adaptive edge controller', sub: 'Nudges the edge per multiplier range toward the policy RTP, learning only from clean flow. Run it only with the hold and graduated toxicity on.',
    fields: [
      { key: 'controller.enabled', label: 'Adaptive edge', kind: 'boolean', help: 'Off zeroes every automatic adjustment (pinned overrides still apply).' },
      { key: 'controller.windowMs', label: 'Learning window', kind: 'minutes', min: 600_000, max: 604_800_000, help: 'Rolling window of settled clean flow, in minutes (10 min – 7 d).' },
      { key: 'controller.evalEveryMs', label: 'Evaluate every', kind: 'minutes', min: 60_000, max: 86_400_000, help: 'Minutes between evaluations (1 min – 1 d).' },
      { key: 'controller.minBets', label: 'Minimum bets per range', kind: 'integer', min: 1, max: 10_000_000, help: 'Settled bets in the window before a range may move.' },
      { key: 'controller.zGate', label: 'Hysteresis z', kind: 'decimal', min: 0, max: 10, help: 'Move only when the gap exceeds z standard errors. Range 0–10.' },
      { key: 'controller.deadband', label: 'Deadband', kind: 'percent', decimals: 2, min: 0, max: 0.2, help: 'Move only when the gap exceeds this. Range 0–20 %.' },
      { key: 'controller.maxStepPerEval', label: 'Largest step per evaluation', kind: 'percent', min: 0, max: 0.05, help: 'Range 0–5 pts.' },
      { key: 'controller.maxStepPerHour', label: 'Largest move per hour', kind: 'percent', min: 0, max: 0.2, help: 'At least the step per evaluation; at most 20 pts.' },
      { key: 'controller.minAdjust', label: 'Lowest adjustment', kind: 'percent', signed: true, min: -0.1, max: 0, help: 'Range −10–0 pts.' },
      { key: 'controller.maxAdjust', label: 'Highest adjustment', kind: 'percent', min: 0, max: 0.2, help: 'Range 0–20 pts.' },
      { key: 'controller.cleanHoldZ', label: 'Clean-flow latency z', kind: 'decimal', unit: 'σ', min: 0, max: 100, help: 'Flow counts as clean only from accounts at or below this latency evidence.' },
    ],
  },
  {
    id: 'reference', title: 'Reference-feed invalidation', sub: 'Live mode only: a sub-second reference (Pyth Hermes) retires a market’s quotes early when it moves beyond moveSigma·σ·√Δt.',
    fields: [
      { key: 'reference.enabled', label: 'Reference invalidation', kind: 'boolean', help: 'Has no effect while the server runs without a reference feed (replay).' },
      { key: 'reference.moveSigma', label: 'Move threshold', kind: 'decimal', unit: 'σ', min: 0.5, max: 50, help: 'Range 0.5–50.' },
    ],
  },
] satisfies DefenseSection[]);

/** DefenseConfig → { "hold.tolRel": 1.3, …, "minLeadS": 4 } (overrides are handled separately). */
export function flattenDefenses(config: DefenseConfig): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = { minLeadS: config.minLeadS };
  for (const section of ['hold', 'quoteValidity', 'ramp', 'toxicity', 'controller', 'reference'] as const) {
    for (const [key, value] of Object.entries(config[section])) if (key !== 'overrides') out[`${section}.${key}`] = value;
  }
  return out;
}

/** Dotted patch → nested DefensePatch. */
export function nestPatch(flat: Readonly<Record<string, FieldValue>>): DefensePatch {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) {
    const [section, field] = path.split('.');
    if (field === undefined) { out[section!] = value; continue; }
    const target = (out[section!] ?? {}) as Record<string, unknown>;
    target[field] = value;
    out[section!] = target;
  }
  return out as DefensePatch;
}

/** Apply a DefensePatch to a config exactly as the server merges it (one level deep; null removes an override). */
export function mergeDefenses(config: DefenseConfig, patch: DefensePatch): DefenseConfig {
  const overrides: Record<string, number> = { ...config.controller.overrides };
  for (const [key, value] of Object.entries(patch.controller?.overrides ?? {})) { if (value === null) delete overrides[key]; else overrides[key] = value; }
  const { overrides: _ignored, ...controllerPatch } = patch.controller ?? {};
  return {
    hold: { ...config.hold, ...patch.hold }, quoteValidity: { ...config.quoteValidity, ...patch.quoteValidity }, minLeadS: patch.minLeadS ?? config.minLeadS,
    ramp: { ...config.ramp, ...patch.ramp }, toxicity: { ...config.toxicity, ...patch.toxicity },
    controller: { ...config.controller, ...controllerPatch, overrides }, reference: { ...config.reference, ...patch.reference },
  };
}

/** The server's cross-field rules (validateDefenses) on the merged config; null when they hold. */
export function validateDefenseRelations(c: DefenseConfig): string | null {
  const t = c.toxicity; const k = c.controller;
  if (t.blockZ < t.surchargeZ) return 'Block z must be at least the surcharge z.';
  if (t.blockMinBets < t.minBets) return 'Block needs at least as many settled bets as the minimum.';
  if (t.unflagZ > t.surchargeZ - 0.5 + 1e-12) return 'Unflag z must be at most the surcharge z − 0.5.';
  if (t.holdBlockMinN < t.holdMinN) return 'The latency block needs at least as many holds as the latency flag.';
  if (t.holdBlockZ < t.holdZ) return 'The latency block z must be at least the latency flag z.';
  if (k.maxStepPerHour < k.maxStepPerEval - 1e-12) return 'The hourly move must be at least the step per evaluation.';
  return null;
}

/**
 * Effective adjustment per range for a config (SPEC-10 `EdgeController.effective`): the override wins,
 * else the learned adjustment while the controller is enabled, else 0.
 */
export function effectiveAdjustments(config: DefenseConfig, ranges: readonly ControllerRangeView[]): Readonly<Record<string, number>> {
  const learned = new Map(ranges.map(r => [r.key, r.adjust]));
  const out: Record<string, number> = {};
  for (const key of new Set([...learned.keys(), ...Object.keys(config.controller.overrides)])) {
    out[key] = config.controller.overrides[key] ?? (config.controller.enabled ? learned.get(key) ?? 0 : 0);
  }
  return out;
}

export interface DefenseChangeClass {
  /** Defenses the change switches off. */
  readonly disabled: readonly DefenseToggle[];
  /** Largest move of an edge charged on new quotes (fraction). */
  readonly edgeMove: number;
  readonly confirmName: string | null;
}

/**
 * Mirror of the server's classification. `margin` widens the edge test to cover controller nudges
 * made after the view was read (sending a confirm the server does not need is harmless; missing one is refused).
 */
export function classifyDefenseChange(before: DefenseConfig, after: DefenseConfig, ranges: readonly ControllerRangeView[], margin = 0): DefenseChangeClass {
  const disabled = DEFENSE_TOGGLES.filter(name => before[name].enabled && !after[name].enabled);
  const effBefore = effectiveAdjustments(before, ranges); const effAfter = effectiveAdjustments(after, ranges);
  let edgeMove = 0;
  for (const key of new Set([...Object.keys(effBefore), ...Object.keys(effAfter)])) edgeMove = Math.max(edgeMove, Math.abs((effAfter[key] ?? 0) - (effBefore[key] ?? 0)));
  const surcharge = (c: DefenseConfig) => (c.toxicity.enabled ? c.toxicity.surchargeEdge : 0);
  edgeMove = Math.max(edgeMove, Math.abs(surcharge(after) - surcharge(before)));
  const confirmName = disabled.length ? CONFIRM_NAMES.defensesDisable : edgeMove > EDGE_DANGER_DELTA - margin + 1e-12 ? CONFIRM_NAMES.edgeChange : null;
  return { disabled, edgeMove, confirmName };
}

/** Nudge margin for a stale view: up to one controller step when the controller is running. */
export function staleMargin(config: DefenseConfig): number {
  return config.controller.enabled ? config.controller.maxStepPerEval : 0;
}

function safetyWarnings(before: DefenseConfig, after: DefenseConfig, cls: DefenseChangeClass): string[] {
  const warnings: string[] = [];
  if (cls.disabled.length) warnings.push(`Switches off: ${cls.disabled.map(d => DEFENSE_TITLES[d]).join(', ')}.`);
  if (cls.disabled.includes('hold')) warnings.push('Without the acceptance hold every profile lost about 3 M OPEN a day in the SPEC-10 ablation.');
  if (after.controller.enabled && (!after.hold.enabled || !after.toxicity.enabled) && (!before.controller.enabled || before.hold.enabled !== after.hold.enabled || before.toxicity.enabled !== after.toxicity.enabled)) {
    warnings.push('The adaptive edge would run without the hold or graduated toxicity: it then charges sniper profits to honest players (−3.2 to −3.5 pts RTP in the ablation).');
  }
  if (cls.confirmName === CONFIRM_NAMES.edgeChange) warnings.push(`An edge charged on new quotes moves by up to ${formatPts(cls.edgeMove)}.`);
  return warnings;
}

/** Plan a change to one defenses section (dotted field draft). */
export function defensesPlan(view: DefensesView | null, section: DefenseSection, draft: Draft): PlanResult {
  if (!view) return { ok: false, errors: { _form: 'The defenses have not loaded from the server yet; current values are unknown.' } };
  const before = view.config;
  const result = buildPatch(section.fields, flattenDefenses(before), draft);
  if (!result.ok) return result;
  const patch = nestPatch(result.patch);
  const after = mergeDefenses(before, patch);
  const relation = validateDefenseRelations(after);
  if (relation) return { ok: false, errors: { _form: relation } };
  const cls = classifyDefenseChange(before, after, view.controller.ranges, staleMargin(before));
  return { ok: true, plan: plan('defenses', `Update ${section.title.toLowerCase()}`, 'Applies to quotes and holds after the server acknowledges; journaled with your reason.', result.changes, cls.confirmName, safetyWarnings(before, after, cls), meta => writes.defenses(patch, meta)) };
}

/** Override input: blank = unchanged, "auto" = remove the pin, otherwise a signed percentage (−10 to 20 pts). */
export type OverrideParse = { readonly ok: true; readonly value: number | null } | { readonly ok: false; readonly error: string };

export const OVERRIDE_SPEC: FieldSpec = Object.freeze({ key: 'override', label: 'Override', kind: 'percent', signed: true, min: -0.1, max: 0.2, help: '' });

export function parseOverride(raw: string): OverrideParse {
  const text = raw.trim().toLowerCase();
  if (text === 'auto' || text === 'clear' || text === 'none') return { ok: true, value: null };
  const parsed = parseField(OVERRIDE_SPEC, raw);
  return parsed.ok ? { ok: true, value: parsed.value as number } : { ok: false, error: parsed.error.replace(/^Override: /, '') };
}

function adjustLabel(value: number | undefined): string { return value === undefined ? '—' : formatPct(value, 2, true); }

/** Plan pinning (or releasing) controller adjustments per multiplier range. */
export function overridesPlan(view: DefensesView | null, draft: Draft): PlanResult {
  if (!view) return { ok: false, errors: { _form: 'The defenses have not loaded from the server yet; current values are unknown.' } };
  const before = view.config;
  const errors: Record<string, string> = {};
  const overrides: Record<string, number | null> = {};
  const changes: Change[] = [];
  for (const r of view.controller.ranges) {
    const raw = draft[r.key];
    if (raw === undefined || raw.trim() === '') continue;
    const parsed = parseOverride(raw);
    if (!parsed.ok) { errors[r.key] = parsed.error; continue; }
    const current = before.controller.overrides[r.key];
    if (parsed.value === null ? current === undefined : current !== undefined && Math.abs(current - parsed.value) < 1e-12) continue;
    overrides[r.key] = parsed.value;
    const describe = (pin: number | undefined) => (pin === undefined ? `auto (${adjustLabel(before.controller.enabled ? r.adjust : 0)})` : `pinned ${adjustLabel(pin)}`);
    changes.push(change(`override.${r.key}`, `${r.key.replace('-', '–')}× adjustment`, describe(current), describe(parsed.value ?? undefined)));
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  if (!changes.length) return { ok: false, errors: { _form: 'Nothing to change: every override matches the current setting.' } };
  const patch: DefensePatch = { controller: { overrides } };
  const after = mergeDefenses(before, patch);
  const cls = classifyDefenseChange(before, after, view.controller.ranges, staleMargin(before));
  const warnings = safetyWarnings(before, after, cls);
  warnings.push('A pinned range is never moved by the controller until the pin is released (enter auto).');
  return { ok: true, plan: plan('defenses', 'Pin controller adjustments', 'Overrides apply to new quotes in that multiplier range after the server acknowledges.', changes, cls.confirmName, warnings, meta => writes.defenses(patch, meta)) };
}

/** Display a defense config value by dotted key (for "current" lines and tables). */
export function describeDefenseValue(config: DefenseConfig, key: string): string {
  const spec = DEFENSE_SECTIONS.flatMap(s => s.fields).find(f => f.key === key);
  return spec ? displayField(spec, flattenDefenses(config)[key]) : '—';
}
