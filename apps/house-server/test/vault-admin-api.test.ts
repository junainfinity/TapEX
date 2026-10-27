import { afterEach, describe, expect, it } from 'vitest';
import { decodeChain } from '../../admin/src/decode.js';
import { chainAlerts } from '../src/chain-alerts.js';
import type { VaultState } from '../src/chain-port.js';
import type { EngineEvent, EngineNotice } from '../src/engine/types.js';
import { admin, api, startTestApp, TOKEN, type TestApp } from './app-helpers.js';

const WEI = 10n ** 18n;
const reason = 'vault administration test';
const NEW_SIGNER = '0x' + '5a'.repeat(20);

function vaultState(over: Partial<VaultState> = {}): VaultState {
  return {
    assetsWei: 0n, houseFundedWei: 0n, totalDepositsWei: 0n, totalWithdrawalsWei: 0n, houseWithdrawnWei: 0n, surplusWei: 0n, paused: false, maxVoucherAmountWei: 1n, dailyOutflowCapWei: 1n,
    lastAttestation: null, ledgerSigner: '0x' + '11'.repeat(20), pendingSigner: null, signerChangeDelay: 172_800n, pendingSignerChangeDelay: null, maxAttestationAge: 600n,
    houseBufferBps: 1000n, houseDailyCap: 1n, pendingHouseLimits: null, houseWithdrawableWei: 0n, excessWei: 0n,
    escape: { mode: false, lastAttestationAt: 1_000_000n, escapeDelay: 604_800n, availableAt: 1_604_800n, poolWei: 0n, claimedWei: 0n },
    ...over,
  };
}

describe('chain alert rules', () => {
  const me = '0x' + '11'.repeat(20);
  const codes = (v: VaultState, nowS: bigint) => chainAlerts(v, { nowS, serverSigner: me, attestEveryS: 600n }).map(a => `${a.code}:${a.level}`);
  it('stays quiet for a healthy vault and escalates a silent house towards the escape delay', () => {
    expect(codes(vaultState(), 1_000_100n)).toEqual([]);
    expect(codes(vaultState(), 1_002_000n)).toEqual(['ATTESTATION_STALE:warning']); // > max(600 s, 3 × 600 s)
    expect(codes(vaultState(), 1_000_000n + 302_400n)).toEqual(['ESCAPE_APPROACHING:warning', 'ATTESTATION_STALE:warning']); // 50 % of 7 d
    expect(codes(vaultState(), 1_000_000n + 453_600n)).toEqual(['ESCAPE_APPROACHING:critical', 'ATTESTATION_STALE:warning']); // 75 %
    expect(codes(vaultState(), 1_604_800n)).toEqual(['ESCAPE_AVAILABLE:critical']);
    expect(codes(vaultState({ escape: { ...vaultState().escape, mode: true } }), 1_700_000n)).toEqual(['ESCAPE_MODE:critical']);
  });
  it('reports pending timelocked changes and a signer this server does not hold', () => {
    const v = vaultState({
      pendingSigner: { address: NEW_SIGNER, eta: 1_100_000n }, pendingSignerChangeDelay: { delay: 3_600n, eta: 1_100_000n },
      pendingHouseLimits: { houseBufferBps: 500n, houseDailyCap: 2n, eta: 1_100_000n },
    });
    expect(codes(v, 1_000_100n)).toEqual(['SIGNER_CHANGE_PENDING:warning', 'SIGNER_DELAY_CHANGE_PENDING:warning', 'HOUSE_LIMITS_CHANGE_PENDING:warning']);
    expect(codes(v, 1_100_000n)[0]).toBe('SIGNER_CHANGE_DUE:critical');
    expect(codes(vaultState({ ledgerSigner: NEW_SIGNER }), 1_000_100n)).toEqual(['SIGNER_MISMATCH:critical']);
    const a = chainAlerts(v, { nowS: 1_000_100n }), b = chainAlerts(v, { nowS: 1_000_200n });
    expect(a.map(x => x.key)).toEqual(b.map(x => x.key)); // unchanged conditions do not re-alert
  });
});

describe('admin API: SPEC-11 vault state and timelocked administration', () => {
  let t: TestApp | undefined;
  afterEach(async () => { await t?.close(); t = undefined; });

  it('exposes the hardened vault state and decodes with the console decoder', async () => {
    t = await startTestApp();
    const raw = (await admin(t, 'GET', '/chain')).body;
    decodeChain(raw);
    const signer = t.chain.addresses().ledgerSigner;
    expect(raw.vault).toMatchObject({
      ledgerSigner: signer, serverSigner: signer, signerMismatch: false, pendingSigner: null, signerChangeDelaySec: 172_800, pendingSignerChangeDelay: null, maxAttestationAgeSec: 600,
      houseBufferBps: 1000, houseDailyCapCenti: '1000000000', pendingHouseLimits: null, houseWithdrawableCenti: expect.stringMatching(/^\d+$/), excessWei: '0', excessCenti: '0',
      escape: { mode: false, available: false, escapeDelaySec: 604_800, secondsUntilAvailable: expect.any(Number), poolCenti: '0', claimedCenti: '0' },
    });
    expect(raw.alerts).toEqual([]);
    expect(raw.withdrawals).toEqual({ indexed: 0, anomalies: [] });
  });

  it('proposes, refuses early, accepts and cancels signer rotations with reason, confirmation, audit and SSE alerts', async () => {
    const clock = { ms: 0 };
    // Vouchers outlive the 48 h notice here so the rotation (not expiry) is what invalidates the outstanding one.
    t = await startTestApp({ chainClockOffset: clock, openPlayerApi: true, engine: { voucherTtlS: 3 * 86_400 } });
    const notices: EngineNotice[] = [];
    t.app.engine.on(n => notices.push(n));
    const controller = new AbortController();
    const stream = await fetch(`${t.base}/admin-api/stream`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' }, signal: controller.signal });
    const reader = stream.body!.getReader(); const decoder = new TextDecoder(); let text = '';
    const readUntil = async (pattern: RegExp) => { const deadline = Date.now() + 5000; while (!pattern.test(text) && Date.now() < deadline) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value); } };

    expect((await admin(t, 'POST', '/vault/signer/propose', { address: NEW_SIGNER })).body.error.code).toBe('REASON_REQUIRED');
    expect((await admin(t, 'POST', '/vault/signer/propose', { address: NEW_SIGNER, reason })).body.error.code).toBe('CONFIRM_REQUIRED');
    expect((await admin(t, 'POST', '/vault/signer/propose', { address: 'nope', reason, confirm: 'signer-propose' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await admin(t, 'POST', '/vault/signer/propose', { address: t.chain.addresses().operator, reason, confirm: 'signer-propose' })).body.error.code).toBe('SIGNER_IS_OWNER');
    expect((await admin(t, 'POST', '/vault/signer/propose', { address: t.chain.addresses().ledgerSigner, reason, confirm: 'signer-propose' })).body.error.code).toBe('SIGNER_UNCHANGED');
    expect((await admin(t, 'POST', '/vault/signer/propose', { address: NEW_SIGNER, reason, confirm: 'signer-propose', extra: 1 })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await admin(t, 'POST', '/vault/signer/accept', { reason, confirm: 'signer-accept' })).body.error.code).toBe('NO_PENDING_SIGNER');
    expect((await admin(t, 'POST', '/vault/signer/cancel', { reason })).body.error.code).toBe('NO_PENDING_SIGNER');

    const proposed = await admin(t, 'POST', '/vault/signer/propose', { address: NEW_SIGNER, reason, confirm: 'signer-propose' }, { 'X-Maya-Actor': 'ops-ben' });
    expect(proposed).toMatchObject({ status: 200, body: { ok: true, action: 'vault-signer-propose', txHash: expect.stringMatching(/^0x/), before: { pendingSigner: null }, after: { pendingSigner: { address: NEW_SIGNER, etaMs: expect.any(Number) } } } });
    await Promise.all([...t.app.pending]);
    const pendingAlert = notices.find((n): n is Extract<EngineNotice, { type: 'alert' }> => n.type === 'alert' && n.data.code === 'SIGNER_CHANGE_PENDING');
    expect(pendingAlert?.data).toMatchObject({ level: 'warning', message: expect.stringContaining(NEW_SIGNER) });
    await readUntil(/SIGNER_CHANGE_PENDING/);
    expect(text).toMatch(/event: alert\ndata: .*SIGNER_CHANGE_PENDING/);
    const chain1 = (await admin(t, 'GET', '/chain')).body;
    expect(chain1.vault.pendingSigner).toMatchObject({ address: NEW_SIGNER, due: false });
    expect(chain1.alerts.map((a: { code: string }) => a.code)).toEqual(['SIGNER_CHANGE_PENDING']);
    expect((await admin(t, 'GET', '/overview')).body.chainAlerts).toEqual([{ code: 'SIGNER_CHANGE_PENDING', level: 'warning', message: expect.stringContaining(NEW_SIGNER) }]);

    // Before the eta the vault itself refuses (chain time is authoritative); the failure is audited.
    const early = await admin(t, 'POST', '/vault/signer/accept', { reason, confirm: 'signer-accept' });
    expect(early).toMatchObject({ status: 409, body: { error: { code: 'TIMELOCK_NOT_ELAPSED' } } });
    expect((await admin(t, 'POST', '/vault/signer/accept', { reason })).body.error.code).toBe('CONFIRM_REQUIRED');

    // Cancel, re-propose, then accept after 48 h of chain time.
    expect((await admin(t, 'POST', '/vault/signer/cancel', { reason })).body).toMatchObject({ ok: true, action: 'vault-signer-cancel', after: { pendingSigner: null } });
    await Promise.all([...t.app.pending]);
    expect(notices.some(n => n.type === 'alert' && n.data.code === 'SIGNER_CHANGE_PENDING_RESOLVED')).toBe(true);
    expect((await admin(t, 'POST', '/vault/signer/propose', { address: NEW_SIGNER, reason, confirm: 'signer-propose' })).body.ok).toBe(true);
    const p1 = t.chain.players()[0]!;
    await t.chain.playerDeposit(p1.role, 100n * WEI);
    const outstanding = await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'rot-wd', account: p1.address, amountCenti: '1000' });
    expect(outstanding.status).toBe(200);
    clock.ms = 48 * 3_600_000 + 1000;
    await t.app.checkChainHealth();
    expect(notices.some(n => n.type === 'alert' && n.data.code === 'SIGNER_CHANGE_DUE' && n.data.level === 'critical')).toBe(true);
    const accepted = await admin(t, 'POST', '/vault/signer/accept', { reason, confirm: 'signer-accept' });
    expect(accepted.body).toMatchObject({ ok: true, action: 'vault-signer-accept', after: { ledgerSigner: NEW_SIGNER }, invalidatedVouchers: 1, warning: expect.stringContaining('SIGNER_MISMATCH') });
    await Promise.all([...t.app.pending]);
    expect(notices.some(n => n.type === 'alert' && n.data.code === 'SIGNER_MISMATCH' && n.data.level === 'critical')).toBe(true);
    const chain2 = (await admin(t, 'GET', '/chain')).body;
    expect(chain2.vault).toMatchObject({ ledgerSigner: NEW_SIGNER, signerMismatch: true, pendingSigner: null });
    // This process can no longer sign: new vouchers are refused before anything is reserved; the old voucher no longer pays.
    const before = t.app.engine.balanceOf(p1.address);
    const refused = await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'rot-wd-2', account: p1.address, amountCenti: '1000' });
    expect(refused).toMatchObject({ status: 503, body: { error: { code: 'SIGNER_MISMATCH' } } });
    expect(t.app.engine.balanceOf(p1.address)).toBe(before);
    const b = outstanding.body;
    await expect(t.chain.playerWithdraw(p1.role, { amountWei: BigInt(b.amountWei), nonce: BigInt(b.nonce), expiry: BigInt(b.expiry), signature: b.signature })).rejects.toThrow(/InvalidSignature/);

    const audit = t.journal.records<EngineEvent>().filter((r): r is Extract<EngineEvent, { type: 'audit' }> => r.type === 'audit').map(r => r.entry);
    for (const action of ['vault-signer-propose', 'vault-signer-cancel', 'vault-signer-accept']) {
      const row = audit.find(a => a.action === action && a.result === 'ok');
      expect(row, action).toMatchObject({ kind: 'admin', reason, txHash: expect.stringMatching(/^0x/) });
      expect(row).toHaveProperty('before'); expect(row).toHaveProperty('after');
    }
    expect(audit.find(a => a.action === 'vault-signer-propose')?.actor).toBe('admin:ops-ben');
    expect(audit.find(a => a.action === 'vault-signer-accept' && a.result?.startsWith('failed'))).toBeDefined();
    controller.abort();
  });

  it('sweeps only stray tokens and bounds house withdrawals by the vault buffer and daily cap', async () => {
    t = await startTestApp();
    const operator = t.chain.addresses().operator;
    const to = '0x' + '77'.repeat(20);
    expect((await admin(t, 'POST', '/vault/sweep-excess', { to, reason })).body.error.code).toBe('CONFIRM_REQUIRED');
    expect((await admin(t, 'POST', '/vault/sweep-excess', { to, reason, confirm: 'sweep-excess' })).body.error.code).toBe('NOTHING_TO_SWEEP');
    expect((await admin(t, 'POST', '/vault/sweep-excess', { to: t.chain.addresses().vault, reason, confirm: 'sweep-excess' })).body.error.code).toBe('VALIDATION_ERROR');
    t.chain.donate(operator, 12n * WEI + 34n);
    await t.app.readVault(true);
    const assets = (await t.chain.vaultState()).assetsWei;
    const swept = await admin(t, 'POST', '/vault/sweep-excess', { to, reason, confirm: 'sweep-excess' });
    expect(swept.body).toMatchObject({ ok: true, action: 'vault-sweep-excess', amountWei: (12n * WEI + 34n).toString(), before: { excessWei: (12n * WEI + 34n).toString() }, after: { excessWei: '0', sweptWei: (12n * WEI + 34n).toString(), to } });
    expect((await t.chain.vaultState()).assetsWei).toBe(assets);
    expect((await t.chain.balances(to)).tokenWei).toBe(12n * WEI + 34n);
    expect(t.app.engine.reconcile(await t.chain.vaultState())).toMatchObject({ match: true });

    const p1 = t.chain.players()[0]!;
    await t.chain.playerDeposit(p1.role, 500n * WEI);
    t.advance(2); // deposits mined at asOf would count twice (conservative vault rule); attest after them
    // All free equity passes the ledger check and the vault surplus, but not the 10 % buffer on player obligations.
    const all = t.app.engine.equityOnchain().toString();
    const w = await admin(t, 'POST', '/treasury/withdraw-surplus', { amountCenti: all, reason, confirm: 'withdraw-surplus' });
    expect(w).toMatchObject({ status: 409, body: { error: { code: 'EXCEEDS_HOUSE_WITHDRAWABLE' } } });
    await t.chain.setHouseLimits(1000n, 100n * WEI); // tightening applies at once
    const capped = await admin(t, 'POST', '/treasury/withdraw-surplus', { amountCenti: '10001', reason, confirm: 'withdraw-surplus' });
    expect(capped.body.error.code).toBe('EXCEEDS_HOUSE_WITHDRAWABLE');
    expect((await admin(t, 'POST', '/treasury/withdraw-surplus', { amountCenti: '10000', reason, confirm: 'withdraw-surplus' })).body).toMatchObject({ ok: true });
    expect(t.app.engine.reconcile(await t.chain.vaultState())).toMatchObject({ match: true });
  });
});
