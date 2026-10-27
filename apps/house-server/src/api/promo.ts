import { sessionAccountOf } from './auth-routes.js';
import type { Ctx } from './context.js';
import { Router, sendJson } from './http.js';

/**
 * SPEC-12 public promo endpoint (contract owned by the promo engineer, consumed by the game UI):
 *
 *   GET /v1/promo → { tier: 'launch'|'growth'|'scale'|'standard', label, minWinX100,
 *                     progress: { players, untilPlayers|null, turnoverCenti, untilTurnoverCenti|null },
 *                     account: { boostRemainingCenti: string|null } | null }
 *
 * `account` is filled only when the request carries a valid player session (SIWE cookie, `sessionAccountOf`); it is
 * never taken from a client-named account. `boostRemainingCenti` is the turnover the account may still place at the
 * current tier's boosted odds (null when no boost applies: standard tier, a paused tier, or a flagged account).
 */
export function promoRoutes(router: Router<Ctx>): void {
  router.add({ method: 'GET', pattern: '/v1/promo', handler: ctx => {
    const account = sessionAccountOf(ctx);
    sendJson(ctx.res, 200, ctx.deps.app.engine.promoView(account));
  } });
}
