import { describe, expect, it, vi } from 'vitest';
import { AdminApi, writes, type FetchLike } from './api.js';
import { overviewFixture } from './test-fixtures.js';

interface Call { url: string; init: RequestInit | undefined }

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function client(respond: (call: Call) => Response | Promise<Response>, extra: Partial<ConstructorParameters<typeof AdminApi>[0]> = {}) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => { const call = { url, init }; calls.push(call); return respond(call); };
  const api = new AdminApi({ getToken: () => 'tok-123', fetch, newRequestId: () => 'req-1', ...extra });
  return { api, calls };
}

const headerOf = (call: Call, name: string) => new Headers(call.init?.headers).get(name);

describe('AdminApi reads', () => {
  it('sends the bearer token and decodes the overview into a frozen snapshot', async () => {
    const { api, calls } = client(() => json(200, overviewFixture()));
    const result = await api.overview();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls[0]!.url).toBe('/admin-api/overview');
    expect(headerOf(calls[0]!, 'authorization')).toBe('Bearer tok-123');
    expect(calls[0]!.init?.method).toBe('GET');
    expect(result.data.equityCenti).toBe('512345678');
    expect(result.data.markets[0]!.spot).toBe('64012.5');
    expect(Object.isFrozen(result.data)).toBe(true);
    expect(Object.isFrozen(result.data.markets[0])).toBe(true);
  });

  it('omits the Authorization header without a token and honours baseUrl', async () => {
    const { api, calls } = client(() => json(200, overviewFixture()), { getToken: () => null, baseUrl: 'http://127.0.0.1:8790/' });
    await api.overview();
    expect(calls[0]!.url).toBe('http://127.0.0.1:8790/admin-api/overview');
    expect(headerOf(calls[0]!, 'authorization')).toBeNull();
  });

  it('encodes query strings for every list endpoint', async () => {
    const { api, calls } = client(({ url }) => {
      if (url.includes('/players?') || url.endsWith('/players')) return json(200, { rows: [], nextCursor: null });
      if (url.includes('/bets')) return json(200, { rows: [] });
      if (url.includes('/audit')) return json(200, []);
      if (url.includes('/metrics')) return json(200, { t: [], equity: [], ggr: [], handle: [], rtp: [], openLiability: [], players: [], betsPerMin: [] });
      if (url.includes('/exposure')) return json(200, { market: 'ETH/USD', windows: [], bands: [], cells: [] });
      return json(404, {});
    });
    await api.players({ sort: 'pnl', dir: 'desc', limit: 50, cursor: 'c2', q: '  0xab ' });
    await api.players({ sort: 'bets', dir: 'asc' });
    await api.bets({ account: 'player:0xab', market: 'BTC/USD', status: 'open', limit: 100 });
    await api.audit(200);
    await api.metrics({ from: 1, to: 2, step: 60_000 });
    await api.exposure('ETH/USD');
    await api.player('player:0xab/cd');
    expect(calls.map(c => c.url)).toEqual([
      '/admin-api/players?sort=-pnl&limit=50&cursor=c2&q=0xab',
      '/admin-api/players?sort=bets',
      '/admin-api/bets?limit=100&account=player%3A0xab&market=BTC%2FUSD&status=open',
      '/admin-api/audit?limit=200',
      '/admin-api/metrics?from=1&to=2&step=60000',
      '/admin-api/exposure?market=ETH%2FUSD',
      '/admin-api/players/player%3A0xab%2Fcd',
    ]);
  });

  it('returns the server error code and message on failure', async () => {
    const { api } = client(() => json(409, { error: { code: 'LIABILITY_LIMIT', message: 'global limit' } }));
    const result = await api.rtp();
    expect(result).toEqual({ ok: false, error: { code: 'LIABILITY_LIMIT', message: 'global limit', status: 409 } });
  });

  it('maps non-JSON errors to HTTP_<status> and calls onUnauthorized on 401', async () => {
    const onUnauthorized = vi.fn();
    const { api } = client(() => new Response('nope', { status: 401, statusText: 'Unauthorized' }), { onUnauthorized });
    const result = await api.chain();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('UNAUTHORIZED');
    expect(onUnauthorized).toHaveBeenCalledOnce();
    const { api: api2 } = client(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const r2 = await api2.chain();
    expect(!r2.ok && r2.error.code).toBe('HTTP_502');
  });

  it('rejects malformed payloads as BAD_RESPONSE instead of rendering zeros', async () => {
    const broken = { ...overviewFixture(), equityCenti: 5123.45 };
    const { api } = client(() => json(200, broken));
    const result = await api.overview();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('BAD_RESPONSE');
    expect(result.error.message).toContain('overview.equityCenti');
    const { api: api2 } = client(() => new Response('not json', { status: 200 }));
    const r2 = await api2.overview();
    expect(!r2.ok && r2.error.code).toBe('BAD_RESPONSE');
  });

  it('rejects metrics series that are not aligned with t[]', async () => {
    const { api } = client(() => json(200, { t: [1, 2], equity: ['1'], ggr: ['1', '2'], handle: ['1', '2'], rtp: [0.9, null], openLiability: ['1', '2'], players: [1, 2], betsPerMin: [3, 4] }));
    const result = await api.metrics({ from: 0, to: 1, step: 1 });
    expect(!result.ok && result.error.message).toContain('metrics.equity');
  });

  it('reports network failures and read timeouts as typed errors', async () => {
    const { api } = client(() => { throw new TypeError('Failed to fetch'); });
    expect(await api.overview()).toEqual({ ok: false, error: { code: 'NETWORK', message: 'Failed to fetch', status: 0 } });
    vi.useFakeTimers();
    try {
      const hanging: FetchLike = (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
      const slow = new AdminApi({ getToken: () => 't', fetch: hanging, readTimeoutMs: 500 });
      const pending = slow.overview();
      await vi.advanceTimersByTimeAsync(501);
      const result = await pending;
      expect(!result.ok && result.error.code).toBe('TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts bare arrays for list endpoints and normalises string multipliers', async () => {
    const leg = { legId: 'L1', account: 'player:0xab', market: 'BTC/USD', start: 1000, bandIndex: 2, stakeCenti: '500', x100: '350', payoutCenti: '1750', status: 'open', placedMs: 900 };
    const { api } = client(() => json(200, [leg]));
    const result = await api.bets();
    expect(result.ok && result.data.rows[0]!.x100).toBe(350);
    const { api: bad } = client(() => json(200, [{ ...leg, status: 'pending' }]));
    const r2 = await bad.bets();
    expect(!r2.ok && r2.error.message).toContain('bets.rows[0].status');
  });
});

describe('AdminApi writes', () => {
  it('builds every write endpoint in SPEC §7 with reason and optional confirm', () => {
    const m = { reason: 'because testing' };
    const d = { reason: 'because testing', confirm: 'pause-all' };
    const table = [
      [writes.pauseMarket('BTC/USD', m), 'POST', '/markets/BTC%2FUSD/pause'],
      [writes.resumeMarket('BTC/USD', m), 'POST', '/markets/BTC%2FUSD/resume'],
      [writes.pauseAll(d), 'POST', '/pause-all'],
      [writes.resumeAll(m), 'POST', '/resume-all'],
      [writes.pricing({ standardEdge: 0.09 }, m), 'PUT', '/pricing'],
      [writes.launch({ enabled: false }, m), 'PUT', '/launch'],
      [writes.limits({ cellFraction: 0.002 }, m), 'PUT', '/limits'],
      [writes.refit(m), 'POST', '/refit'],
      [writes.player('player:0xab', 'flag', m), 'POST', '/players/player%3A0xab/flag'],
      [writes.player('player:0xab', 'unblock', m), 'POST', '/players/player%3A0xab/unblock'],
      [writes.fundHouse('100000', m), 'POST', '/treasury/fund'],
      [writes.withdrawSurplus('5000', m), 'POST', '/treasury/withdraw-surplus'],
      [writes.attest(m), 'POST', '/treasury/attest'],
      [writes.vaultPause(m), 'POST', '/vault/pause'],
      [writes.vaultUnpause(m), 'POST', '/vault/unpause'],
      [writes.sim({ running: false }, m), 'POST', '/sim'],
    ] as const;
    for (const [request, method, path] of table) {
      expect(request.method).toBe(method);
      expect(request.path).toBe(path);
      expect(request.body['reason']).toBe('because testing');
    }
    expect(writes.pauseAll(d).body).toEqual({ reason: 'because testing', confirm: 'pause-all' });
    expect(writes.pricing({ standardEdge: 0.09 }, m).body).toEqual({ standardEdge: 0.09, reason: 'because testing' });
    expect(writes.fundHouse('100000', m).body).toEqual({ amountCenti: '100000', reason: 'because testing' });
    expect('confirm' in writes.resumeAll(m).body).toBe(false);
  });

  it('sends JSON with an idempotency key and returns the acknowledgement', async () => {
    const { api, calls } = client(() => json(200, { ok: true, auditId: 'a-7', before: { paused: false }, after: { paused: true } }));
    const result = await api.send(writes.pauseMarket('ETH/USD', { reason: 'feed looks wrong' }));
    expect(result.ok && result.data.auditId).toBe('a-7');
    const call = calls[0]!;
    expect(call.url).toBe('/admin-api/markets/ETH%2FUSD/pause');
    expect(call.init?.method).toBe('POST');
    expect(headerOf(call, 'content-type')).toBe('application/json');
    expect(headerOf(call, 'idempotency-key')).toBe('req-1');
    expect(JSON.parse(String(call.init?.body))).toEqual({ reason: 'feed looks wrong' });
  });

  it('refuses to send a write without a reason', async () => {
    const { api, calls } = client(() => json(200, {}));
    const result = await api.send({ method: 'POST', path: '/pause-all', body: { reason: '   ' } });
    expect(!result.ok && result.error.code).toBe('REASON_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  it('surfaces server rejections such as CONFIRM_REQUIRED verbatim', async () => {
    const { api } = client(() => json(400, { error: { code: 'CONFIRM_REQUIRED', message: 'type pause-all' } }));
    const result = await api.send(writes.pauseAll({ reason: 'incident 42' }));
    expect(result).toEqual({ ok: false, error: { code: 'CONFIRM_REQUIRED', message: 'type pause-all', status: 400 } });
  });

  it('never reports a write timeout as a rejection: the outcome is unknown and nothing is retried', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const hanging: FetchLike = (_url, init) => { attempts++; return new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); }); };
      const api = new AdminApi({ getToken: () => 't', fetch: hanging, writeTimeoutMs: 1000 });
      const pending = api.send(writes.fundHouse('100', { reason: 'top up the house' }));
      await vi.advanceTimersByTimeAsync(1001);
      const result = await pending;
      expect(!result.ok && result.error.code).toBe('WRITE_TIMEOUT_UNKNOWN_OUTCOME');
      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    const { api } = client(() => { throw new TypeError('socket hang up'); });
    const result = await api.send(writes.attest({ reason: 'hourly attest' }));
    expect(!result.ok && result.error.code).toBe('WRITE_NETWORK_UNKNOWN_OUTCOME');
  });

  it('treats a 2xx write with an empty or non-JSON body as acknowledged', async () => {
    const { api } = client(() => new Response(null, { status: 204 }));
    const r1 = await api.send(writes.attest({ reason: 'hourly attest' }));
    expect(r1.ok).toBe(true);
    const { api: api2 } = client(() => new Response('OK', { status: 200 }));
    const r2 = await api2.send(writes.attest({ reason: 'hourly attest' }));
    expect(r2.ok && r2.data['note']).toContain('not JSON');
  });
});

describe('AdminApi SPEC-10 / SPEC-11 routes', () => {
  const proofBody = { account: '0x4444444444444444444444444444444444444444', chainId: 31337, vault: '0x2222222222222222222222222222222222222222', attestation: { seq: '7', root: `0x${'ab'.repeat(32)}`, asOf: '1790000000', asOfMs: 1_790_000_000_000, liabilitiesWei: '1000', source: 'vault' }, escape: null };

  it('looks up proofs on the public player route without the admin token', async () => {
    const { api, calls } = client(() => json(200, { ...proofBody, included: true, balanceWei: '500', proof: [`0x${'cd'.repeat(32)}`], currentOwedWei: '400' }), { baseUrl: 'http://127.0.0.1:8790' });
    const r = await api.proof('0x4444444444444444444444444444444444444444');
    expect(calls[0]!.url).toBe('http://127.0.0.1:8790/v1/account/0x4444444444444444444444444444444444444444/proof');
    expect(headerOf(calls[0]!, 'authorization')).toBeNull();
    expect(r).toMatchObject({ ok: true, data: { included: true, balanceWei: '500' } });
  });

  it('renders the 503 PROOF_UNAVAILABLE body instead of a bare error, and never signs out on a player-route 401', async () => {
    const onUnauthorized = vi.fn();
    const { api } = client(({ url }) => (url.includes('dead') ? json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }) : json(503, { ...proofBody, error: { code: 'PROOF_UNAVAILABLE', message: 'tree missing' } })), { onUnauthorized });
    const r = await api.proof('0x4444444444444444444444444444444444444444');
    expect(r).toMatchObject({ ok: true, data: { unavailable: { code: 'PROOF_UNAVAILABLE' }, attestation: { seq: '7' } } });
    const denied = await api.proof('0x000000000000000000000000000000000000dead');
    expect(denied).toMatchObject({ ok: false, error: { status: 401 } });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('a 503 without a JSON body is still an error', async () => {
    const { api } = client(() => new Response('upstream down', { status: 503 }));
    expect(await api.proof('0x4444444444444444444444444444444444444444')).toMatchObject({ ok: false, error: { code: 'HTTP_503', status: 503 } });
  });

  it('asks the server for one exposure cell (start + bandIndex)', async () => {
    const { api, calls } = client(() => json(200, { rows: [] }));
    await api.bets({ market: 'btc-usd', start: 1_790_000_005_000, bandIndex: 8631, limit: 500 });
    expect(calls[0]!.url).toBe('/admin-api/bets?limit=500&market=btc-usd&start=1790000005000&bandIndex=8631');
  });

  it('builds the defenses and vault writes with reason, confirm and the exact paths', () => {
    expect(writes.defenses({ controller: { overrides: { '2-5': null } } }, { reason: 'release pin', confirm: 'edge-change' })).toEqual({ method: 'PUT', path: '/defenses', body: { controller: { overrides: { '2-5': null } }, reason: 'release pin', confirm: 'edge-change' } });
    expect(writes.signerPropose('0xabc', { reason: 'rotate', confirm: 'signer-propose' })).toEqual({ method: 'POST', path: '/vault/signer/propose', body: { address: '0xabc', reason: 'rotate', confirm: 'signer-propose' } });
    expect(writes.signerAccept({ reason: 'accept', confirm: 'signer-accept' }).path).toBe('/vault/signer/accept');
    expect(writes.signerCancel({ reason: 'cancel it' })).toEqual({ method: 'POST', path: '/vault/signer/cancel', body: { reason: 'cancel it' } });
    expect(writes.sweepExcess('0xdef', { reason: 'sweep', confirm: 'sweep-excess' })).toEqual({ method: 'POST', path: '/vault/sweep-excess', body: { to: '0xdef', reason: 'sweep', confirm: 'sweep-excess' } });
  });
});

describe('AdminApi players type filter', () => {
  it('passes kind to the server for the On-chain / Simulated chips', async () => {
    const { api, calls } = client(() => json(200, { rows: [], nextCursor: null }));
    await api.players({ sort: 'handle', dir: 'desc', limit: 100, kind: 'onchain' });
    expect(calls[0]!.url).toBe('/admin-api/players?sort=-handle&limit=100&kind=onchain');
  });
});
