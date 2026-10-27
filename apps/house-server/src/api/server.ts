import { createServer, type Server } from 'node:http';
import { errorMessage } from '../util.js';
import { bearerMatches } from './admin-token.js';
import { adminRoutes } from './admin.js';
import type { ApiDeps, Ctx } from './context.js';
import { HttpError, Router, secure, sendError } from './http.js';
import { playerRoutes } from './player.js';
import { authRoutes } from './auth-routes.js';
import { devWalletRoutes } from './dev-wallet.js';
import { playerLiveRoutes } from './player-live.js';
import { promoRoutes } from './promo.js';

/**
 * One hardened HTTP server for `/v1` (player) and `/admin-api` (bearer token). Strict routing,
 * JSON only, bounded bodies, no-store/nosniff on every response, generic 500s (details are logged).
 */
export function createHouseServer(deps: ApiDeps): Server {
  const router = new Router<Ctx>();
  playerRoutes(router);
  // Stage B: SIWE sessions (404 unless deps.auth), chain config and the pinned path for the live game.
  authRoutes(router);
  playerLiveRoutes(router);
  // SPEC-12: the public promo view (tier, progress, the session account's boost allowance).
  promoRoutes(router);
  // DEV ONLY: mounted only when main.ts built a local test wallet (MAYA_DEV_TEST_WALLET=1, 127.0.0.1, local chain).
  if (deps.devWallet) devWalletRoutes(router, deps.devWallet);
  adminRoutes(router);
  const server = createServer(async (req, res) => {
    secure(res);
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://house.local'); } catch { sendError(res, 400, 'BAD_URL', 'Malformed URL'); return; }
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST' && method !== 'PUT') { sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed', { Allow: 'GET, POST, PUT' }); return; }
    const admin = url.pathname === '/admin-api' || url.pathname.startsWith('/admin-api/');
    if (admin && !bearerMatches(req.headers.authorization, deps.adminToken)) {
      req.resume();
      sendError(res, 401, 'UNAUTHORIZED', 'A valid admin bearer token is required', { 'WWW-Authenticate': 'Bearer realm="maya-house-admin"' });
      return;
    }
    const match = router.match(method, url.pathname);
    if (!match) { req.resume(); sendError(res, 404, 'NOT_FOUND', 'Unknown route'); return; }
    if ('allow' in match) { req.resume(); sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed for this route', { Allow: match.allow.join(', ') }); return; }
    const actorHeader = req.headers['x-maya-actor'];
    const actor = typeof actorHeader === 'string' && /^[A-Za-z0-9._@-]{1,64}$/.test(actorHeader) ? `admin:${actorHeader}` : 'admin';
    try {
      await match.handler({ req, res, url, deps, actor }, match.params);
    } catch (error) {
      if (error instanceof HttpError) { sendError(res, error.status, error.code, error.message, error.headers); return; }
      deps.log(`house: ${method} ${url.pathname} failed: ${errorMessage(error)}`);
      sendError(res, 500, 'INTERNAL', 'Internal error');
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}
