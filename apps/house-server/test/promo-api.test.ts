import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { DEFAULT_PROMO } from '@maya/house';
import { SESSION_COOKIE, readCookie } from '../src/api/auth.js';
import { admin, api, startTestApp, type TestApp } from './app-helpers.js';

const ORIGIN = 'http://127.0.0.1:8180';
const CHAIN = 31337;
const clock = { ms: Date.parse('2026-09-27T12:00:00Z') };
const reason = 'operator decision for the test';

let t: TestApp;
let legacy: TestApp;
beforeAll(async () => {
  t = await startTestApp({ promo: DEFAULT_PROMO, auth: { publicOrigin: ORIGIN, chainId: CHAIN, now: () => clock.ms } });
  legacy = await startTestApp();
});
afterAll(async () => { await t.close(); await legacy.close(); });

async function signIn(): Promise<{ cookie: string; account: string }> {
  const account = privateKeyToAccount(generatePrivateKey());
  const nonce = (await api(t.base, 'GET', '/v1/auth/nonce')).body.nonce as string;
  const message = createSiweMessage({ address: account.address, chainId: CHAIN, domain: '127.0.0.1:8180', nonce, uri: `${ORIGIN}/`, version: '1', issuedAt: new Date(clock.ms), statement: 'Sign in to Maya-Live on testnet.' });
  const res = await api(t.base, 'POST', '/v1/auth/verify', { message, signature: await account.signMessage({ message }) }, { Origin: ORIGIN });
  expect(res.status).toBe(200);
  const token = readCookie((res.headers.get('set-cookie') ?? '').split(',').join(';'), SESSION_COOKIE);
  return { cookie: `${SESSION_COOKIE}=${token}`, account: account.address.toLowerCase() };
}

describe('GET /v1/promo (SPEC-12 public contract)', () => {
  it('answers the tier, label, minimum win and progress; account is null without a session', async () => {
    const r = await api(t.base, 'GET', '/v1/promo');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['account', 'label', 'minWinX100', 'progress', 'tier']);
    expect(r.body).toMatchObject({ tier: 'launch', label: 'Launch boost', minWinX100: 125, account: null, progress: { untilPlayers: 10_000, untilTurnoverCenti: '100000000' } });
    expect(Object.keys(r.body.progress).sort()).toEqual(['players', 'turnoverCenti', 'untilPlayers', 'untilTurnoverCenti']);
    expect(typeof r.body.progress.players).toBe('number');
    expect(r.body.progress.turnoverCenti).toMatch(/^\d+$/);
    // A client-named account is never used: the account block needs a session.
    expect((await api(t.base, 'GET', `/v1/promo?account=0x${'a'.repeat(40)}`)).body.account).toBeNull();
  });

  it('fills the account block from a valid player session (SIWE cookie)', async () => {
    const { cookie, account } = await signIn();
    const r = await api(t.base, 'GET', '/v1/promo', undefined, { Cookie: cookie });
    expect(r.body).toMatchObject({ tier: 'launch', account: { boostRemainingCenti: '100000' } });
    expect(t.app.engine.player(account)).toBeDefined();
    expect((await api(t.base, 'GET', '/v1/promo', undefined, { Cookie: `${SESSION_COOKIE}=${'x'.repeat(43)}` })).body.account).toBeNull();
  });

  it('works on the legacy server (no promo tiers, no sessions): standard tier, account null', async () => {
    const r = await api(legacy.base, 'GET', '/v1/promo');
    expect(r.body).toEqual({ tier: 'standard', label: 'Standard odds', minWinX100: 101, progress: { players: expect.any(Number), untilPlayers: null, turnoverCenti: expect.stringMatching(/^\d+$/), untilTurnoverCenti: null }, account: null });
  });
});

describe('promo admin API (SPEC-12 §6, SPEC §7 conventions)', () => {
  it('GET /admin-api/promo reports the configuration and live state per tier; the overview carries tier, progress and budget used', async () => {
    const r = await admin(t, 'GET', '/promo');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: true, enabled: true, current: { tier: 'launch', boosted: true, baseEdge: -0.1, lossBudget: 0.1, minWinX100: 125 }, confirm: { endTier: 'promo-end-tier', resume: 'promo-resume', edgeChange: 'edge-change' } });
    expect(r.body.tiers.map((x: { id: string; status: string }) => [x.id, x.status])).toEqual([['launch', 'current'], ['growth', 'upcoming'], ['scale', 'upcoming'], ['standard', 'upcoming']]);
    expect(r.body.tiers[0]).toMatchObject({ turnoverCenti: expect.any(String), realized: { boosted: { budget: 0.1 }, boostedClean: { budget: 0.1 } }, accounts: { capCenti: '100000' }, guard: { adjust: 0, tripped: false } });
    const o = await admin(t, 'GET', '/overview');
    expect(o.body.promo).toMatchObject({ enabled: true, tier: 'launch', label: 'Launch boost', boosted: true, progress: { untilPlayers: 10_000, untilTurnoverCenti: '100000000' }, budget: { lossBudget: 0.1 }, guard: { tripped: false } });
    expect(o.body.launch).toMatchObject({ enabled: true, active: true, edge: -0.1, untilPlayers: 10_000, standardEdge: 0.08 });
    expect(Array.isArray(o.body.breakers)).toBe(true);
  });

  it('PUT /admin-api/promo edits with a reason, strict keys, confirmation for edge moves and Idempotency-Key replay', async () => {
    expect((await admin(t, 'PUT', '/promo', { tiers: { launch: { minWinX100: 130 } } })).body.error.code).toBe('REASON_REQUIRED');
    expect((await admin(t, 'PUT', '/promo', { bogus: 1, reason })).status).toBe(400);
    expect((await admin(t, 'PUT', '/promo', { tiers: { launch: { nope: 1 } }, reason })).body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringMatching(/tiers\.launch\.nope/) });
    expect((await admin(t, 'PUT', '/promo', { reason })).body.error.code).toBe('VALIDATION_ERROR');
    const ok = await admin(t, 'PUT', '/promo', { tiers: { launch: { minWinX100: 130 } }, reason }, { 'Idempotency-Key': 'promo-edit-1' });
    expect(ok).toMatchObject({ status: 200, body: { ok: true, action: 'promo', auditId: expect.any(String), before: { tier: 'launch' }, after: { config: { tiers: [{ minWinX100: 130 }, {}, {}] } } } });
    const replay = await admin(t, 'PUT', '/promo', { tiers: { launch: { minWinX100: 130 } }, reason }, { 'Idempotency-Key': 'promo-edit-1' });
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    expect(replay.body.auditId).toBe(ok.body.auditId);
    expect((await api(t.base, 'GET', '/v1/promo')).body.minWinX100).toBe(130);
    expect((await admin(t, 'PUT', '/promo', { tiers: { launch: { lossBudget: 0.2 } }, reason })).body.error.code).toBe('CONFIRM_REQUIRED');
    expect((await admin(t, 'PUT', '/promo', { tiers: { launch: { lossBudget: 0.2 } }, reason, confirm: 'edge-change' })).body).toMatchObject({ ok: true });
    expect((await admin(t, 'PUT', '/promo', { tiers: { launch: { lossBudget: 0.1, minWinX100: 125 } }, reason, confirm: 'edge-change' })).body).toMatchObject({ ok: true });
    const audit = await admin(t, 'GET', '/audit?limit=20');
    const rows = audit.body.rows.filter((a: { action: string }) => a.action === 'promo');
    expect(rows.length).toBe(3);
    expect(rows.every((a: { actor: string; reason: string; before: unknown; after: unknown }) => a.actor === 'admin' && a.reason === reason && a.before && a.after)).toBe(true);
  });

  it('the legacy launch endpoint is replaced; end-tier and resume need their confirmation phrases', async () => {
    expect(await admin(t, 'PUT', '/launch', { enabled: false, reason, confirm: 'edge-change' })).toMatchObject({ status: 409, body: { error: { code: 'LAUNCH_REPLACED' } } });
    expect((await admin(t, 'POST', '/promo/resume', { reason, confirm: 'promo-resume' })).body.error.code).toBe('NOT_TRIPPED');
    expect((await admin(t, 'POST', '/promo/resume', { tier: 'bonus', reason, confirm: 'promo-resume' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await admin(t, 'POST', '/promo/end-tier', { reason })).body.error.code).toBe('CONFIRM_REQUIRED');
    const ended = await admin(t, 'POST', '/promo/end-tier', { reason, confirm: 'promo-end-tier' });
    expect(ended.body).toMatchObject({ ok: true, action: 'promo-end-tier', before: { tier: 'launch' }, after: { tier: 'growth' } });
    const pub = (await api(t.base, 'GET', '/v1/promo')).body;
    expect(pub).toMatchObject({ tier: 'growth', label: 'Growth boost', minWinX100: 110, progress: { untilPlayers: 100_000, untilTurnoverCenti: '1000000000' } });
    const view = await admin(t, 'GET', '/promo');
    expect(view.body.tiers.map((x: { id: string; status: string }) => [x.id, x.status])).toEqual([['launch', 'ended'], ['growth', 'current'], ['scale', 'upcoming'], ['standard', 'upcoming']]);
    expect(view.body.tierLog.map((x: { tier: string }) => x.tier)).toEqual(['launch', 'growth']);
    t.advance(2);
    const quotes = await api(t.base, 'GET', '/v1/quotes?market=btc-usd');
    expect(quotes.body).toMatchObject({ tier: 'growth', pricing: 'boosted', variant: 'main', minWinX100: 110, boostRemainingCenti: null, phase: 'launch' });
    for (const c of quotes.body.cells as { available: boolean; x100?: number }[]) if (c.available) expect(c.x100!).toBeGreaterThanOrEqual(110);
  });
});
