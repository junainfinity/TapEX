import { bearerMatches } from './admin-token.js';
import { clientIp, setCookie, type SessionView } from './auth.js';
import type { Ctx } from './context.js';
import { HttpError, Router, allowKeys, readJsonBody, sendJson } from './http.js';
import type { RateBucket } from './auth-rate.js';

/**
 * SIWE routes (Stage B). Mounted only when the server runs with player sessions (`ApiDeps.auth`; main.ts always
 * does). Without it the server keeps the Stage A player API for embedded tests.
 */
export function authRoutes(router: Router<Ctx>): void {
  router.add({ method: 'GET', pattern: '/v1/auth/nonce', handler: ctx => {
    const auth = requireAuth(ctx);
    auth.rateLimit('nonce', clientIp(ctx.req));
    sendJson(ctx.res, 200, auth.issueNonce());
  } });

  router.add({ method: 'POST', pattern: '/v1/auth/verify', handler: async ctx => {
    const auth = requireAuth(ctx);
    auth.checkOrigin(ctx.req);
    auth.rateLimit('verify', clientIp(ctx.req));
    const body = await readJsonBody(ctx.req);
    allowKeys(body, ['message', 'signature']);
    const r = await auth.verify(body['message'], body['signature']);
    if (!r.ok) throw new HttpError(r.status, r.code, r.message);
    ctx.deps.app.engine.flush();
    // A fresh token on every sign-in (no session fixation); any session the browser carried before is ended.
    if (auth.resolve(ctx.req)) auth.logout(ctx.req);
    setCookie(ctx.res, r.cookie);
    sendJson(ctx.res, 200, sessionJson(r.session, auth.chainId));
  } });

  router.add({ method: 'POST', pattern: '/v1/auth/logout', handler: async ctx => {
    const auth = requireAuth(ctx);
    auth.checkOrigin(ctx.req);
    const body = await readJsonBody(ctx.req);
    allowKeys(body, []);
    setCookie(ctx.res, auth.logout(ctx.req));
    sendJson(ctx.res, 200, { authenticated: false });
  } });

  router.add({ method: 'GET', pattern: '/v1/session', handler: ctx => {
    const auth = requireAuth(ctx);
    const peek = auth.resolve(ctx.req);
    auth.rateLimit('session', peek?.sid ?? clientIp(ctx.req));
    const { session, cookie } = auth.current(ctx.req);
    if (cookie) setCookie(ctx.res, cookie);
    sendJson(ctx.res, 200, session ? sessionJson(session, auth.chainId) : { authenticated: false });
  } });
}

function requireAuth(ctx: Ctx) {
  const auth = ctx.deps.auth;
  if (!auth) { ctx.req.resume(); throw new HttpError(404, 'NOT_FOUND', 'Player sessions are not enabled on this server'); }
  return auth;
}

function sessionJson(s: SessionView, chainId: number): Record<string, unknown> {
  return { authenticated: true, account: s.account, issuedAtMs: s.issuedAtMs, expiresAtMs: s.expiresAtMs, chainId };
}

/** The session of the request, if the server runs with sessions and the request carries a valid one. */
export function sessionOf(ctx: Ctx): SessionView | undefined { return ctx.deps.auth?.resolve(ctx.req); }

/**
 * The account a public (non-account-scoped) route may personalise for, e.g. `GET /v1/promo` or the per-account quote
 * grid: the session's account, or undefined. Never an account named by the client.
 */
export function sessionAccountOf(ctx: Ctx): string | undefined { return sessionOf(ctx)?.account; }

export interface AccountScope {
  /** Lower-case 0x account (or the Stage A body/path value in legacy mode). */
  readonly account: string;
  /** How the request was authorized. */
  readonly via: 'session' | 'stage-a' | 'dev-override' | 'admin';
  readonly session?: SessionView;
}

/**
 * Authorize an account-scoped player request (bets, withdrawals, account, proof).
 *
 * - With sessions (production): the account is the session's; a client-named account is ignored for authorization and
 *   must match it (else 403 ACCOUNT_MISMATCH). No session: 401 AUTH_REQUIRED, unless the explicit dev override
 *   MAYA_OPEN_PLAYER_API=testnet-unsafe is set (then the claimed account is used, as in Stage A), or `allowAdmin` and
 *   the admin bearer token is presented (the house console's escape-proof lookup).
 * - Without sessions (Stage A embedded server, tests): the claimed account, unchanged behaviour.
 */
export function authorizeAccount(ctx: Ctx, claimed: unknown, options: { readonly bucket?: RateBucket; readonly allowAdmin?: boolean; readonly stateChanging?: boolean } = {}): AccountScope | undefined {
  const auth = ctx.deps.auth;
  const claimedText = typeof claimed === 'string' && claimed !== '' ? claimed : undefined;
  if (claimed !== undefined && claimed !== null && typeof claimed !== 'string') throw new HttpError(400, 'VALIDATION_ERROR', 'account must be a string');
  if (!auth) return claimedText === undefined ? undefined : { account: claimedText, via: 'stage-a' };
  if (options.stateChanging) auth.checkOrigin(ctx.req);
  const session = auth.resolve(ctx.req);
  if (session) {
    if (options.bucket) auth.rateLimit(options.bucket, session.sid);
    if (claimedText !== undefined && claimedText.toLowerCase() !== session.account) throw new HttpError(403, 'ACCOUNT_MISMATCH', 'The request names another account than the signed-in one');
    return { account: session.account, via: 'session', session };
  }
  if (options.allowAdmin && bearerMatches(ctx.req.headers.authorization, ctx.deps.adminToken)) {
    return claimedText === undefined ? undefined : { account: claimedText, via: 'admin' };
  }
  if (options.bucket) auth.rateLimit(options.bucket, clientIp(ctx.req));
  if (ctx.deps.openPlayerApi) return claimedText === undefined ? undefined : { account: claimedText, via: 'dev-override' };
  ctx.req.resume();
  throw new HttpError(401, 'AUTH_REQUIRED', 'Sign in with your wallet first (GET /v1/auth/nonce, POST /v1/auth/verify)');
}
