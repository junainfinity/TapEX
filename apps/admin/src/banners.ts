/**
 * The shell's banner strip, as pure data (ui/shell.ts renders it). Ranking, most urgent first:
 *
 *  -1  the console has had no overview for a while: every figure on screen is stale;
 *   0  the stream rejected the token;
 *   1  critical breakers, critical vault alerts, an unreadable vault;
 *   2  the live stream is interrupted (polling keeps the data fresh), so it is never hidden by warnings;
 *   3  warnings (per-market pauses, widened drawdown, vault warnings, hold off).
 *
 * The strip shows the top item; the rest are one click away ("+N more" expands).
 */
import { formatTime } from './format.js';
import { breakerNeedsAdminResume, breakerSeverity, breakerTitle, isBreakerActive } from './health.js';
import type { StreamState } from './sse.js';
import type { ApiErrorBody, Overview } from './types.js';

export type BannerAction = 'controls' | 'treasury' | 'defenses' | 'signin';

export interface BannerItem {
  readonly key: string;
  readonly rank: number;
  readonly severity: 'critical' | 'warning';
  readonly title: string;
  readonly detail: string;
  readonly action: BannerAction | null;
}

export interface BannerInput {
  readonly overview: Overview | null;
  readonly stream: StreamState;
  /** Wall time since the last overview arrived (null before the first). */
  readonly overviewAgeMs: number | null;
  /** Latest fallback-poll failure, if any. */
  readonly pollError: ApiErrorBody | null;
  /** The last GET /chain answer said the server could not read the vault. */
  readonly vaultUnavailable: boolean;
}

/** The server sends an overview every second and the fallback poll runs every 5 s: older than this means nothing is arriving. */
export const OVERVIEW_STALE_MS = 8_000;

export function isOverviewStale(overviewAgeMs: number | null): boolean {
  return overviewAgeMs !== null && overviewAgeMs > OVERVIEW_STALE_MS;
}

function streamDetail(input: BannerInput): string {
  const parts: string[] = [];
  if (input.pollError) parts.push(`poll: ${input.pollError.code} ${input.pollError.message}`);
  if (input.stream.status === 'reconnecting') parts.push(`stream: ${input.stream.lastError}`);
  return parts.join(' · ');
}

export function bannerItems(input: BannerInput): BannerItem[] {
  const o = input.overview;
  const s = input.stream;
  const items: BannerItem[] = [];
  const stale = isOverviewStale(input.overviewAgeMs);
  if (stale && o) {
    items.push({
      key: 'stale', rank: -1, severity: 'critical',
      // Stable text (no ticking age): the strip is a live region and must not re-announce every second.
      title: `No update from the server: every figure is stale (as of ${formatTime(o.clockMs)} UTC server clock).`,
      detail: streamDetail(input), action: null,
    });
  }
  for (const b of (o?.breakers ?? []).filter(isBreakerActive)) {
    const severity = breakerSeverity(b);
    const active = (o?.breakers ?? []).filter(isBreakerActive).length;
    items.push({
      key: `breaker:${b.id}:${b.market ?? '*'}:${b.state}:${b.since}`, rank: severity === 'critical' ? 1 : 3, severity,
      title: breakerTitle(b), detail: `${b.reason ? `${b.reason} · ` : ''}since ${formatTime(b.since)} UTC`,
      action: breakerNeedsAdminResume(b) || active > 1 ? 'controls' : null,
    });
  }
  if (input.vaultUnavailable) {
    items.push({ key: 'vault-unreadable', rank: 1, severity: 'critical', title: 'Vault unreadable', detail: 'The server could not read the vault: on-chain figures are placeholders and vault alerts cannot be computed.', action: 'treasury' });
  }
  for (const a of (o?.chainAlerts ?? []).filter(x => x.level !== 'info')) {
    const severity = a.level === 'critical' ? 'critical' : 'warning';
    items.push({ key: `vault:${a.code}:${a.level}`, rank: severity === 'critical' ? 1 : 3, severity, title: `Vault: ${a.code.replace(/_/g, ' ').toLowerCase()}`, detail: a.message, action: 'treasury' });
  }
  if (o?.defenses?.hold === false) {
    items.push({ key: 'hold-off', rank: 3, severity: 'warning', title: 'Acceptance hold is off', detail: 'Bets accept at once: latency arbitrage is only checked by the spot guard.', action: 'defenses' });
  }
  if (s.status === 'unauthorized') {
    items.push({ key: 'unauth', rank: 0, severity: 'critical', title: 'The live stream rejected the admin token.', detail: '', action: 'signin' });
  } else if (!stale && s.status === 'reconnecting' && s.attempt >= 2) {
    items.push({ key: `stream:${s.attempt}`, rank: 2, severity: 'warning', title: 'Live stream interrupted — polling every 5 s until it reconnects.', detail: streamDetail(input), action: null });
  }
  return items.sort((a, b) => a.rank - b.rank);
}
