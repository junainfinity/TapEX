import { afterEach, describe, expect, it } from 'vitest';
import { AdminApi, writes } from '../api.js';
import {
  decodeAudit, decodeBets, decodeChain, decodeDefenses, decodeExposure, decodeMetrics, decodeOverview, decodePlayerDetail, decodePlayers, decodeRtp, decodeStreamEvent,
} from '../decode.js';
import { SseParser } from '../sse.js';
import { Store } from '../store.js';
import { BREAKER_CLEAR_S, BREAKER_TRIP_S, DEMO_START_MS, DemoWorld, type DemoEvent } from './fixture.js';
import { createDemoServer, type DemoServer } from './server.js';

/** Drive the world with a fake clock in 100 ms steps, collecting stream events. */
function run(world: DemoWorld, clock: { t: number }, seconds: number): DemoEvent[] {
  const events: DemoEvent[] = [];
  for (let i = 0; i < seconds * 10; i++) { clock.t += 100; events.push(...world.step()); }
  return events;
}

function newWorld(seed = 1) {
  const clock = { t: 1_000_000 };
  const world = new DemoWorld({ seed, now: () => clock.t });
  return { world, clock };
}

describe('demo fixture honours the SPEC §7 contract', () => {
  it('every read payload decodes with the production decoders', () => {
    const { world, clock } = newWorld();
    run(world, clock, 12);
    const o = decodeOverview(world.overview());
    expect(o.chainId).toBe(84532);
    expect(o.markets.map(m => m.id)).toEqual(['btc-usd', 'eth-usd']); // the house server's market ids
    expect(o.pricing?.standardEdge).toBe(0.08);
    const m = decodeMetrics(world.metrics(o.clockMs - 6 * 3_600_000, o.clockMs, 300_000));
    expect(m.t.length).toBeGreaterThan(60);
    expect(m.t[m.t.length - 1]).toBe(o.clockMs);
    expect(m.equity[m.equity.length - 1]).toBe(o.equityCenti);
    const rtp = decodeRtp(world.rtp());
    expect(rtp.byRange).toHaveLength(10);
    expect(rtp.calibration).toHaveLength(10);
    for (const market of ['btc-usd', 'eth-usd']) {
      const e = decodeExposure(world.exposure(market));
      expect(e.windows).toHaveLength(6);
      expect(e.bands).toHaveLength(7);
      expect(e.cells).toHaveLength(42);
    }
    const players = decodePlayers(world.players({ sort: '-pnl', limit: 50 }));
    expect(players.rows).toHaveLength(50);
    expect(players.total).toBe(491);
    const pnls = players.rows.map(r => BigInt(r.pnlCenti));
    expect(pnls.every((v, i) => i === 0 || pnls[i - 1]! >= v)).toBe(true);
    const detail = decodePlayerDetail(world.player(players.rows[0]!.account));
    expect(detail.player.account).toBe(players.rows[0]!.account);
    expect(decodeBets(world.bets({ limit: 20 })).rows.length).toBeGreaterThan(0);
    const chain = decodeChain(world.chain());
    const v = chain.vault;
    expect(BigInt(v.assetsCenti)).toBe(BigInt(v.totalPlayerDepositsCenti) + BigInt(v.houseFundedCenti) - BigInt(v.totalPlayerWithdrawalsCenti) - BigInt(v.houseWithdrawnCenti ?? '0'));
    expect(decodeAudit({ rows: world.auditLog(100) }).length).toBeGreaterThan(5);
  });

  it('streams bets and settlements that decode as typed events', () => {
    const { world, clock } = newWorld();
    const events = run(world, clock, 20);
    const types = new Set(events.map(e => e.event));
    expect(types.has('bet')).toBe(true);
    expect(types.has('settlement')).toBe(true);
    for (const e of events) expect(decodeStreamEvent(e.event, JSON.parse(JSON.stringify(e.data)))).not.toBeNull();
    const perSecond = events.filter(e => e.event === 'bet').length / 20;
    expect(perSecond).toBeLessThanOrEqual(20); // SPEC: sampled ≤ 20/s
    expect(perSecond).toBeGreaterThan(3);
  });

  it('trips and clears the ETH feedStale breaker on schedule', () => {
    const { world, clock } = newWorld();
    const early = run(world, clock, BREAKER_TRIP_S - 3);
    expect(early.some(e => e.event === 'breaker')).toBe(false);
    const trip = run(world, clock, 5);
    const tripped = trip.find(e => e.event === 'breaker');
    expect(tripped?.data).toMatchObject({ id: 'feedStale', market: 'eth-usd', state: 'tripped' });
    expect(world.overview().markets.find(m => m.id === 'eth-usd')?.paused).toBe(true);
    const clear = run(world, clock, BREAKER_CLEAR_S - BREAKER_TRIP_S + 2);
    expect(clear.find(e => e.event === 'breaker')?.data).toMatchObject({ state: 'ok' });
    expect(world.overview().markets.every(m => !m.paused)).toBe(true);
    expect(world.auditLog(50).filter(a => a.kind === 'breaker' && a.ms >= DEMO_START_MS)).toHaveLength(2);
  });

  it('ends the launch boost when registered players cross 10,000', () => {
    const { world, clock } = newWorld();
    expect(world.overview().launch).toMatchObject({ active: true, edge: 0.03 });
    const events = run(world, clock, 70);
    const o = world.overview();
    expect(o.registeredPlayers).toBeGreaterThanOrEqual(10_000);
    expect(o.launch.active).toBe(false);
    const alert = events.find(e => e.event === 'alert' && (e.data as { code?: string }).code === 'LAUNCH_BOOST_ENDED');
    expect(alert).toBeDefined();
    expect(events.some(e => e.event === 'admin-action' && (e.data as { action: string }).action === 'launch boost ended')).toBe(true);
    // New legs after the crossing are priced in the standard phase.
    const after = run(world, clock, 5).filter(e => e.event === 'bet').map(e => e.data as { phase: string });
    expect(after.length).toBeGreaterThan(0);
    expect(after.every(l => l.phase === 'standard')).toBe(true);
  });

  it('is deterministic for a seed', () => {
    const a = newWorld(7); const b = newWorld(7);
    run(a.world, a.clock, 15); run(b.world, b.clock, 15);
    expect(a.world.overview()).toEqual(b.world.overview());
    expect(a.world.players({ limit: 20 })).toEqual(b.world.players({ limit: 20 }));
  });
});

describe('demo writes enforce the same safety rules as the server contract', () => {
  it('requires a reason and the exact confirm phrase for dangerous actions', () => {
    const { world } = newWorld();
    expect(world.write('POST', '/pause-all', {}).outcome).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(world.write('POST', '/pause-all', { reason: 'incident' }).outcome).toMatchObject({ ok: false, status: 400, code: 'CONFIRM_REQUIRED' });
    expect(world.write('POST', '/pause-all', { reason: 'incident', confirm: 'Pause-All' }).outcome).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    const ok = world.write('POST', '/pause-all', { reason: 'incident', confirm: 'pause-all' });
    expect(ok.outcome).toMatchObject({ ok: true, ack: { action: 'pause-all', before: { manualGlobal: false }, after: { manualGlobal: true } } });
    expect(world.overview().markets.every(m => m.paused)).toBe(true);
    expect(ok.events.some(e => e.event === 'admin-action')).toBe(true);
    expect(world.write('POST', '/vault/pause', { reason: 'x' }).outcome).toMatchObject({ code: 'CONFIRM_REQUIRED' });
    expect(world.write('PUT', '/pricing', { reason: 'x', standardEdge: 0.11 }).outcome).toMatchObject({ code: 'CONFIRM_REQUIRED' });
    expect(world.write('PUT', '/pricing', { reason: 'x', standardEdge: 0.1 }).outcome).toMatchObject({ ok: true });
    expect(world.write('PUT', '/pricing', { reason: 'x', standardEdge: 0.3, confirm: 'edge-change' }).outcome).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect(world.write('PUT', '/launch', { reason: 'end early', enabled: false }).outcome).toMatchObject({ code: 'CONFIRM_REQUIRED' });
    expect(world.write('PUT', '/limits', { reason: 'x', cellFraction: 0.01 }).outcome).toMatchObject({ ok: false, code: 'LIMIT_HIERARCHY' });
  });

  it('moves treasury balances exactly and caps withdrawals at the surplus', () => {
    const { world } = newWorld();
    const before = world.chain();
    const fund = world.write('POST', '/treasury/fund', { reason: 'top up', amountCenti: '12345' });
    expect(fund.outcome).toMatchObject({ ok: true, ack: { txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) } });
    const after = world.chain();
    expect(BigInt(after.vault.houseFundedCenti) - BigInt(before.vault.houseFundedCenti)).toBe(12345n);
    expect(BigInt(before.operator.tokenCenti) - BigInt(after.operator.tokenCenti)).toBe(12345n);
    const surplus = BigInt(after.vault.surplusCenti);
    expect(world.write('POST', '/treasury/withdraw-surplus', { reason: 'sweep', confirm: 'withdraw-surplus', amountCenti: (surplus + 1n).toString() }).outcome).toMatchObject({ ok: false, code: 'INSUFFICIENT_SURPLUS' });
    expect(world.write('POST', '/treasury/withdraw-surplus', { reason: 'sweep', confirm: 'withdraw-surplus', amountCenti: '100' }).outcome).toMatchObject({ ok: true });
    expect(BigInt(world.chain().vault.surplusCenti)).toBe(surplus - 100n);
  });
});

describe('demo server over the production client', () => {
  let server: DemoServer | null = null;
  afterEach(() => { server?.stop(); server = null; });

  it('rejects requests without the demo token and serves decoded data with it', async () => {
    const clock = { t: 5_000 };
    server = createDemoServer({ now: () => clock.t, latency: false, tickMs: 3_600_000 });
    const anonymous = new AdminApi({ getToken: () => null, fetch: server.fetch });
    expect(await anonymous.overview()).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED', status: 401 } });
    const api = new AdminApi({ getToken: () => 'demo-token', fetch: server.fetch });
    const overview = await api.overview();
    expect(overview.ok).toBe(true);
    const refused = await api.send(writes.vaultPause({ reason: 'drill' }));
    expect(refused).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED', status: 400 } });
    const applied = await api.send(writes.vaultPause({ reason: 'drill', confirm: 'vault-pause' }));
    expect(applied.ok && applied.data.auditId).toMatch(/^a-\d+$/);
    const chain = await api.chain();
    expect(chain.ok && chain.data.vault.paused).toBe(true);
  });

  it('drops open streams once at the scripted time even when only API calls advance the world', async () => {
    const clock = { t: 5_000 };
    server = createDemoServer({ now: () => clock.t, latency: false, tickMs: 3_600_000 });
    const api = new AdminApi({ getToken: () => 'demo-token', fetch: server.fetch });
    const response = await server.fetch('/admin-api/stream', { headers: { Authorization: 'Bearer demo-token' } });
    const reader = response.body!.getReader();
    let closed = false;
    let bytes = 0;
    const pump = (async () => { for (;;) { const { done, value } = await reader.read(); if (done) { closed = true; return; } bytes += value.byteLength; } })();
    for (let s = 1; s <= 69; s++) { clock.t += 1_000; await api.overview(); }
    await new Promise(r => setTimeout(r, 10));
    expect(closed).toBe(false);
    const before = bytes;
    for (let s = 70; s <= 72; s++) { clock.t += 1_000; await api.overview(); }
    await pump;
    expect(closed).toBe(true);
    expect(before).toBeGreaterThan(1_000); // events produced during fetch-driven steps were broadcast
  });

  it('streams text/event-stream frames the SSE parser and store accept', async () => {
    const clock = { t: 5_000 };
    server = createDemoServer({ now: () => clock.t, latency: false, tickMs: 3_600_000 });
    const response = await server.fetch('/admin-api/stream', { headers: { Authorization: 'Bearer demo-token' } });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    for (let i = 0; i < 40; i++) { clock.t += 100; server.tick(); }
    const parser = new SseParser();
    const store = new Store(() => clock.t);
    let text = '';
    for (;;) {
      const { value } = await Promise.race([reader.read(), new Promise<{ value: undefined }>(r => setTimeout(() => r({ value: undefined }), 50))]);
      if (!value) break;
      text += value;
    }
    const messages = parser.feed(text);
    expect(parser.retryMs).toBe(1000);
    expect(messages.length).toBeGreaterThan(5);
    for (const m of messages) expect(store.ingest(m)).toBe(true);
    expect(store.snapshot.overview?.chainId).toBe(84532);
    expect(store.snapshot.bets.length).toBeGreaterThan(0);
    expect(store.snapshot.badEvents).toBe(0);
    void reader.cancel();
  });
});

describe('demo SPEC-10 defenses and SPEC-11 vault hardening', () => {
  it('serves the defenses, the overview additions and the SPEC-11 chain fields in the server shapes', () => {
    const { world, clock } = newWorld();
    run(world, clock, 5);
    const d = decodeDefenses(world.defensesView());
    expect(d.config.hold.maxHoldMs).toBe(1500);
    expect(d.controller.ranges).toHaveLength(6);
    expect(d.hold.created).toBeGreaterThan(d.hold.rejected);
    const o = decodeOverview(world.overview());
    expect(o.defenses).toMatchObject({ hold: true, toxicity: 'graduated' });
    expect(o.holdLatencyP95Ms).toBeLessThanOrEqual(1500);
    expect(o.chainAlerts?.map(a => a.code)).toEqual(['SIGNER_CHANGE_PENDING']);
    const c = decodeChain(world.chain());
    expect(c.vault.pendingSigner).toMatchObject({ due: false });
    expect(c.vault.escape?.escapeDelaySec).toBe(604_800);
    expect(BigInt(c.vault.houseWithdrawableCenti!)).toBeLessThanOrEqual(BigInt(c.vault.surplusCenti));
    expect(c.vault.excessWei).toBe('1234560000000000000042');
    expect(c.reconciliation?.match).toBe(true);
    expect(c.withdrawals?.anomalies[0]?.outcome).toBe('claimed-after-release');
    const onchain = decodePlayers(world.players({ q: 'onchain', limit: 5 })).rows[0]!;
    expect(onchain.account).toMatch(/^0x[0-9a-f]{40}$/);
    expect(decodePlayerDetail(world.player(onchain.account)).player.holds).toBeGreaterThan(0);
  });

  it('nudges the controller at ~35 s and makes the pending rotation due at ~95 s (alert transition)', () => {
    const { world, clock } = newWorld();
    const early = run(world, clock, 40);
    expect(early.some(e => e.event === 'admin-action' && (e.data as { action: string }).action === 'controller-adjust')).toBe(true);
    const later = run(world, clock, 60);
    const due = later.find(e => e.event === 'alert' && (e.data as { code?: string }).code === 'SIGNER_CHANGE_DUE');
    expect(due?.data).toMatchObject({ level: 'critical' });
    expect(decodeChain(world.chain()).vault.pendingSigner).toMatchObject({ due: true });
  });

  it('defenses writes enforce the server confirm classes', () => {
    const { world } = newWorld();
    expect(world.write('PUT', '/defenses', { reason: 'x', hold: { enabled: false } }).outcome).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    expect(world.write('PUT', '/defenses', { reason: 'x', hold: { enabled: false }, confirm: 'edge-change' }).outcome).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    expect(world.write('PUT', '/defenses', { reason: 'x', hold: { enabled: false }, confirm: 'defenses-disable' }).outcome).toMatchObject({ ok: true, ack: { disabled: ['hold'] } });
    expect(decodeOverview(world.overview()).defenses?.hold).toBe(false);
    expect(world.write('PUT', '/defenses', { reason: 'x', controller: { overrides: { '2-5': 0.03 } } }).outcome).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    expect(world.write('PUT', '/defenses', { reason: 'x', controller: { overrides: { '2-5': 0.015 } } }).outcome).toMatchObject({ ok: true });
    expect(world.write('PUT', '/defenses', { reason: 'x', hold: { tolRel: 9 } }).outcome).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(world.write('PUT', '/defenses', { reason: 'x', bogus: {} }).outcome).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(world.write('PUT', '/defenses', { reason: 'x', minLeadS: 4 }).outcome).toMatchObject({ ok: false, code: 'NO_CHANGE' });
  });

  it('signer rotation: accept is refused before the eta, then flips the signer and raises SIGNER_MISMATCH', () => {
    const { world, clock } = newWorld();
    expect(world.write('POST', '/vault/signer/accept', { reason: 'x' }).outcome).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    expect(world.write('POST', '/vault/signer/accept', { reason: 'x', confirm: 'signer-accept' }).outcome).toMatchObject({ ok: false, status: 409, code: 'TIMELOCK_NOT_ELAPSED' });
    run(world, clock, 100);
    const accepted = world.write('POST', '/vault/signer/accept', { reason: 'x', confirm: 'signer-accept' }).outcome;
    expect(accepted).toMatchObject({ ok: true, ack: { invalidatedVouchers: 2, warning: expect.stringContaining('SIGNER_MISMATCH') } });
    expect(decodeChain(world.chain()).vault).toMatchObject({ signerMismatch: true, pendingSigner: null });
    expect(decodeOverview(world.overview()).chainAlerts?.[0]).toMatchObject({ code: 'SIGNER_MISMATCH', level: 'critical' });
    const propose = world.write('POST', '/vault/signer/propose', { reason: 'x', confirm: 'signer-propose', address: '0x7777777777777777777777777777777777777777' }).outcome;
    expect(propose).toMatchObject({ ok: true });
    expect(world.write('POST', '/vault/signer/cancel', { reason: 'x' }).outcome).toMatchObject({ ok: true });
    expect(world.write('POST', '/vault/signer/cancel', { reason: 'x' }).outcome).toMatchObject({ ok: false, code: 'NO_PENDING_SIGNER' });
  });

  it('sweeps the excess exactly once and attests every 10 minutes of demo time', () => {
    const { world, clock } = newWorld();
    const to = '0x7777777777777777777777777777777777777777';
    expect(world.write('POST', '/vault/sweep-excess', { reason: 'x', to }).outcome).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    expect(world.write('POST', '/vault/sweep-excess', { reason: 'x', to, confirm: 'sweep-excess' }).outcome).toMatchObject({ ok: true, ack: { amountWei: '1234560000000000000042' } });
    expect(world.write('POST', '/vault/sweep-excess', { reason: 'x', to, confirm: 'sweep-excess' }).outcome).toMatchObject({ ok: false, code: 'NOTHING_TO_SWEEP' });
    const seq = decodeChain(world.chain()).lastAttestation!.seq;
    run(world, clock, 6 * 60 + 5);
    const after = decodeChain(world.chain());
    expect(after.lastAttestation!.seq).toBe(seq + 1);
    expect(after.vault.escape!.lastAttestationAtMs).toBe(after.lastAttestation!.asOfMs);
  });
});

describe('demo proof route over the production client', () => {
  let proofServer: DemoServer | null = null;
  afterEach(() => { proofServer?.stop(); proofServer = null; });

  it('answers /v1/account/:address/proof without the admin token', async () => {
    proofServer = createDemoServer({ latency: false, tickMs: 60_000 });
    const api = new AdminApi({ getToken: () => null, fetch: proofServer.fetch });
    const onchain = decodePlayers(proofServer.world.players({ q: 'onchain', limit: 1 })).rows[0]!;
    const r = await api.proof(onchain.account);
    expect(r).toMatchObject({ ok: true, data: { included: true, proof: expect.arrayContaining([expect.stringMatching(/^0x[0-9a-f]{64}$/)]) } });
    const none = await api.proof('0x000000000000000000000000000000000000dead');
    expect(none).toMatchObject({ ok: true, data: { included: false, balanceWei: '0' } });
  });
});
