import { randomUUID } from 'node:crypto';
import type { MarketId } from '@maya/contracts';
import { toWei } from '@maya/house';
import { ledgerAccountOf } from '../engine/engine.js';
import type { BetIntent, PlaceResult } from '../engine/types.js';
import { isAddress } from '../util.js';
import { authorizeAccount, sessionOf } from './auth-routes.js';
import type { Ctx } from './context.js';
import { HttpError, Router, allowKeys, readJsonBody, sendJson } from './http.js';
import { legJson, quotesView } from './views.js';

/** HTTP status for a placement rejection; a conflict is 409, every other typed rejection 422. */
function rejectionStatus(r: Extract<PlaceResult, { status: 'rejected' }>): number {
  return r.reason === 'REQUEST_CONFLICT' ? 409 : r.reason === 'INVALID_REQUEST' ? 400 : 422;
}

/** Suggested poll interval while a placement is held (the hold ends at the next first-seen sample). */
export const PENDING_RETRY_MS = 250;

export function placementBody(ctx: Ctx, r: PlaceResult): { status: number; body: Record<string, unknown> } {
  if (r.status === 'accepted') return { status: 200, body: { status: 'accepted', newlyCommitted: r.newlyCommitted, leg: legJson(ctx.deps.app.engine, r.leg) } };
  // SPEC-10 acceptance hold: not a rejection and not yet a bet; poll GET /v1/bets/by-request/:id (or re-send the same intent).
  if (r.status === 'pending') return { status: 202, body: { status: 'pending', newlyHeld: r.newlyHeld, requestId: r.hold.requestId, hold: { ...r.hold }, retryAfterMs: PENDING_RETRY_MS } };
  return { status: rejectionStatus(r), body: { status: 'rejected', reason: r.reason, ...(r.message ? { message: r.message } : {}), ...(r.limit ? { limit: r.limit } : {}), error: { code: r.reason, message: r.message ?? r.reason } } };
}

/** The account a receipt belongs to (a rejection carries none: the API remembers who sent the request). */
function receiptOwner(ctx: Ctx, requestId: string, r: PlaceResult): string | undefined {
  if (r.status === 'accepted') return r.leg.account.toLowerCase();
  if (r.status === 'pending') return r.hold.account.toLowerCase();
  return ctx.deps.auth?.requestOwner(requestId);
}

function marketParam(ctx: Ctx): MarketId {
  const m = ctx.url.searchParams.get('market');
  if (!m || !ctx.deps.app.engine.markets.includes(m as MarketId)) throw new HttpError(400, 'VALIDATION_ERROR', `market must be one of ${ctx.deps.app.engine.markets.join(', ')}`);
  return m as MarketId;
}

/**
 * Player API. Placement never takes odds from the client: it names a stored quote and a stake, and is idempotent by
 * requestId. With `deps.auth` (Stage B, main.ts) every account-scoped route takes the account from the SIWE session
 * (see auth-routes.ts `authorizeAccount`); without it (embedded Stage A server) the body/path account is used as before.
 */
export function playerRoutes(router: Router<Ctx>): void {
  router.add({ method: 'GET', pattern: '/v1/health', handler: ctx => sendJson(ctx.res, 200, { status: 'ok', clockMs: ctx.deps.app.engine.nowMs, feed: ctx.deps.app.feed.mode, network: ctx.deps.app.chain.network }) });

  router.add({ method: 'POST', pattern: '/v1/bets', handler: async ctx => {
    const body = await readJsonBody(ctx.req);
    allowKeys(body, ['requestId', 'account', 'quoteId', 'revision', 'cellId', 'stakeCenti']);
    // With sessions the account is the signed-in one (a body account must match it); Stage A takes the body as is.
    const scope = ctx.deps.auth ? authorizeAccount(ctx, body['account'], { bucket: 'bet', stateChanging: true }) : undefined;
    const intent = (scope ? { ...body, account: scope.account } : body) as unknown as BetIntent;
    const r = ctx.deps.app.engine.placeBet(intent);
    ctx.deps.app.engine.flush();
    if (scope && typeof intent.requestId === 'string') ctx.deps.auth!.rememberRequest(intent.requestId, scope.account);
    const out = placementBody(ctx, r);
    sendJson(ctx.res, out.status, out.body);
  } });

  router.add({ method: 'GET', pattern: '/v1/bets/by-request/:id', handler: (ctx, p) => {
    const scope = ctx.deps.auth ? authorizeAccount(ctx, undefined, { bucket: 'read' }) : undefined;
    const r = ctx.deps.app.engine.receiptFor(p['id']!);
    // Another account's receipt is indistinguishable from an unknown requestId.
    if (!r || (scope && receiptOwner(ctx, p['id']!, r) !== scope.account)) throw new HttpError(404, 'NOT_FOUND', 'No result for this requestId (it may never have reached the server)');
    const out = placementBody(ctx, r);
    sendJson(ctx.res, out.status === 422 || out.status === 409 || out.status === 202 ? 200 : out.status, out.body);
  } });

  router.add({ method: 'GET', pattern: '/v1/quotes', handler: ctx => {
    const market = marketParam(ctx);
    const accountRaw = ctx.url.searchParams.get('account');
    // With sessions the per-account grid is the session's (a named account must match); anonymous callers get the public grid.
    const named = ctx.deps.auth ? (accountRaw || sessionOf(ctx) ? authorizeAccount(ctx, accountRaw ?? undefined)?.account : undefined) : accountRaw;
    const ids = named ? ledgerAccountOf(named) : undefined;
    if (named && !ids) throw new HttpError(400, 'VALIDATION_ERROR', 'account must be a 0x address or sim id');
    sendJson(ctx.res, 200, quotesView(ctx.deps.app.engine, market, ids?.account));
  } });

  router.add({ method: 'GET', pattern: '/v1/account/:address', handler: (ctx, p) => {
    if (ctx.deps.auth) authorizeAccount(ctx, p['address'], { bucket: 'read' });
    const ids = ledgerAccountOf(p['address']!);
    if (!ids) throw new HttpError(400, 'VALIDATION_ERROR', 'address must be a 0x address or sim id');
    const e = ctx.deps.app.engine;
    const player = e.player(ids.account);
    if (!player) { sendJson(ctx.res, 200, { account: ids.account, registered: false, balanceCenti: '0', openLegs: [], recentLegs: [], deposits: [], withdrawals: [] }); return; }
    const legs = [...player.recentLegs].reverse().map(id => e.legView(id)).filter(l => l !== undefined);
    sendJson(ctx.res, 200, {
      account: player.account, kind: player.kind, registered: true, balanceCenti: e.balanceOf(player.account).toString(), availableCenti: e.availableBalance(player.account).toString(), flagged: player.flagged, blocked: player.blocked,
      pendingBets: e.pendingHolds().filter(h => h.account === player.account),
      openLegs: legs.filter(l => l.status === 'open').map(l => legJson(e, l)), recentLegs: legs.map(l => legJson(e, l)),
      deposits: player.deposits.map(d => ({ id: d.key, amountCenti: d.centi, dustWei: d.dustWei, txHash: d.txHash, blockNumber: d.blockNumber, ms: d.ms })),
      withdrawals: player.vouchers.map(id => e.vouchers.get(id)!).map(v => ({ voucherId: v.voucherId, amountCenti: v.amountCenti, nonce: v.nonce, expiry: v.expiry, status: v.status, ...(v.signature ? { signature: v.signature } : {}), ...(v.txHash ? { txHash: v.txHash } : {}) })),
    });
  } });

  router.add({ method: 'POST', pattern: '/v1/sign-in', handler: async ctx => {
    const body = await readJsonBody(ctx.req);
    allowKeys(body, ['account']);
    // With sessions, SIWE (POST /v1/auth/verify) registers; this route then only confirms the session's account.
    const account = ctx.deps.auth ? authorizeAccount(ctx, body['account'], { stateChanging: true })?.account : body['account'];
    if (!isAddress(account)) throw new HttpError(400, 'VALIDATION_ERROR', 'account must be a 0x address');
    const r = ctx.deps.app.engine.register(account, 'sign-in');
    ctx.deps.app.engine.flush();
    if (!r.ok) throw new HttpError(400, r.code, 'Cannot register this account');
    sendJson(ctx.res, 200, { account: r.account, created: r.created, registeredPlayers: ctx.deps.app.engine.registeredPlayers });
  } });

  // Escape hatch (SPEC-11 §6): the account's leaf and proof under the vault's latest (or frozen) root. Public data, like /v1/account.
  router.add({ method: 'GET', pattern: '/v1/account/:address/proof', handler: async (ctx, p) => {
    // With sessions: the signed-in account, or the admin bearer token (the house console's escape-proof lookup).
    if (ctx.deps.auth) authorizeAccount(ctx, p['address'], { bucket: 'read', allowAdmin: true });
    if (!isAddress(p['address'])) throw new HttpError(400, 'VALIDATION_ERROR', 'address must be a 0x address');
    const out = await ctx.deps.app.accountProof(p['address']);
    sendJson(ctx.res, out.status, out.body);
  } });

  // Stage B external-wallet (MetaMask) withdrawals. Stage A has no SIWE: anyone who can reach the port can act for any
  // account, so these stay off unless MAYA_OPEN_PLAYER_API=testnet-unsafe. SIWE must replace this switch before any real use.
  router.add({ method: 'POST', pattern: '/v1/withdrawals', handler: async ctx => {
    if (!ctx.deps.auth) requireOpenPlayerApi(ctx);
    const body = await readJsonBody(ctx.req);
    allowKeys(body, ['requestId', 'account', 'amountCenti']);
    const { app } = ctx.deps;
    // With sessions the voucher is for the signed-in account only (no MAYA_OPEN_PLAYER_API needed).
    if (ctx.deps.auth) {
      const scope = authorizeAccount(ctx, body['account'], { bucket: 'withdraw', stateChanging: true });
      if (scope) body['account'] = scope.account;
    }
    if (!isAddress(body['account'])) throw new HttpError(400, 'INVALID_ACCOUNT', 'account must be a 0x address (only on-chain accounts can withdraw)');
    if (typeof body['amountCenti'] !== 'string') throw new HttpError(400, 'VALIDATION_ERROR', 'amountCenti is a required Centi string');
    if (body['requestId'] !== undefined && typeof body['requestId'] !== 'string') throw new HttpError(400, 'VALIDATION_ERROR', 'requestId must be a string');
    // requestId makes a retry idempotent (same voucher); without one the server names the request and a retry reserves again.
    const requestId = typeof body['requestId'] === 'string' ? body['requestId'] : `wd-${randomUUID()}`;
    const r = await app.issueVoucher(requestId, body['account'], body['amountCenti']);
    if (!r.ok) throw new HttpError(r.status, r.code, r.message);
    const v = r.voucher;
    sendJson(ctx.res, 200, {
      ...app.voucherJson(v), created: r.created, ...app.voucherTypedData(v),
      call: { function: 'withdraw(uint256,uint256,uint256,bytes)', args: [toWei(v.amountCenti).toString(), v.nonce, v.expiry, v.signature ?? null], from: v.account },
    });
  } });

  router.add({ method: 'GET', pattern: '/v1/withdrawals', handler: ctx => {
    if (!ctx.deps.auth) requireOpenPlayerApi(ctx);
    const account = ctx.deps.auth ? authorizeAccount(ctx, ctx.url.searchParams.get('account') ?? undefined, { bucket: 'read' })?.account ?? null : ctx.url.searchParams.get('account');
    if (!isAddress(account)) throw new HttpError(400, 'VALIDATION_ERROR', 'account must be a 0x address');
    sendJson(ctx.res, 200, ctx.deps.app.withdrawalsView(account));
  } });
}

function requireOpenPlayerApi(ctx: Ctx): void {
  if (!ctx.deps.openPlayerApi) {
    ctx.req.resume();
    throw new HttpError(403, 'PLAYER_API_DISABLED', 'External-wallet withdrawals are disabled: Stage A has no SIWE. Set MAYA_OPEN_PLAYER_API=testnet-unsafe on a testnet only; SIWE must replace it before any real use.');
  }
}
