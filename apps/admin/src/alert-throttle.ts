/**
 * Toast coalescing for SSE alerts. The toxicity monitor raises one alert per account action, which at
 * crowd scale is several per second; every alert still lands in the store (and the audit log keeps the
 * detail), but toasts show at most one per alert code per window, carrying how many were folded in.
 */
import type { Alert } from './types.js';

export interface ToastDecision {
  readonly show: boolean;
  /** Alerts of the same code folded into this toast since the previous one was shown. */
  readonly folded: number;
}

export function createAlertThrottle(windowMs = 60_000, now: () => number = () => Date.now()): (alert: Alert) => ToastDecision {
  const last = new Map<string, { at: number; folded: number }>();
  return alert => {
    const key = alert.code ?? `${alert.level}:${alert.message}`;
    const t = now();
    const prev = last.get(key);
    if (prev && t - prev.at < windowMs) { prev.folded++; return { show: false, folded: prev.folded }; }
    const folded = prev?.folded ?? 0;
    last.set(key, { at: t, folded: 0 });
    return { show: true, folded };
  };
}

export function toastText(alert: Alert, folded: number): string {
  return folded > 0 ? `${alert.message} (+${folded} more ${alert.code ?? 'similar'} alert${folded === 1 ? '' : 's'} since the last notice)` : alert.message;
}

/**
 * Which item to drop from a newest-first list that is over its limit: the oldest non-critical one, so
 * routine notices (acks, toxicity folds) can never push out a critical alert. When every item is
 * critical, the oldest goes.
 */
export function evictIndex(levels: readonly string[]): number {
  for (let i = levels.length - 1; i >= 0; i--) if (levels[i] !== 'critical') return i;
  return levels.length - 1;
}

export type AlertFilter = 'all' | 'critical' | 'warning' | 'info';

/** Alerts panel filter (newest first, as stored). */
export function filterAlerts<T extends { readonly level: string }>(alerts: readonly T[], filter: AlertFilter): readonly T[] {
  return filter === 'all' ? alerts : alerts.filter(a => a.level === filter);
}
