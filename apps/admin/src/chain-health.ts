/**
 * Pure classification of the SPEC-11 vault state: escape-hatch clock, attestation freshness, signer
 * rotation. Thresholds mirror the server's chain alerts (src/chain-alerts.ts): escape warning at 50 % of
 * escapeDelay since the last attestation, critical at 75 %, then available to anyone.
 */
import { formatAge, formatInt, networkLabel, shortAddress } from './format.js';
import { vaultIdentity } from './ledger-math.js';
import { formatOpen } from './money.js';
import type { ChainState, EscapeState } from './types.js';
import type { StatusKind } from './ui/dom.js';

export const ESCAPE_WARN_FRACTION = 0.5;
export const ESCAPE_CRITICAL_FRACTION = 0.75;

/**
 * Chain clock estimate. The offline vault (and the demo) run on the feed clock, which is historical in
 * replay; live chains run on wall time (the server also uses wall time for its alerts there).
 */
export function chainNowMs(network: string | undefined, demo: boolean, feedNowMs: number | null, wallNowMs = Date.now()): number {
  return (network === 'offline' || demo) && feedNowMs !== null ? feedNowMs : wallNowMs;
}

export interface EscapeHealth {
  readonly level: StatusKind;
  readonly label: string;
  /** Time since the last attestation (the escape clock), ms. */
  readonly ageMs: number;
  /** ageMs / escapeDelay, clamped to [0, 1]. */
  readonly fraction: number;
  /** Until anyone may trigger escape mode (0 once available). */
  readonly leftMs: number;
}

export function escapeHealth(escape: EscapeState, nowMs: number): EscapeHealth {
  const delayMs = Math.max(1, escape.escapeDelaySec * 1000);
  const ageMs = Math.max(0, nowMs - escape.lastAttestationAtMs);
  const leftMs = Math.max(0, escape.availableAtMs - nowMs);
  const fraction = Math.min(1, ageMs / delayMs);
  if (escape.mode) return { level: 'critical', label: 'Escape mode active (irreversible)', ageMs, fraction: 1, leftMs: 0 };
  if (escape.available || leftMs === 0) return { level: 'critical', label: 'Escape available to anyone now', ageMs, fraction: 1, leftMs: 0 };
  if (fraction >= ESCAPE_CRITICAL_FRACTION) return { level: 'critical', label: `Escape in ${formatAge(leftMs)}`, ageMs, fraction, leftMs };
  if (fraction >= ESCAPE_WARN_FRACTION) return { level: 'warning', label: `Escape in ${formatAge(leftMs)}`, ageMs, fraction, leftMs };
  return { level: 'good', label: `Escape clock healthy · ${formatAge(leftMs)} left`, ageMs, fraction, leftMs };
}

export interface AttestationHealth {
  readonly level: StatusKind;
  readonly label: string;
  readonly ageMs: number | null;
  readonly maxAgeMs: number;
}

/** Freshness against the vault's maxAttestationAge (withdrawHouse needs a fresh one; the server attests right before withdrawing). */
export function attestationHealth(chain: ChainState, nowMs: number): AttestationHealth {
  const maxAgeMs = (chain.vault.maxAttestationAgeSec ?? 600) * 1000;
  const a = chain.lastAttestation;
  if (!a) return { level: 'warning', label: chain.vault.unavailable ? 'Unknown: the vault is unreadable' : 'No attestation yet', ageMs: null, maxAgeMs };
  const ageMs = Math.max(0, nowMs - a.asOfMs);
  // Unreadable vault: this is the server journal's last attestation, not one read from the vault.
  if (chain.vault.unavailable) return { level: 'warning', label: `Unverified — the vault is unreadable; the server journal's last attestation is ${formatAge(ageMs)} old`, ageMs, maxAgeMs };
  if (ageMs > maxAgeMs) return { level: 'warning', label: `Stale — ${formatAge(ageMs)} old (vault max ${formatAge(maxAgeMs)})`, ageMs, maxAgeMs };
  if (ageMs > maxAgeMs * 0.75) return { level: 'warning', label: `Ageing — ${formatAge(ageMs)} old`, ageMs, maxAgeMs };
  return { level: 'good', label: `Fresh — ${formatAge(ageMs)} old`, ageMs, maxAgeMs };
}

export interface SignerHealth {
  readonly level: StatusKind;
  readonly label: string;
}

export function signerHealth(chain: ChainState): SignerHealth {
  const v = chain.vault;
  if (v.signerMismatch) return { level: 'critical', label: 'Signer mismatch: this server cannot sign vouchers or attest' };
  if (v.pendingSigner?.due) return { level: 'critical', label: `Rotation to ${shortAddress(v.pendingSigner.address)} is due` };
  if (v.pendingSigner) return { level: 'warning', label: `Rotation to ${shortAddress(v.pendingSigner.address)} pending` };
  if (v.ledgerSigner === undefined) return { level: 'neutral', label: 'Signer not reported' };
  return { level: 'good', label: 'Server holds the vault signer key' };
}

/** Worst level among the vault alerts the server computed (null when none). */
export function worstAlertLevel(alerts: readonly { readonly level: 'info' | 'warning' | 'critical' }[] | undefined): 'critical' | 'warning' | 'info' | null {
  if (!alerts?.length) return null;
  return alerts.some(a => a.level === 'critical') ? 'critical' : alerts.some(a => a.level === 'warning') ? 'warning' : 'info';
}

/** Overview health-strip cell for the chain. An unreadable vault is critical, never "vault open". */
export function chainSummary(chain: ChainState): { readonly level: StatusKind; readonly value: string; readonly detail: string } {
  if (chain.vault.unavailable) return { level: 'critical', value: 'Vault unreadable', detail: `${networkLabel(chain.network, chain.chainId)}: the server could not read the vault; figures are placeholders` };
  const lag = chain.indexer.lagBlocks;
  const alerts = (chain.alerts ?? []).filter(a => a.level !== 'info');
  const worstAlert = worstAlertLevel(alerts);
  const rec = chain.reconciliation;
  const level: StatusKind = worstAlert === 'critical' || chain.vault.escape?.mode || (rec && !rec.match) ? 'critical'
    : worstAlert === 'warning' || chain.vault.paused || (Number.isFinite(lag) && lag > 5) ? 'warning' : 'good';
  const detail = alerts.length ? alerts.map(a => a.code).join(', ')
    : `${chain.vault.paused ? 'vault paused' : 'vault open'} · indexer lag ${Number.isFinite(lag) ? formatInt(lag) : '—'} blk${rec ? (rec.match ? ' · reconciled' : ' · MISMATCH') : ''}`;
  return { level, value: networkLabel(chain.network, chain.chainId), detail };
}

export interface VaultBadge { readonly kind: StatusKind; readonly label: string }

/**
 * Status line above the vault figures. While the vault is unreadable the figures are placeholders, so no
 * "open" or "identity holds" status is derived from them.
 */
export function vaultBadges(chain: ChainState): readonly VaultBadge[] {
  const v = chain.vault;
  if (v.unavailable) return [{ kind: 'critical', label: 'Vault unreadable: the server could not read it, so the figures below are placeholders (not the vault state)' }];
  const badges: VaultBadge[] = [v.paused ? { kind: 'warning', label: 'Vault paused — withdrawals blocked' } : { kind: 'good', label: 'Vault open' }];
  if (v.escape?.mode) badges.push({ kind: 'critical', label: 'Escape mode' });
  const identity = vaultIdentity(chain);
  if (identity) badges.push(identity.ok ? { kind: 'good', label: 'Assets identity holds' } : { kind: 'critical', label: `Assets identity broken: expected ${formatOpen(identity.expected)}` });
  const rec = chain.reconciliation;
  if (rec) badges.push(rec.match ? { kind: 'good', label: 'Ledger reconciles to the wei' } : { kind: 'critical', label: `Reconciliation off by ${rec.deltaWei} wei` });
  return badges;
}

/** Escape-hatch card when the server sends no escape state: an unreadable vault is not an old vault. */
export function escapeMissingNotice(chain: ChainState): VaultBadge {
  return chain.vault.unavailable
    ? { kind: 'critical', label: 'Vault unreadable: the escape-hatch clock is unknown until the server can read the vault again.' }
    : { kind: 'neutral', label: 'The server does not report the escape hatch (pre-SPEC-11 vault).' };
}
