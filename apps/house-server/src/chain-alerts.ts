import type { VaultState } from './chain-port.js';

export type ChainAlertLevel = 'info' | 'warning' | 'critical';
export interface ChainAlert {
  readonly code: string;
  readonly level: ChainAlertLevel;
  readonly message: string;
  /** Identity for change detection: a new proposal or a higher level re-alerts, an unchanged one does not. */
  readonly key: string;
  /** Chain time (s) the condition refers to (an eta or an availability time), when there is one. */
  readonly atS?: string;
}

export interface ChainAlertOptions {
  /** Chain time now (Unix seconds). */
  readonly nowS: bigint;
  /** Address of the ledger-signer key this server holds (vouchers and attestations need it to be the vault's signer). */
  readonly serverSigner?: string;
  /** The server's attestation interval (s); an attestation older than max(3 intervals, maxAttestationAge) is stale. */
  readonly attestEveryS?: bigint;
}

/** Fractions of `escapeDelay` since the last attestation at which the escape-hatch alert escalates. */
export const ESCAPE_WARN_FRACTION_BPS = 5_000n;
export const ESCAPE_CRITICAL_FRACTION_BPS = 7_500n;

function duration(seconds: bigint): string {
  const s = seconds < 0n ? -seconds : seconds;
  if (s >= 86_400n) return `${(Number(s) / 86_400).toFixed(1)} d`;
  if (s >= 3_600n) return `${(Number(s) / 3_600).toFixed(1)} h`;
  if (s >= 60n) return `${(Number(s) / 60).toFixed(0)} min`;
  return `${s} s`;
}
function iso(seconds: bigint): string { return new Date(Number(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

/**
 * Operator alerts derived from the vault state (SPEC-11): pending timelocked changes (signer rotation,
 * signer-delay decrease, house-limit loosening), a signer this server does not hold, and attestations
 * going stale towards `escapeDelay` (after which anyone can put the vault into irreversible escape mode).
 */
export function chainAlerts(vault: VaultState, options: ChainAlertOptions): ChainAlert[] {
  const out: ChainAlert[] = [];
  const now = options.nowS;
  const signer = vault.ledgerSigner.toLowerCase();
  if (options.serverSigner && signer !== options.serverSigner.toLowerCase()) {
    out.push({ code: 'SIGNER_MISMATCH', level: 'critical', key: `SIGNER_MISMATCH:${signer}`, message: `The vault's ledger signer is ${vault.ledgerSigner} but this server holds the key for ${options.serverSigner}: vouchers and attestations fail until it restarts with the new key` });
  }
  const p = vault.pendingSigner;
  if (p) {
    const due = now >= p.eta;
    out.push({
      code: due ? 'SIGNER_CHANGE_DUE' : 'SIGNER_CHANGE_PENDING', level: due ? 'critical' : 'warning', key: `SIGNER_CHANGE:${p.address.toLowerCase()}:${p.eta}:${due ? 'due' : 'pending'}`, atS: p.eta.toString(),
      message: due
        ? `Ledger-signer rotation to ${p.address} can be accepted now (eta ${iso(p.eta)}); accepting invalidates every outstanding voucher and this server's signer key`
        : `Ledger-signer rotation to ${p.address} proposed; it can be accepted at ${iso(p.eta)} (in ${duration(p.eta - now)})`,
    });
  }
  const d = vault.pendingSignerChangeDelay;
  if (d) out.push({ code: 'SIGNER_DELAY_CHANGE_PENDING', level: 'warning', key: `SIGNER_DELAY:${d.delay}:${d.eta}`, atS: d.eta.toString(), message: `Signer-change delay decrease to ${duration(d.delay)} scheduled for ${iso(d.eta)}` });
  const h = vault.pendingHouseLimits;
  if (h) out.push({ code: 'HOUSE_LIMITS_CHANGE_PENDING', level: 'warning', key: `HOUSE_LIMITS:${h.houseBufferBps}:${h.houseDailyCap}:${h.eta}`, atS: h.eta.toString(), message: `House-limit loosening (buffer ${h.houseBufferBps} bps, daily cap ${h.houseDailyCap} wei) scheduled for ${iso(h.eta)}` });
  const e = vault.escape;
  if (e.mode) {
    out.push({ code: 'ESCAPE_MODE', level: 'critical', key: 'ESCAPE:mode', message: `The vault is in escape mode (irreversible): deposits, vouchers and attestations are stopped; players claim from a pool of ${e.poolWei} wei (${e.claimedWei} claimed)` });
    return out;
  }
  const age = now - e.lastAttestationAt;
  const delay = e.escapeDelay > 0n ? e.escapeDelay : 1n;
  const left = e.availableAt - now;
  if (left <= 0n) {
    out.push({ code: 'ESCAPE_AVAILABLE', level: 'critical', key: `ESCAPE:available:${e.availableAt}`, atS: e.availableAt.toString(), message: `No attestation for ${duration(age)}: anyone can trigger the vault's escape mode now (available since ${iso(e.availableAt)})` });
  } else if (age * 10_000n >= delay * ESCAPE_WARN_FRACTION_BPS) {
    const critical = age * 10_000n >= delay * ESCAPE_CRITICAL_FRACTION_BPS;
    out.push({ code: 'ESCAPE_APPROACHING', level: critical ? 'critical' : 'warning', key: `ESCAPE:approaching:${e.availableAt}:${critical ? 'critical' : 'warning'}`, atS: e.availableAt.toString(), message: `No attestation for ${duration(age)}: escape mode becomes available to anyone at ${iso(e.availableAt)} (in ${duration(left)})` });
  }
  const staleAfter = [vault.maxAttestationAge, (options.attestEveryS ?? 0n) * 3n].reduce((a, b) => (b > a ? b : a));
  if (staleAfter > 0n && age > staleAfter && left > 0n) {
    out.push({ code: 'ATTESTATION_STALE', level: 'warning', key: `ATTESTATION_STALE:${e.lastAttestationAt}`, message: `The last attestation is ${duration(age)} old (stale after ${duration(staleAfter)}); house withdrawals are blocked and the escape clock is running` });
  }
  return out;
}
