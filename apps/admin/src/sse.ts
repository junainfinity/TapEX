/**
 * Server-sent events over fetch. `EventSource` cannot send an Authorization
 * header, and the admin token must never travel in a URL, so the stream is
 * read with fetch + a spec-conformant incremental parser. The connection
 * reconnects with capped exponential backoff and jitter, resumes with
 * Last-Event-ID, detects stalls, and stops (no retry loop) on 401/403.
 */
import type { FetchLike } from './api.js';

export interface SseMessage {
  readonly event: string;
  readonly data: string;
  readonly id: string;
}

/** Incremental parser for the text/event-stream format (WHATWG HTML §9.2.6). */
export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventType = '';
  private pendingCr = false;
  /** Last event ID buffer; persists across events like EventSource's. */
  lastEventId = '';
  /** Most recent valid `retry:` value in ms, if the server sent one. */
  retryMs: number | null = null;

  feed(chunk: string): SseMessage[] {
    let text = chunk;
    // A CRLF split across chunks: the LF belongs to the CR already consumed.
    if (this.pendingCr && text.startsWith('\n')) text = text.slice(1);
    this.pendingCr = false;
    this.buffer += text;
    const out: SseMessage[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      const line = this.buffer.slice(start, i);
      if (ch === '\r') {
        if (i + 1 < this.buffer.length) { if (this.buffer[i + 1] === '\n') i++; }
        else this.pendingCr = true;
      }
      start = i + 1;
      const message = this.line(line);
      if (message) out.push(message);
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  private line(line: string): SseMessage | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event': this.eventType = value; break;
      case 'data': this.dataLines.push(value); break;
      case 'id': if (!value.includes('\u0000')) this.lastEventId = value; break;
      case 'retry': if (/^\d+$/.test(value)) this.retryMs = Number(value); break;
      default: break;
    }
    return null;
  }

  private dispatch(): SseMessage | null {
    const hasData = this.dataLines.length > 0;
    const message = hasData ? { event: this.eventType || 'message', data: this.dataLines.join('\n'), id: this.lastEventId } : null;
    this.dataLines = [];
    this.eventType = '';
    return message;
  }
}

export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly factor: number;
  /** 0..1: fraction of the delay randomised (equal jitter around the nominal delay). */
  readonly jitter: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = Object.freeze({ baseMs: 1_000, maxMs: 30_000, factor: 2, jitter: 0.2 });

/** Delay before reconnect attempt `attempt` (1-based). Pure; `random` ∈ [0, 1). */
export function backoffDelay(attempt: number, policy: BackoffPolicy, random: number): number {
  const n = Math.max(1, Math.floor(attempt));
  const nominal = Math.min(policy.maxMs, policy.baseMs * policy.factor ** (n - 1));
  const r = Math.min(Math.max(random, 0), 1);
  const jittered = nominal * (1 - policy.jitter + 2 * policy.jitter * r);
  return Math.round(Math.min(policy.maxMs, Math.max(0, jittered)));
}

export type StreamState =
  | { readonly status: 'idle' }
  | { readonly status: 'connecting'; readonly attempt: number }
  | { readonly status: 'open'; readonly since: number }
  | { readonly status: 'reconnecting'; readonly attempt: number; readonly retryAt: number; readonly lastError: string }
  | { readonly status: 'unauthorized' }
  | { readonly status: 'closed' };

export type TimerHandle = unknown;

export interface StreamOptions {
  readonly url: string;
  readonly headers: () => Record<string, string>;
  readonly fetch: FetchLike;
  readonly onMessage: (message: SseMessage) => void;
  readonly onState: (state: StreamState) => void;
  readonly backoff?: BackoffPolicy;
  /** No bytes for this long (the server sends overview every 1 s) → reconnect. */
  readonly stallMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
  readonly random?: () => number;
}

export class SseConnection {
  private generation = 0;
  /** Consecutive failed connections since the last stream that delivered an event. */
  private failures = 0;
  private controller: AbortController | null = null;
  private retryTimer: TimerHandle | null = null;
  private stallTimer: TimerHandle | null = null;
  private lastEventId = '';
  private serverRetryMs: number | null = null;
  private current: StreamState = { status: 'idle' };
  private readonly policy: BackoffPolicy;
  private readonly stallMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly random: () => number;

  constructor(private readonly options: StreamOptions) {
    this.policy = options.backoff ?? DEFAULT_BACKOFF;
    this.stallMs = options.stallMs ?? 15_000;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.random = options.random ?? Math.random;
  }

  get state(): StreamState { return this.current; }
  get resumeId(): string { return this.lastEventId; }

  start(): void {
    if (this.current.status === 'connecting' || this.current.status === 'open') return;
    this.connect();
  }

  /** Stop permanently (sign-out, page unload). */
  stop(): void {
    this.generation++;
    this.teardown();
    this.setState({ status: 'closed' });
  }

  /** Skip the backoff wait (operator pressed "Retry now", or the browser came back online). */
  reconnectNow(): void {
    if (this.current.status === 'open' || this.current.status === 'connecting') return;
    this.connect();
  }

  private teardown(): void {
    if (this.retryTimer !== null) { this.clearTimer(this.retryTimer); this.retryTimer = null; }
    if (this.stallTimer !== null) { this.clearTimer(this.stallTimer); this.stallTimer = null; }
    this.controller?.abort();
    this.controller = null;
  }

  private setState(state: StreamState): void {
    this.current = Object.freeze(state);
    this.options.onState(this.current);
  }

  private connect(): void {
    this.teardown();
    const generation = ++this.generation;
    this.setState({ status: 'connecting', attempt: this.failures + 1 });
    void this.run(generation);
  }

  private armStall(generation: number): void {
    if (this.stallTimer !== null) this.clearTimer(this.stallTimer);
    this.stallTimer = this.setTimer(() => {
      if (generation !== this.generation) return;
      this.fail(generation, `no data for ${Math.round(this.stallMs / 1000)} s`);
    }, this.stallMs);
  }

  private fail(generation: number, reason: string): void {
    if (generation !== this.generation) return;
    this.generation++;
    this.teardown();
    const base = this.serverRetryMs === null ? this.policy : { ...this.policy, baseMs: this.serverRetryMs };
    this.failures++;
    const delay = backoffDelay(this.failures, base, this.random());
    const retryAt = this.now() + delay;
    this.setState({ status: 'reconnecting', attempt: this.failures, retryAt, lastError: reason });
    this.retryTimer = this.setTimer(() => { this.retryTimer = null; this.connect(); }, delay);
  }

  private async run(generation: number): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const headers: Record<string, string> = { ...this.options.headers(), Accept: 'text/event-stream' };
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;
    let response: Response;
    try {
      response = await this.options.fetch(this.options.url, { method: 'GET', headers, signal: controller.signal, cache: 'no-store' });
    } catch (error) {
      this.fail(generation, error instanceof Error ? error.message || 'network error' : 'network error');
      return;
    }
    if (generation !== this.generation) { controller.abort(); return; }
    if (response.status === 401 || response.status === 403) {
      this.generation++;
      this.teardown();
      this.setState({ status: 'unauthorized' });
      return;
    }
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !response.body || !type.includes('text/event-stream')) {
      void response.body?.cancel().catch(() => undefined);
      this.fail(generation, response.ok ? `unexpected content-type "${type}"` : `HTTP ${response.status}`);
      return;
    }
    this.setState({ status: 'open', since: this.now() });
    this.armStall(generation);
    const parser = new SseParser();
    parser.lastEventId = this.lastEventId;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let received = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (generation !== this.generation) { void reader.cancel().catch(() => undefined); return; }
        if (done) break;
        this.armStall(generation);
        const messages = parser.feed(value);
        if (parser.retryMs !== null) this.serverRetryMs = parser.retryMs;
        this.lastEventId = parser.lastEventId;
        for (const message of messages) {
          // Only a stream that actually delivers events resets the backoff ladder.
          if (!received) { received = true; this.failures = 0; }
          this.options.onMessage(message);
          if (generation !== this.generation) return;
        }
      }
      this.fail(generation, 'stream ended by server');
    } catch (error) {
      this.fail(generation, error instanceof Error ? error.message || 'stream error' : 'stream error');
    }
  }
}
