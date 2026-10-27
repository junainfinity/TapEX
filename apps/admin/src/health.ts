/** Pure health classification for the health strip and breaker banners. */
import { formatInt, formatPct, marketLabel } from './format.js';
import type { Breaker, LaunchState, MarketState } from './types.js';
import type { StatusKind } from './ui/dom.js';

const INACTIVE_STATES = new Set(['ok', 'clear', 'cleared', 'closed', 'normal', 'idle', 'armed', 'resumed']);

export function isBreakerActive(breaker: Breaker): boolean {
  return !INACTIVE_STATES.has(breaker.state.toLowerCase());
}

/** SPEC §4: equity floor and global pauses stop all quoting; per-market pauses and widening are warnings. */
export function breakerSeverity(breaker: Breaker): 'critical' | 'warning' {
  const id = breaker.id.toLowerCase();
  const state = breaker.state.toLowerCase();
  if (id.includes('equity')) return 'critical';
  if (id.includes('manual')) return breaker.market ? 'warning' : 'critical';
  if (id.includes('drawdown')) return state === 'widened' ? 'warning' : 'critical';
  return 'warning';
}

export function breakerTitle(breaker: Breaker): string {
  const id = breaker.id.toLowerCase();
  const scope = breaker.market ? marketLabel(breaker.market) : 'all markets';
  if (id.includes('feed')) return `Feed stale — quoting paused for ${scope}`;
  if (id.includes('drawdown')) return breaker.state.toLowerCase() === 'widened' ? `Drawdown — edge widened +2 pts (${scope})` : `Drawdown — quoting paused for ${scope}`;
  if (id.includes('equity')) return 'Equity below floor — quoting nothing';
  if (id.includes('manual')) return `Manual pause — ${scope}`;
  return `${breaker.id} ${breaker.state} — ${scope}`;
}

/** Admin-only resume applies to drawdown and manual breakers (SPEC §4). */
export function breakerNeedsAdminResume(breaker: Breaker): boolean {
  const id = breaker.id.toLowerCase();
  return id.includes('manual') || (id.includes('drawdown') && breaker.state.toLowerCase() !== 'widened');
}

export const FEED_FRESH_MS = 3_000;
export const FEED_STALE_MS = 7_000;

export interface FeedHealth {
  readonly market: string;
  readonly ageMs: number | null;
  readonly level: StatusKind;
}

export function feedHealth(markets: readonly MarketState[], serverNowMs: number | null): FeedHealth[] {
  return markets.map(m => {
    if (serverNowMs === null || !Number.isFinite(m.lastPriceMs)) return { market: m.id, ageMs: null, level: 'neutral' as const };
    const age = Math.max(0, serverNowMs - m.lastPriceMs);
    const level: StatusKind = m.paused ? 'warning' : age > FEED_STALE_MS ? 'critical' : age > FEED_FRESH_MS ? 'warning' : 'good';
    return { market: m.id, ageMs: age, level };
  });
}

export function worst(levels: readonly StatusKind[]): StatusKind {
  const rank: Record<StatusKind, number> = { critical: 5, serious: 4, warning: 3, info: 2, good: 1, neutral: 0 };
  return levels.reduce<StatusKind>((acc, l) => (rank[l] > rank[acc] ? l : acc), 'neutral');
}

export interface LaunchProgress {
  readonly share: number;
  readonly label: string;
  readonly state: 'active' | 'ended' | 'disabled';
  readonly detail: string;
}

export function launchProgress(launch: LaunchState, registeredPlayers: number): LaunchProgress {
  const threshold = Math.max(0, launch.untilPlayers);
  const share = threshold === 0 ? 1 : Math.min(1, registeredPlayers / threshold);
  const label = `${formatInt(registeredPlayers)} / ${formatInt(threshold)} players`;
  if (!launch.enabled) return { share, label, state: 'disabled', detail: `Boost off · edge ${formatPct(launch.standardEdge, 1)}` };
  if (launch.active && registeredPlayers < threshold) {
    return { share, label, state: 'active', detail: `Edge ${formatPct(launch.edge, 1)} now · ${formatPct(launch.standardEdge, 1)} after ${formatInt(threshold - registeredPlayers)} more players` };
  }
  return { share: 1, label, state: 'ended', detail: `Boost ended · edge ${formatPct(launch.standardEdge, 1)}` };
}
