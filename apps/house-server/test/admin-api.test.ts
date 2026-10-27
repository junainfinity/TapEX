import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Contract check: every read must decode with the house console's own decoders (apps/admin).
import { decodeAudit, decodeBets, decodeChain, decodeExposure, decodeMetrics, decodeOverview, decodePlayerDetail, decodePlayers, decodeRtp } from '../../admin/src/decode.js';
import type { EngineEvent } from '../src/engine/types.js';
import { admin, api, TOKEN, startTestApp, type TestApp } from './app-helpers.js';

let t: TestApp;
beforeAll(async () => { t = await startTestApp({ sim: 40 }); t.advance(120); });
afterAll(async () => { await t.close(); });

const reason = 'integration test action';

describe('admin API auth and hardening', () => {
  it('returns 401 without or with a wrong bearer token, on reads, writes and the stream', async () => {
    for (const [method, path] of [['GET', '/overview'], ['POST', '/pause-all'], ['GET', '/stream'], ['GET', '/nope'], ['PUT', '/pricing']] as const) {
      const none = await api(t.base, method, `/admin-api${path}`, method === 'GET' ? undefined : { reason });
      expect(none.status).toBe(401);
      expect(none.body).toEqual({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
      expect(none.headers.get('www-authenticate')).toMatch(/^Bearer/);
      const wrong = await api(t.base, method, `/admin-api${path}`, undefined, { Authorization: `Bearer ${TOKEN}x` });
      expect(wrong.status).toBe(401);
    }
    expect((await api(t.base, 'GET', '/admin-api/overview', undefined, { Authorization: TOKEN })).status).toBe(401);
  });

  it('sets no-store and nosniff, routes strictly and rejects wrong methods', async () => {
    const r = await admin(t, 'GET', '/overview');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    expect((await admin(t, 'GET', '/overview/extra')).status).toBe(404);
    const wrong = await admin(t, 'POST', '/overview', { reason });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET');
    expect((await api(t.base, 'DELETE', '/admin-api/overview', undefined, { Authorization: `Bearer ${TOKEN}` })).status).toBe(405);
    expect((await api(t.base, 'GET', '/unknown')).status).toBe(404);
  });
});

describe('admin API reads decode with the console decoders', () => {
  it('overview, metrics, rtp, exposure, players, bets, chain and audit', async () => {
    const o = decodeOverview((await admin(t, 'GET', '/overview')).body);
    expect(o).toMatchObject({ network: 'offline', feedMode: 'replay', registeredPlayers: expect.any(Number), launch: { active: true, edge: 0.03 } });
    expect(o.pricing).toMatchObject({ standardEdge: 0.08, capX100: 5000 });
    expect(o.limits).toMatchObject({ maxStakePerBetCenti: expect.any(String) });
    expect(o.markets[0]).toMatchObject({ id: 'btc-usd', enabled: true, paused: false });
    const clock = o.clockMs;
    const metrics = decodeMetrics((await admin(t, 'GET', `/metrics?from=${clock - 3_600_000}&to=${clock}&step=60000`)).body);
    expect(metrics.t.length).toBeGreaterThan(0);
    expect((await admin(t, 'GET', `/metrics?from=${clock}&to=${clock - 1}&step=60000`)).status).toBe(400);
    expect((await admin(t, 'GET', `/metrics?from=0&to=${clock}&step=1000`)).body.error.code).toBe('VALIDATION_ERROR');
    const rtp = decodeRtp((await admin(t, 'GET', '/rtp')).body);
    expect(rtp.byRange.map(r => r.key)).toEqual(expect.arrayContaining(['1.01-2', '2-5', '5-10', '10-20', '20-50']));
    expect(rtp.byPhase.map(r => r.key)).toEqual(['launch', 'standard']);
    const ex = decodeExposure((await admin(t, 'GET', '/exposure?market=btc-usd')).body);
    expect(ex.cells).toHaveLength(42); expect(ex.windows).toHaveLength(6); expect(ex.bands).toHaveLength(7);
    expect((await admin(t, 'GET', '/exposure?market=doge')).status).toBe(400);
    const players = decodePlayers((await admin(t, 'GET', '/players?sort=-handle&limit=5')).body);
    expect(players.rows.length).toBeGreaterThan(0);
    expect((await admin(t, 'GET', '/players?sort=nope')).status).toBe(400);
    expect((await admin(t, 'GET', '/players?limit=5000')).status).toBe(400);
    const detail = decodePlayerDetail((await admin(t, 'GET', `/players/${encodeURIComponent(players.rows[0]!.account)}`)).body);
    expect(detail.player.account).toBe(players.rows[0]!.account);
    expect((await admin(t, 'GET', '/players/sim:none')).status).toBe(404);
    const bets = decodeBets((await admin(t, 'GET', '/bets?limit=20')).body);
    expect(bets.rows.length).toBeGreaterThan(0);
    const page2 = decodeBets((await admin(t, 'GET', `/bets?limit=20&cursor=${bets.nextCursor}`)).body);
    if (page2.rows.length) expect(Number(page2.rows[0]!.legId.slice(1))).toBeLessThan(Number(bets.rows.at(-1)!.legId.slice(1)));
    expect((await admin(t, 'GET', '/bets?status=bogus')).status).toBe(400);
    const chain = decodeChain((await admin(t, 'GET', '/chain')).body);
    expect(chain.vault.assetsCenti).toBe((BigInt(chain.vault.totalPlayerDepositsCenti) + BigInt(chain.vault.houseFundedCenti) - BigInt(chain.vault.totalPlayerWithdrawalsCenti) - BigInt(chain.vault.houseWithdrawnCenti ?? '0')).toString());
    expect((await admin(t, 'GET', '/chain')).body.reconciliation).toMatchObject({ match: true });
    decodeAudit((await admin(t, 'GET', '/audit?limit=10')).body);
  });
});

describe('admin API writes', () => {
  it('validates bodies: reason, unknown fields, ranges, content type, JSON and size', async () => {
    expect((await admin(t, 'PUT', '/pricing', { capX100: 3000 })).body.error.code).toBe('REASON_REQUIRED');
    expect((await admin(t, 'PUT', '/pricing', { capX100: 3000, reason: 'short' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await admin(t, 'PUT', '/pricing', { capx100: 3000, reason })).body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringMatching(/capx100/) });
    expect((await admin(t, 'PUT', '/pricing', { capX100: 150, reason })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await admin(t, 'PUT', '/pricing', { capX100: 20000, reason })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await admin(t, 'PUT', '/pricing', { standardEdge: 0.3, reason, confirm: 'edge-change' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await admin(t, 'PUT', '/pricing', { aboveCap: 'maybe', reason })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await admin(t, 'PUT', '/limits', { cellFraction: 0, reason })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await admin(t, 'PUT', '/limits', { maxStakePerBetCenti: '1.5', reason })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await admin(t, 'PUT', '/launch', { untilPlayers: 1.5, reason })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await admin(t, 'POST', '/sim', { speed: 0, reason })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await admin(t, 'POST', '/treasury/fund', { amountCenti: '-5', reason })).body.error.code).toBe('VALIDATION_ERROR');
    const text = await api(t.base, 'PUT', '/admin-api/pricing', 'capX100=3000', { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' });
    expect(text.status).toBe(415);
    const bad = await api(t.base, 'PUT', '/admin-api/pricing', '{"capX100":', { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });
    expect(bad).toMatchObject({ status: 400, body: { error: { code: 'INVALID_JSON' } } });
    const big = await admin(t, 'PUT', '/pricing', { reason: 'x'.repeat(20_000) });
    expect(big.status).toBe(413);
  });

  it('requires typed confirmation for dangerous actions and journals every change with actor, reason, before/after', async () => {
    expect((await admin(t, 'POST', '/pause-all', { reason })).body.error.code).toBe('CONFIRM_REQUIRED');
    expect((await admin(t, 'POST', '/pause-all', { reason, confirm: 'pause all' })).body.error.code).toBe('CONFIRM_REQUIRED');
    const paused = await admin(t, 'POST', '/pause-all', { reason, confirm: 'pause-all' }, { 'X-Maya-Actor': 'ops-anna' });
    expect(paused).toMatchObject({ status: 200, body: { ok: true, action: 'pause-all', auditId: expect.stringMatching(/^A\d+$/) } });
    expect((await admin(t, 'POST', '/pause-all', { reason, confirm: 'pause-all' })).status).toBe(409);
    expect((await admin(t, 'POST', '/resume-all', { reason })).body).toMatchObject({ ok: true, action: 'resume-all' });

    expect((await admin(t, 'PUT', '/pricing', { standardEdge: 0.11, reason })).body.error.code).toBe('CONFIRM_REQUIRED');
    expect((await admin(t, 'PUT', '/pricing', { standardEdge: 0.09, reason })).body).toMatchObject({ ok: true, before: { standardEdge: 0.08 }, after: { standardEdge: 0.09 } });
    expect((await admin(t, 'PUT', '/pricing', { standardEdge: 0.12, reason, confirm: 'edge-change' })).body).toMatchObject({ ok: true, after: { standardEdge: 0.12 } });
    expect((await admin(t, 'PUT', '/pricing', { standardEdge: 0.12, reason })).status).toBe(409);
    expect((await admin(t, 'PUT', '/launch', { enabled: false, reason })).body.error.code).toBe('CONFIRM_REQUIRED');
    expect((await admin(t, 'PUT', '/limits', { cellFraction: 0.002, maxStakePerBetCenti: '200000', reason })).body).toMatchObject({ ok: true, before: { cellFraction: 0.001 }, after: { cellFraction: 0.002, maxStakePerBetCenti: '200000' } });
    expect((await admin(t, 'POST', '/vault/pause', { reason })).body.error.code).toBe('CONFIRM_REQUIRED');
    expect((await admin(t, 'POST', '/vault/pause', { reason, confirm: 'vault-pause' })).body).toMatchObject({ ok: true, txHash: expect.stringMatching(/^0x/) });
    expect((await admin(t, 'POST', '/vault/unpause', { reason })).body).toMatchObject({ ok: true, after: { paused: false } });
    expect((await admin(t, 'POST', '/markets/btc-usd/pause', { reason })).body).toMatchObject({ ok: true, after: { paused: true } });
    expect((await admin(t, 'POST', '/markets/btc-usd/resume', { reason })).body).toMatchObject({ ok: true, after: { paused: false } });
    expect((await admin(t, 'POST', '/markets/doge-usd/pause', { reason })).status).toBe(404);

    const audit = (await admin(t, 'GET', '/audit?limit=200')).body.rows as { action: string; actor: string; reason?: string; before?: unknown; after?: unknown; kind: string }[];
    const adminRows = audit.filter(a => a.kind === 'admin');
    for (const action of ['pause-all', 'resume-all', 'pricing', 'limits', 'vault-pause', 'vault-unpause', 'market-pause', 'market-resume']) {
      const row = adminRows.find(a => a.action === action);
      expect(row, action).toBeDefined();
      expect(row!.reason).toBe(reason);
      expect(row).toHaveProperty('before'); expect(row).toHaveProperty('after');
    }
    expect(adminRows.find(a => a.action === 'pause-all')!.actor).toBe('admin:ops-anna');
    const journaled = t.journal.records<EngineEvent>().filter(r => r.type === 'audit').map(r => (r as Extract<EngineEvent, { type: 'audit' }>).entry.action);
    expect(journaled).toEqual(expect.arrayContaining(['pause-all', 'resume-all', 'pricing', 'limits', 'vault-pause']));
  });

  it('replays an Idempotency-Key with the same body and refuses it with a different body', async () => {
    const key = { 'Idempotency-Key': 'idem-1' };
    const first = await admin(t, 'PUT', '/pricing', { impactK: 0.03, reason }, key);
    const again = await admin(t, 'PUT', '/pricing', { impactK: 0.03, reason }, key);
    expect(first.body.ok).toBe(true);
    expect(again.body).toEqual(first.body);
    expect(again.headers.get('idempotency-replayed')).toBe('true');
    expect((await admin(t, 'PUT', '/pricing', { impactK: 0.04, reason }, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(t.app.engine.pricing.impactK).toBe(0.03);
  });

  it('runs treasury actions on the chain and records their transactions', async () => {
    const before = t.app.engine.equityOnchain();
    const fund = await admin(t, 'POST', '/treasury/fund', { amountCenti: '500000', reason });
    expect(fund.body).toMatchObject({ ok: true, action: 'treasury-fund', txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(t.app.engine.equityOnchain()).toBe(before + 500_000n);
    const attest = await admin(t, 'POST', '/treasury/attest', { reason });
    expect(attest.body).toMatchObject({ ok: true, txHash: expect.any(String), after: { seq: '1' } });
    expect((await admin(t, 'POST', '/treasury/withdraw-surplus', { amountCenti: '1000', reason })).body.error.code).toBe('CONFIRM_REQUIRED');
    const w = await admin(t, 'POST', '/treasury/withdraw-surplus', { amountCenti: '1000', reason, confirm: 'withdraw-surplus' });
    expect(w.body).toMatchObject({ ok: true, txHash: expect.any(String), attestTxHash: expect.any(String) });
    expect(t.app.engine.equityOnchain()).toBe(before + 499_000n);
    const tooMuch = await admin(t, 'POST', '/treasury/withdraw-surplus', { amountCenti: (t.app.engine.equityOnchain() + 1n).toString(), reason, confirm: 'withdraw-surplus' });
    expect(tooMuch.body.error.code).toBe('EXCEEDS_FREE_EQUITY');
    const chain = (await admin(t, 'GET', '/chain')).body;
    expect(chain.reconciliation).toMatchObject({ match: true });
    expect(chain.lastAttestation).toMatchObject({ seq: 2 });
  });

  it('flags and blocks players, starts refits and controls the simulation', async () => {
    const account = t.app.crowd ? [...t.app.engine.players.values()].find(p => p.kind === 'sim')!.account : 'sim:none';
    expect((await admin(t, 'POST', `/players/${encodeURIComponent(account)}/flag`, { reason })).body).toMatchObject({ ok: true, after: { flagged: true } });
    expect((await admin(t, 'POST', `/players/${encodeURIComponent(account)}/flag`, { reason })).status).toBe(409);
    expect((await admin(t, 'POST', `/players/${encodeURIComponent(account)}/block`, { reason })).body).toMatchObject({ ok: true, after: { blocked: true } });
    expect((await admin(t, 'POST', `/players/sim:ghost/block`, { reason })).status).toBe(404);
    const detail = (await admin(t, 'GET', `/players/${encodeURIComponent(account)}`)).body;
    expect(detail.flags.map((f: { action: string }) => f.action)).toEqual(['flag', 'block']);
    const refit = await admin(t, 'POST', '/refit', { reason });
    expect(refit).toMatchObject({ status: 202, body: { ok: true, jobId: expect.stringMatching(/^R\d+$/) } });
    await Promise.all([...t.app.pending]);
    expect(t.app.refitJobs.get(refit.body.jobId)?.state).toMatch(/done|failed/);
    const sim = await admin(t, 'POST', '/sim', { running: false, speed: 50, reason });
    expect(sim.body).toMatchObject({ ok: true, after: { running: false, speed: 50 } });
    expect(t.app.crowd!.running).toBe(false);
    expect((await admin(t, 'GET', '/overview')).body.sim).toMatchObject({ running: false, speed: 50 });
  });
});

describe('admin SSE stream', () => {
  it('streams overview and admin-action events to an authenticated client', async () => {
    const controller = new AbortController();
    const res = await fetch(`${t.base}/admin-api/stream`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' }, signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (pattern: RegExp) => { const deadline = Date.now() + 5000; while (!pattern.test(text) && Date.now() < deadline) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value); } };
    await readUntil(/event: overview/);
    expect(text).toMatch(/^retry: \d+/);
    await admin(t, 'PUT', '/pricing', { z: 0.25, reason });
    await readUntil(/event: admin-action/);
    const frame = text.split('\n\n').find(f => f.includes('event: admin-action'))!;
    expect(frame).toMatch(/^id: \d+/m);
    expect(JSON.parse(frame.split('\n').find(l => l.startsWith('data: '))!.slice(6))).toMatchObject({ action: 'pricing', actor: 'admin', reason });
    controller.abort();
  });
});
