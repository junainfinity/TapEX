import { describe, expect, it } from 'vitest';
import type { ChainWithdrawal } from '../src/chain-port.js';
import { voucherNonce, type HouseEngine } from '../src/engine/engine.js';
import type { EngineEvent, EngineNotice } from '../src/engine/types.js';
import { MemoryJournal } from '../src/ledger/journal.js';
import { ACCOUNTS } from '../src/ledger/ledger.js';
import { OfflineChain } from '../src/offline-chain.js';
import { makeEngine } from './helpers.js';

const WEI = 10n ** 18n;
const CENTI = 10n ** 16n;

/** Engine + offline vault wired like HouseApp: deposits and redemptions reach the ledger only as chain events. */
function setup() {
  const journal = new MemoryJournal();
  const { engine } = makeEngine({ journal, bankrollCenti: '100000000' });
  const chain = new OfflineChain({ now: () => engine.nowMs, seed: 'wd-chain', syncEvents: true, initialHouseFundWei: 1_000_000n * WEI });
  const alerts: Extract<EngineNotice, { type: 'alert' }>['data'][] = [];
  engine.on(n => { if (n.type === 'alert') alerts.push(n.data); });
  chain.onDeposit(d => { engine.creditDeposit(d); });
  chain.onWithdrawn(w => { engine.applyChainWithdrawal(w); });
  const p1 = chain.players()[0]!, p2 = chain.players()[1]!;
  return { engine, chain, journal, alerts, p1, p2 };
}
async function voucher(engine: HouseEngine, chain: OfflineChain, requestId: string, account: string, amountCenti: string) {
  const r = engine.requestWithdrawal(requestId, account, amountCenti, BigInt(Math.floor(engine.nowMs / 1000)));
  if (!r.ok) throw new Error(r.code);
  const v = r.voucher;
  const signature = await chain.signWithdrawal({ account, amountWei: BigInt(v.amountCenti) * CENTI, nonce: BigInt(v.nonce), expiry: BigInt(v.expiry) });
  expect(engine.attachVoucherSignature(v.voucherId, signature)).toBe(true);
  return { v, signature, terms: { amountWei: BigInt(v.amountCenti) * CENTI, nonce: BigInt(v.nonce), expiry: BigInt(v.expiry), signature } };
}

describe('voucher nonces', () => {
  it('are uint256 values unique per run and voucher (no reuse of small counters on a vault shared across runs)', () => {
    const a = voucherNonce('run-a', 'V1'), b = voucherNonce('run-a', 'V2'), c = voucherNonce('run-b', 'V1');
    expect(new Set([a, b, c]).size).toBe(3);
    for (const n of [a, b, c]) { expect(n).toMatch(/^\d+$/); expect(BigInt(n)).toBeLessThan(2n ** 248n); expect(BigInt(n)).toBeGreaterThan(2n ** 200n); }
    expect(voucherNonce('run-a', 'V1')).toBe(a);
  });

  it('also differ per process boot, so a rebuilt ledger never re-issues a spent nonce for the same voucher id (MC-4)', () => {
    const b1 = voucherNonce('run-a', 'V1', 'boot-1'), b2 = voucherNonce('run-a', 'V1', 'boot-2');
    expect(new Set([b1, b2, voucherNonce('run-a', 'V1')]).size).toBe(3);
    for (const n of [b1, b2]) { expect(BigInt(n)).toBeLessThan(2n ** 248n); expect(BigInt(n)).toBeGreaterThan(2n ** 200n); }
    expect(voucherNonce('run-a', 'V1', 'boot-1')).toBe(b1);
  });
});

describe('ChainPort.onWithdrawn → ledger', () => {
  it('claims a voucher redeemed by any wallet only when the chain event arrives, idempotently, and reconciles exactly', async () => {
    const { engine, chain, journal, p1 } = setup();
    await chain.playerDeposit(p1.role, 500n * WEI + 7n);
    const { v, terms } = await voucher(engine, chain, 'wd-1', p1.address, '20000');
    expect(v.nonce).toBe(voucherNonce('test-run', 'V1', 'b1'));
    expect(engine.ledger.balance(ACCOUNTS.vouchers)).toBe(20_000n);
    // A receipt the server holds is only a hint: nothing moves until the Withdrawn event.
    expect(engine.noteVoucherSubmitted(v.voucherId, '0x' + 'e'.repeat(64))).toBe(true);
    expect(engine.vouchers.get(v.voucherId)).toMatchObject({ status: 'pending', submittedTxHash: '0x' + 'e'.repeat(64) });
    expect(engine.ledger.balance(ACCOUNTS.vouchers)).toBe(20_000n);
    // The player redeems from their own wallet (not through the server); the event claims the voucher.
    const tx = await chain.playerWithdraw(p1.role, terms);
    expect(engine.vouchers.get(v.voucherId)).toMatchObject({ status: 'claimed', txHash: tx.txHash, claimSource: 'event', claimBlock: expect.any(String) });
    expect(engine.ledger.balance(ACCOUNTS.vouchers)).toBe(0n);
    expect(engine.balanceOf(p1.address)).toBe(30_000n);
    expect(engine.reconcile(await chain.vaultState())).toMatchObject({ match: true, dustWei: '7', components: { anomalousWithdrawals: '0' } });
    // At-least-once delivery: the same event again (or the server's own receipt) changes nothing.
    const event: ChainWithdrawal = { player: p1.address, amountWei: terms.amountWei, nonce: terms.nonce, txHash: tx.txHash, logIndex: 0, blockNumber: 99n };
    const seq = engine.journalSeq;
    expect(engine.applyChainWithdrawal(event)).toMatchObject({ ok: true, duplicate: true, outcome: 'claimed' });
    expect(engine.markVoucherClaimed(v.voucherId, tx.txHash)).toBe(true);
    expect(engine.markVoucherClaimed(v.voucherId, '0x' + '1'.repeat(64))).toBe(false);
    expect(engine.journalSeq).toBe(seq);
    expect(journal.records<EngineEvent>().filter(r => r.type === 'withdrawal')).toHaveLength(1);
    expect(engine.applyChainWithdrawal({ ...event, player: 'nope' })).toEqual({ ok: false, code: 'INVALID_WITHDRAWAL' });
    expect(engine.applyChainWithdrawal({ ...event, amountWei: 0n })).toEqual({ ok: false, code: 'INVALID_WITHDRAWAL' });
  });

  it('books a voucher paid after the ledger released it by clawing back the balance, the shortfall from house equity, with a critical alert', async () => {
    const { engine, chain, alerts, p1 } = setup();
    await chain.playerDeposit(p1.role, 100n * WEI);
    const { v, terms } = await voucher(engine, chain, 'wd-late', p1.address, '8000');
    // Released too early (e.g. clock skew beyond the sweep margin): 8,000 back on the balance, the player bets part of it away.
    expect(engine.expireVoucher(v.voucherId, 'test: premature release')).toBe(true);
    expect(engine.balanceOf(p1.address)).toBe(10_000n);
    engine.ledger.post({ kind: 'stake', ref: 'test-spend', atMs: engine.nowMs, postings: [{ account: `player:${p1.address}`, delta: -5_000n }, { account: ACCOUNTS.equity, delta: 5_000n }] });
    const equityBefore = engine.equityOnchain();
    await chain.playerWithdraw(p1.role, terms);
    const w = engine.chainWithdrawals.get(`${p1.address}:${v.nonce}`)!;
    expect(w).toMatchObject({ outcome: 'claimed-after-release', voucherId: v.voucherId });
    expect(engine.balanceOf(p1.address)).toBe(0n);
    expect(engine.equityOnchain()).toBe(equityBefore - 3_000n);
    expect(engine.vouchers.get(v.voucherId)).toMatchObject({ status: 'claimed', claimNote: 'paid after expired' });
    expect(alerts.find(a => a.code === 'WITHDRAWAL_CLAIMED_AFTER_RELEASE')).toMatchObject({ level: 'critical' });
    const r = engine.reconcile(await chain.vaultState());
    // The ad-hoc test posting moved 5,000 between ledger accounts only; the vault view is still exact.
    expect(r).toMatchObject({ match: true, components: { anomalousWithdrawals: '1' } });
  });

  it('charges unmatched and mismatched redemptions (including sub-Centi amounts) conservatively and still reconciles to the wei', async () => {
    const { engine, chain, alerts, p1, p2 } = setup();
    await chain.playerDeposit(p1.role, 200n * WEI);
    await chain.playerDeposit(p2.role, 200n * WEI);
    const equity0 = engine.equityOnchain();
    // A voucher this ledger never issued (another run's, or a leaked signer key), with a sub-Centi amount.
    const nowS = BigInt(Math.floor(engine.nowMs / 1000));
    const foreign = { account: p2.address, amountWei: 3n * WEI + 5n, nonce: 42n, expiry: nowS + 600n };
    await chain.playerWithdraw(p2.role, { ...foreign, signature: await chain.signWithdrawal(foreign) });
    expect(engine.chainWithdrawals.get(`${p2.address}:42`)).toMatchObject({ outcome: 'unmatched' });
    expect(engine.equityOnchain()).toBe(equity0 - 301n); // ceil(3 OPEN + 5 wei) in Centi; the rounding stays as dust
    expect(engine.balanceOf(p2.address)).toBe(20_000n);
    // Same nonce as a live voucher but another amount: the voucher is spent, the excess charged to the house.
    const { v: big } = await voucher(engine, chain, 'wd-big', p1.address, '1000');
    const over = { account: p1.address, amountWei: 15n * WEI, nonce: BigInt(big.nonce), expiry: BigInt(big.expiry) };
    await chain.playerWithdraw(p1.role, { ...over, signature: await chain.signWithdrawal(over) });
    expect(engine.chainWithdrawals.get(`${p1.address}:${big.nonce}`)).toMatchObject({ outcome: 'amount-mismatch' });
    expect(engine.equityOnchain()).toBe(equity0 - 301n - 500n);
    // ...and a smaller one: the unpaid remainder returns to the player (the nonce can never pay again).
    const { v: small } = await voucher(engine, chain, 'wd-small', p1.address, '1000');
    const under = { account: p1.address, amountWei: 4n * WEI, nonce: BigInt(small.nonce), expiry: BigInt(small.expiry) };
    await chain.playerWithdraw(p1.role, { ...under, signature: await chain.signWithdrawal(under) });
    expect(engine.balanceOf(p1.address)).toBe(20_000n - 1000n - 1000n + 600n);
    expect(alerts.filter(a => a.level === 'critical').map(a => a.code)).toEqual(['WITHDRAWAL_UNMATCHED', 'WITHDRAWAL_AMOUNT_MISMATCH', 'WITHDRAWAL_AMOUNT_MISMATCH']);
    expect(engine.reconcile(await chain.vaultState())).toMatchObject({ match: true, deltaWei: '0', components: { anomalousWithdrawals: '3' } });
    expect(engine.invariants()).toMatchObject({ ledgerSumZero: true, negativeAccounts: [] });
  });

  it('rebuilds the same withdrawal state from the journal', async () => {
    const { engine, chain, journal, p1, p2 } = setup();
    await chain.playerDeposit(p1.role, 300n * WEI + 11n);
    await chain.playerDeposit(p2.role, 50n * WEI);
    const a = await voucher(engine, chain, 'wd-a', p1.address, '5000');
    await chain.playerWithdraw(p1.role, a.terms);
    const b = await voucher(engine, chain, 'wd-b', p1.address, '2500');
    engine.noteVoucherSubmitted(b.v.voucherId, '0x' + 'c'.repeat(64));
    const c = await voucher(engine, chain, 'wd-c', p2.address, '1000');
    engine.expireVoucher(c.v.voucherId, 'test expiry');
    const nowS = BigInt(Math.floor(engine.nowMs / 1000));
    const foreign = { account: p2.address, amountWei: WEI, nonce: 7n, expiry: nowS + 60n };
    await chain.playerWithdraw(p2.role, { ...foreign, signature: await chain.signWithdrawal(foreign) });
    const records = journal.records<EngineEvent>();
    for (const t of ['withdrawal', 'voucher-submitted', 'voucher-expired']) expect(records.map(r => r.type)).toContain(t);
    const rebuilt = makeEngine({ records, journal: new MemoryJournal() }).engine;
    const strip = (s: unknown) => { const { seq: _s, ...rest } = s as Record<string, unknown>; return rest; };
    expect(strip(rebuilt.stateSnapshot())).toEqual(strip(engine.stateSnapshot()));
    expect(rebuilt.reconcile(await chain.vaultState())).toMatchObject({ match: true });
    expect(rebuilt.voucherByNonce(p1.address, b.v.nonce)).toMatchObject({ voucherId: b.v.voucherId, status: 'pending', submittedTxHash: '0x' + 'c'.repeat(64) });
  });
});
