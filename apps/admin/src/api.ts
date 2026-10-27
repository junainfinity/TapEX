/**
 * Typed client for the admin API (SPEC §7). Every call resolves to an
 * `ApiResult` — it never throws — so pages render server error codes inline.
 *
 * Writes are never retried automatically: a timeout, a network failure, any
 * 5xx or a chain error on a write is reported as an *unknown outcome*, because
 * the server may already have applied and journaled the action (SPEC §1.3: a
 * timeout is not a rejection). Only an explicit retry of the identical request
 * with the same Idempotency-Key is safe (see write-session.ts).
 */
import {
  DecodeFailure, decodeAudit, decodeBets, decodeChain, decodeDefenses, decodeExposure, decodeMetrics, decodeOverview, decodePlayerDetail, decodePlayers,
  decodeProof, decodePromo, decodeRtp, decodeWriteAck,
} from './decode.js';
import type {
  AccountProof, ApiErrorBody, DefensePatch, PlayerKind, ApiResult, AuditEntry, BetPage, Centi, ChainState, DefensesView, Exposure, LegStatus, LimitsConfig, MetricsSeries, Overview, PlayerDetail, PlayerPage,
  PricingConfig, PromoLegacyView, PromoPatch, PromoTierId, PromoView, RtpReport, SimState, WriteAck,
} from './types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const API_PREFIX = '/admin-api';
/** Player API prefix: only the public, unauthenticated proof lookup is used (the admin token is never sent there). */
export const PLAYER_PREFIX = '/v1';

export interface ApiClientOptions {
  /** Origin prefix; '' means same origin (the Vite dev server proxies /admin-api). */
  readonly baseUrl?: string;
  readonly getToken: () => string | null;
  readonly fetch?: FetchLike;
  readonly readTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  /** Called on HTTP 401 so the shell can ask for a fresh token. */
  readonly onUnauthorized?: () => void;
  /** Idempotency-Key generator for writes (injectable for tests). */
  readonly newRequestId?: () => string;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT';

/** A fully described write, built before submission so the confirm dialog can show it verbatim. */
export interface WriteRequest {
  readonly method: 'POST' | 'PUT';
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface WriteMeta {
  readonly reason: string;
  /** Exact action name; required by the server for dangerous actions. */
  readonly confirm?: string;
}

export type PlayerAction = 'flag' | 'unflag' | 'block' | 'unblock';
export type PlayerSortKey = 'balance' | 'handle' | 'pnl' | 'bets' | 'rtp' | 'firstSeen';

export interface PlayersQuery {
  readonly sort?: PlayerSortKey;
  readonly dir?: 'asc' | 'desc';
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly q?: string;
  /** Server-side type filter (house-server extension). */
  readonly kind?: PlayerKind;
}

export interface BetsQuery {
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly account?: string;
  readonly market?: string;
  readonly status?: LegStatus;
  /** Server-side cell filter (house-server extension): window start and absolute band index. */
  readonly start?: number;
  readonly bandIndex?: number;
}

export interface MetricsQuery { readonly from: number; readonly to: number; readonly step: number }

/** Client-side codes for a write whose outcome is unknown (no HTTP answer). */
export const UNKNOWN_OUTCOME_CODES = new Set(['WRITE_TIMEOUT_UNKNOWN_OUTCOME', 'WRITE_NETWORK_UNKNOWN_OUTCOME']);

/**
 * Server codes that leave a write's outcome open whatever the HTTP status: a chain transaction that timed
 * out may still be mined (house-server `CHAIN_ERROR` for TX_TIMEOUT, chain/tx.ts).
 */
export const SERVER_UNKNOWN_OUTCOME_CODES = new Set(['CHAIN_ERROR', 'TX_TIMEOUT', 'TX_UNKNOWN_OUTCOME', 'UNKNOWN_OUTCOME']);

/**
 * True when a failed write may still have been applied: no answer at all (timeout, dropped connection),
 * any 5xx (a proxy's 502 after the server applied the write, a 500 half way through) or a chain code
 * above. Such a write must never be resubmitted with a new Idempotency-Key.
 */
export function isUnknownOutcome(error: ApiErrorBody): boolean {
  return error.outcome === 'unknown' || UNKNOWN_OUTCOME_CODES.has(error.code);
}

function query(params: Readonly<Record<string, string | number | null | undefined>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function withMeta(fields: Readonly<Record<string, unknown>>, meta: WriteMeta): Record<string, unknown> {
  const body: Record<string, unknown> = { ...fields, reason: meta.reason };
  if (meta.confirm !== undefined) body['confirm'] = meta.confirm;
  return body;
}

const seg = (value: string) => encodeURIComponent(value);

/** Pure builders for every write endpoint in SPEC §7. */
export const writes = {
  pauseMarket: (market: string, meta: WriteMeta): WriteRequest => ({ method: 'POST', path: `/markets/${seg(market)}/pause`, body: withMeta({}, meta) }),
  resumeMarket: (market: string, meta: WriteMeta): WriteRequest => ({ method: 'POST', path: `/markets/${seg(market)}/resume`, body: withMeta({}, meta) }),
  pauseAll: (meta: WriteMeta): WriteRequest => ({ method: 'POST', path: '/pause-all', body: withMeta({}, meta) }),
  resumeAll: (meta: WriteMeta): WriteRequest => ({ method: 'POST', path: '/resume-all', body: withMeta({}, meta) }),
  pricing: (patch: Partial<PricingConfig>, meta: WriteMeta): WriteRequest => ({ method: 'PUT', path: '/pricing', body: withMeta(patch, meta) }),
  launch: (patch: Partial<{ enabled: boolean; edge: number; untilPlayers: number }>, meta: WriteMeta): WriteRequest => ({ method: 'PUT', path: '/launch', body: withMeta(patch, meta) }),
  limits: (patch: Partial<LimitsConfig>, meta: WriteMeta): WriteRequest => ({ method: 'PUT', path: '/limits', body: withMeta(patch, meta) }),
  refit: (meta: WriteMeta): WriteRequest => ({ method: 'POST', path: '/refit', body: withMeta({}, meta) }),
  player: (account: string, action: PlayerAction, meta: WriteMeta): WriteRequest => ({ method: 'POST', path: `/players/${seg(account)}/${action}`, body: withMeta({}, meta) }),
  fundHouse: (amountCenti: Centi, meta: WriteMeta): WriteRequest => ({ method: 'POST', path: '/treasury/fund', body: withMeta({ amountCenti }, meta) }),
  withdrawSurplus: (amountCenti: Centi, meta: WriteMeta): WriteRequest => ({ method: 'POST', path: '/treasury/withdraw-surplus', body: withMeta({ amountCenti }, meta) }),
  attest: (meta: WriteMeta): WriteRequest => ({ method: 'POST', path: '/treasury/attest', body: withMeta({}, meta) }),
  vaultPause: (meta: WriteMeta): WriteRequest => ({ method: 'POST', path: '/vault/pause', body: withMeta({}, meta) }),
  vaultUnpause: (meta: WriteMeta): WriteRequest => ({ method: 'POST', path: '/vault/unpause', body: withMeta({}, meta) }),
  sim: (patch: Partial<SimState>, meta: WriteMeta): WriteRequest => ({ method: 'POST', path: '/sim', body: withMeta(patch, meta) }),
  /** SPEC-10 defenses (house-server extension; confirm "defenses-disable" / "edge-change"). */
  defenses: (patch: DefensePatch, meta: WriteMeta): WriteRequest => ({ method: 'PUT', path: '/defenses', body: withMeta(patch as Readonly<Record<string, unknown>>, meta) }),
  /** SPEC-11 timelocked signer rotation and excess sweep (confirm "signer-propose", "signer-accept", "sweep-excess"; cancel needs a reason only). */
  signerPropose: (address: string, meta: WriteMeta): WriteRequest => ({ method: 'POST', path: '/vault/signer/propose', body: withMeta({ address }, meta) }),
  signerAccept: (meta: WriteMeta): WriteRequest => ({ method: 'POST', path: '/vault/signer/accept', body: withMeta({}, meta) }),
  signerCancel: (meta: WriteMeta): WriteRequest => ({ method: 'POST', path: '/vault/signer/cancel', body: withMeta({}, meta) }),
  sweepExcess: (to: string, meta: WriteMeta): WriteRequest => ({ method: 'POST', path: '/vault/sweep-excess', body: withMeta({ to }, meta) }),
  /** SPEC-12 promo tiers: edit/extend/disable (confirm "edge-change" when an edge moves > 2 pts), end the current tier ("promo-end-tier"), resume after a budget breaker ("promo-resume"). */
  promo: (patch: PromoPatch, meta: WriteMeta): WriteRequest => ({ method: 'PUT', path: '/promo', body: withMeta(patch as Readonly<Record<string, unknown>>, meta) }),
  promoEndTier: (meta: WriteMeta): WriteRequest => ({ method: 'POST', path: '/promo/end-tier', body: withMeta({}, meta) }),
  promoResume: (tier: PromoTierId | undefined, meta: WriteMeta): WriteRequest => ({ method: 'POST', path: '/promo/resume', body: withMeta(tier === undefined ? {} : { tier }, meta) }),
} as const;

/** A fresh Idempotency-Key (one per operator intent; reused only to retry that same request). */
export function defaultRequestId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class AdminApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly readTimeoutMs: number;
  private readonly writeTimeoutMs: number;

  constructor(private readonly options: ApiClientOptions) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    const f = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.fetchImpl = f;
    this.readTimeoutMs = options.readTimeoutMs ?? 10_000;
    this.writeTimeoutMs = options.writeTimeoutMs ?? 30_000;
  }

  url(path: string): string { return `${this.baseUrl}${API_PREFIX}${path}`; }

  /** Headers for any authenticated request, including the SSE stream. */
  authHeaders(): Record<string, string> {
    const token = this.options.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  get fetcher(): FetchLike { return this.fetchImpl; }

  overview(): Promise<ApiResult<Overview>> { return this.get('/overview', decodeOverview); }
  metrics(q: MetricsQuery): Promise<ApiResult<MetricsSeries>> { return this.get(`/metrics${query({ from: q.from, to: q.to, step: q.step })}`, decodeMetrics); }
  rtp(): Promise<ApiResult<RtpReport>> { return this.get('/rtp', decodeRtp); }
  exposure(market: string): Promise<ApiResult<Exposure>> { return this.get(`/exposure${query({ market })}`, decodeExposure); }
  players(q: PlayersQuery = {}): Promise<ApiResult<PlayerPage>> {
    const sort = q.sort ? `${q.dir === 'asc' ? '' : '-'}${q.sort}` : undefined;
    return this.get(`/players${query({ sort, limit: q.limit, cursor: q.cursor, q: q.q?.trim(), kind: q.kind })}`, decodePlayers);
  }
  player(account: string): Promise<ApiResult<PlayerDetail>> { return this.get(`/players/${seg(account)}`, decodePlayerDetail); }
  bets(q: BetsQuery = {}): Promise<ApiResult<BetPage>> {
    return this.get(`/bets${query({ limit: q.limit, cursor: q.cursor, account: q.account, market: q.market, status: q.status, start: q.start, bandIndex: q.bandIndex })}`, decodeBets);
  }
  chain(): Promise<ApiResult<ChainState>> { return this.get('/chain', decodeChain); }
  audit(limit?: number): Promise<ApiResult<readonly AuditEntry[]>> { return this.get(`/audit${query({ limit })}`, decodeAudit); }
  defenses(): Promise<ApiResult<DefensesView>> { return this.get('/defenses', decodeDefenses); }
  /** SPEC-12 promo tiers (configured: false on a legacy launch-boost server). */
  promo(): Promise<ApiResult<PromoView | PromoLegacyView>> { return this.get('/promo', decodePromo); }

  /**
   * Escape-hatch proof for an on-chain account from the public player route. The admin token is not
   * sent there. A 503 PROOF_UNAVAILABLE body is decoded: it still carries the attestation and escape status.
   */
  proof(address: string): Promise<ApiResult<AccountProof>> {
    return this.request('GET', `/account/${seg(address)}/proof`, decodeProof, undefined, {}, { prefix: PLAYER_PREFIX, auth: false, acceptStatus: [503] });
  }

  /**
   * Submit a write exactly once. Never retried here. `idempotencyKey` is the key of the operator's intent:
   * pass the same key only to resend the identical request after an unknown outcome (the server then
   * replays its stored answer instead of applying the action again); omit it for a new intent.
   */
  async send(request: WriteRequest, idempotencyKey?: string): Promise<ApiResult<WriteAck>> {
    const reason = request.body['reason'];
    if (typeof reason !== 'string' || reason.trim() === '') {
      return { ok: false, error: { code: 'REASON_REQUIRED', message: 'Every admin write requires a reason.', status: 0 } };
    }
    const key = idempotencyKey ?? (this.options.newRequestId ?? defaultRequestId)();
    return this.request(request.method, request.path, decodeWriteAck, JSON.stringify(request.body), { 'Idempotency-Key': key });
  }

  private get<T>(path: string, decode: (raw: unknown) => T): Promise<ApiResult<T>> {
    return this.request('GET', path, decode);
  }

  private async request<T>(
    method: HttpMethod, path: string, decode: (raw: unknown) => T, body?: string, extraHeaders: Record<string, string> = {},
    route: { readonly prefix?: string; readonly auth?: boolean; readonly acceptStatus?: readonly number[] } = {},
  ): Promise<ApiResult<T>> {
    const isWrite = method !== 'GET';
    const controller = new AbortController();
    const timeoutMs = isWrite ? this.writeTimeoutMs : this.readTimeoutMs;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const headers: Record<string, string> = { Accept: 'application/json', ...(route.auth === false ? {} : this.authHeaders()), ...extraHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${route.prefix ?? API_PREFIX}${path}`, { method, headers, ...(body === undefined ? {} : { body }), signal: controller.signal, cache: 'no-store' });
    } catch (error) {
      clearTimeout(timer);
      if (isWrite) {
        return timedOut
          ? { ok: false, error: { code: 'WRITE_TIMEOUT_UNKNOWN_OUTCOME', message: `No response within ${Math.round(timeoutMs / 1000)} s. The action may still have been applied — check the audit log before retrying.`, status: 0 } }
          : { ok: false, error: { code: 'WRITE_NETWORK_UNKNOWN_OUTCOME', message: 'The connection failed while sending. The action may or may not have been applied — check the audit log before retrying.', status: 0 } };
      }
      return timedOut
        ? { ok: false, error: { code: 'TIMEOUT', message: `No response within ${Math.round(timeoutMs / 1000)} s.`, status: 0 } }
        : { ok: false, error: { code: 'NETWORK', message: error instanceof Error ? error.message : 'Network request failed.', status: 0 } };
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      clearTimeout(timer);
      return { ok: false, error: { code: isWrite ? 'WRITE_NETWORK_UNKNOWN_OUTCOME' : 'NETWORK', message: 'The response body could not be read.', status: response.status } };
    }
    clearTimeout(timer);
    let parsed: unknown = undefined;
    let parseFailed = false;
    if (text !== '') {
      try { parsed = JSON.parse(text); } catch { parseFailed = true; }
    }
    // Some routes answer a documented non-2xx status with a body worth rendering (the proof's 503).
    const accepted = route.acceptStatus?.includes(response.status) === true && !parseFailed && parsed !== undefined;
    if (!response.ok && !accepted) {
      if (response.status === 401 && route.auth !== false) this.options.onUnauthorized?.();
      const errorBody = parsed && typeof parsed === 'object' ? (parsed as { error?: { code?: unknown; message?: unknown } }).error : undefined;
      const code = typeof errorBody?.code === 'string' ? errorBody.code : response.status === 401 ? 'UNAUTHORIZED' : `HTTP_${response.status}`;
      const message = typeof errorBody?.message === 'string' ? errorBody.message : (response.statusText || text.slice(0, 200) || 'Request failed.');
      // A write answered 5xx (e.g. the dev proxy's empty 502 after the server applied it) or with a chain code may have been applied.
      if (isWrite && (response.status >= 500 || SERVER_UNKNOWN_OUTCOME_CODES.has(code))) return { ok: false, error: { code, message, status: response.status, outcome: 'unknown' } };
      return { ok: false, error: { code, message, status: response.status } };
    }
    // A 2xx write was applied; an odd body must not read as a failure an operator might retry.
    if (isWrite && (parseFailed || !parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
      return { ok: true, data: decode({ ok: true, httpStatus: response.status, note: parseFailed ? 'Acknowledged; the response body was not JSON.' : 'Acknowledged.' }) };
    }
    if (parseFailed) return { ok: false, error: { code: 'BAD_RESPONSE', message: 'The server returned a response that is not JSON.', status: response.status } };
    try {
      return { ok: true, data: decode(parsed) };
    } catch (error) {
      const message = error instanceof DecodeFailure ? error.message : error instanceof Error ? error.message : 'Unexpected response shape.';
      return { ok: false, error: { code: 'BAD_RESPONSE', message, status: response.status } };
    }
  }
}
