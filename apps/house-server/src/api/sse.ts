import type { IncomingMessage, ServerResponse } from 'node:http';
import { toJson } from './http.js';

export type StreamEventName = 'overview' | 'bet' | 'settlement' | 'breaker' | 'admin-action' | 'alert' | 'refit';

interface Buffered { readonly id: number; readonly event: StreamEventName; readonly data: string }
interface Client { readonly res: ServerResponse; readonly since: number }

export interface SseOptions {
  readonly overview: () => unknown;
  readonly maxClients?: number;
  /** Sampled events (bet, settlement) per wall second. */
  readonly sampledPerSecond?: number;
  readonly bufferSize?: number;
  readonly retryMs?: number;
}

/**
 * Admin SSE hub: `overview` every second, `bet`/`settlement` sampled to ≤ N per second, and every
 * `breaker`, `admin-action`, `alert` and `refit` event. Non-overview events carry ids and are
 * buffered so a reconnect with `Last-Event-ID` resumes without gaps (within the buffer).
 */
export class SseHub {
  private readonly clients = new Set<Client>();
  private readonly buffer: Buffered[] = [];
  private nextId = 1;
  private readonly sampled = new Map<string, { second: number; count: number }>();
  dropped = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: SseOptions) {}

  get clientCount(): number { return this.clients.size; }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.broadcastOverview(), 1000);
    this.timer.unref?.();
  }
  close(): void {
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }

  attach(req: IncomingMessage, res: ServerResponse): boolean {
    if (this.clients.size >= (this.options.maxClients ?? 16)) return false;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: ${this.options.retryMs ?? 3000}\n\n`);
    const last = Number(req.headers['last-event-id']);
    if (Number.isSafeInteger(last) && last > 0) for (const b of this.buffer) if (b.id > last) res.write(frame(b.event, b.data, b.id));
    res.write(frame('overview', toJson(this.options.overview())));
    const client: Client = { res, since: Date.now() };
    this.clients.add(client);
    const drop = () => { this.clients.delete(client); };
    req.on('close', drop); res.on('error', drop);
    return true;
  }

  publish(event: StreamEventName, data: unknown): void {
    if (event === 'bet' || event === 'settlement') {
      const second = Math.floor(Date.now() / 1000);
      const s = this.sampled.get(event);
      if (s && s.second === second) { if (s.count >= (this.options.sampledPerSecond ?? 20)) { this.dropped++; return; } s.count++; }
      else this.sampled.set(event, { second, count: 1 });
    }
    const b: Buffered = { id: this.nextId++, event, data: toJson(data) };
    this.buffer.push(b);
    if (this.buffer.length > (this.options.bufferSize ?? 1000)) this.buffer.shift();
    if (!this.clients.size) return;
    const text = frame(b.event, b.data, b.id);
    for (const c of this.clients) c.res.write(text);
  }

  broadcastOverview(): void {
    if (!this.clients.size) return;
    const text = frame('overview', toJson(this.options.overview()));
    for (const c of this.clients) c.res.write(text);
  }
}

function frame(event: string, data: string, id?: number): string {
  return `${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${data}\n\n`;
}
