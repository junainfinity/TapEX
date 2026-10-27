import type { MarketId } from '@maya/contracts';
import { ledgerAccountOf } from '../engine/engine.js';
import type { DefensePatch, PromoPatch } from '@maya/house';
import type { AdminMeta, AdminResult, FlagAction } from '../engine/types.js';
import { sha256Hex } from '../util.js';
import type { Ctx } from './context.js';
import { HttpError, Router, allowKeys, intParam, readJsonBody, sendError, sendJson, toJson } from './http.js';
import { betsPage, exposureView, metricsView, playerDetail, playersPage } from './views.js';

export const DEFENSE_SECTIONS = Object.freeze(['hold', 'quoteValidity', 'minLeadS', 'ramp', 'toxicity', 'controller', 'reference'] as const);
/** PUT /admin-api/promo body fields (nested keys are checked strictly by @maya/house changePromo). */
export const PROMO_FIELDS = Object.freeze(['enabled', 'standardLabel', 'tiers', 'guard'] as const);
export const REASON_MIN = 8;
export const REASON_MAX = 500;

/** reason (8–500 chars after trim) is required on every write; confirm is passed through for dangerous actions. */
export function metaFrom(ctx: Ctx, body: Record<string, unknown>): AdminMeta {
  const reason = body['reason'];
  if (typeof reason !== 'string' || reason.trim().length === 0) throw new HttpError(400, 'REASON_REQUIRED', 'Every admin write requires a reason');
  const trimmed = reason.trim();
  if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) throw new HttpError(400, 'VALIDATION_ERROR', `reason must be ${REASON_MIN}–${REASON_MAX} characters`);
  const confirm = body['confirm'];
  if (confirm !== undefined && typeof confirm !== 'string') throw new HttpError(400, 'VALIDATION_ERROR', 'confirm must be a string');
  return { actor: ctx.actor, reason: trimmed, ...(typeof confirm === 'string' ? { confirm } : {}) };
}

interface Stored { readonly hash: string; readonly status: number; readonly body: string }
/** Idempotency-Key replay cache for admin writes (same key + same body → the original response). */
export class IdempotencyCache {
  private readonly done = new Map<string, Stored>();
  private readonly inflight = new Map<string, { hash: string; promise: Promise<Stored> }>();
  constructor(private readonly capacity = 2000) {}
  async run(key: string | undefined, hash: string, fn: () => Promise<{ status: number; body: unknown }>): Promise<Stored & { replayed: boolean }> {
    if (key === undefined) { const r = await fn(); return { hash, status: r.status, body: toJson(r.body), replayed: false }; }
    const prior = this.done.get(key) ?? await this.inflight.get(key)?.promise;
    const inflightHash = this.inflight.get(key)?.hash;
    if (prior) { if (prior.hash !== hash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was used with a different request'); return { ...prior, replayed: true }; }
    if (inflightHash && inflightHash !== hash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was used with a different request');
    const promise = fn().then(r => ({ hash, status: r.status, body: toJson(r.body) }));
    this.inflight.set(key, { hash, promise });
    try {
      const stored = await promise;
      this.done.set(key, stored);
      if (this.done.size > this.capacity) this.done.delete(this.done.keys().next().value!);
      return { ...stored, replayed: false };
    } finally { this.inflight.delete(key); }
  }
}

/** Ack or `{ error: { code, message, txHash?, opId? } }` (a chain failure names its transaction and treasury operation). */
function resultBody(r: AdminResult, okStatus = 200): { status: number; body: unknown } {
  return r.ok ? { status: okStatus, body: r } : { status: r.status, body: { error: { code: r.code, message: r.message, ...(r.txHash ? { txHash: r.txHash } : {}), ...(r.opId ? { opId: r.opId } : {}) } } };
}

type WriteHandler = (ctx: Ctx, body: Record<string, unknown>, params: Readonly<Record<string, string>>) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown };

/** Admin API (§7). Every route is behind the bearer check in the server dispatcher. */
export function adminRoutes(router: Router<Ctx>, cache = new IdempotencyCache()): void {
  const read = (pattern: string, handler: (ctx: Ctx, params: Readonly<Record<string, string>>) => unknown | Promise<unknown>) =>
    router.add({ method: 'GET', pattern: `/admin-api${pattern}`, handler: async (ctx, params) => sendJson(ctx.res, 200, await handler(ctx, params)) });
  const write = (method: 'POST' | 'PUT', pattern: string, allowed: readonly string[], handler: WriteHandler) =>
    router.add({ method, pattern: `/admin-api${pattern}`, handler: async (ctx, params) => {
      const body = await readJsonBody(ctx.req);
      allowKeys(body, [...allowed, 'reason', 'confirm']);
      const keyRaw = ctx.req.headers['idempotency-key'];
      const key = typeof keyRaw === 'string' ? keyRaw : undefined;
      if (key !== undefined && !/^[A-Za-z0-9._:~-]{1,128}$/.test(key)) throw new HttpError(400, 'VALIDATION_ERROR', 'Idempotency-Key is malformed');
      const hash = sha256Hex(`${method} ${ctx.url.pathname} ${toJson(body)}`);
      const r = await cache.run(key, hash, async () => handler(ctx, body, params));
      if (r.replayed) ctx.res.setHeader('Idempotency-Replayed', 'true');
      ctx.res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(r.body) });
      ctx.res.end(r.body);
    } });

  read('/overview', ctx => ctx.deps.app.overview());
  read('/metrics', ctx => metricsView(ctx.deps.app.engine, ctx.url.searchParams));
  read('/rtp', ctx => {
    const e = ctx.deps.app.engine;
    return { ...e.metrics.rtpReport(), tables: e.markets.map(m => ({ market: m, ...e.tableInfo(m) })), ...(e.lastRefitMs !== undefined ? { lastRefitMs: e.lastRefitMs } : {}), phaseLog: e.phaseLog };
  });
  read('/exposure', ctx => {
    const m = ctx.url.searchParams.get('market') ?? ctx.deps.app.engine.markets[0]!;
    if (!ctx.deps.app.engine.markets.includes(m as MarketId)) throw new HttpError(400, 'VALIDATION_ERROR', 'unknown market');
    return exposureView(ctx.deps.app.engine, m as MarketId);
  });
  read('/players', ctx => playersPage(ctx.deps.app.engine, ctx.url.searchParams, intParam(ctx.url.searchParams, 'limit', 50, 1, 500)));
  read('/players/:account', (ctx, p) => {
    const d = playerDetail(ctx.deps.app.engine, p['account']!);
    if (!d) throw new HttpError(404, 'UNKNOWN_ACCOUNT', 'Unknown account');
    return d;
  });
  read('/bets', ctx => betsPage(ctx.deps.app.engine, ctx.url.searchParams, intParam(ctx.url.searchParams, 'limit', 100, 1, 500)));
  read('/chain', ctx => ctx.deps.app.chainView());
  read('/audit', ctx => ({ rows: ctx.deps.app.engine.auditLog(intParam(ctx.url.searchParams, 'limit', 200, 1, 5000)) }));
  read('/defenses', ctx => ctx.deps.app.defensesView());
  // SPEC-12 promo tiers: configuration and live state per tier (turnover, players, realized loss vs budget, accounts, guard).
  read('/promo', ctx => ctx.deps.app.engine.promoAdminView());
  router.add({ method: 'GET', pattern: '/admin-api/stream', handler: ctx => {
    if (!ctx.deps.sse.attach(ctx.req, ctx.res)) sendError(ctx.res, 503, 'TOO_MANY_STREAMS', 'Too many open admin streams', { 'Retry-After': '5' });
  } });

  const flushAfter = (ctx: Ctx, r: AdminResult, okStatus = 200) => { ctx.deps.app.engine.flush(); return resultBody(r, okStatus); };
  write('POST', '/markets/:id/pause', [], (ctx, body, p) => flushAfter(ctx, ctx.deps.app.engine.pauseMarket(p['id']!, metaFrom(ctx, body))));
  write('POST', '/markets/:id/resume', [], (ctx, body, p) => flushAfter(ctx, ctx.deps.app.engine.resumeMarket(p['id']!, metaFrom(ctx, body))));
  write('POST', '/pause-all', [], (ctx, body) => flushAfter(ctx, ctx.deps.app.engine.pauseAll(metaFrom(ctx, body))));
  write('POST', '/resume-all', [], (ctx, body) => flushAfter(ctx, ctx.deps.app.engine.resumeAll(metaFrom(ctx, body))));
  write('PUT', '/pricing', ['standardEdge', 'capX100', 'aboveCap', 'impactK', 'z'], (ctx, body) => {
    const meta = metaFrom(ctx, body);
    return flushAfter(ctx, ctx.deps.app.engine.setPricing(body as Parameters<typeof ctx.deps.app.engine.setPricing>[0], meta));
  });
  write('PUT', '/launch', ['enabled', 'edge', 'untilPlayers'], (ctx, body) => {
    const meta = metaFrom(ctx, body);
    return flushAfter(ctx, ctx.deps.app.engine.setLaunch(body as Parameters<typeof ctx.deps.app.engine.setLaunch>[0], meta));
  });
  write('PUT', '/limits', ['cellFraction', 'columnFraction', 'globalFraction', 'accountFraction', 'maxStakePerBetCenti', 'maxStakePerCellCenti'], (ctx, body) => {
    const meta = metaFrom(ctx, body);
    return flushAfter(ctx, ctx.deps.app.engine.setLimits(body as Parameters<typeof ctx.deps.app.engine.setLimits>[0], meta));
  });
  // SPEC-10: partial update of the defenses (nested sections merge one level deep; overrides set to null are removed).
  write('PUT', '/defenses', DEFENSE_SECTIONS, (ctx, body) => {
    const meta = metaFrom(ctx, body);
    const patch = Object.fromEntries(Object.entries(body).filter(([k]) => (DEFENSE_SECTIONS as readonly string[]).includes(k)));
    if (!Object.keys(patch).length) throw new HttpError(400, 'VALIDATION_ERROR', `Provide at least one of ${DEFENSE_SECTIONS.join(', ')}`);
    return flushAfter(ctx, ctx.deps.app.engine.setDefenses(patch as DefensePatch, meta));
  });
  // SPEC-12: edit tier fields, extend, disable/enable the promo (confirm "edge-change" when an edge moves > 2 pts);
  // end the current tier early (confirm "promo-end-tier"); resume boosted pricing after a budget breaker (confirm "promo-resume").
  write('PUT', '/promo', PROMO_FIELDS, (ctx, body) => {
    const meta = metaFrom(ctx, body);
    const patch = Object.fromEntries(Object.entries(body).filter(([k]) => (PROMO_FIELDS as readonly string[]).includes(k)));
    if (!Object.keys(patch).length) throw new HttpError(400, 'VALIDATION_ERROR', `Provide at least one of ${PROMO_FIELDS.join(', ')}`);
    return flushAfter(ctx, ctx.deps.app.engine.setPromo(patch as PromoPatch, meta));
  });
  write('POST', '/promo/end-tier', [], (ctx, body) => flushAfter(ctx, ctx.deps.app.engine.endPromoTier(metaFrom(ctx, body))));
  write('POST', '/promo/resume', ['tier'], (ctx, body) => flushAfter(ctx, ctx.deps.app.engine.resumePromo(body['tier'], metaFrom(ctx, body))));
  write('POST', '/refit', [], (ctx, body) => {
    const meta = metaFrom(ctx, body);
    const { jobId } = ctx.deps.app.startRefit(meta.actor, meta.reason);
    const entry = ctx.deps.app.engine.recordAudit({ kind: 'admin', actor: meta.actor, action: 'refit', after: { jobId }, reason: meta.reason, result: 'started' });
    ctx.deps.app.engine.flush();
    return { status: 202, body: { ok: true, action: 'refit', auditId: entry.id, before: null, after: { jobId }, jobId } };
  });
  for (const action of ['flag', 'unflag', 'block', 'unblock'] as const satisfies readonly FlagAction[]) {
    write('POST', `/players/:account/${action}`, [], (ctx, body, p) => {
      const meta = metaFrom(ctx, body);
      if (!ledgerAccountOf(p['account']!)) throw new HttpError(400, 'VALIDATION_ERROR', 'account must be a 0x address or sim id');
      return flushAfter(ctx, ctx.deps.app.engine.setPlayerFlag(p['account']!, action, meta));
    });
  }
  write('POST', '/treasury/fund', ['amountCenti'], async (ctx, body) => resultBody(await ctx.deps.app.fundHouse(body['amountCenti'], metaFrom(ctx, body))));
  write('POST', '/treasury/withdraw-surplus', ['amountCenti'], async (ctx, body) => resultBody(await ctx.deps.app.withdrawSurplus(body['amountCenti'], metaFrom(ctx, body))));
  write('POST', '/treasury/attest', [], async (ctx, body) => resultBody(await ctx.deps.app.attestNow(metaFrom(ctx, body))));
  // A treasury transaction with an unknown outcome that the vault shows was never mined (confirm "treasury-release").
  write('POST', '/treasury/release-pending', ['opId'], async (ctx, body) => resultBody(await ctx.deps.app.releasePendingTreasury(body['opId'], metaFrom(ctx, body))));
  write('POST', '/vault/pause', [], async (ctx, body) => resultBody(await ctx.deps.app.vaultPause(true, metaFrom(ctx, body))));
  write('POST', '/vault/unpause', [], async (ctx, body) => resultBody(await ctx.deps.app.vaultPause(false, metaFrom(ctx, body))));
  // SPEC-11 timelocked signer rotation and excess sweep (confirm phrases: signer-propose, signer-accept, sweep-excess).
  write('POST', '/vault/signer/propose', ['address'], async (ctx, body) => resultBody(await ctx.deps.app.proposeSigner(body['address'], metaFrom(ctx, body))));
  write('POST', '/vault/signer/accept', [], async (ctx, body) => resultBody(await ctx.deps.app.acceptSigner(metaFrom(ctx, body))));
  write('POST', '/vault/signer/cancel', [], async (ctx, body) => resultBody(await ctx.deps.app.cancelSigner(metaFrom(ctx, body))));
  write('POST', '/vault/sweep-excess', ['to'], async (ctx, body) => resultBody(await ctx.deps.app.sweepExcess(body['to'], metaFrom(ctx, body))));
  write('POST', '/sim', ['running', 'speed', 'arrivalsPerMin'], (ctx, body) => {
    if (ctx.deps.app.feed.mode === 'live') throw new HttpError(404, 'NOT_FOUND', 'Simulation controls are unavailable with MAYA_FEED=live');
    const meta = metaFrom(ctx, body);
    const r = ctx.deps.app.engine.setSim(body as Parameters<typeof ctx.deps.app.engine.setSim>[0], meta);
    if (r.ok) ctx.deps.app.applySimSettings();
    return flushAfter(ctx, r);
  });
}
