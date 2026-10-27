import { describe, expect, it } from 'vitest';
import { backoffDelay, DEFAULT_BACKOFF, SseConnection, SseParser, type SseMessage, type StreamState } from './sse.js';
import type { FetchLike } from './api.js';

describe('SseParser', () => {
  it('parses events, multi-line data, ids and comments', () => {
    const p = new SseParser();
    const out = p.feed(': keep-alive\nevent: bet\nid: 7\ndata: {"a":1}\n\ndata: line1\ndata: line2\n\n');
    expect(out).toEqual([
      { event: 'bet', data: '{"a":1}', id: '7' },
      { event: 'message', data: 'line1\nline2', id: '7' },
    ]);
    expect(p.lastEventId).toBe('7');
  });

  it('handles arbitrary chunk boundaries, including a CRLF split across chunks', () => {
    const text = 'event: overview\r\ndata: {"x":1}\r\n\r\nevent: alert\rdata: hi\r\r';
    for (let cut = 1; cut < text.length; cut++) {
      const p = new SseParser();
      const out = [...p.feed(text.slice(0, cut)), ...p.feed(text.slice(cut))];
      expect(out, `cut at ${cut}`).toEqual([
        { event: 'overview', data: '{"x":1}', id: '' },
        { event: 'alert', data: 'hi', id: '' },
      ]);
    }
  });

  it('feeds byte-by-byte identically', () => {
    const text = 'retry: 2500\nevent: settlement\ndata: {"legId":"L1"}\nid: 99\n\n';
    const p = new SseParser();
    const out: SseMessage[] = [];
    for (const ch of text) out.push(...p.feed(ch));
    expect(out).toEqual([{ event: 'settlement', data: '{"legId":"L1"}', id: '99' }]);
    expect(p.retryMs).toBe(2500);
  });

  it('ignores events without data, invalid retry values and ids containing NUL', () => {
    const p = new SseParser();
    expect(p.feed('event: bet\n\nretry: soon\nid: a\u0000b\ndata\n\n')).toEqual([{ event: 'message', data: '', id: '' }]);
    expect(p.retryMs).toBeNull();
    expect(p.feed('data:no-space\n\n')).toEqual([{ event: 'message', data: 'no-space', id: '' }]);
    expect(p.feed('data:  two spaces\n\n')).toEqual([{ event: 'message', data: ' two spaces', id: '' }]);
  });

  it('keeps an incomplete trailing event buffered until its blank line arrives', () => {
    const p = new SseParser();
    expect(p.feed('event: bet\ndata: {"a"')).toEqual([]);
    expect(p.feed(':1}\n')).toEqual([]);
    expect(p.feed('\n')).toEqual([{ event: 'bet', data: '{"a":1}', id: '' }]);
  });
});

describe('backoffDelay', () => {
  it('grows exponentially, is capped, and jitters symmetrically', () => {
    const noJitter = { ...DEFAULT_BACKOFF, jitter: 0 };
    expect([1, 2, 3, 4, 5, 6, 7].map(n => backoffDelay(n, noJitter, 0.9))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(backoffDelay(1, DEFAULT_BACKOFF, 0)).toBe(800);
    expect(backoffDelay(1, DEFAULT_BACKOFF, 0.5)).toBe(1000);
    expect(backoffDelay(1, DEFAULT_BACKOFF, 0.999999)).toBe(1200);
    expect(backoffDelay(10, DEFAULT_BACKOFF, 0.999999)).toBe(30000);
    expect(backoffDelay(0, noJitter, 0.5)).toBe(1000);
  });
});

/** Deterministic timer queue so reconnect timing is asserted exactly. */
class ManualClock {
  now = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  set = (fn: () => void, ms: number): number => { const id = ++this.seq; this.timers.set(id, { at: this.now + ms, fn }); return id; };
  clear = (handle: unknown): void => { this.timers.delete(handle as number); };
  pending(): number[] { return [...this.timers.values()].map(t => t.at - this.now).sort((a, b) => a - b); }
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = target;
  }
}

/** Let the fetch/reader promise chains settle (real macrotasks; connection timers are manual). */
async function flush(): Promise<void> { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); }

interface FakeStream { push(text: string): void; close(): void; fail(): void }

function harness(opts: { random?: number } = {}) {
  const clock = new ManualClock();
  const calls: { headers: Headers; signal: AbortSignal | undefined }[] = [];
  const streams: FakeStream[] = [];
  type Next = { kind: 'stream' } | { kind: 'status'; status: number; contentType?: string } | { kind: 'reject' };
  const plan: Next[] = [];
  const fetch: FetchLike = async (_url, init) => {
    calls.push({ headers: new Headers(init?.headers), signal: init?.signal ?? undefined });
    const next = plan.shift() ?? { kind: 'stream' };
    if (next.kind === 'reject') throw new TypeError('connect ECONNREFUSED');
    if (next.kind === 'status') return new Response('x', { status: next.status, headers: { 'content-type': next.contentType ?? 'text/plain' } });
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    init?.signal?.addEventListener('abort', () => { try { controller.error(new DOMException('aborted', 'AbortError')); } catch { /* already closed */ } });
    streams.push({ push: t => controller.enqueue(encoder.encode(t)), close: () => controller.close(), fail: () => controller.error(new TypeError('network changed')) });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  };
  const messages: SseMessage[] = [];
  const states: StreamState[] = [];
  const connection = new SseConnection({
    url: '/admin-api/stream', headers: () => ({ Authorization: 'Bearer tok' }), fetch,
    onMessage: m => messages.push(m), onState: s => states.push(s),
    now: () => clock.now, setTimer: clock.set, clearTimer: clock.clear, random: () => opts.random ?? 0.5, stallMs: 15_000,
  });
  return { clock, calls, streams, plan, messages, states, connection, last: () => states[states.length - 1]! };
}

describe('SseConnection', () => {
  it('connects with the bearer token, delivers events and reports open state', async () => {
    const h = harness();
    h.connection.start();
    expect(h.last()).toEqual({ status: 'connecting', attempt: 1 });
    await flush();
    expect(h.last().status).toBe('open');
    expect(h.calls[0]!.headers.get('authorization')).toBe('Bearer tok');
    expect(h.calls[0]!.headers.get('accept')).toBe('text/event-stream');
    expect(h.calls[0]!.headers.get('last-event-id')).toBeNull();
    h.streams[0]!.push('event: overview\nid: 41\ndata: {"clockMs":1}\n\n');
    await flush();
    expect(h.messages).toEqual([{ event: 'overview', data: '{"clockMs":1}', id: '41' }]);
    h.connection.stop();
  });

  it('reconnects after the server ends the stream and resumes with Last-Event-ID', async () => {
    const h = harness();
    h.connection.start();
    await flush();
    h.streams[0]!.push('event: bet\nid: 100\ndata: {}\n\n');
    await flush();
    h.streams[0]!.close();
    await flush();
    expect(h.last()).toMatchObject({ status: 'reconnecting', attempt: 1, retryAt: 1000, lastError: 'stream ended by server' });
    expect(h.clock.pending()).toEqual([1000]);
    h.clock.advance(999);
    expect(h.calls).toHaveLength(1);
    h.clock.advance(1);
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.headers.get('last-event-id')).toBe('100');
    expect(h.last().status).toBe('open');
    h.connection.stop();
  });

  it('backs off exponentially across consecutive failures and caps the delay', async () => {
    const h = harness();
    h.plan.push(...Array.from({ length: 7 }, () => ({ kind: 'reject' as const })));
    h.connection.start();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      await flush();
      const state = h.last();
      expect(state.status).toBe('reconnecting');
      if (state.status !== 'reconnecting') return;
      expect(state.attempt).toBe(i + 1);
      delays.push(state.retryAt - h.clock.now);
      h.clock.advance(state.retryAt - h.clock.now);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    await flush();
    expect(h.last().status).toBe('open');
    expect(h.calls).toHaveLength(8);
    h.connection.stop();
  });

  it('resets the backoff ladder only once a stream delivers an event', async () => {
    const h = harness();
    h.plan.push({ kind: 'reject' }, { kind: 'reject' });
    h.connection.start();
    await flush(); h.clock.advance(1000);
    await flush(); h.clock.advance(2000);
    await flush();
    expect(h.last().status).toBe('open');
    // Opened but closed before any event: still escalating.
    h.streams[0]!.close();
    await flush();
    expect(h.last()).toMatchObject({ status: 'reconnecting', attempt: 3 });
    h.clock.advance(4000);
    await flush();
    h.streams[1]!.push('data: ok\n\n');
    await flush();
    h.streams[1]!.fail();
    await flush();
    expect(h.last()).toMatchObject({ status: 'reconnecting', attempt: 1 });
    expect(h.clock.pending()).toEqual([1000]);
    h.connection.stop();
  });

  it('stops retrying on 401/403 and reports unauthorized', async () => {
    for (const status of [401, 403]) {
      const h = harness();
      h.plan.push({ kind: 'status', status });
      h.connection.start();
      await flush();
      expect(h.last()).toEqual({ status: 'unauthorized' });
      expect(h.clock.pending()).toEqual([]);
      h.clock.advance(120_000);
      await flush();
      expect(h.calls).toHaveLength(1);
      // A fresh token lets the operator start again.
      h.connection.start();
      await flush();
      expect(h.last().status).toBe('open');
      h.connection.stop();
    }
  });

  it('retries on 5xx and on a non-SSE content type', async () => {
    const h = harness();
    h.plan.push({ kind: 'status', status: 503 }, { kind: 'status', status: 200, contentType: 'text/html' });
    h.connection.start();
    await flush();
    expect(h.last()).toMatchObject({ status: 'reconnecting', lastError: 'HTTP 503' });
    h.clock.advance(1000);
    await flush();
    expect(h.last()).toMatchObject({ status: 'reconnecting', attempt: 2, lastError: 'unexpected content-type "text/html"' });
    h.clock.advance(2000);
    await flush();
    expect(h.last().status).toBe('open');
    h.connection.stop();
  });

  it('honours the server retry: field as the backoff base', async () => {
    const h = harness();
    h.connection.start();
    await flush();
    h.streams[0]!.push('retry: 5000\ndata: hello\n\n');
    await flush();
    h.streams[0]!.close();
    await flush();
    expect(h.clock.pending()).toEqual([5000]);
    h.connection.stop();
  });

  it('treats a silent stream as stalled and reconnects', async () => {
    const h = harness();
    h.connection.start();
    await flush();
    h.clock.advance(10_000);
    h.streams[0]!.push(': ping\n');
    await flush();
    h.clock.advance(14_999);
    expect(h.last().status).toBe('open');
    h.clock.advance(1);
    expect(h.last()).toMatchObject({ status: 'reconnecting', lastError: 'no data for 15 s' });
    expect(h.calls[0]!.signal?.aborted).toBe(true);
    h.clock.advance(1000);
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.last().status).toBe('open');
    h.connection.stop();
  });

  it('reconnectNow skips the wait; stop cancels timers and aborts the stream', async () => {
    const h = harness();
    h.plan.push({ kind: 'reject' });
    h.connection.start();
    await flush();
    expect(h.last().status).toBe('reconnecting');
    h.connection.reconnectNow();
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.clock.pending()).toEqual([15_000]); // only the stall watchdog remains
    h.connection.stop();
    expect(h.last()).toEqual({ status: 'closed' });
    expect(h.clock.pending()).toEqual([]);
    expect(h.calls[1]!.signal?.aborted).toBe(true);
    await flush();
    expect(h.last()).toEqual({ status: 'closed' });
  });
});
