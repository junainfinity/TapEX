import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { PlayerAuth, readCookie, SESSION_COOKIE } from '../src/api/auth.js';
import { RateLimiter } from '../src/api/auth-rate.js';
import { api, auth as adminAuth, startTestApp, type TestApp } from './app-helpers.js';

const ORIGIN = 'http://127.0.0.1:8180';
const CHAIN = 31337;
const WEI = 10n ** 18n;

/** Mutable wall clock shared by the session store (the replay feed keeps its own clock). */
const clock = { ms: Date.parse('2026-09-27T12:00:00Z') };
let t: TestApp;
beforeAll(async () => { t = await startTestApp({ auth: { publicOrigin: ORIGIN, chainId: CHAIN, now: () => clock.ms, rateLimits: { bet: { limit: 1000, windowMs: 1000 }, read: { limit: 1000, windowMs: 1000 } } } }); });
afterAll(async () => { await t.close(); });

interface Siwe { domain?: string; uri?: string; chainId?: number; nonce?: string; issuedAt?: Date; expirationTime?: Date; address?: `0x${string}` }
async function nonce(): Promise<string> {
  const r = await api(t.base, 'GET', '/v1/auth/nonce');
  expect(r).toMatchObject({ status: 200, body: { domain: '127.0.0.1:8180', uri: ORIGIN, chainId: CHAIN, version: '1', nonce: expect.stringMatching(/^[A-Za-z0-9]{8,}$/) } });
  return r.body.nonce as string;
}
async function message(account: PrivateKeyAccount, o: Siwe = {}): Promise<string> {
  return createSiweMessage({ address: o.address ?? account.address, chainId: o.chainId ?? CHAIN, domain: o.domain ?? '127.0.0.1:8180', nonce: o.nonce ?? await nonce(), uri: o.uri ?? `${ORIGIN}/`, version: '1', issuedAt: o.issuedAt ?? new Date(clock.ms), ...(o.expirationTime ? { expirationTime: o.expirationTime } : {}), statement: 'Sign in to Maya-Live on testnet.' });
}
async function verify(account: PrivateKeyAccount, o: Siwe = {}, signer: PrivateKeyAccount = account) {
  const text = await message(account, o);
  const signature = await signer.signMessage({ message: text });
  return { text, signature, res: await api(t.base, 'POST', '/v1/auth/verify', { message: text, signature }, { Origin: ORIGIN }) };
}
function cookieOf(res: { headers: Headers }): string {
  const raw = res.headers.get('set-cookie') ?? '';
  const token = readCookie(raw.split(',').join(';'), SESSION_COOKIE);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return `${SESSION_COOKIE}=${token}`;
}
async function signIn(account: PrivateKeyAccount): Promise<string> {
  const { res } = await verify(account);
  expect(res.status).toBe(200);
  return cookieOf(res);
}
const as = (cookie: string, extra: Record<string, string> = {}) => ({ Cookie: cookie, Origin: ORIGIN, ...extra });

describe('SIWE sign-in and session cookie', () => {
  it('signs in with a single-use nonce, sets a hardened cookie, registers the player and reads the session', async () => {
    const alice = privateKeyToAccount(generatePrivateKey());
    const { res, text, signature } = await verify(alice);
    expect(res).toMatchObject({ status: 200, body: { authenticated: true, account: alice.address.toLowerCase(), chainId: CHAIN, expiresAtMs: clock.ms + 12 * 3_600_000 } });
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(/^maya_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
    expect(set).not.toMatch(/Secure/); // http origin
    const cookie = cookieOf(res);
    expect(t.app.engine.player(alice.address.toLowerCase())).toMatchObject({ via: 'sign-in' });
    expect((await api(t.base, 'GET', '/v1/session', undefined, { Cookie: cookie })).body).toMatchObject({ authenticated: true, account: alice.address.toLowerCase() });
    expect((await api(t.base, 'GET', '/v1/session')).body).toEqual({ authenticated: false });

    // Replay: the same signed message (its nonce is consumed) never opens a second session.
    const replay = await api(t.base, 'POST', '/v1/auth/verify', { message: text, signature }, { Origin: ORIGIN });
    expect(replay).toMatchObject({ status: 401, body: { error: { code: 'NONCE_INVALID' } } });

    // Logout ends the session server-side and clears the cookie.
    const out = await api(t.base, 'POST', '/v1/auth/logout', {}, as(cookie));
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toMatch(/^maya_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0$/);
    expect((await api(t.base, 'GET', '/v1/session', undefined, { Cookie: cookie })).body).toEqual({ authenticated: false });
    expect((await api(t.base, 'GET', `/v1/account/${alice.address}`, undefined, { Cookie: cookie })).status).toBe(401);
  });

  it('consumes a nonce even when the attempt fails, and refuses expired nonces', async () => {
    const bob = privateKeyToAccount(generatePrivateKey());
    const n = await nonce();
    const wrong = await verify(bob, { nonce: n, chainId: 1 });
    expect(wrong.res).toMatchObject({ status: 401, body: { error: { code: 'CHAIN_MISMATCH' } } });
    const retry = await verify(bob, { nonce: n });
    expect(retry.res).toMatchObject({ status: 401, body: { error: { code: 'NONCE_INVALID' } } });
    const late = await nonce();
    clock.ms += 5 * 60_000 + 1;
    const expired = await verify(bob, { nonce: late, issuedAt: new Date(clock.ms) });
    expect(expired.res).toMatchObject({ status: 401, body: { error: { code: 'NONCE_EXPIRED' } } });
    expect((await verify(bob, { nonce: 'neverIssued123' })).res).toMatchObject({ status: 401, body: { error: { code: 'NONCE_INVALID' } } });
  });

  it('refuses a wrong domain, URI, chain, scheme-less origin, stale or expired message and a foreign signature', async () => {
    const carol = privateKeyToAccount(generatePrivateKey());
    const mallory = privateKeyToAccount(generatePrivateKey());
    const code = async (o: Siwe, signer = carol) => (await verify(carol, o, signer)).res.body.error.code;
    expect(await code({ domain: 'evil.example' })).toBe('DOMAIN_MISMATCH');
    expect(await code({ domain: '127.0.0.1:5173' })).toBe('DOMAIN_MISMATCH');
    expect(await code({ uri: 'http://evil.example/' })).toBe('URI_MISMATCH');
    expect(await code({ uri: 'https://127.0.0.1:8180/' })).toBe('URI_MISMATCH');
    expect(await code({ chainId: 84532 })).toBe('CHAIN_MISMATCH');
    expect(await code({ issuedAt: new Date(clock.ms - 10 * 60_000) })).toBe('MESSAGE_STALE');
    expect(await code({ issuedAt: new Date(clock.ms + 5 * 60_000) })).toBe('MESSAGE_STALE');
    expect(await code({ issuedAt: new Date(clock.ms - 60_000), expirationTime: new Date(clock.ms - 1) })).toBe('MESSAGE_EXPIRED');
    expect(await code({}, mallory)).toBe('SIGNATURE_INVALID');
    expect(await code({ address: mallory.address })).toBe('SIGNATURE_INVALID'); // claims mallory, signed by carol
    const bad = await api(t.base, 'POST', '/v1/auth/verify', { message: 'hello', signature: '0x00' }, { Origin: ORIGIN });
    expect(bad.status).toBe(400);
    const extra = await api(t.base, 'POST', '/v1/auth/verify', { message: 'x', signature: '0x00', account: carol.address }, { Origin: ORIGIN });
    expect(extra).toMatchObject({ status: 400, body: { error: { code: 'VALIDATION_ERROR' } } });
    const foreign = await api(t.base, 'POST', '/v1/auth/verify', { message: await message(carol), signature: '0x00' }, { Origin: 'http://evil.example' });
    expect(foreign).toMatchObject({ status: 403, body: { error: { code: 'ORIGIN_MISMATCH' } } });
    expect(t.app.engine.player(carol.address.toLowerCase())).toBeUndefined();
  });

  it('expires sessions after 12 h and rotates the token with a short grace for requests in flight', async () => {
    const dave = privateKeyToAccount(generatePrivateKey());
    const first = await signIn(dave);
    clock.ms += 16 * 60_000; // past the 15 min rotation age
    const rotated = await api(t.base, 'GET', '/v1/session', undefined, { Cookie: first });
    expect(rotated.body).toMatchObject({ authenticated: true, account: dave.address.toLowerCase() });
    const second = cookieOf(rotated);
    expect(second).not.toBe(first);
    expect((await api(t.base, 'GET', `/v1/account/${dave.address}`, undefined, { Cookie: first })).status).toBe(200); // grace
    clock.ms += 31_000;
    expect((await api(t.base, 'GET', `/v1/account/${dave.address}`, undefined, { Cookie: first })).status).toBe(401);
    expect((await api(t.base, 'GET', `/v1/account/${dave.address}`, undefined, { Cookie: second })).status).toBe(200);
    clock.ms += 12 * 3_600_000;
    expect((await api(t.base, 'GET', '/v1/session', undefined, { Cookie: second })).body).toEqual({ authenticated: false });
    expect((await api(t.base, 'POST', '/v1/bets', { requestId: 'late-1', quoteId: 'q', cellId: 'c', stakeCenti: '100' }, as(second))).body.error.code).toBe('AUTH_REQUIRED');
  });
});

describe('account-scoped routes take the account from the session', () => {
  it('bets, receipts, account, withdrawals and proofs refuse other accounts and unauthenticated callers', async () => {
    const alice = privateKeyToAccount(generatePrivateKey()), bob = privateKeyToAccount(generatePrivateKey());
    const a = alice.address.toLowerCase(), b = bob.address.toLowerCase();
    const ca = await signIn(alice), cb = await signIn(bob);
    t.app.engine.creditDeposit({ player: a, amountWei: 500n * WEI, depositId: 9001n, txHash: '0x' + 'a'.repeat(64), logIndex: 0, blockNumber: 1n });
    t.advance(2);
    const grid = (await api(t.base, 'GET', '/v1/quotes?market=btc-usd', undefined, { Cookie: ca })).body;
    const cell = grid.cells.find((c: { available: boolean; window: number }) => c.available && c.window >= 3);
    expect(cell).toBeTruthy();

    // No account in the body: the session's account places it.
    const bet = { requestId: 'siwe-bet-1', quoteId: cell.quoteId, revision: 1, cellId: cell.cellId, stakeCenti: '1000' };
    const placed = await api(t.base, 'POST', '/v1/bets', bet, as(ca));
    expect(placed).toMatchObject({ status: 200, body: { status: 'accepted', leg: { account: a, stakeCenti: '1000' } } });
    // A body account is ignored for authorization: it must match the session, else 403 and nothing is placed.
    expect(await api(t.base, 'POST', '/v1/bets', { ...bet, requestId: 'siwe-bet-2', account: b }, as(ca))).toMatchObject({ status: 403, body: { error: { code: 'ACCOUNT_MISMATCH' } } });
    expect(await api(t.base, 'POST', '/v1/bets', { ...bet, requestId: 'siwe-bet-3', account: alice.address }, as(ca))).toMatchObject({ status: 200 });
    expect(t.app.engine.receiptFor('siwe-bet-2')).toBeUndefined();
    // Unauthenticated, cross-site, and Bob using Alice's intent.
    expect((await api(t.base, 'POST', '/v1/bets', { ...bet, requestId: 'siwe-bet-4', account: a })).status).toBe(401);
    expect((await api(t.base, 'POST', '/v1/bets', { ...bet, requestId: 'siwe-bet-5' }, { Cookie: ca, Origin: 'http://evil.example' })).body.error.code).toBe('ORIGIN_MISMATCH');
    const bobs = await api(t.base, 'POST', '/v1/bets', bet, as(cb));
    expect(bobs).toMatchObject({ status: 409, body: { reason: 'REQUEST_CONFLICT' } });
    const bobRejected = await api(t.base, 'POST', '/v1/bets', { ...bet, requestId: 'siwe-bet-bob' }, as(cb));
    expect(bobRejected.body).toMatchObject({ status: 'rejected', reason: 'INSUFFICIENT_BALANCE' });

    // Receipts: own ones only (another account's is indistinguishable from an unknown id).
    expect((await api(t.base, 'GET', '/v1/bets/by-request/siwe-bet-1', undefined, { Cookie: ca })).body).toMatchObject({ status: 'accepted' });
    expect((await api(t.base, 'GET', '/v1/bets/by-request/siwe-bet-1', undefined, { Cookie: cb })).status).toBe(404);
    expect((await api(t.base, 'GET', '/v1/bets/by-request/siwe-bet-bob', undefined, { Cookie: cb })).body).toMatchObject({ status: 'rejected', reason: 'INSUFFICIENT_BALANCE' });
    expect((await api(t.base, 'GET', '/v1/bets/by-request/siwe-bet-bob', undefined, { Cookie: ca })).status).toBe(404);
    expect((await api(t.base, 'GET', '/v1/bets/by-request/siwe-bet-1')).status).toBe(401);

    // Account views.
    expect((await api(t.base, 'GET', `/v1/account/${alice.address}`, undefined, { Cookie: ca })).body).toMatchObject({ account: a, balanceCenti: '48000' });
    expect(await api(t.base, 'GET', `/v1/account/${bob.address}`, undefined, { Cookie: ca })).toMatchObject({ status: 403, body: { error: { code: 'ACCOUNT_MISMATCH' } } });
    expect((await api(t.base, 'GET', `/v1/account/${alice.address}`)).status).toBe(401);
    expect((await api(t.base, 'GET', `/v1/quotes?market=btc-usd&account=${b}`, undefined, { Cookie: ca })).status).toBe(403);
    expect((await api(t.base, 'GET', `/v1/quotes?market=btc-usd&account=${a}`)).status).toBe(401);
    expect((await api(t.base, 'GET', '/v1/quotes?market=btc-usd')).status).toBe(200); // the public grid stays public

    // Withdrawals: no MAYA_OPEN_PLAYER_API needed with a session, and only for the session's account.
    const w = await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'siwe-wd-1', amountCenti: '2500' }, as(ca));
    expect(w).toMatchObject({ status: 200, body: { account: a, amountCenti: '2500', status: 'pending' } });
    expect(await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'siwe-wd-2', account: b, amountCenti: '1' }, as(ca))).toMatchObject({ status: 403 });
    expect((await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'siwe-wd-3', account: a, amountCenti: '1' })).status).toBe(401);
    expect((await api(t.base, 'GET', '/v1/withdrawals', undefined, { Cookie: ca })).body).toMatchObject({ account: a, rows: [{ requestId: 'siwe-wd-1' }] });
    expect((await api(t.base, 'GET', `/v1/withdrawals?account=${b}`, undefined, { Cookie: ca })).status).toBe(403);

    // Escape-hatch proof: own account, or the admin bearer token (house console).
    expect((await api(t.base, 'GET', `/v1/account/${alice.address}/proof`, undefined, { Cookie: ca })).status).toBe(200);
    expect((await api(t.base, 'GET', `/v1/account/${alice.address}/proof`, undefined, { Cookie: cb })).status).toBe(403);
    expect((await api(t.base, 'GET', `/v1/account/${alice.address}/proof`)).status).toBe(401);
    expect((await api(t.base, 'GET', `/v1/account/${alice.address}/proof`, undefined, adminAuth)).status).toBe(200);
  });

  it('rate-limits sign-in attempts per client', async () => {
    const limited = new PlayerAuth({ publicOrigin: ORIGIN, chainId: CHAIN, rateLimits: { nonce: { limit: 3, windowMs: 60_000 } } });
    expect(() => { for (let i = 0; i < 4; i++) limited.rateLimit('nonce', '10.0.0.1'); }).toThrow(/Too many requests/);
    expect(() => limited.rateLimit('nonce', '10.0.0.2')).not.toThrow();
    let now = 0;
    const r = new RateLimiter({ now: () => now, limits: { bet: { limit: 2, windowMs: 1000 } } });
    expect([r.take('bet', 's').ok, r.take('bet', 's').ok, r.take('bet', 's').ok]).toEqual([true, true, false]);
    now += 500;
    expect(r.take('bet', 's').ok).toBe(true);
    // The server answers 429 with Retry-After once the nonce budget of one client is spent.
    let last = 0;
    for (let i = 0; i < 40 && last !== 429; i++) last = (await api(t.base, 'GET', '/v1/auth/nonce')).status;
    expect(last).toBe(429);
  });
});

describe('public live-game routes', () => {
  it('serves chain config and the pinned first-seen path', async () => {
    const cfg = (await api(t.base, 'GET', '/v1/chain-config')).body;
    expect(cfg).toMatchObject({ network: 'offline', chainId: 0, walletSupported: false, rpcUrl: null, token: { symbol: 'tOPEN', decimals: 18 }, nativeCurrency: { symbol: 'ETH' }, siwe: { domain: '127.0.0.1:8180', uri: ORIGIN, chainId: CHAIN } });
    const path = (await api(t.base, 'GET', '/v1/path?market=btc-usd')).body;
    expect(path.samples.length).toBeGreaterThan(10);
    const latest = t.app.engine.paths.get('btc-usd')!.latest()!;
    expect(path).toMatchObject({ market: 'btc-usd', latestT: latest.t, clockMs: t.app.engine.nowMs });
    expect(path.samples.at(-1)).toEqual({ t: latest.t, sourceTimeMs: latest.sourceTimeMs, price: latest.priceText, sampleId: latest.sampleId, receivedAtMs: latest.receivedAtMs });
    for (const s of path.samples) expect(s.price).toBe(t.app.engine.paths.get('btc-usd')!.sample(s.t)!.priceText);
    const since = (await api(t.base, 'GET', `/v1/path?market=btc-usd&fromMs=${(latest.t - 3) * 1000}`)).body;
    expect(since.samples.map((s: { t: number }) => s.t)).toEqual([latest.t - 2, latest.t - 1, latest.t]);
    expect((await api(t.base, 'GET', '/v1/path?market=doge')).status).toBe(400);
    expect((await api(t.base, 'GET', '/v1/path?market=btc-usd&fromMs=-1')).status).toBe(400);
  });
});

describe('MAYA_OPEN_PLAYER_API=testnet-unsafe as an explicit dev override next to sessions', () => {
  it('lets a request without a session act for a named account, while a session still wins and mismatches stay 403', async () => {
    const o = await startTestApp({ auth: { publicOrigin: ORIGIN, chainId: CHAIN }, openPlayerApi: true });
    try {
      const p = o.chain.players()[0]!;
      await o.chain.playerDeposit(p.role, 100n * WEI);
      expect((await api(o.base, 'GET', `/v1/account/${p.address}`)).body).toMatchObject({ account: p.address, balanceCenti: '10000' });
      const w = await api(o.base, 'POST', '/v1/withdrawals', { requestId: 'override-wd', account: p.address, amountCenti: '100' });
      expect(w).toMatchObject({ status: 200, body: { account: p.address, status: 'pending' } });
      expect((await api(o.base, 'POST', '/v1/withdrawals', { requestId: 'override-wd-2', amountCenti: '100' })).status).toBe(400); // no account named
      const eve = privateKeyToAccount(generatePrivateKey());
      const text = createSiweMessage({ address: eve.address, chainId: CHAIN, domain: '127.0.0.1:8180', nonce: (await api(o.base, 'GET', '/v1/auth/nonce')).body.nonce, uri: ORIGIN, version: '1', issuedAt: new Date() });
      const signedIn = await api(o.base, 'POST', '/v1/auth/verify', { message: text, signature: await eve.signMessage({ message: text }) }, { Origin: ORIGIN });
      const cookie = cookieOf(signedIn);
      expect((await api(o.base, 'GET', `/v1/account/${p.address}`, undefined, { Cookie: cookie })).status).toBe(403);
    } finally { await o.close(); }
  });
});
