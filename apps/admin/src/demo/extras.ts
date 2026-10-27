/**
 * `?demo` stand-ins for the SPEC-10 defenses and SPEC-11 vault hardening. Written independently of the
 * console's own rules (they mirror the house server: packages/house validateDefenses/changeDefenses,
 * engine.setDefenses, src/chain-alerts.ts) so the demo can surface a console bug instead of agreeing with it.
 */
import type { ChainAlertView, ControllerRangeView, DefenseConfig, EscapeState } from '../types.js';

export const RANGE_KEYS = ['1.01-2', '2-5', '5-10', '10-20', '20-50', '50-100'] as const;
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** House-server production defaults (DEFAULT_DEFENSES). */
export function defaultDefenses(): DefenseConfig {
  return {
    hold: { enabled: true, maxHoldMs: 1500, tolScale: 'logit', tolRel: 1.3, tolAbs: 0.002, onTimeout: 'reject', flaggedTolRel: 0.05, newAccountHolds: 10, newAccountTolRel: 0.12, newAccountMaxZ: 2 },
    quoteValidity: { enabled: true, graceMs: 500, maxTtlMs: 2500 },
    minLeadS: 4,
    ramp: { enabled: true, startCenti: '25000', perSettledBetCenti: '2500', handleFraction: 0.25 },
    toxicity: { enabled: true, minBets: 20, minWins: 5, surchargeZ: 3, surchargeEdge: 0.05, blockZ: 6, blockMinBets: 60, unflagZ: 1, holdMinN: 10, holdZ: 4, holdBlockMinN: 25, holdBlockZ: 6 },
    controller: { enabled: true, windowMs: 3 * HOUR, evalEveryMs: 15 * MINUTE, minBets: 1000, zGate: 2, deadband: 0.005, maxStepPerEval: 0.01, maxStepPerHour: 0.03, minAdjust: -0.02, maxAdjust: 0.05, cleanHoldZ: 2, overrides: {} },
    reference: { enabled: true, moveSigma: 4 },
  };
}

const PATCH_KEYS: Readonly<Record<string, readonly string[] | null>> = {
  hold: ['enabled', 'maxHoldMs', 'tolScale', 'tolRel', 'tolAbs', 'onTimeout', 'flaggedTolRel', 'newAccountHolds', 'newAccountTolRel', 'newAccountMaxZ'], quoteValidity: ['enabled', 'graceMs', 'maxTtlMs'], minLeadS: null,
  ramp: ['enabled', 'startCenti', 'perSettledBetCenti', 'handleFraction'], toxicity: ['enabled', 'minBets', 'minWins', 'surchargeZ', 'surchargeEdge', 'blockZ', 'blockMinBets', 'unflagZ', 'holdMinN', 'holdZ', 'holdBlockMinN', 'holdBlockZ'],
  controller: ['enabled', 'windowMs', 'evalEveryMs', 'minBets', 'zGate', 'deadband', 'maxStepPerEval', 'maxStepPerHour', 'minAdjust', 'maxAdjust', 'cleanHoldZ', 'overrides'], reference: ['enabled', 'moveSigma'],
};
const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const int = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi;
const bool = (v: unknown) => typeof v === 'boolean';
const centi = (v: unknown, positive: boolean) => typeof v === 'string' && /^(0|[1-9]\d{0,17})$/.test(v) && (!positive || v !== '0');

/** Server validateDefenses (first failing section named). */
function validate(c: DefenseConfig): string | null {
  const h = c.hold, v = c.quoteValidity, r = c.ramp, t = c.toxicity, k = c.controller, f = c.reference;
  if (!bool(h.enabled) || !int(h.maxHoldMs, 250, 5000) || (h.tolScale !== 'relative' && h.tolScale !== 'logit') || !num(h.tolRel, 0, 5) || !num(h.tolAbs, 0, 0.2) || (h.onTimeout !== 'reject' && h.onTimeout !== 'accept')
    || !num(h.flaggedTolRel, 0, 5) || !int(h.newAccountHolds, 0, 10_000) || !num(h.newAccountTolRel, 0, 5) || !num(h.newAccountMaxZ, -10, 100)) return 'hold: out of range';
  if (!bool(v.enabled) || !int(v.graceMs, 0, 2000) || !int(v.maxTtlMs, 500, 10_000)) return 'quoteValidity: out of range';
  if (!int(c.minLeadS, 3, 10)) return 'minLeadS must be an integer within 3–10';
  if (!bool(r.enabled) || !centi(r.startCenti, true) || !centi(r.perSettledBetCenti, false) || !num(r.handleFraction, 0, 10)) return 'ramp: out of range';
  if (!bool(t.enabled) || !int(t.minBets, 5, 100_000) || !int(t.minWins, 0, 10_000) || !num(t.surchargeZ, 1, 20) || !num(t.surchargeEdge, 0, 0.25) || !num(t.blockZ, t.surchargeZ, 50)
    || !int(t.blockMinBets, t.minBets, 1_000_000) || !num(t.unflagZ, -10, t.surchargeZ - 0.5) || !int(t.holdMinN, 5, 100_000) || !num(t.holdZ, 1, 50) || !int(t.holdBlockMinN, t.holdMinN, 1_000_000) || !num(t.holdBlockZ, t.holdZ, 100)) return 'toxicity: out of range';
  if (!bool(k.enabled) || !int(k.windowMs, 10 * MINUTE, 7 * 24 * HOUR) || !int(k.evalEveryMs, MINUTE, 24 * HOUR) || !int(k.minBets, 1, 10_000_000) || !num(k.zGate, 0, 10) || !num(k.deadband, 0, 0.2)
    || !num(k.maxStepPerEval, 0, 0.05) || !num(k.maxStepPerHour, k.maxStepPerEval, 0.2) || !num(k.minAdjust, -0.1, 0) || !num(k.maxAdjust, 0, 0.2) || !num(k.cleanHoldZ, 0, 100)) return 'controller: out of range';
  for (const [key, value] of Object.entries(k.overrides)) {
    if (!(RANGE_KEYS as readonly string[]).includes(key)) return `controller.overrides: unknown range ${key}`;
    if (!num(value, -0.1, 0.2)) return `controller.overrides.${key} must be within −0.1–0.2`;
  }
  if (!bool(f.enabled) || !num(f.moveSigma, 0.5, 50)) return 'reference: out of range';
  return null;
}

export type DefenseWrite =
  | { readonly ok: true; readonly config: DefenseConfig; readonly disabled: readonly string[] }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };

/** Server setDefenses: strict keys, merge one level deep (null removes an override), validate, confirm class. */
export function applyDefensePatch(before: DefenseConfig, body: Readonly<Record<string, unknown>>, learned: Readonly<Record<string, number>>, confirm: string | undefined): DefenseWrite {
  const sections = Object.keys(body).filter(k => k !== 'reason' && k !== 'confirm');
  if (!sections.length) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'Provide at least one defense section' };
  for (const key of sections) {
    if (!(key in PATCH_KEYS)) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: `Unknown field(s): ${key}` };
    const allowed = PATCH_KEYS[key];
    if (allowed === null || allowed === undefined) continue;
    const value = body[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: `${key} must be an object` };
    for (const field of Object.keys(value)) if (!allowed.includes(field)) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: `unknown field ${key}.${field}` };
  }
  const patch = body as Record<string, Record<string, unknown> | number>;
  const next: DefenseConfig = JSON.parse(JSON.stringify(before));
  const merge = (name: 'hold' | 'quoteValidity' | 'ramp' | 'toxicity' | 'reference') => { if (patch[name]) Object.assign(next[name], patch[name]); };
  merge('hold'); merge('quoteValidity'); merge('ramp'); merge('toxicity'); merge('reference');
  if (typeof patch['minLeadS'] === 'number') (next as { minLeadS: number }).minLeadS = patch['minLeadS'];
  const ctl = patch['controller'];
  if (ctl && typeof ctl === 'object') {
    const { overrides, ...rest } = ctl as Record<string, unknown>;
    Object.assign(next.controller, rest);
    const o = { ...next.controller.overrides } as Record<string, number>;
    for (const [key, value] of Object.entries((overrides ?? {}) as Record<string, number | null>)) { if (value === null) delete o[key]; else o[key] = value; }
    (next.controller as { overrides: Record<string, number> }).overrides = o;
  }
  const error = validate(next);
  if (error) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: error };
  if (JSON.stringify(next) === JSON.stringify(before)) return { ok: false, status: 409, code: 'NO_CHANGE', message: 'defenses already have these values' };
  const names = ['hold', 'quoteValidity', 'ramp', 'toxicity', 'controller', 'reference'] as const;
  const disabled = names.filter(n => before[n].enabled && !next[n].enabled);
  const eff = (c: DefenseConfig, key: string) => c.controller.overrides[key] ?? (c.controller.enabled ? learned[key] ?? 0 : 0);
  const surcharge = (c: DefenseConfig) => (c.toxicity.enabled ? c.toxicity.surchargeEdge : 0);
  const edgeMove = Math.max(...RANGE_KEYS.map(k => Math.abs(eff(next, k) - eff(before, k))), Math.abs(surcharge(next) - surcharge(before)));
  if (disabled.length && confirm !== 'defenses-disable') return { ok: false, status: 400, code: 'CONFIRM_REQUIRED', message: `Disabling ${disabled.join(', ')} requires confirm: "defenses-disable"` };
  if (!disabled.length && edgeMove > 0.02 + 1e-9 && confirm !== 'edge-change') return { ok: false, status: 400, code: 'CONFIRM_REQUIRED', message: 'This change moves an edge charged on new quotes by more than 2 points; it requires confirm: "edge-change"' };
  return { ok: true, config: next, disabled };
}

export interface DemoVaultHealth {
  readonly nowMs: number;
  readonly ledgerSigner: string;
  readonly serverSigner: string;
  readonly pendingSigner: { readonly address: string; readonly etaMs: number } | null;
  readonly lastAttestationAtMs: number;
  readonly escapeDelayMs: number;
  readonly maxAttestationAgeMs: number;
  readonly attestEveryMs: number;
  readonly escapeMode: boolean;
}

function span(ms: number): string {
  const s = Math.abs(ms) / 1000;
  return s >= 86_400 ? `${(s / 86_400).toFixed(1)} d` : s >= 3_600 ? `${(s / 3_600).toFixed(1)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`;
}
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Mirror of the server's chainAlerts (src/chain-alerts.ts), in ms. */
export function demoChainAlerts(v: DemoVaultHealth): ChainAlertView[] {
  const out: ChainAlertView[] = [];
  if (v.ledgerSigner.toLowerCase() !== v.serverSigner.toLowerCase()) out.push({ code: 'SIGNER_MISMATCH', level: 'critical', message: `The vault's ledger signer is ${v.ledgerSigner} but this server holds the key for ${v.serverSigner}: vouchers and attestations fail until it restarts with the new key` });
  const p = v.pendingSigner;
  if (p) {
    const due = v.nowMs >= p.etaMs;
    out.push(due
      ? { code: 'SIGNER_CHANGE_DUE', level: 'critical', atMs: p.etaMs, message: `Ledger-signer rotation to ${p.address} can be accepted now (eta ${iso(p.etaMs)}); accepting invalidates every outstanding voucher and this server's signer key` }
      : { code: 'SIGNER_CHANGE_PENDING', level: 'warning', atMs: p.etaMs, message: `Ledger-signer rotation to ${p.address} proposed; it can be accepted at ${iso(p.etaMs)} (in ${span(p.etaMs - v.nowMs)})` });
  }
  if (v.escapeMode) { out.push({ code: 'ESCAPE_MODE', level: 'critical', message: 'The vault is in escape mode (irreversible)' }); return out; }
  const age = v.nowMs - v.lastAttestationAtMs;
  const availableAt = v.lastAttestationAtMs + v.escapeDelayMs;
  if (availableAt <= v.nowMs) out.push({ code: 'ESCAPE_AVAILABLE', level: 'critical', atMs: availableAt, message: `No attestation for ${span(age)}: anyone can trigger the vault's escape mode now` });
  else if (age >= v.escapeDelayMs * 0.5) out.push({ code: 'ESCAPE_APPROACHING', level: age >= v.escapeDelayMs * 0.75 ? 'critical' : 'warning', atMs: availableAt, message: `No attestation for ${span(age)}: escape mode becomes available to anyone at ${iso(availableAt)}` });
  const staleAfter = Math.max(v.maxAttestationAgeMs, 3 * v.attestEveryMs);
  if (age > staleAfter && availableAt > v.nowMs) out.push({ code: 'ATTESTATION_STALE', level: 'warning', message: `The last attestation is ${span(age)} old (stale after ${span(staleAfter)}); house withdrawals are blocked and the escape clock is running` });
  return out;
}

export function demoEscape(v: DemoVaultHealth, poolWei: bigint, claimedWei: bigint): EscapeState {
  const availableAtMs = v.lastAttestationAtMs + v.escapeDelayMs;
  const left = availableAtMs - v.nowMs;
  return {
    mode: v.escapeMode, available: v.escapeMode || left <= 0, lastAttestationAtMs: v.lastAttestationAtMs, escapeDelaySec: v.escapeDelayMs / 1000, availableAtMs,
    secondsUntilAvailable: v.escapeMode || left <= 0 ? 0 : Math.floor(left / 1000), poolWei: poolWei.toString(), claimedWei: claimedWei.toString(),
    poolCenti: (poolWei / 10n ** 16n).toString(), claimedCenti: (claimedWei / 10n ** 16n).toString(),
  };
}

/** Deterministic 32-byte hex from a string (FNV-1a stretched): a stand-in for Merkle siblings, never verified. */
export function fakeHash(seed: string): string {
  let out = '';
  let h = 0x811c9dc5;
  for (let round = 0; out.length < 64; round++) {
    for (const ch of `${seed}:${round}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    out += h.toString(16).padStart(8, '0');
  }
  return `0x${out.slice(0, 64)}`;
}

/** Controller ranges as the server reports them (learned adjust, pins, clean-flow RTP per range). */
export function controllerView(state: readonly { key: string; adjust: number; bets: number; handle: bigint; returned: number; target: number; se: number; lastChangeMs?: number }[], config: DefenseConfig): ControllerRangeView[] {
  return state.map(s => {
    const override = config.controller.overrides[s.key];
    return {
      key: s.key, adjust: s.adjust, ...(override !== undefined ? { override } : {}), effective: override ?? (config.controller.enabled ? s.adjust : 0),
      bets: s.bets, handleCenti: s.handle.toString(), realized: s.bets > 0 ? s.returned : null, target: s.bets > 0 ? s.target : null, se: s.bets > 0 ? s.se : null, avgAdjust: s.bets > 0 ? s.adjust * 0.8 : null,
      ...(s.lastChangeMs !== undefined ? { lastChangeMs: s.lastChangeMs } : {}),
    };
  });
}
