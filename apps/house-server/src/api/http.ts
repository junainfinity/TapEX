import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_BODY_BYTES = 16 * 1024;

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly headers: Record<string, string> = {}) { super(message); }
}

/** JSON with bigint as decimal strings; never throws on bigint. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

/** Hardening headers on every response (mirrors apps/feed-relay plus a locked-down CSP). */
export function secure(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) { res.end(); return; }
  const text = toJson(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: { code, message } }, headers);
}

/** Read a JSON object body: Content-Type must be JSON, size is bounded, duplicate-free parse. */
export async function readJsonBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > limit) { req.resume(); throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Body exceeds ${limit} bytes`); }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) { req.resume(); throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Body exceeds ${limit} bytes`); }
    chunks.push(buf);
  }
  if (size === 0) return {};
  if (type !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'INVALID_JSON', 'Body is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'INVALID_JSON', 'Body must be a JSON object');
  return parsed as Record<string, unknown>;
}

/** Reject keys outside the endpoint's contract so typos never silently do nothing. */
export function allowKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(body).filter(k => !allowed.includes(k));
  if (extra.length) throw new HttpError(400, 'VALIDATION_ERROR', `Unknown field(s): ${extra.join(', ')}`);
}

export interface Route<C> {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly pattern: string;
  readonly handler: (ctx: C, params: Readonly<Record<string, string>>) => Promise<void> | void;
}

/** Exact segment routing with `:param` segments; decoded params are bounded and must be printable. */
export class Router<C> {
  private readonly routes: { method: string; parts: string[]; handler: Route<C>['handler'] }[] = [];
  add(route: Route<C>): this { this.routes.push({ method: route.method, parts: route.pattern.split('/').filter(Boolean), handler: route.handler }); return this; }

  match(method: string, pathname: string): { handler: Route<C>['handler']; params: Record<string, string> } | { allow: string[] } | undefined {
    const segs = pathname.split('/').filter(Boolean);
    if (pathname !== '/' + segs.join('/') && pathname !== '/' + segs.join('/') + '/') return undefined;
    const allow: string[] = [];
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length && ok; i++) {
        const p = r.parts[i]!, s = segs[i]!;
        if (p.startsWith(':')) {
          let v: string;
          try { v = decodeURIComponent(s); } catch { ok = false; break; }
          if (!v || v.length > 200 || /[\u0000-\u001f/\\]/.test(v)) { ok = false; break; }
          params[p.slice(1)] = v;
        } else if (p !== s) ok = false;
      }
      if (!ok) continue;
      if (r.method === method) return { handler: r.handler, params };
      allow.push(r.method);
    }
    return allow.length ? { allow } : undefined;
  }
}

export function intParam(query: URLSearchParams, key: string, fallback: number, lo: number, hi: number): number {
  const raw = query.get(key);
  if (raw === null || raw === '') return fallback;
  if (!/^-?\d+$/.test(raw)) throw new HttpError(400, 'VALIDATION_ERROR', `${key} must be an integer`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < lo || n > hi) throw new HttpError(400, 'VALIDATION_ERROR', `${key} must be within ${lo}–${hi}`);
  return n;
}
