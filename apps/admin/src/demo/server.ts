/**
 * In-browser stand-in for the house server's admin API, used by `?demo`.
 * It answers the same routes with the same JSON and streams real
 * text/event-stream bytes, so the demo exercises the production client,
 * decoders, SSE parser and reconnect logic unchanged.
 */
import type { FetchLike } from '../api.js';
import { DEMO_TOKEN, DemoWorld, type DemoEvent } from './fixture.js';

export interface DemoServerOptions {
  readonly seed?: number;
  readonly now?: () => number;
  /** Simulated network latency (default true). */
  readonly latency?: boolean;
  readonly tickMs?: number;
}

export interface DemoServer {
  readonly fetch: FetchLike;
  readonly world: DemoWorld;
  /** Advance the world once and broadcast (the timer calls this; tests may call it directly). */
  tick(): void;
  stop(): void;
}

interface Subscriber { send(text: string): void; close(): void }

const encoder = new TextEncoder();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function error(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

function sleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
  });
}

export function createDemoServer(options: DemoServerOptions = {}): DemoServer {
  const now = options.now ?? (() => Date.now());
  const world = new DemoWorld({ seed: options.seed ?? 20260926, now });
  const latency = options.latency ?? true;
  const subscribers = new Set<Subscriber>();
  let eventId = 0;
  let lastOverviewReal = 0;
  let dropWatermark = 0;

  const frame = (event: DemoEvent) => `id: ${++eventId}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
  const broadcast = (events: readonly DemoEvent[]) => {
    if (events.length === 0 || subscribers.size === 0) return;
    const text = events.map(frame).join('');
    for (const s of subscribers) s.send(text);
  };

  // Every world step goes through tick() so no stream event is ever produced and dropped.
  const tick = () => {
    const events = world.step();
    const real = now();
    if (real - lastOverviewReal >= 1_000) { lastOverviewReal = real; events.push({ event: 'overview', data: world.overview() }); }
    broadcast(events);
    if (world.shouldDropStream(dropWatermark)) for (const s of [...subscribers]) s.close();
    dropWatermark = world.elapsedSeconds;
  };
  const timer = setInterval(tick, options.tickMs ?? 100);

  function stream(signal: AbortSignal | null | undefined): Response {
    let sub: Subscriber | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        sub = {
          send: text => { if (open) controller.enqueue(encoder.encode(text)); },
          close: () => { if (!open) return; open = false; subscribers.delete(sub!); controller.close(); },
        };
        subscribers.add(sub);
        controller.enqueue(encoder.encode(`retry: 1000\n: demo stream\n\n${frame({ event: 'overview', data: world.overview() })}`));
        signal?.addEventListener('abort', () => {
          if (!open) return;
          open = false; subscribers.delete(sub!);
          controller.error(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      },
      cancel() { if (sub) subscribers.delete(sub); },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
  }

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input, 'http://demo.local');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    // Public player route (no token): the escape-hatch proof lookup.
    const proofRoute = /^\/v1\/account\/([^/]+)\/proof$/.exec(url.pathname);
    if (proofRoute && method === 'GET') {
      if (latency) await sleep(60 + Math.random() * 100, init?.signal);
      const r = world.proof(decodeURIComponent(proofRoute[1]!));
      return json(r.status, r.body);
    }
    if (!url.pathname.startsWith('/admin-api/')) return error(404, 'NOT_FOUND', 'Not an admin route.');
    const path = url.pathname.slice('/admin-api'.length);
    if (headers.get('authorization') !== `Bearer ${DEMO_TOKEN}`) return error(401, 'UNAUTHORIZED', 'Missing or invalid admin token.');
    if (method === 'GET' && path === '/stream') return stream(init?.signal);
    if (latency) await sleep(method === 'GET' ? 60 + Math.random() * 100 : 350 + Math.random() * 450, init?.signal);
    tick();
    const q = url.searchParams;
    if (method === 'GET') {
      switch (path) {
        case '/overview': return json(200, world.overview());
        case '/metrics': {
          const to = Number(q.get('to') ?? world.clock()); const from = Number(q.get('from') ?? to - 3_600_000); const step = Number(q.get('step') ?? 60_000);
          if (![to, from, step].every(Number.isFinite) || from > to) return error(400, 'BAD_QUERY', 'from, to and step must be numbers with from ≤ to.');
          return json(200, world.metrics(from, to, step));
        }
        case '/rtp': return json(200, world.rtp());
        case '/exposure': {
          const e = world.exposure(q.get('market') ?? 'btc-usd');
          return e ? json(200, e) : error(404, 'UNKNOWN_MARKET', `No market ${q.get('market')}.`);
        }
        case '/players': return json(200, world.players({ sort: q.get('sort'), limit: Number(q.get('limit') ?? 100), cursor: q.get('cursor'), q: q.get('q'), kind: q.get('kind') }));
        case '/bets': return json(200, world.bets({ limit: Number(q.get('limit') ?? 100), account: q.get('account'), market: q.get('market'), status: q.get('status'), start: q.get('start'), bandIndex: q.get('bandIndex') }));
        case '/chain': return json(200, world.chain());
        case '/defenses': return json(200, world.defensesView());
        case '/audit': return json(200, { rows: world.auditLog(Number(q.get('limit') ?? 200)) });
        default: {
          const m = /^\/players\/([^/]+)$/.exec(path);
          if (m) { const d = world.player(decodeURIComponent(m[1]!)); return d ? json(200, d) : error(404, 'UNKNOWN_ACCOUNT', 'No such account.'); }
          return error(404, 'NOT_FOUND', `No admin route GET ${path}.`);
        }
      }
    }
    if (method !== 'POST' && method !== 'PUT') return error(405, 'METHOD_NOT_ALLOWED', `${method} is not supported.`);
    let body: Record<string, unknown> = {};
    try {
      const text = typeof init?.body === 'string' ? init.body : '';
      body = text ? JSON.parse(text) as Record<string, unknown> : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) return error(400, 'BAD_BODY', 'Body must be a JSON object.');
    } catch { return error(400, 'BAD_BODY', 'Body must be JSON.'); }
    const { outcome, events } = world.write(method, path, body);
    broadcast(events);
    return outcome.ok ? json(200, outcome.ack) : error(outcome.status, outcome.code, outcome.message);
  };

  return { fetch, world, tick, stop: () => { clearInterval(timer); for (const s of [...subscribers]) s.close(); } };
}
