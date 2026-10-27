/** Shared page context and small scheduling helpers. */
import type { AdminApi } from './api.js';
import type { ActionPlan } from './controls.js';
import type { PageId } from './keys.js';
import type { Settings } from './settings.js';
import type { Store } from './store.js';
import type { WriteAck } from './types.js';
import type { DialogOutcome } from './ui/dialog.js';

export interface AppContext {
  readonly api: AdminApi;
  readonly store: Store;
  readonly settings: Settings;
  readonly demo: boolean;
  /** Open the confirm dialog for a write; resolves after it closes. */
  act(plan: ActionPlan, onApplied?: (ack: WriteAck) => void): Promise<DialogOutcome>;
  navigate(page: PageId): void;
  openPlayer(account: string): void;
  chainId(): number;
}

export interface Page {
  readonly el: HTMLElement;
  mount(): void;
  unmount(): void;
  focusSearch?(): void;
  /** Close any open drawer; returns true when something was closed. */
  dismiss?(): boolean;
}

/**
 * Runs `task` every `intervalMs` while started (slower in background tabs);
 * never overlaps runs, so a slow server cannot pile up requests.
 */
export class Poller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;
  private readonly onVisibility = () => { if (document.visibilityState === 'visible' && this.running) this.kick(); };

  constructor(private readonly task: () => Promise<void>, private intervalMs: number) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.kick();
  }

  stop(): void {
    this.running = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  setInterval(ms: number): void { this.intervalMs = ms; }

  /** Run now (e.g. after a write was acknowledged). */
  kick(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    void this.run();
  }

  private async run(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    try { await this.task(); } catch (error) { console.error('[admin] poll failed', error); } finally { this.inFlight = false; }
    this.schedule();
  }

  /** Background tabs keep polling, just 4× slower; returning to the tab refreshes at once. */
  private schedule(): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    this.timer = setTimeout(() => void this.run(), hidden ? this.intervalMs * 4 : this.intervalMs);
  }
}

/** Evenly thin a series to at most `max` points (sparklines). */
export function thin<T>(values: readonly T[], max: number): T[] {
  if (values.length <= max) return [...values];
  const out: T[] = [];
  const step = (values.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(values[Math.round(i * step)]!);
  return out;
}

/** Index of the last sample at or before `t` (binary search on ascending times). */
export function indexAtOrBefore(times: readonly number[], t: number): number {
  let lo = 0; let hi = times.length - 1; let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}
