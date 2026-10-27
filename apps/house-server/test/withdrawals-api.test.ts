import { afterEach, describe, expect, it } from 'vitest';
import type { ChainWithdrawal } from '../src/chain-port.js';
import { loadConfig } from '../src/config.js';
import type { EngineNotice } from '../src/engine/types.js';
import { ACCOUNTS } from '../src/ledger/ledger.js';
import { admin, api, startTestApp, type TestApp } from './app-helpers.js';

const WEI = 10n ** 18n;
const CENTI = 10n ** 16n;

describe('MAYA_OPEN_PLAYER_API', () => {
  it('defaults to off and accepts only off or testnet-unsafe', () => {
    const base = { MAYA_REPO_ROOT: '.' };
    expect(loadConfig(base)).toMatchObject({ ok: true, config: { openPlayerApi: 'off' } });
    expect(loadConfig({ ...base, MAYA_OPEN_PLAYER_API: 'testnet-unsafe' })).toMatchObject({ ok: true, config: { openPlayerApi: 'testnet-unsafe' } });
    const bad = loadConfig({ ...base, MAYA_OPEN_PLAYER_API: 'on' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(' ')).toMatch(/MAYA_OPEN_PLAYER_API must be off or testnet-unsafe/);
  });
});

describe('external-wallet withdrawals (Stage B MetaMask flow)', () => {
  let t: TestApp | undefined;
  afterEach(async () => { await t?.close(); t = undefined; });

  it('is disabled by default (no SIWE in Stage A) and reserves nothing', async () => {
    t = await startTestApp();
    const p = t.chain.players()[0]!;
    await t.chain.playerDeposit(p.role, 50n * WEI);
    const post = await api(t.base, 'POST', '/v1/withdrawals', { account: p.address, amountCenti: '100' });
    expect(post).toMatchObject({ status: 403, body: { error: { code: 'PLAYER_API_DISABLED', message: expect.stringMatching(/SIWE/) } } });
    expect((await api(t.base, 'GET', `/v1/withdrawals?account=${p.address}`)).status).toBe(403);
    expect(t.app.engine.balanceOf(p.address)).toBe(5000n);
    expect(t.app.engine.vouchers.size).toBe(0);
  });

  it('issues a signed voucher the player redeems from their own wallet; the Withdrawn event claims it and the ledger reconciles', async () => {
    t = await startTestApp({ openPlayerApi: true });
    const p = t.chain.players()[2]!;
    await t.chain.playerDeposit(p.role, 250n * WEI + 9n);
    const r = await api(t.base, 'POST', '/v1/withdrawals', { account: p.address, amountCenti: '7500' });
    expect(r.status).toBe(200);
    const v = r.body;
    expect(v).toMatchObject({
      status: 'pending', created: true, account: p.address, amountCenti: '7500', amountWei: (7500n * CENTI).toString(), nonce: expect.stringMatching(/^\d{60,}$/), expiry: expect.stringMatching(/^\d+$/),
      signature: expect.stringMatching(/^0x[0-9a-f]{130}$/), vault: t.chain.addresses().vault, chainId: 0, requestId: expect.stringMatching(/^wd-/),
      domain: { name: 'MayaHouseVault', version: '1', chainId: 0, verifyingContract: t.chain.addresses().vault }, primaryType: 'Withdrawal',
      types: { Withdrawal: [{ name: 'account', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint256' }] },
      message: { account: p.address, amount: (7500n * CENTI).toString() },
      call: { function: 'withdraw(uint256,uint256,uint256,bytes)', from: p.address },
    });
    expect(v.call.args).toEqual([v.amountWei, v.nonce, v.expiry, v.signature]);
    expect(t.app.engine.availableBalance(p.address)).toBe(17_500n);
    // Validation: bad account, sim account, unknown fields, malformed requestId.
    expect((await api(t.base, 'POST', '/v1/withdrawals', { account: 'sim:x', amountCenti: '1' })).body.error.code).toBe('INVALID_ACCOUNT');
    expect((await api(t.base, 'POST', '/v1/withdrawals', { account: p.address, amountCenti: '1', x: 1 })).status).toBe(400);
    expect((await api(t.base, 'POST', '/v1/withdrawals', { account: p.address, amountCenti: '1', requestId: 'has space' })).body.error.code).toBe('INVALID_REQUEST');
    expect((await api(t.base, 'POST', '/v1/withdrawals', { account: p.address, amountCenti: '17501' })).body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect((await api(t.base, 'POST', '/v1/withdrawals', { account: p.address, amountCenti: '10000001' })).body.error.code).toBe('ABOVE_VOUCHER_MAX');

    // MetaMask sends the transaction straight to the vault; the server only sees the chain event.
    const tx = await t.chain.playerWithdraw(p.role, { amountWei: BigInt(v.amountWei), nonce: BigInt(v.nonce), expiry: BigInt(v.expiry), signature: v.signature });
    const list = await api(t.base, 'GET', `/v1/withdrawals?account=${p.address}`);
    expect(list.body).toMatchObject({ account: p.address, availableCenti: '17500', rows: [{ voucherId: v.voucherId, status: 'claimed', txHash: tx.txHash, claimBlock: expect.any(String) }] });
    expect(list.body.rows[0].signature).toBeUndefined();
    expect((await api(t.base, 'GET', '/v1/withdrawals?account=nope')).status).toBe(400);
    expect(t.app.engine.ledger.balance(ACCOUNTS.vouchers)).toBe(0n);
    expect(t.app.engine.reconcile(await t.chain.vaultState())).toMatchObject({ match: true, dustWei: '9' });
    const chain = (await admin(t, 'GET', '/chain')).body;
    expect(chain).toMatchObject({ pendingVouchers: { count: 0 }, withdrawals: { indexed: 1, anomalies: [] }, reconciliation: { match: true } });
  });

  it('refuses new vouchers while the vault is paused and answers the original voucher for a repeated requestId', async () => {
    t = await startTestApp({ openPlayerApi: true });
    const p = t.chain.players()[0]!;
    await t.chain.playerDeposit(p.role, 100n * WEI);
    const first = await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'wd-pause-1', account: p.address, amountCenti: '1000' });
    expect(first.status).toBe(200);
    expect((await admin(t, 'POST', '/vault/pause', { reason: 'pause for the test run', confirm: 'vault-pause' })).body.ok).toBe(true);
    const again = await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'wd-pause-1', account: p.address, amountCenti: '1000' });
    expect(again.body).toMatchObject({ voucherId: first.body.voucherId, created: false, signature: first.body.signature });
    const paused = await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'wd-pause-2', account: p.address, amountCenti: '1000' });
    expect(paused).toMatchObject({ status: 409, body: { error: { code: 'VAULT_PAUSED' } } });
    expect(t.app.engine.balanceOf(p.address)).toBe(9000n);
  });

  it('returns expired, unredeemed vouchers to the balance only when the vault reports the nonce unused, and waits for late events', async () => {
    t = await startTestApp({ openPlayerApi: true, engine: { voucherTtlS: 60 }, app: { voucherSweepEveryMs: 5_000, voucherExpiryMarginS: 30 } });
    const notices: EngineNotice[] = [];
    t.app.engine.on(n => notices.push(n));
    const [a, b] = t.chain.players();
    await t.chain.playerDeposit(a!.role, 100n * WEI);
    await t.chain.playerDeposit(b!.role, 100n * WEI);
    const va = (await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'exp-a', account: a!.address, amountCenti: '4000' })).body;
    const vb = (await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'exp-b', account: b!.address, amountCenti: '3000' })).body;
    // b redeems, but the event is lost in transit (indexer lag): the sweep must not re-credit b.
    const deliver = (t.app as unknown as { unsubscribeWithdrawn?: () => void });
    deliver.unsubscribeWithdrawn?.();
    const txB = await t.chain.playerWithdraw(b!.role, { amountWei: BigInt(vb.amountWei), nonce: BigInt(vb.nonce), expiry: BigInt(vb.expiry), signature: vb.signature });
    t.advance(60);
    await Promise.all([...t.app.pending]);
    expect(t.app.engine.vouchers.get(va.voucherId)?.status).toBe('pending'); // expired but inside the 30 s margin
    t.advance(40);
    await Promise.all([...t.app.pending]);
    expect(t.app.engine.vouchers.get(va.voucherId)).toMatchObject({ status: 'expired', cancelReason: expect.stringMatching(/nonce unused/) });
    expect(t.app.engine.balanceOf(a!.address)).toBe(10_000n);
    expect(t.app.engine.vouchers.get(vb.voucherId)?.status).toBe('pending');
    expect(t.app.engine.balanceOf(b!.address)).toBe(7_000n);
    expect(notices.some(n => n.type === 'alert' && n.data.code === 'WITHDRAWAL_EVENT_PENDING' && n.data.message.includes(vb.voucherId))).toBe(true);
    expect(t.app.engine.auditLog(20).find(x => x.action === 'voucher-expired')).toMatchObject({ kind: 'system', actor: 'voucher-sweep', target: a!.address });
    // The redeemed voucher was never released, so the vault is 3,000 below the ledger until the event lands.
    expect(t.app.engine.reconcile(await t.chain.vaultState())).toMatchObject({ match: false, deltaWei: (-3000n * CENTI).toString() });
    const late: ChainWithdrawal = { player: b!.address, amountWei: BigInt(vb.amountWei), nonce: BigInt(vb.nonce), txHash: txB.txHash, logIndex: 0, blockNumber: 5n };
    expect(t.app.engine.applyChainWithdrawal(late)).toMatchObject({ ok: true, duplicate: false, outcome: 'claimed' });
    expect(t.app.engine.reconcile(await t.chain.vaultState())).toMatchObject({ match: true });
    // An expired voucher's signature no longer pays on chain either.
    await expect(t.chain.playerWithdraw(a!.role, { amountWei: BigInt(va.amountWei), nonce: BigInt(va.nonce), expiry: BigInt(va.expiry), signature: va.signature })).rejects.toThrow(/VoucherExpired/);
  });
});
