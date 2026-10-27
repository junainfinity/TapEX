/**
 * Live console state fed by the SSE stream (and overview polling while the
 * stream is down). Pages subscribe to topics; snapshots are immutable.
 */
import { evictIndex } from './alert-throttle.js';
import { decodeStreamEvent } from './decode.js';
import { formatDateTime } from './format.js';
import type { SseMessage, StreamState } from './sse.js';
import type { Alert, ApiErrorBody, AuditEntry, BetLeg, Breaker, ChainState, Overview, RefitProgress, StreamEvent } from './types.js';

export type Topic = 'overview' | 'bets' | 'stream' | 'alerts' | 'audit' | 'refit' | 'breaker' | 'chain' | 'run';

export const MAX_BETS = 300;
export const MAX_ALERTS = 50;
export const MAX_AUDIT = 500;

/**
 * Within one run the server clock never goes back, so a small backwards step is an out-of-order answer
 * (dropped) and a large one means the server restarted on a new run (a fresh replay clock).
 */
export const RUN_RESET_BACKWARDS_MS = 60_000;

export type OverviewOrder = 'newer' | 'stale' | 'new-run';

/**
 * Where an incoming overview sits relative to the one shown: a new run (different `runId`, a journal
 * sequence that restarted, or a large backwards clock jump) replaces everything; an older answer from the
 * same run is dropped; anything else is newer.
 */
export function classifyOverview(prev: Overview | null, next: Overview): OverviewOrder {
  if (!prev) return 'newer';
  if (prev.runId !== undefined && next.runId !== undefined && prev.runId !== next.runId) return 'new-run';
  if (prev.journalSeq !== undefined && next.journalSeq !== undefined) {
    if (next.journalSeq >= prev.journalSeq) return 'newer';
    // The sequence went back: a stale answer carries an older clock too; a restarted journal does not (or jumps far back).
    return next.clockMs > prev.clockMs || prev.clockMs - next.clockMs > RUN_RESET_BACKWARDS_MS ? 'new-run' : 'stale';
  }
  if (next.clockMs >= prev.clockMs) return 'newer';
  return prev.clockMs - next.clockMs > RUN_RESET_BACKWARDS_MS ? 'new-run' : 'stale';
}

export interface StoreState {
  readonly overview: Overview | null;
  /** Local receipt time of the last overview, to tick the server clock between updates. */
  readonly overviewAtMs: number;
  readonly stream: StreamState;
  readonly bets: readonly BetLeg[];
  readonly alerts: readonly Alert[];
  /** Alerts received since the operator last opened the alerts panel. */
  readonly unreadAlerts: number;
  readonly audit: readonly AuditEntry[];
  readonly refits: ReadonlyMap<string, RefitProgress>;
  readonly lastBreaker: Breaker | null;
  readonly badEvents: number;
  readonly lastEventMs: number;
  /** Last failure of the fallback overview poll (null once an overview arrives). */
  readonly pollError: ApiErrorBody | null;
  /** Latest GET /chain answer from any page or the background poll. */
  readonly chain: ChainState | null;
  /** Runs seen since the page loaded (1 for the first). */
  readonly runs: number;
}

type Listener = () => void;

/** Transitions the server journals as its own audit rows (engine.commitBreaker); admin ones arrive as admin-action rows. */
const isAutomatic = (b: Breaker) => b.actor === undefined || b.actor === 'system';

const provisionalId = (b: Breaker) => `breaker:${b.id}:${b.market ?? '*'}:${b.since}:${b.state}`;

/** The server's audit row for a breaker transition: action `breaker:<id>:<state>`, target market, at the transition time. */
function isServerRowFor(entry: AuditEntry, b: Breaker): boolean {
  return entry.kind === 'breaker' && !entry.id.startsWith('breaker:') && entry.action === `breaker:${b.id}:${b.state}` && (entry.target ?? undefined) === (b.market ?? undefined) && entry.ms === b.since;
}

/** Provisional row id `breaker:<id>:<market|*>:<since>:<state>` → the transition it stands for. */
function provisionalKey(entry: AuditEntry): Breaker | null {
  const m = /^breaker:([^:]+):([^:]+):(\d+):(.+)$/.exec(entry.id);
  if (!m) return null;
  return { id: m[1]!, ...(m[2] === '*' ? {} : { market: m[2]! }), since: Number(m[3]), state: m[4]!, reason: '' };
}

export class Store {
  private state: StoreState = {
    overview: null, overviewAtMs: 0, stream: { status: 'idle' }, bets: [], alerts: [], unreadAlerts: 0, audit: [], refits: new Map(), lastBreaker: null, badEvents: 0, lastEventMs: 0,
    pollError: null, chain: null, runs: 1,
  };
  private readonly listeners = new Map<Topic, Set<Listener>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  get snapshot(): StoreState { return this.state; }

  /** The store's clock (wall time by default); poll request times must use it. */
  nowMs(): number { return this.now(); }

  on(topic: Topic, listener: Listener): () => void {
    let set = this.listeners.get(topic);
    if (!set) { set = new Set(); this.listeners.set(topic, set); }
    set.add(listener);
    return () => { set.delete(listener); };
  }

  private emit(topic: Topic): void {
    for (const listener of this.listeners.get(topic) ?? []) {
      try { listener(); } catch (error) { console.error(`[admin] ${topic} listener failed`, error); }
    }
  }

  private set(patch: Partial<StoreState>, ...topics: Topic[]): void {
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const topic of topics) this.emit(topic);
  }

  setStream(stream: StreamState): void { this.set({ stream }, 'stream'); }

  /**
   * Apply an overview. `requestedAtMs` (store clock) marks a poll answer: it is stale when another
   * overview arrived after the poll was sent. A new run resets every run-scoped view (ticker, audit,
   * refits, breaker) instead of being dropped as "older".
   */
  setOverview(overview: Overview, source: { readonly requestedAtMs?: number } = {}): OverviewOrder {
    const prev = this.state.overview;
    if (prev && source.requestedAtMs !== undefined && this.state.overviewAtMs >= source.requestedAtMs) return 'stale';
    const order = classifyOverview(prev, overview);
    if (order === 'stale') return order;
    if (order === 'new-run') {
      this.set({ overview, overviewAtMs: this.now(), pollError: null, bets: [], audit: [], refits: new Map(), lastBreaker: null, chain: null, runs: this.state.runs + 1 }, 'overview', 'bets', 'audit', 'refit', 'breaker', 'chain', 'stream', 'run');
      const from = prev?.runId ? ` (was ${prev.runId})` : '';
      this.pushAlert({ level: 'info', code: 'NEW_RUN', message: `The server started a new run${overview.runId ? ` ${overview.runId}` : ''}${from}. The console reset its live views; server clock ${formatDateTime(overview.clockMs)}.`, ms: this.now() });
      return order;
    }
    const hadError = this.state.pollError !== null;
    this.set({ overview, overviewAtMs: this.now(), pollError: null }, ...(hadError ? ['overview', 'stream'] as const : ['overview'] as const));
    return order;
  }

  /** Fallback poll failure (or null): surfaced in the stream banner while the stream is down. */
  setPollError(error: ApiErrorBody | null): void {
    if (error === null && this.state.pollError === null) return;
    this.set({ pollError: error }, 'stream');
  }

  setChain(chain: ChainState): void { this.set({ chain }, 'chain'); }

  /** Server clock estimate: last reported clock advanced by local elapsed time × replay speed (capped at 5 s, for the header clock). */
  serverNow(): number | null {
    const o = this.state.overview;
    if (!o) return null;
    const elapsed = Math.max(0, this.now() - this.state.overviewAtMs);
    return o.clockMs + Math.min(elapsed, 5_000) * (o.feedMode === 'replay' ? o.speed : 1);
  }

  /**
   * Uncapped clock estimate for ages ("last price N s ago"): when overviews stop arriving, the freshest
   * price the console knows of keeps getting older instead of freezing at a fresh-looking age.
   */
  feedNow(): number | null {
    const o = this.state.overview;
    if (!o) return null;
    return o.clockMs + Math.max(0, this.now() - this.state.overviewAtMs) * (o.feedMode === 'replay' ? o.speed : 1);
  }

  /** Wall time since the last overview arrived (null before the first). */
  overviewAgeMs(): number | null {
    return this.state.overview ? Math.max(0, this.now() - this.state.overviewAtMs) : null;
  }

  /** Keep the newest alerts; when full, drop the oldest non-critical one first so a critical alert is never pushed out by noise. */
  pushAlert(alert: Alert): void {
    const alerts = [alert, ...this.state.alerts];
    while (alerts.length > MAX_ALERTS) alerts.splice(evictIndex(alerts.map(a => a.level)), 1);
    this.set({ alerts, unreadAlerts: this.state.unreadAlerts + 1 }, 'alerts');
  }

  markAlertsRead(): void {
    if (this.state.unreadAlerts !== 0) this.set({ unreadAlerts: 0 }, 'alerts');
  }

  seedAudit(entries: readonly AuditEntry[]): void {
    const seen = new Set(this.state.audit.map(e => e.id));
    const fresh = entries.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });
    const all = [...this.state.audit, ...fresh];
    // A provisional breaker row gives way to the server's own journal entry for the same transition.
    const merged = all.filter(e => { const b = e.id.startsWith('breaker:') ? provisionalKey(e) : null; return !b || !all.some(other => isServerRowFor(other, b)); })
      .sort((a, b) => b.ms - a.ms).slice(0, MAX_AUDIT);
    this.set({ audit: merged }, 'audit');
  }

  /** Decode and apply one SSE message. Returns false when the payload was malformed. */
  ingest(message: SseMessage): boolean {
    let parsed: unknown;
    try { parsed = JSON.parse(message.data); } catch { return this.bad(message.event, 'data is not JSON'); }
    let event: StreamEvent | null;
    try { event = decodeStreamEvent(message.event, parsed); } catch (error) { return this.bad(message.event, error instanceof Error ? error.message : 'invalid payload'); }
    if (!event) return true; // unknown event names are ignored by design
    this.state = Object.freeze({ ...this.state, lastEventMs: this.now() });
    this.apply(event);
    return true;
  }

  apply(event: StreamEvent): void {
    switch (event.type) {
      case 'overview': this.setOverview(event.data); break;
      case 'bet': {
        if (this.state.bets.some(b => b.legId === event.data.legId)) break;
        this.set({ bets: [event.data, ...this.state.bets].slice(0, MAX_BETS) }, 'bets');
        break;
      }
      case 'settlement': {
        const index = this.state.bets.findIndex(b => b.legId === event.data.legId);
        if (index === -1) break; // settlement of a leg the ticker never showed (bets are sampled)
        const bets = [...this.state.bets];
        bets[index] = event.data;
        this.set({ bets }, 'bets');
        break;
      }
      case 'breaker': {
        const b = event.data;
        this.set({ lastBreaker: b }, 'breaker');
        // Admin transitions reach the audit log as the server's admin-action row (actor, before/after, reason).
        // Automatic ones get a provisional row, with the payload's actor and previous state, until GET /audit returns the journaled entry.
        if (!isAutomatic(b) || this.state.audit.some(e => isServerRowFor(e, b))) break;
        const entry: AuditEntry = Object.freeze({
          id: provisionalId(b), ms: b.since, kind: 'breaker', actor: b.actor ?? 'system', action: `breaker:${b.id}:${b.state}`,
          ...(b.market ? { target: b.market } : {}), ...(b.from !== undefined ? { before: b.from } : {}), after: b.state, reason: b.reason, result: 'live (journal entry pending)',
        });
        this.seedAudit([entry]);
        break;
      }
      case 'admin-action': this.seedAudit([event.data]); break;
      case 'alert': this.pushAlert(event.data); break;
      case 'refit': {
        const refits = new Map(this.state.refits);
        refits.set(event.data.jobId, event.data);
        this.set({ refits }, 'refit');
        break;
      }
    }
  }

  private bad(type: string, detail: string): false {
    const count = this.state.badEvents + 1;
    this.state = Object.freeze({ ...this.state, badEvents: count });
    // Surface the first and then every 50th malformed event, not a flood.
    if (count === 1 || count % 50 === 0) this.pushAlert({ level: 'warning', code: 'BAD_EVENT', message: `Ignored malformed "${type}" stream event (${detail}). ${count} so far.`, ms: this.now() });
    return false;
  }
}
