import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_DEFENSES } from '@maya/house';
// Contract check: the overview with the SPEC-10 additions must still decode with the house console's decoder.
import { decodeOverview } from '../../admin/src/decode.js';
import type { EngineEvent } from '../src/engine/types.js';
import { admin, api, startTestApp, type TestApp } from './app-helpers.js';

let t: TestApp;
beforeAll(async () => { t = await startTestApp({ defenses: DEFAULT_DEFENSES }); });
afterAll(async () => { await t.close(); });

const reason = 'defenses integration test';

describe('player API with the acceptance hold', () => {
  it('answers 202 pending, stays idempotent, reconciles through by-request and ends in the final result', async () => {
    const player = t.chain.players()[1]!;
    await t.chain.playerDeposit(player.role, 300n * 10n ** 18n);
    t.advance(2);
    const grid = (await api(t.base, 'GET', `/v1/quotes?market=btc-usd&account=${player.address}`)).body;
    expect(grid.acceptance).toEqual({ hold: true, maxHoldMs: DEFAULT_DEFENSES.hold.maxHoldMs, minLeadS: DEFAULT_DEFENSES.minLeadS });
    for (const c of grid.cells) if (c.tau < DEFAULT_DEFENSES.minLeadS) expect(c.available).toBe(false);
    const cell = grid.cells.find((c: { available: boolean; window: number; x100: number; bandOffset: number }) => c.available && c.window === 5 && c.bandOffset === 0 && c.x100 <= 500);
    expect(cell).toBeDefined();
    // The player's own maximum includes the new-account ramp (25,000 Centi of liability).
    expect(BigInt(cell.maxStakeCenti) * BigInt(cell.x100 - 100) / 100n).toBeLessThanOrEqual(BigInt(DEFAULT_DEFENSES.ramp.startCenti));
    const bet = { requestId: 'held-api-1', account: player.address, quoteId: cell.quoteId, revision: 1, cellId: cell.cellId, stakeCenti: '1000' };
    const first = await api(t.base, 'POST', '/v1/bets', bet);
    expect(first).toMatchObject({ status: 202, body: { status: 'pending', newlyHeld: true, requestId: 'held-api-1', retryAfterMs: expect.any(Number), hold: { quoteId: cell.quoteId, x100: cell.x100, holdUntilMs: expect.any(Number) } } });
    expect((await api(t.base, 'POST', '/v1/bets', bet))).toMatchObject({ status: 202, body: { status: 'pending', newlyHeld: false } });
    expect((await api(t.base, 'POST', '/v1/bets', { ...bet, stakeCenti: '1001' }))).toMatchObject({ status: 409, body: { reason: 'REQUEST_CONFLICT' } });
    expect((await api(t.base, 'GET', '/v1/bets/by-request/held-api-1'))).toMatchObject({ status: 200, body: { status: 'pending' } });
    const acct = (await api(t.base, 'GET', `/v1/account/${player.address}`)).body;
    expect(acct).toMatchObject({ balanceCenti: '30000', availableCenti: '29000', pendingBets: [{ requestId: 'held-api-1' }] });
    t.advance(2);
    const done = await api(t.base, 'GET', '/v1/bets/by-request/held-api-1');
    expect(done.status).toBe(200);
    expect(['accepted', 'rejected']).toContain(done.body.status);
    // The same intent re-sent after the hold returns the final result (idempotent across the hold).
    expect((await api(t.base, 'POST', '/v1/bets', bet)).body.status).toBe(done.body.status);
    const kinds = t.journal.records<EngineEvent>().filter(e => (e.type === 'hold' && e.hold.requestId === 'held-api-1') || (e.type === 'hold-resolved' && e.requestId === 'held-api-1')).map(e => e.type);
    expect(kinds).toEqual(['hold', 'hold-resolved']);
    // More squares: every hold ends in a final result; accepted legs keep the quoted multiplier and carry the hold time.
    const grid2 = (await api(t.base, 'GET', `/v1/quotes?market=btc-usd&account=${player.address}`)).body;
    const cells = grid2.cells.filter((c: { available: boolean; x100: number }) => c.available && c.x100 <= 400).slice(0, 8);
    expect(cells.length).toBeGreaterThan(3);
    for (const [i, c] of cells.entries()) expect((await api(t.base, 'POST', '/v1/bets', { requestId: `held-api-m${i}`, account: player.address, quoteId: c.quoteId, revision: 1, cellId: c.cellId, stakeCenti: '500' })).status).toBe(202);
    t.advance(2);
    let accepted = 0;
    for (const [i, c] of cells.entries()) {
      const r = (await api(t.base, 'GET', `/v1/bets/by-request/held-api-m${i}`)).body;
      if (r.status === 'accepted') {
        accepted++;
        expect(r.leg).toMatchObject({ x100: c.x100, stakeCenti: '500', heldMs: expect.any(Number) });
        expect(r.leg.heldMs).toBeGreaterThan(0);
        expect(r.leg.heldMs).toBeLessThanOrEqual(DEFAULT_DEFENSES.hold.maxHoldMs);
      } else {
        expect(r.status).toBe('rejected');
        expect(['QUOTE_CHANGED', 'PRICE_MOVED']).toContain(r.reason);
      }
    }
    expect(accepted).toBeGreaterThan(0);
  });
});
describe('admin API for the defenses', () => {
  it('reads configuration and live metrics, and the overview carries the SPEC-10 additions', async () => {
    const d = (await admin(t, 'GET', '/defenses')).body;
    expect(d).toMatchObject({
      config: DEFAULT_DEFENSES, hold: { enabled: true, pending: expect.any(Number), created: expect.any(Number), latencyMs: expect.any(Object) }, minLeadS: DEFAULT_DEFENSES.minLeadS,
      toxicity: { enabled: true, mode: 'graduated', flowEdge: DEFAULT_DEFENSES.toxicity.surchargeEdge }, controller: { enabled: true, ranges: expect.any(Array) }, reference: { enabled: true }, referenceFeed: null,
    });
    expect(d.controller.ranges.map((r: { key: string }) => r.key)).toEqual(['1.01-2', '2-5', '5-10', '10-20', '20-50', '50-100']);
    const raw = (await admin(t, 'GET', '/overview')).body;
    expect(raw).toMatchObject({ holdPending: expect.any(Number), toxicFlowShare: 0, defenses: { hold: true, toxicity: 'graduated', minLeadS: DEFAULT_DEFENSES.minLeadS, reference: false }, controller: { enabled: true, ranges: expect.any(Array) } });
    expect('holdRejectRate' in raw).toBe(true);
    expect(decodeOverview(raw)).toMatchObject({ network: 'offline' });
  });

  it('writes partial changes with a reason, typed confirmations, strict fields, and journals them', async () => {
    expect((await admin(t, 'PUT', '/defenses', { hold: { tolRel: 0.3 } })).body.error.code).toBe('REASON_REQUIRED');
    expect((await admin(t, 'PUT', '/defenses', { reason })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await admin(t, 'PUT', '/defenses', { bogus: 1, reason })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await admin(t, 'PUT', '/defenses', { hold: { bogus: 1 }, reason })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await admin(t, 'PUT', '/defenses', { hold: { maxHoldMs: 1 }, reason })).body.error.code).toBe('VALIDATION_ERROR');
    const ok = await admin(t, 'PUT', '/defenses', { hold: { tolRel: 0.3 }, minLeadS: 5, reason });
    expect(ok).toMatchObject({ status: 200, body: { ok: true, action: 'defenses', auditId: expect.any(String), before: { hold: { tolRel: DEFAULT_DEFENSES.hold.tolRel } }, after: { hold: { tolRel: 0.3 }, minLeadS: 5 } } });
    expect((await admin(t, 'PUT', '/defenses', { hold: { tolRel: 0.3 }, reason })).status).toBe(409);
    const off = await admin(t, 'PUT', '/defenses', { ramp: { enabled: false }, reason });
    expect(off).toMatchObject({ status: 400, body: { error: { code: 'CONFIRM_REQUIRED' } } });
    expect((await admin(t, 'PUT', '/defenses', { ramp: { enabled: false }, reason, confirm: 'defenses-disable' }))).toMatchObject({ status: 200, body: { disabled: ['ramp'] } });
    expect((await admin(t, 'PUT', '/defenses', { controller: { overrides: { '5-10': 0.04 } }, reason })).body.error.code).toBe('CONFIRM_REQUIRED');
    expect((await admin(t, 'PUT', '/defenses', { controller: { overrides: { '5-10': 0.04 } }, reason, confirm: 'edge-change' })).status).toBe(200);
    expect((await admin(t, 'GET', '/defenses')).body).toMatchObject({ minLeadS: 5, config: { hold: { tolRel: 0.3 }, ramp: { enabled: false }, controller: { overrides: { '5-10': 0.04 } } } });
    const audit = (await admin(t, 'GET', '/audit?limit=20')).body.rows.filter((r: { action: string }) => r.action === 'defenses');
    expect(audit).toHaveLength(3);
    expect(audit[0]).toMatchObject({ kind: 'admin', actor: 'admin', reason });
    expect(t.journal.records<EngineEvent>().filter(e => e.type === 'config' && e.target === 'defenses')).toHaveLength(3);
  });
});
