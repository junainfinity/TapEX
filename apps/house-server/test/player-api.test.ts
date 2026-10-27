import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, startTestApp, type TestApp } from './app-helpers.js';

let t: TestApp;
// The withdrawal routes are opt-in (MAYA_OPEN_PLAYER_API=testnet-unsafe); test/withdrawals-api.test.ts covers the default-off guard.
beforeAll(async () => { t = await startTestApp({ openPlayerApi: true }); });
afterAll(async () => { await t.close(); });

describe('player API', () => {
  it('signs in, quotes, places idempotent bets, reads receipts and accounts, and withdraws with a signed voucher', async () => {
    const player = t.chain.players()[0]!;
    await t.chain.playerDeposit(player.role, 500n * 10n ** 18n + 42n);
    const acct = await api(t.base, 'GET', `/v1/account/${player.address}`);
    expect(acct.body).toMatchObject({ account: player.address, registered: true, balanceCenti: '50000', deposits: [{ amountCenti: '50000', dustWei: '42' }] });
    const other = '0x' + '9'.repeat(40);
    expect((await api(t.base, 'POST', '/v1/sign-in', { account: other })).body).toMatchObject({ account: other, created: true });
    expect((await api(t.base, 'POST', '/v1/sign-in', { account: other })).body).toMatchObject({ created: false });
    expect((await api(t.base, 'POST', '/v1/sign-in', { account: 'sim:hack' })).status).toBe(400);

    t.advance(2);
    const grid = (await api(t.base, 'GET', `/v1/quotes?market=btc-usd&account=${player.address}`)).body;
    expect(grid).toMatchObject({ market: 'btc-usd', phase: 'launch', cells: expect.any(Array) });
    expect(grid.cells).toHaveLength(42);
    const cell = grid.cells.find((c: { available: boolean; window: number }) => c.available && c.window >= 3);
    expect(cell).toMatchObject({ quoteId: expect.any(String), x100: expect.any(Number), maxStakeCenti: expect.any(String) });
    expect(BigInt(cell.maxStakeCenti)).toBeLessThanOrEqual(50_000n);
    expect((await api(t.base, 'GET', '/v1/quotes?market=doge')).status).toBe(400);

    const bet = { requestId: 'player-api-1', account: player.address, quoteId: cell.quoteId, revision: 1, cellId: cell.cellId, stakeCenti: '2500' };
    const placed = await api(t.base, 'POST', '/v1/bets', bet);
    expect(placed).toMatchObject({ status: 200, body: { status: 'accepted', newlyCommitted: true, leg: { stakeCenti: '2500', x100: cell.x100, status: 'open', account: player.address } } });
    const again = await api(t.base, 'POST', '/v1/bets', bet);
    expect(again.body).toMatchObject({ status: 'accepted', newlyCommitted: false, leg: { legId: placed.body.leg.legId } });
    const conflict = await api(t.base, 'POST', '/v1/bets', { ...bet, stakeCenti: '2600' });
    expect(conflict).toMatchObject({ status: 409, body: { status: 'rejected', reason: 'REQUEST_CONFLICT' } });
    expect((await api(t.base, 'POST', '/v1/bets', { ...bet, requestId: 'player-api-2', x100: 9999 })).status).toBe(400);
    expect((await api(t.base, 'POST', '/v1/bets', { ...bet, requestId: 'player-api-3', stakeCenti: '99999999' })).body).toMatchObject({ reason: 'STAKE_NOT_ALLOWED' });
    expect((await api(t.base, 'GET', '/v1/bets/by-request/player-api-1')).body).toMatchObject({ status: 'accepted', leg: { legId: placed.body.leg.legId } });
    expect((await api(t.base, 'GET', '/v1/bets/by-request/never-sent')).status).toBe(404);
    const account = (await api(t.base, 'GET', `/v1/account/${player.address}`)).body;
    expect(account).toMatchObject({ balanceCenti: '47500', openLegs: [{ legId: placed.body.leg.legId }] });

    const w = await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'wd-api-1', account: player.address, amountCenti: '10000' });
    expect(w.body).toMatchObject({ status: 'pending', amountCenti: '10000', amountWei: (10000n * 10n ** 16n).toString(), signature: expect.stringMatching(/^0x[0-9a-f]{130}$/), domain: { name: 'MayaHouseVault', version: '1' } });
    expect((await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'wd-api-1', account: player.address, amountCenti: '10000' })).body).toMatchObject({ voucherId: w.body.voucherId, created: false });
    expect((await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'wd-api-1', account: player.address, amountCenti: '10001' })).status).toBe(409);
    expect((await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'wd-api-2', account: player.address, amountCenti: '100000' })).body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect((await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'wd-api-4', account: player.address, amountCenti: '10000001' })).body.error.code).toBe('ABOVE_VOUCHER_MAX');
    expect((await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'wd-api-3', account: 'sim:x', amountCenti: '1' })).status).toBe(400);
    const tx = await t.chain.playerWithdraw(player.role, { amountWei: BigInt(w.body.amountWei), nonce: BigInt(w.body.nonce), expiry: BigInt(w.body.expiry), signature: w.body.signature });
    expect(t.app.engine.markVoucherClaimed(w.body.voucherId, tx.txHash)).toBe(true);
    expect(t.app.engine.balanceOf(player.address)).toBe(37_500n);
    expect(t.app.engine.reconcile(await t.chain.vaultState())).toMatchObject({ match: true, dustWei: '42' });
  });
});
