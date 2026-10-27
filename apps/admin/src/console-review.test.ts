/**
 * Regression tests for the console-conformance review (CC-01 … CC-14, CC-06 is server-side). Each block
 * encodes the finding's failure scenario; every one of them failed on the console as reviewed.
 */
import { describe, expect, it } from 'vitest';
import { evictIndex, filterAlerts } from './alert-throttle.js';
import { AdminApi, isUnknownOutcome, writes, type FetchLike } from './api.js';
import { bannerItems, isOverviewStale, OVERVIEW_STALE_MS } from './banners.js';
import { attestationHealth, chainSummary, escapeMissingNotice, vaultBadges } from './chain-health.js';
import {
  attestPlan, CONFIRM_NAMES, fundPlan, marketControl, marketPlan, pauseAllPlan, pricingPlan, signerCancelPlan, sweepExcessPlan, vaultPlan, withdrawSurplusPlan,
} from './controls.js';
import { decodeChain, decodeOverview, decodeRtp } from './decode.js';
import { formatDisplayValue, networkLine } from './format.js';
import { feedHealth } from './health.js';
import { LIVE } from './live-fixtures.js';
import { matchesAudit } from './pages/audit.js';
import { rtpBand, rtpTarget } from './rtp-stats.js';
import { Store } from './store.js';
import { chainFixture, launchFixture, marketFixture, overviewFixture, pricingFixture } from './test-fixtures.js';
import type { Breaker, Overview } from './types.js';
import { equityTileValue, flagLabel } from './view-models.js';
import { UnknownOutcomeLog, WriteSession } from './write-session.js';

const REASON = 'fund the house for review';
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Seen { key: string | null; body: string }
/** A fetch that answers from a script of responses and records the Idempotency-Key and body of each request. */
function scripted(responses: (() => Response)[]): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  let i = 0;
  const fetch: FetchLike = async (_url, init) => {
    seen.push({ key: new Headers(init?.headers).get('idempotency-key'), body: String(init?.body) });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return next();
  };
  return { fetch, seen };
}
const viteBadGateway = () => new Response('', { status: 502, statusText: 'Bad Gateway' });
const jsonResponse = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('CC-01: a write whose outcome is unknown is never shown as a definite, resubmittable failure', () => {
  const cases: [string, () => Response][] = [
    ['Vite dev proxy 502 with an empty body after the server applied the write', viteBadGateway],
    ['server 502 CHAIN_ERROR for a TX_TIMEOUT ("it may still be mined")', jsonResponse(502, { error: { code: 'CHAIN_ERROR', message: 'fundHouse: no receipt for 0xabc (outcome unknown; it may still be mined): timeout' } })],
    ['server 500 INTERNAL', jsonResponse(500, { error: { code: 'INTERNAL', message: 'Internal error' } })],
    ['gateway 504', () => new Response('', { status: 504, statusText: 'Gateway Timeout' })],
    ['a CHAIN_ERROR code on a non-5xx status', jsonResponse(409, { error: { code: 'CHAIN_ERROR', message: 'reverted?' } })],
  ];
  for (const [name, respond] of cases) {
    it(`${name} is an unknown outcome`, async () => {
      const { fetch } = scripted([respond]);
      const api = new AdminApi({ getToken: () => 't', fetch });
      const r = await api.send(writes.fundHouse('100', { reason: REASON }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(isUnknownOutcome(r.error)).toBe(true);
      expect(r.error.outcome).toBe('unknown');
    });
  }

  it('keeps definite rejections definite, and reads are never flagged', async () => {
    const { fetch } = scripted([jsonResponse(400, { error: { code: 'CONFIRM_REQUIRED', message: 'type pause-all' } }), viteBadGateway]);
    const api = new AdminApi({ getToken: () => 't', fetch });
    const w = await api.send(writes.pauseAll({ reason: 'pause for review' }));
    expect(!w.ok && isUnknownOutcome(w.error)).toBe(false);
    const read = await api.chain();
    expect(!read.ok && read.error).toEqual({ code: 'HTTP_502', message: 'Bad Gateway', status: 502 });
  });

  it('the dialog session locks after a proxy 502: clicking Apply again sends nothing; only an identical retry under the same key', async () => {
    const { fetch, seen } = scripted([viteBadGateway, jsonResponse(200, { ok: true, action: 'treasury-fund', auditId: 'A47', txHash: `0x${'b3'.repeat(32)}` })]);
    let n = 0;
    const session = new WriteSession(new AdminApi({ getToken: () => 't', fetch }), () => `key-${++n}`);
    const request = writes.fundHouse('100', { reason: REASON });
    const first = await session.submit(request);
    expect(first.ok).toBe(false);
    expect(session.phase).toBe('unknown');
    expect(session.canSubmit).toBe(false);
    // The operator clicks "Apply change" again (even with an edited reason): refused locally, nothing reaches the server.
    const again = await session.submit(writes.fundHouse('100', { reason: `${REASON} again` }));
    expect(!again.ok && again.error.code).toBe('RESUBMIT_LOCKED');
    expect(seen).toHaveLength(1);
    // The explicit retry resends the identical request with the same Idempotency-Key, so the server replays instead of re-applying.
    const retried = await session.retry();
    expect(retried.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[0]!.key).toBe('key-1');
    expect(session.phase).toBe('applied');
    expect((await session.submit(request)).ok).toBe(false);
    expect(seen).toHaveLength(2);
  });

  it('a definite rejection allows an edited resubmission under a new key (a new intent)', async () => {
    const { fetch, seen } = scripted([jsonResponse(400, { error: { code: 'VALIDATION_ERROR', message: 'bad amount' } }), jsonResponse(200, { ok: true })]);
    let n = 0;
    const session = new WriteSession(new AdminApi({ getToken: () => 't', fetch }), () => `key-${++n}`);
    await session.submit(writes.fundHouse('100', { reason: REASON }));
    expect(session.phase).toBe('rejected');
    expect(session.canRetry).toBe(false);
    await session.submit(writes.fundHouse('200', { reason: REASON }));
    expect(seen.map(s => s.key)).toEqual(['key-1', 'key-2']);
    expect(session.phase).toBe('applied');
  });

  it('AdminApi.send uses the caller\'s Idempotency-Key when given', async () => {
    const { fetch, seen } = scripted([jsonResponse(200, { ok: true })]);
    await new AdminApi({ getToken: () => 't', fetch, newRequestId: () => 'fresh' }).send(writes.attest({ reason: 'hourly attest' }), 'intent-7');
    expect(seen[0]!.key).toBe('intent-7');
  });

  it('remembers an unknown outcome across dialogs until it is acknowledged or ages out', () => {
    const log = new UnknownOutcomeLog(60_000);
    log.record('/treasury/fund', 'Fund the house', { code: 'HTTP_502', message: 'Bad Gateway', status: 502, outcome: 'unknown' }, 1_000);
    expect(log.recent('/treasury/fund', 30_000)).toMatchObject({ title: 'Fund the house', code: 'HTTP_502' });
    expect(log.recent('/treasury/withdraw-surplus', 30_000)).toBeNull();
    expect(log.recent('/treasury/fund', 62_000)).toBeNull();
    log.record('/vault/pause', 'Pause the vault', { code: 'INTERNAL', message: 'x', status: 500, outcome: 'unknown' }, 1_000);
    log.clear('/vault/pause');
    expect(log.recent('/vault/pause', 2_000)).toBeNull();
  });
});

const overview = (over: Record<string, unknown>): Overview => decodeOverview({ ...overviewFixture(), ...over });
const msg = (event: string, data: unknown, id = '1') => ({ event, data: JSON.stringify(data), id });

describe('CC-02: a server restart on a new run replaces the previous run instead of being dropped as "older"', () => {
  const late = Date.UTC(2026, 8, 23, 6, 13, 28);
  const early = Date.UTC(2026, 8, 23, 2, 1, 0);

  it('a new runId with an earlier replay clock is applied and resets the run-scoped views', () => {
    const store = new Store(() => 5_000);
    const topics: string[] = [];
    store.on('run', () => topics.push('run'));
    store.ingest(msg('overview', { ...overviewFixture(), runId: 'review1', journalSeq: 90_000, clockMs: late, registeredPlayers: 538 }));
    store.ingest(msg('bet', { legId: 'L1', account: 'sim:1', market: 'btc-usd', start: late, bandIndex: 1, stakeCenti: '100', x100: 200, payoutCenti: '200', status: 'open', placedMs: late - 1000 }));
    store.ingest(msg('overview', { ...overviewFixture(), runId: 'review2', journalSeq: 40, clockMs: early, registeredPlayers: 11 }));
    expect(store.snapshot.overview).toMatchObject({ runId: 'review2', clockMs: early, registeredPlayers: 11 });
    expect(store.snapshot.bets).toEqual([]);
    expect(topics).toEqual(['run']);
    expect(store.snapshot.alerts[0]).toMatchObject({ code: 'NEW_RUN', level: 'info' });
  });

  it('the same runId restarted without its journal (sequence back to the start) is a new run, whatever the clock does', () => {
    const back = new Store();
    back.setOverview(overview({ runId: 'r', journalSeq: 90_000, clockMs: late }));
    expect(back.setOverview(overview({ runId: 'r', journalSeq: 12, clockMs: early }))).toBe('new-run');
    expect(back.snapshot.overview?.clockMs).toBe(early);
    const forward = new Store();
    forward.setOverview(overview({ runId: 'r', journalSeq: 90_000, clockMs: early }));
    expect(forward.setOverview(overview({ runId: 'r', journalSeq: 12, clockMs: late }))).toBe('new-run');
  });

  it('without run identity a large backwards clock jump is a new run; a small skew is still dropped as out of order', () => {
    const store = new Store();
    store.setOverview(overview({ clockMs: late }));
    expect(store.setOverview(overview({ clockMs: late - 2_000 }))).toBe('stale');
    expect(store.snapshot.overview?.clockMs).toBe(late);
    expect(store.setOverview(overview({ clockMs: early }))).toBe('new-run');
    expect(store.snapshot.overview?.clockMs).toBe(early);
  });

  it('a poll answer is dropped when a newer overview arrived after the poll was sent, and applied otherwise', () => {
    let now = 100;
    const store = new Store(() => now);
    store.setOverview(overview({ runId: 'r', journalSeq: 50, clockMs: 2_000_000 })); // stream, received at t=100
    now = 200;
    expect(store.setOverview(overview({ runId: 'r', journalSeq: 40, clockMs: 1_990_000 }), { requestedAtMs: 50 })).toBe('stale');
    expect(store.snapshot.overview?.clockMs).toBe(2_000_000);
    expect(store.setOverview(overview({ runId: 'r2', journalSeq: 3, clockMs: 1_000_000 }), { requestedAtMs: 150 })).toBe('new-run');
    expect(store.snapshot.overview?.runId).toBe('r2');
  });
});

describe('CC-03: a frozen overview is flagged stale; feed ages keep growing; the stream banner is never hidden behind warnings', () => {
  const perMarketPause: Breaker = { id: 'manual', market: 'eth-usd', state: 'paused', since: 1_790_000_000_000, reason: 'ETH incident' };
  const pauseAll: Breaker = { id: 'manual', state: 'paused', since: 1_790_000_000_000, reason: 'pause all' };

  it('ranks "live stream interrupted" above a warning breaker', () => {
    const items = bannerItems({
      overview: overview({ breakers: [perMarketPause] }), stream: { status: 'reconnecting', attempt: 3, retryAt: 0, lastError: 'fetch failed' },
      overviewAgeMs: 2_000, pollError: null, vaultUnavailable: false,
    });
    expect(items.map(i => i.key)).toEqual(['stream:3', expect.stringMatching(/^breaker:manual:eth-usd/)]);
  });

  it('a stale overview outranks everything and says why (poll error) and as of when', () => {
    const items = bannerItems({
      overview: overview({ breakers: [pauseAll], clockMs: Date.UTC(2026, 8, 23, 6, 13, 28) }), stream: { status: 'reconnecting', attempt: 5, retryAt: 0, lastError: 'fetch failed' },
      overviewAgeMs: 50_000, pollError: { code: 'NETWORK', message: 'Failed to fetch', status: 0 }, vaultUnavailable: false,
    });
    expect(items[0]).toMatchObject({ key: 'stale', severity: 'critical' });
    expect(items[0]!.title).toContain('06:13:28 UTC');
    expect(items[0]!.detail).toContain('NETWORK Failed to fetch');
    expect(isOverviewStale(OVERVIEW_STALE_MS + 1)).toBe(true);
    expect(isOverviewStale(1_000)).toBe(false);
  });

  it('feed ages grow from wall time when overviews stop (live feed: the 5 s clock cap no longer freezes them under the 7 s stale mark)', () => {
    let now = 0;
    const store = new Store(() => now);
    const clock = 1_790_000_000_000;
    store.setOverview(overview({ feedMode: 'live', speed: 1, clockMs: clock, markets: [{ ...marketFixture('btc-usd'), lastPriceMs: clock - 1_600 }] }));
    now = 60_000;
    const o = store.snapshot.overview!;
    expect(feedHealth(o.markets, store.feedNow())[0]).toMatchObject({ level: 'critical', ageMs: 61_600 });
    expect(store.overviewAgeMs()).toBe(60_000);
    expect(store.serverNow()).toBe(clock + 5_000); // the header clock stays capped (and is marked stale)
  });

  it('records the fallback poll error and clears it when an overview arrives', () => {
    const store = new Store();
    store.setPollError({ code: 'NETWORK', message: 'Failed to fetch', status: 0 });
    expect(store.snapshot.pollError?.code).toBe('NETWORK');
    store.setOverview(overview({}));
    expect(store.snapshot.pollError).toBeNull();
  });
});

describe('CC-04: per-market pause/resume follows the market\'s own manual breaker, not the shared quoting gate', () => {
  const b = (id: string, state: string, market?: string): Breaker => ({ id, ...(market ? { market } : {}), state, since: 1, reason: '' });
  const underPauseAll = [b('feedStale', 'ok', 'btc-usd'), b('feedStale', 'ok', 'eth-usd'), b('drawdown', 'ok'), b('equityFloor', 'ok'), b('manual', 'paused'), b('manual', 'ok', 'btc-usd'), b('manual', 'ok', 'eth-usd')];
  const btc = marketFixture('btc-usd', { paused: true });

  it('under pause-all a market offers Pause (not a Resume the server rejects) and names the cause', () => {
    expect(marketControl(btc, underPauseAll)).toMatchObject({ ownPause: false, heldBy: ['pause-all'], action: 'pause', label: 'Held by pause-all', gateClosed: true });
    const resume = marketPlan(btc, 'resume', underPauseAll);
    expect(resume.title).toBe('Resume BTC/USD');
    expect(resume.warnings.join(' ')).toContain('NOT_PAUSED');
    const pause = marketPlan(btc, 'pause', underPauseAll);
    expect(pause.path).toBe('/markets/btc-usd/pause');
    expect(pause.warnings.join(' ')).toContain('pause-all');
  });

  it('a market paused on its own offers Resume, and says when pause-all or drawdown still holds it', () => {
    const own = underPauseAll.map(x => (x.id === 'manual' && x.market === 'btc-usd' ? { ...x, state: 'paused' } : x));
    expect(marketControl(btc, own)).toMatchObject({ ownPause: true, action: 'resume', label: 'Paused (manual) · also pause-all' });
    expect(marketPlan(btc, 'resume', own).warnings.join(' ')).toContain('Resume all');
    const drawdown = [b('drawdown', 'paused'), b('manual', 'ok'), b('manual', 'ok', 'btc-usd')];
    expect(marketControl(btc, drawdown)).toMatchObject({ ownPause: false, heldBy: ['drawdown pause'], action: 'pause' });
    expect(marketControl(marketFixture('btc-usd'), [b('manual', 'ok'), b('manual', 'ok', 'btc-usd')])).toMatchObject({ label: 'Quoting', action: 'pause', gateClosed: false });
  });
});

describe('CC-05: an unreadable vault is critical everywhere, never "vault open"', () => {
  // Exactly the server's placeholder branch (house-server app.ts chainView when readVault fails).
  const raw = clone(LIVE['chain']) as Record<string, unknown>;
  raw['vault'] = { address: '0x59d8574581250385570e41d8d66823113b954bfe', token: '0xe02596708a77590086881fb61abfdf02883d8cec', paused: false, assetsCenti: '0', houseFundedCenti: '0', totalPlayerDepositsCenti: '0', totalPlayerWithdrawalsCenti: '0', surplusCenti: '0', unavailable: true };
  raw['alerts'] = []; raw['reconciliation'] = null;
  const chain = decodeChain(raw);
  const asOf = chain.lastAttestation!.asOfMs;

  it('Overview chain cell and banner strip', () => {
    expect(chainSummary(chain)).toMatchObject({ level: 'critical', value: 'Vault unreadable' });
    expect(chainSummary(chainFixture()).level).toBe('good');
    const items = bannerItems({ overview: overview({}), stream: { status: 'open', since: 0 }, overviewAgeMs: 1_000, pollError: null, vaultUnavailable: true });
    expect(items[0]).toMatchObject({ key: 'vault-unreadable', severity: 'critical', action: 'treasury' });
  });

  it('Treasury status row, escape card and attestation card', () => {
    const labels = vaultBadges(chain).map(x => x.label);
    expect(labels.some(l => l.includes('Vault open'))).toBe(false);
    expect(labels.some(l => l.includes('identity holds'))).toBe(false);
    expect(vaultBadges(chain)).toEqual([{ kind: 'critical', label: expect.stringContaining('unreadable') }]);
    expect(escapeMissingNotice(chain)).toMatchObject({ kind: 'critical', label: expect.stringContaining('unreadable') });
    expect(escapeMissingNotice(chainFixture()).label).toContain('pre-SPEC-11');
    const att = attestationHealth(chain, asOf + 60_000);
    expect(att.level).not.toBe('good');
    expect(att.label).toContain('unreadable');
  });
});

describe('CC-07: alerts have a durable view and critical ones are never evicted by routine notices', () => {
  it('evicts the oldest non-critical item first (toasts and the stored alert list)', () => {
    expect(evictIndex(['info', 'good', 'warning', 'info', 'critical'])).toBe(3);
    expect(evictIndex(['critical', 'info', 'critical'])).toBe(1);
    expect(evictIndex(['critical', 'critical'])).toBe(1);
  });

  it('the store keeps a critical alert through a flood of warnings and counts unread alerts until the panel is opened', () => {
    const store = new Store(() => 1);
    store.pushAlert({ level: 'critical', code: 'TABLE_MISSING', message: 'no table', ms: 1 });
    for (let i = 0; i < 80; i++) store.pushAlert({ level: 'warning', code: 'TOXIC_FLOW', message: `toxic ${i}`, ms: 2 + i });
    expect(store.snapshot.alerts).toHaveLength(50);
    expect(store.snapshot.alerts.some(a => a.code === 'TABLE_MISSING')).toBe(true);
    expect(store.snapshot.unreadAlerts).toBe(81);
    expect(filterAlerts(store.snapshot.alerts, 'critical').map(a => a.code)).toEqual(['TABLE_MISSING']);
    store.markAlertsRead();
    expect(store.snapshot.unreadAlerts).toBe(0);
  });
});

describe('CC-08: breaker stream events keep their actor and never duplicate the server\'s audit rows', () => {
  it('an admin pause is journaled once, by the admin-action row, with the admin as actor', () => {
    const store = new Store(() => 1);
    store.ingest(msg('breaker', { id: 'manual', market: 'eth-usd', state: 'paused', from: 'ok', since: 1_790_133_920_000, reason: 'review: actor attribution check', actor: 'admin:alice' }));
    store.ingest(msg('admin-action', { id: 'A51', ms: 1_790_133_920_000, kind: 'admin', actor: 'admin:alice', action: 'market-pause', target: 'eth-usd', before: { paused: false }, after: { paused: true }, reason: 'review: actor attribution check', result: 'ok' }));
    expect(store.snapshot.audit.map(e => [e.id, e.actor])).toEqual([['A51', 'admin:alice']]);
    expect(store.snapshot.lastBreaker).toMatchObject({ actor: 'admin:alice', from: 'ok' });
  });

  it('an automatic transition shows at once (actor and previous state kept) and gives way to the server row', () => {
    const since = 1_790_133_000_000;
    const event = { id: 'feedStale', market: 'btc-usd', state: 'tripped', from: 'ok', since, reason: 'no fresh price for 8 s', actor: 'system' };
    const serverRow = { id: 'A77', ms: since, kind: 'breaker' as const, actor: 'system', action: 'breaker:feedStale:tripped', target: 'btc-usd', before: 'ok', after: 'tripped', reason: 'no fresh price for 8 s' };
    const store = new Store(() => 1);
    store.ingest(msg('breaker', event));
    expect(store.snapshot.audit[0]).toMatchObject({ actor: 'system', before: 'ok', after: 'tripped', target: 'btc-usd' });
    store.seedAudit([serverRow]);
    expect(store.snapshot.audit.filter(e => e.target === 'btc-usd').map(e => e.id)).toEqual(['A77']);
    // Replayed event after the audit poll (Last-Event-ID replay): still one row.
    store.ingest(msg('breaker', event));
    expect(store.snapshot.audit.filter(e => e.target === 'btc-usd').map(e => e.id)).toEqual(['A77']);
  });
});

describe('CC-09: acks and audit cells read money in OPEN, not raw Centi or wei', () => {
  it('formats …Centi and …Wei keys exactly, ETH gas as ETH', () => {
    expect(formatDisplayValue({ houseEquityCenti: '9999963302' })).toBe('houseEquity: 99,999,633.02 OPEN');
    expect(formatDisplayValue({ liabilitiesWei: '1181443000000000000', seq: 7 })).toBe('liabilities: 1.18 OPEN + 1,443,000,000,000,000 wei · seq: 7');
    expect(formatDisplayValue({ ethWei: '500000000000000000' })).toBe('eth: 0.50000 ETH');
    expect(formatDisplayValue({ paused: true })).toBe('paused: true');
    expect(formatDisplayValue('paused')).toBe('paused');
  });

  it('audit search matches the OPEN figure', () => {
    expect(matchesAudit({ id: 'A1', ms: 1, kind: 'admin', actor: 'admin', action: 'treasury-withdraw-surplus', after: { houseEquityCenti: '9999963302' } }, '99,999,633.02')).toBe(true);
  });
});

describe('CC-10: the flag label names who set the flag', () => {
  it('admin flags are not attributed to the toxicity monitor', () => {
    expect(flagLabel(true, [{ ms: 1, actor: 'admin', action: 'flag', reason: 'manual review' }])).toBe('Flagged by admin');
    expect(flagLabel(true, [{ ms: 1, actor: 'toxicity-monitor', action: 'flag', reason: 'z' }, { ms: 2, actor: 'toxicity-monitor', action: 'unflag', reason: 'z' }, { ms: 3, actor: 'admin:bob', action: 'flag', reason: 'again' }])).toBe('Flagged by admin:bob');
    expect(flagLabel(true, [{ ms: 1, actor: 'toxicity-monitor', action: 'flag', reason: 'z' }])).toBe('Flagged by toxicity monitor');
    expect(flagLabel(false, [])).toBeNull();
  });
});

describe('CC-11: ranges or phases with no bets show no target, not 0 %', () => {
  it('the server\'s zero standard-phase row has no target and no band', () => {
    const rows = decodeRtp(LIVE['rtp']).byRange;
    const empty = rows.find(r => r.bets === 0)!;
    expect(empty).toMatchObject({ expected: 0, expectedLow: 0, expectedHigh: 0 });
    expect(rtpTarget(empty)).toBeNull();
    expect(rtpBand(empty)).toBeNull();
    const busy = rows.find(r => r.bets > 0)!;
    expect(rtpTarget(busy)).toBe(busy.expected);
    expect(rtpBand(busy)).not.toBeNull();
  });
});

describe('CC-12: the pricing dialog says when a standard-edge change takes effect during the launch boost', () => {
  it('boost active: applies when the boost ends (still an edge-change confirmation)', () => {
    const plan = pricingPlan(pricingFixture(), { standardEdge: '11' }, { launch: launchFixture(), registeredPlayers: 144 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const text = plan.plan.warnings.join(' ');
    expect(text).not.toContain('reprice immediately');
    expect(text).toContain('launch boost is active');
    expect(text).toContain('10,000');
    expect(plan.plan.confirmName).toBe(CONFIRM_NAMES.edgeChange);
    expect(plan.plan.changes).toContainEqual({ key: 'effectiveEdge', label: 'Edge on new quotes now', before: '3.00%', after: '3.00%', beforeKnown: true });
  });

  it('boost over: new quotes reprice immediately', () => {
    const plan = pricingPlan(pricingFixture(), { standardEdge: '11' }, { launch: launchFixture({ active: false }), registeredPlayers: 12_000 });
    expect(plan.ok && plan.plan.warnings.join(' ')).toContain('reprice immediately');
  });
});

describe('CC-13: on-chain action dialogs name the network and chain id', () => {
  it('flags every vault transaction as on-chain, and nothing else', () => {
    const chain = chainFixture({ vault: { pendingSigner: { address: '0x6666666666666666666666666666666666666666', etaMs: 0, due: true }, excessWei: '5' } });
    const onChain = [
      fundPlan(chain, '1'), withdrawSurplusPlan(chain, '1', 1_790_000_000_000), signerCancelPlan(chain), sweepExcessPlan(chain, '0x7777777777777777777777777777777777777777'),
    ].map(r => r.ok && r.plan.onChain);
    expect(onChain).toEqual([true, true, true, true]);
    expect([attestPlan(chain), vaultPlan(chain, 'pause'), vaultPlan(chain, 'unpause')].map(p => p.onChain)).toEqual([true, true, true]);
    expect([pauseAllPlan([marketFixture('btc-usd')]), marketPlan(marketFixture('btc-usd'), 'pause')].map(p => p.onChain)).toEqual([false, false]);
    expect(networkLine('base-sepolia', 84532)).toBe('Base Sepolia · chain 84532');
    expect(networkLine('offline', 0)).toBe('Offline vault · chain 0');
  });
});

describe('CC-14: the house equity tile shows the exact figure', () => {
  it('99,999,801.94 OPEN no longer reads as 99.9M, and ±1 OPEN around 100M is visible', () => {
    expect(equityTileValue('9999980194')).toEqual({ value: '99,999,801.94', title: '99,999,801.94 OPEN' });
    expect(equityTileValue('10000000000').value).toBe('100,000,000.00');
    expect(equityTileValue('9999990000').value).not.toBe(equityTileValue('10000010000').value);
  });
});
