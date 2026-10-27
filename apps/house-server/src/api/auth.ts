import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPublicClient, custom, http, type Hex, type PublicClient } from 'viem';
import { generateSiweNonce, parseSiweMessage, verifySiweMessage } from 'viem/siwe';
import { isAddress } from '../util.js';
import { HttpError } from './http.js';
import { RateLimiter, type RateBucket } from './auth-rate.js';

/**
 * Stage B player authentication: Sign-In with Ethereum (EIP-4361) and an opaque session cookie.
 *
 * - `GET /v1/auth/nonce` issues a single-use nonce (5 min TTL). Every verify attempt that names a nonce consumes it,
 *   so a nonce can never be replayed, even after a failed attempt.
 * - `POST /v1/auth/verify` checks the message strictly against MAYA_PUBLIC_ORIGIN (domain, URI origin, scheme), the
 *   house's chain id, version 1, issuance and expiry times, then the signature (viem/siwe `verifySiweMessage`; EOAs by
 *   ECDSA recovery, contract wallets via ERC-1271/6492 when an RPC is configured).
 * - The session is a random 256-bit token in an HttpOnly, SameSite=Strict cookie (Secure when the origin is https).
 *   Only its SHA-256 is stored. Sessions live 12 h from sign-in; the token is rotated on sign-in and after
 *   `rotateAfterMs` (the previous token keeps working for `rotationGraceMs` so requests in flight do not fail).
 * - State is in memory: a restart signs everybody out (they sign in again; no money state depends on a session).
 */

export const SESSION_COOKIE = 'maya_session';
export const SIWE_STATEMENT = 'Sign in to Maya-Live on testnet. tOPEN is a test mock of $OPEN and has no value.';

export interface AuthOptions {
  /** Origin the players' browsers load the game from (MAYA_PUBLIC_ORIGIN), e.g. http://127.0.0.1:8180. */
  readonly publicOrigin: string;
  /** Chain id a SIWE message must name (the house's chain; the offline vault uses the local chain id 31337). */
  readonly chainId: number;
  /** Optional RPC for ERC-1271 / ERC-6492 contract-wallet signatures; EOAs verify offline either way. */
  readonly rpcUrl?: string | undefined;
  readonly sessionTtlMs?: number;
  readonly nonceTtlMs?: number;
  readonly rotateAfterMs?: number;
  readonly rotationGraceMs?: number;
  /** Tolerated clock skew for `issuedAt` in the future / `notBefore`. */
  readonly clockSkewMs?: number;
  readonly maxNonces?: number;
  readonly maxSessions?: number;
  /** Wall clock (injectable for tests). */
  readonly now?: () => number;
  /** Per-bucket rate limits (requests per window); see DEFAULT_RATE_LIMITS. */
  readonly rateLimits?: Partial<Record<RateBucket, { readonly limit: number; readonly windowMs: number }>>;
  /** Called after a successful sign-in with the (lower-case) account; the server registers the player here. */
  readonly onSignIn?: (account: string) => void;
}

export interface SessionView {
  readonly account: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  /** Stable id of the sign-in (not the cookie token); used as a rate-limit key. */
  readonly sid: string;
}

interface SessionRecord extends SessionView {
  /** When this token was minted (rotation age). */
  readonly tokenMintedMs: number;
  /** Set when a newer token replaced this one: the token stops working at this time. */
  retiredAtMs?: number;
}

export type VerifyResult =
  | { readonly ok: true; readonly session: SessionView; readonly cookie: string }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };

const NONCE_RE = /^[A-Za-z0-9]{8,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Parse one cookie value from a Cookie header (first occurrence wins; values are not decoded). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (typeof header !== 'string' || header.length > 8192) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** The request's client IP for rate limits (the socket peer; a reverse proxy must be trusted explicitly, see DEVIATIONS). */
export function clientIp(req: IncomingMessage): string { return req.socket.remoteAddress ?? 'unknown'; }

export class PlayerAuth {
  readonly publicOrigin: string;
  readonly domain: string;
  readonly scheme: string;
  readonly chainId: number;
  readonly secure: boolean;
  readonly sessionTtlMs: number;
  readonly nonceTtlMs: number;
  readonly rotateAfterMs: number;
  readonly rotationGraceMs: number;
  readonly limiter: RateLimiter;
  private readonly clockSkewMs: number;
  private readonly maxNonces: number;
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly client: PublicClient;
  private readonly onSignIn: ((account: string) => void) | undefined;
  private readonly nonces = new Map<string, number>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly requestOwners = new Map<string, string>();

  constructor(options: AuthOptions) {
    let origin: URL;
    try { origin = new URL(options.publicOrigin); } catch { throw new Error(`MAYA_PUBLIC_ORIGIN is not a URL: ${options.publicOrigin}`); }
    if ((origin.protocol !== 'http:' && origin.protocol !== 'https:') || origin.origin !== options.publicOrigin.replace(/\/$/, '')) throw new Error(`MAYA_PUBLIC_ORIGIN must be a bare http(s) origin such as https://game.example (got ${options.publicOrigin})`);
    if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0) throw new Error(`SIWE chain id must be a positive integer (got ${options.chainId})`);
    this.publicOrigin = origin.origin;
    this.domain = origin.host;
    this.scheme = origin.protocol.slice(0, -1);
    this.secure = origin.protocol === 'https:';
    this.chainId = options.chainId;
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 3_600_000;
    this.nonceTtlMs = options.nonceTtlMs ?? 5 * 60_000;
    this.rotateAfterMs = options.rotateAfterMs ?? 15 * 60_000;
    this.rotationGraceMs = options.rotationGraceMs ?? 30_000;
    this.clockSkewMs = options.clockSkewMs ?? 60_000;
    this.maxNonces = options.maxNonces ?? 20_000;
    this.maxSessions = options.maxSessions ?? 100_000;
    this.now = options.now ?? Date.now;
    this.onSignIn = options.onSignIn;
    this.limiter = new RateLimiter({ now: this.now, ...(options.rateLimits ? { limits: options.rateLimits } : {}) });
    // EOAs verify by ECDSA recovery without a node. Without an RPC every eth_call fails, verifyHash falls back to
    // recovery, and a signature that does not recover is refused (contract wallets need MAYA_RPC_URL/network RPC).
    const transport = options.rpcUrl ? http(options.rpcUrl, { timeout: 5_000, retryCount: 0 }) : custom({ request: async () => { throw new Error('no RPC configured for contract-wallet signatures'); } });
    this.client = createPublicClient({ transport }) as PublicClient;
  }

  /** What a client needs to build the SIWE message. */
  issueNonce(): { nonce: string; expiresAtMs: number; domain: string; uri: string; chainId: number; version: '1'; statement: string } {
    const now = this.now();
    this.pruneNonces(now);
    if (this.nonces.size >= this.maxNonces) throw new HttpError(503, 'AUTH_BUSY', 'Too many sign-ins in progress; try again shortly', { 'Retry-After': '30' });
    const nonce = generateSiweNonce().slice(0, 32);
    this.nonces.set(nonce, now + this.nonceTtlMs);
    return { nonce, expiresAtMs: now + this.nonceTtlMs, domain: this.domain, uri: this.publicOrigin, chainId: this.chainId, version: '1', statement: SIWE_STATEMENT };
  }

  /** Verify a signed SIWE message and open a session. The nonce named by the message is consumed on every attempt. */
  async verify(message: unknown, signature: unknown): Promise<VerifyResult> {
    const refuse = (code: string, text: string, status = 401): VerifyResult => ({ ok: false, status, code, message: text });
    if (typeof message !== 'string' || message.length === 0 || message.length > 4096) return refuse('INVALID_MESSAGE', 'message must be an EIP-4361 string of at most 4096 characters', 400);
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{2,4096}$/.test(signature)) return refuse('INVALID_SIGNATURE', 'signature must be a 0x hex string', 400);
    let parsed: ReturnType<typeof parseSiweMessage>;
    try { parsed = parseSiweMessage(message); } catch { return refuse('INVALID_MESSAGE', 'message is not an EIP-4361 message', 400); }
    const now = this.now();
    // Consume the nonce first: whatever else is wrong, it can never be used again.
    const nonce = typeof parsed.nonce === 'string' ? parsed.nonce : '';
    const nonceExpiry = NONCE_RE.test(nonce) ? this.nonces.get(nonce) : undefined;
    if (nonceExpiry !== undefined) this.nonces.delete(nonce);
    if (!parsed.domain || !parsed.address || !parsed.uri || !parsed.version || parsed.chainId === undefined || !nonce) return refuse('INVALID_MESSAGE', 'message is not a complete EIP-4361 message (domain, address, URI, version, chain id, nonce)', 400);
    if (nonceExpiry === undefined) return refuse('NONCE_INVALID', 'Unknown or already used nonce: request a new one');
    if (now > nonceExpiry) return refuse('NONCE_EXPIRED', 'The nonce expired: request a new one');
    if (parsed.domain !== this.domain) return refuse('DOMAIN_MISMATCH', `The message is for ${String(parsed.domain)}, not ${this.domain}`);
    let uriOrigin: string | undefined;
    try { uriOrigin = parsed.uri ? new URL(parsed.uri).origin : undefined; } catch { uriOrigin = undefined; }
    if (uriOrigin !== this.publicOrigin) return refuse('URI_MISMATCH', `The message URI must be on ${this.publicOrigin}`);
    if (parsed.scheme !== undefined && parsed.scheme !== this.scheme) return refuse('SCHEME_MISMATCH', `The message scheme must be ${this.scheme}`);
    if (parsed.version !== '1') return refuse('VERSION_UNSUPPORTED', 'Only SIWE version 1 is supported');
    if (parsed.chainId !== this.chainId) return refuse('CHAIN_MISMATCH', `The message must name chain ${this.chainId}`);
    if (!parsed.address || !isAddress(parsed.address)) return refuse('INVALID_MESSAGE', 'The message names no valid address', 400);
    const issued = parsed.issuedAt?.getTime();
    if (issued === undefined || !Number.isFinite(issued)) return refuse('INVALID_MESSAGE', 'The message must carry an Issued At time', 400);
    if (issued > now + this.clockSkewMs || issued < now - this.nonceTtlMs - this.clockSkewMs) return refuse('MESSAGE_STALE', 'Issued At is outside the sign-in window');
    const expiration = parsed.expirationTime?.getTime();
    if (expiration !== undefined && (!Number.isFinite(expiration) || expiration <= now)) return refuse('MESSAGE_EXPIRED', 'The message has expired');
    const notBefore = parsed.notBefore?.getTime();
    if (notBefore !== undefined && (!Number.isFinite(notBefore) || notBefore > now + this.clockSkewMs)) return refuse('MESSAGE_NOT_YET_VALID', 'The message is not valid yet');
    let valid = false;
    try {
      valid = await verifySiweMessage(this.client, { message, signature: signature as Hex, domain: this.domain, nonce, time: new Date(now) });
    } catch { valid = false; }
    if (!valid) return refuse('SIGNATURE_INVALID', 'The signature does not match the message address');
    const account = parsed.address.toLowerCase();
    this.onSignIn?.(account);
    const opened = this.open(account, now);
    return { ok: true, session: opened.view, cookie: opened.cookie };
  }

  /** The session carried by the request (undefined when absent, unknown, retired past its grace, or expired). */
  resolve(req: IncomingMessage): SessionView | undefined {
    const found = this.lookup(req);
    return found ? this.view(found) : undefined;
  }

  /** `GET /v1/session`: the session and, when its token is old enough, a rotated cookie. */
  current(req: IncomingMessage): { session: SessionView | undefined; cookie?: string } {
    const record = this.lookup(req);
    if (!record) return { session: undefined };
    const now = this.now();
    if (record.retiredAtMs === undefined && now - record.tokenMintedMs >= this.rotateAfterMs) {
      record.retiredAtMs = now + this.rotationGraceMs;
      const token = randomBytes(32).toString('base64url');
      this.sessions.set(hashToken(token), { account: record.account, issuedAtMs: record.issuedAtMs, expiresAtMs: record.expiresAtMs, sid: record.sid, tokenMintedMs: now });
      return { session: this.view(record), cookie: this.cookie(token, record.expiresAtMs - now) };
    }
    return { session: this.view(record) };
  }

  /** End the request's session (every token of that sign-in) and return a clearing cookie. */
  logout(req: IncomingMessage): string {
    const found = this.lookup(req);
    if (found) for (const [key, s] of this.sessions) if (s.sid === found.sid) this.sessions.delete(key);
    return this.clearCookie();
  }

  clearCookie(): string { return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.secure ? '; Secure' : ''}`; }

  /** Refuse a state-changing request whose Origin header names another site (SameSite=Strict is the first line). */
  checkOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== this.publicOrigin) throw new HttpError(403, 'ORIGIN_MISMATCH', `Requests must come from ${this.publicOrigin}`);
  }

  /** Count one request against `bucket` for `key`; throws 429 when over the limit. */
  rateLimit(bucket: RateBucket, key: string): void {
    const r = this.limiter.take(bucket, key);
    if (!r.ok) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests; slow down', { 'Retry-After': String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))) });
  }

  /**
   * Remember which account sent a placement, so `GET /v1/bets/by-request/:id` can refuse other accounts even for a
   * rejection (the engine's rejection receipts carry no account). Bounded like the engine's rejection memory.
   */
  rememberRequest(requestId: string, account: string): void {
    if (this.requestOwners.has(requestId)) return;
    this.requestOwners.set(requestId, account);
    if (this.requestOwners.size > 100_000) { const oldest = this.requestOwners.keys().next().value; if (oldest !== undefined) this.requestOwners.delete(oldest); }
  }
  requestOwner(requestId: string): string | undefined { return this.requestOwners.get(requestId); }

  /** Test/diagnostic counts. */
  stats(): { nonces: number; sessions: number } { return { nonces: this.nonces.size, sessions: this.sessions.size }; }

  private open(account: string, now: number): { view: SessionView; cookie: string } {
    this.pruneSessions(now);
    if (this.sessions.size >= this.maxSessions) {
      // Evict the oldest token (Map keeps insertion order) rather than refusing sign-ins.
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    const record: SessionRecord = { account, issuedAtMs: now, expiresAtMs: now + this.sessionTtlMs, sid: randomBytes(12).toString('base64url'), tokenMintedMs: now };
    this.sessions.set(hashToken(token), record);
    return { view: this.view(record), cookie: this.cookie(token, this.sessionTtlMs) };
  }

  private lookup(req: IncomingMessage): SessionRecord | undefined {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token || !TOKEN_RE.test(token)) return undefined;
    // Tokens are 256-bit random values and only their SHA-256 is stored, so the Map lookup leaks nothing useful.
    const key = hashToken(token);
    const record = this.sessions.get(key);
    if (!record) return undefined;
    const now = this.now();
    if (now >= record.expiresAtMs || (record.retiredAtMs !== undefined && now >= record.retiredAtMs)) { this.sessions.delete(key); return undefined; }
    return record;
  }

  private view(r: SessionRecord): SessionView { return { account: r.account, issuedAtMs: r.issuedAtMs, expiresAtMs: r.expiresAtMs, sid: r.sid }; }

  private cookie(token: string, maxAgeMs: number): string {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor(maxAgeMs / 1000))}${this.secure ? '; Secure' : ''}`;
  }

  private pruneNonces(now: number): void {
    if (this.nonces.size < 1024 && Math.random() > 0.05) return;
    for (const [nonce, expiry] of this.nonces) if (now > expiry) this.nonces.delete(nonce);
  }

  private pruneSessions(now: number): void {
    if (this.sessions.size < 1024 && Math.random() > 0.05) return;
    for (const [key, s] of this.sessions) if (now >= s.expiresAtMs || (s.retiredAtMs !== undefined && now >= s.retiredAtMs)) this.sessions.delete(key);
  }
}

/** Attach a Set-Cookie header (kept separate so handlers can add it before sendJson writes the head). */
export function setCookie(res: ServerResponse, cookie: string): void {
  const prior = res.getHeader('Set-Cookie');
  const list = Array.isArray(prior) ? prior.map(String) : typeof prior === 'string' ? [prior] : [];
  res.setHeader('Set-Cookie', [...list, cookie]);
}
