// MC-2 / MC-3 / CC-06 / CC-15: house treasury flows under latency and unknown outcomes.
//  - withdraw-surplus reserves its amount before the first await, so bets accepted during the pre-withdrawal
//    attestation are checked against the equity that remains (SPEC §1 invariant 6);
//  - a treasury transaction with an unknown outcome (ChainError TX_TIMEOUT) answers 504 CHAIN_OUTCOME_UNKNOWN,
//    is audited `unknown: …`, stays pending (a withdrawal stays reserved) and is booked from the vault's house
//    counters once mined, or released by an admin only when the vault shows it never was;
//  - a failed operator balance read is reported as unavailable, not as zeros.
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { ChainError } from '../src/chain/errors.js';
import type { EngineEvent } from '../src/engine/types.js';
import { MemoryJournal } from '../src/ledger/journal.js';
import { OfflineChainError } from '../src/offline-chain.js';
import type { HouseQuote } from '../src/quotes/quote-book.js';
import { admin, startTestApp, type TestApp } from './app-helpers.js';
import { tempDir } from './helpers.js';

const E18 = 10n ** 18n;
const CENTI = 10n ** 16n;
const meta = { actor: 'admin', reason: 'treasury safety regression test', confirm: 'withdraw-surplus' };
const TX = '0x' + 'ab'.repeat(32);

const open: TestApp[] = [];
afterEach(async () => { for (const t of open.splice(0)) await t.close().catch(() => undefined); });

function onchainOpenLiability(app: TestApp['app']): bigint {
  let s = 0n; for (const l of app.engine.openLegsList()) if (l.kind === 'onchain') s += BigInt(l.liabilityCenti); return s;
}

/** The offered quote that lets `balance` carry the largest liability (stake a multiple of 10 Centi). */
function bestQuote(app: TestApp['app'], balance: bigint, maxLiability?: bigint): { quote: HouseQuote; stake: bigint; liability: bigint } {
  let best: { quote: HouseQuote; stake: bigint; liability: bigint } | undefined;
  for (const q of app.engine.latestGrid('btc-usd')?.quotes ?? []) {
    if (!q || !app.engine.quoteStands(q)) continue;
    let stake = BigInt(q.maxStakeCenti); if (stake > balance) stake = balance; if (stake > 1_000_000n) stake = 1_000_000n;
    stake = stake / 10n * 10n;
    let liability = (stake * BigInt(q.x100)) / 100n - stake;
    if (maxLiability !== undefined && liability > maxLiability) { stake = (maxLiability * 100n / BigInt(q.x100 - 100)) / 10n * 10n; liability = (stake * BigInt(q.x100)) / 100n - stake; }
    if (stake < 10n) continue;
    if (!best || liability > best.liability) best = { quote: q, stake, liability };
  }
  if (!best) throw new Error('no quote offered');
  return best;
}

/** Hold the chain's attest call until released (a live chain waits seconds for the receipt). */
function gateAttest(t: TestApp): { entered: Promise<void>; release: () => void } {
  const real = t.chain.attest.bind(t.chain);
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let entered!: () => void; const inAttest = new Promise<void>(r => { entered = r; });
  (t.chain as { attest: typeof t.chain.attest }).attest = async a => { entered(); await gate; return real(a); };
  return { entered: inAttest, release };
}

describe('withdraw-surplus vs. bets accepted while the pre-withdrawal attestation is in flight (MC-2)', () => {
  it('reserves the amount first: a bet the remaining equity cannot cover is refused, and vault assets still cover every open max payout', async () => {
    const t = await startTestApp({ bootId: 'ts1' }); open.push(t);
    const { app, chain } = t; const e = app.engine;
    const player = chain.players()[0]!;
    const account = player.address.toLowerCase();
    await chain.playerDeposit(player.role, 1_000n * E18);
    t.advance(3);
    const amount = e.equityOnchain() - onchainOpenLiability(app) - 10_000n; // leave 100 tOPEN of free equity
    const gate = gateAttest(t);
    const pending = app.withdrawSurplus(amount.toString(), meta);
    await gate.entered;
    // During the attestation (seconds on a live chain) a player bets more than the equity that will remain.
    const big = bestQuote(app, e.balanceOf(account));
    expect(big.liability).toBeGreaterThan(10_000n);
    const refused = e.placeBet({ requestId: 'race-big', account, quoteId: big.quote.quoteId, revision: big.quote.revision, cellId: big.quote.cellId, stakeCenti: big.stake.toString() });
    expect(refused).toMatchObject({ status: 'rejected', reason: 'LIABILITY_LIMIT' });
    // It is refused because the reservation is journaled and the risk engine sees only what will remain.
    expect(e.pendingTreasury).toMatchObject({ action: 'withdraw-surplus', amountCenti: amount.toString(), state: 'sending' });
    expect(e.freeOnchainEquity()).toBe(10_000n);
    gate.release();
    const result = await pending;
    expect(result).toMatchObject({ ok: true, action: 'treasury-withdraw-surplus' });
    expect(e.pendingTreasury).toBeUndefined();

    const vault = await chain.vaultState();
    const snap = e.attestationSnapshot();
    expect(e.equityOnchain()).toBeGreaterThanOrEqual(onchainOpenLiability(app));
    expect(vault.assetsWei).toBeGreaterThanOrEqual(snap.liabilitiesWei);
    expect(e.invariants()).toMatchObject({ equityNonNegative: true, solvencyViolations: 0, ledgerSumZero: true });
    expect(e.reconcile(vault).match).toBe(true);
  });

  it('keeps accepting bets sized to the equity that remains while a withdrawal is pending', async () => {
    const t = await startTestApp({ bootId: 'ts1b' }); open.push(t);
    const { app, chain } = t; const e = app.engine;
    const player = chain.players()[0]!;
    const account = player.address.toLowerCase();
    await chain.playerDeposit(player.role, 1_000n * E18);
    t.advance(3);
    const half = (e.equityOnchain() - onchainOpenLiability(app)) / 2n;
    const gate = gateAttest(t);
    const pending = app.withdrawSurplus(half.toString(), meta);
    await gate.entered;
    t.advance(1); // the next grid advertises stakes against the reserved equity
    expect(e.limitAmounts().cell).toBeLessThan(e.equity() / 1000n);
    const pick = bestQuote(app, e.balanceOf(account));
    const r = e.placeBet({ requestId: 'half-1', account, quoteId: pick.quote.quoteId, revision: pick.quote.revision, cellId: pick.quote.cellId, stakeCenti: pick.stake.toString() });
    expect(r.status).toBe('accepted');
    gate.release();
    expect(await pending).toMatchObject({ ok: true });
    expect(e.invariants()).toMatchObject({ equityNonNegative: true, solvencyViolations: 0 });
    expect(e.equityOnchain()).toBeGreaterThanOrEqual(onchainOpenLiability(app));
  });

  it('releases the reservation when the withdrawal is refused (vault buffer), so equity is not held back', async () => {
    const t = await startTestApp({ bootId: 'ts2' }); open.push(t);
    const { app, chain } = t; const e = app.engine;
    const player = chain.players()[0]!;
    await chain.playerDeposit(player.role, 1_000n * E18);
    t.advance(2);
    const free = e.equityOnchain() - onchainOpenLiability(app);
    // Free equity covers it, but the vault keeps a 10 % buffer on player obligations.
    const r = await app.withdrawSurplus(free.toString(), meta);
    expect(r).toMatchObject({ ok: false, code: 'EXCEEDS_HOUSE_WITHDRAWABLE' });
    const released = t.journal.records<EngineEvent>().filter(x => x.type === 'treasury-released');
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ reason: 'refused: exceeds the vault house withdrawable' });
    expect(e.pendingTreasury).toBeUndefined();
    expect(e.freeOnchainEquity()).toBe(free);
    expect(e.riskEquity()).toBe(e.equity());
  });
});

describe('treasury transactions with an unknown outcome (MC-3, CC-06)', () => {
  it('a surplus withdrawal mined after a receipt timeout: 504 CHAIN_OUTCOME_UNKNOWN, reserved meanwhile, booked from vault state, reconciled', async () => {
    const t = await startTestApp({ bootId: 'ts3' }); open.push(t);
    const { app, chain } = t; const e = app.engine;
    t.advance(2);
    const real = chain.withdrawHouse.bind(chain);
    (chain as { withdrawHouse: typeof chain.withdrawHouse }).withdrawHouse = async (amountWei, to) => {
      const tx = await real(amountWei, to); // mined ...
      throw new ChainError('TX_TIMEOUT', `No receipt for ${tx.txHash} within 120000 ms (outcome unknown; it may still be mined)`, { txHash: tx.txHash }); // ... receipt timed out
    };
    const equityBefore = e.equityOnchain();
    const r = await admin(t, 'POST', '/treasury/withdraw-surplus', { amountCenti: '1000000', reason: 'withdraw surplus under a congested RPC', confirm: 'withdraw-surplus' });
    expect(r.status).toBe(504);
    expect(r.body.error).toMatchObject({ code: 'CHAIN_OUTCOME_UNKNOWN', opId: 'T1', txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    const audit = e.auditLog(5).find(a => a.action === 'treasury-withdraw-surplus')!;
    expect(audit.result).toMatch(/^unknown: /);
    expect(audit.txHash).toBe(r.body.error.txHash);
    // Unknown, not failed: the amount stays reserved against equity for acceptance and solvency checks.
    expect(e.pendingTreasury).toMatchObject({ opId: 'T1', state: 'unknown', txHash: r.body.error.txHash });
    expect(e.equityOnchain()).toBe(equityBefore);
    expect(e.riskEquity()).toBe(e.equity() - 1_000_000n);
    // A new treasury action first resolves it from vault state, and books the mined withdrawal.
    await app.checkChainHealth();
    expect(e.pendingTreasury).toBeUndefined();
    expect(e.equityOnchain()).toBe(equityBefore - 1_000_000n);
    const vault = await chain.vaultState();
    expect(vault.houseWithdrawnWei).toBe(1_000_000n * CENTI);
    expect(e.reconcile(vault).match).toBe(true);
    const booked = t.journal.records<EngineEvent>().filter(x => x.type === 'treasury' && x.action === 'withdraw-surplus');
    expect(booked).toEqual([expect.objectContaining({ opId: 'T1', resolution: 'vault-state', txHash: r.body.error.txHash })]);
    expect(e.auditLog(10).find(a => a.actor === 'treasury-resolver')).toMatchObject({ action: 'treasury-withdraw-surplus', result: 'ok', txHash: r.body.error.txHash });
    // A retry is no longer blocked and books exactly what the vault pays.
    (chain as { withdrawHouse: typeof chain.withdrawHouse }).withdrawHouse = real;
    const again = await app.withdrawSurplus('1000', meta);
    expect(again).toMatchObject({ ok: true });
    expect(e.reconcile(await chain.vaultState()).match).toBe(true);
  });

  it('a house funding with a timed-out receipt is not credited until the vault shows it, then booked exactly once', async () => {
    const t = await startTestApp({ bootId: 'ts4' }); open.push(t);
    const { app, chain } = t; const e = app.engine;
    const real = chain.fundHouse.bind(chain);
    (chain as { fundHouse: typeof chain.fundHouse }).fundHouse = async amountWei => { const tx = await real(amountWei); throw new ChainError('TX_TIMEOUT', 'no receipt (outcome unknown; it may still be mined)', { txHash: tx.txHash }); };
    const before = e.equityOnchain();
    const r = await app.fundHouse('500000', { actor: 'admin', reason: 'top up the bankroll' });
    expect(r).toMatchObject({ ok: false, status: 504, code: 'CHAIN_OUTCOME_UNKNOWN', opId: 'T1' });
    expect(e.equityOnchain()).toBe(before);
    expect(e.riskEquity()).toBe(e.equity()); // a funding reserves nothing
    // Another treasury action waits for the outcome; resolving it books the funding.
    (chain as { fundHouse: typeof chain.fundHouse }).fundHouse = real;
    const next = await app.fundHouse('100', { actor: 'admin', reason: 'second top up of the bankroll' });
    expect(next).toMatchObject({ ok: true });
    expect(e.equityOnchain()).toBe(before + 500_000n + 100n);
    expect(t.journal.records<EngineEvent>().filter(x => x.type === 'treasury' && x.action === 'fund').map(x => (x as { resolution?: string }).resolution)).toEqual(['vault-state', 'receipt']);
    expect(e.reconcile(await chain.vaultState()).match).toBe(true);
  });

  it('a funding that never reached the chain blocks further treasury actions until an admin releases it; release is refused once mined', async () => {
    const t = await startTestApp({ bootId: 'ts5' }); open.push(t);
    const { app, chain } = t; const e = app.engine;
    const real = chain.fundHouse.bind(chain);
    (chain as { fundHouse: typeof chain.fundHouse }).fundHouse = async () => { throw new ChainError('TX_TIMEOUT', 'no receipt (outcome unknown; it may still be mined)', { txHash: TX }); };
    const r = await admin(t, 'POST', '/treasury/fund', { amountCenti: '500000', reason: 'top up the bankroll' });
    expect(r.status).toBe(504);
    (chain as { fundHouse: typeof chain.fundHouse }).fundHouse = real;
    const blocked = await admin(t, 'POST', '/treasury/withdraw-surplus', { amountCenti: '1000', reason: 'withdraw while funding pending', confirm: 'withdraw-surplus' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'TREASURY_OUTCOME_PENDING', opId: 'T1', txHash: TX });
    const chainView = await admin(t, 'GET', '/chain');
    expect(chainView.body.treasury.pending).toMatchObject({ opId: 'T1', action: 'fund', state: 'unknown', txHash: TX, reservedCenti: '0' });
    await app.checkChainHealth();
    expect(app.chainAlertsNow.find(a => a.code === 'TREASURY_OUTCOME_UNKNOWN')).toMatchObject({ level: 'warning' });
    expect(app.chainAlertsNow.map(a => a.code)).not.toContain('LEDGER_VAULT_MISMATCH');
    expect(await admin(t, 'POST', '/treasury/release-pending', { opId: 'T1', reason: 'the explorer shows the tx was dropped' })).toMatchObject({ status: 400, body: { error: { code: 'CONFIRM_REQUIRED' } } });
    const released = await admin(t, 'POST', '/treasury/release-pending', { opId: 'T1', reason: 'the explorer shows the tx was dropped', confirm: 'treasury-release' });
    expect(released).toMatchObject({ status: 200, body: { ok: true, action: 'treasury-release', opId: 'T1' } });
    expect(e.pendingTreasury).toBeUndefined();
    expect((await admin(t, 'POST', '/treasury/fund', { amountCenti: '100', reason: 'top up after the release' })).status).toBe(200);

    // A mined operation cannot be released: the vault's counters book it instead.
    (chain as { fundHouse: typeof chain.fundHouse }).fundHouse = async amountWei => { const tx = await real(amountWei); throw new ChainError('TX_TIMEOUT', 'no receipt', { txHash: tx.txHash }); };
    expect((await admin(t, 'POST', '/treasury/fund', { amountCenti: '700', reason: 'top up under a congested RPC' })).status).toBe(504);
    const refused = await admin(t, 'POST', '/treasury/release-pending', { opId: 'T3', reason: 'operator thinks it was dropped', confirm: 'treasury-release' });
    expect(refused).toMatchObject({ status: 409, body: { error: { code: 'TREASURY_ALREADY_MINED' } } });
    expect(e.pendingTreasury).toBeUndefined();
    expect(e.reconcile(await chain.vaultState()).match).toBe(true);
  });

  it('a definite failure releases the reservation and answers 502 CHAIN_ERROR audited as failed', async () => {
    const t = await startTestApp({ bootId: 'ts6' }); open.push(t);
    const { app, chain } = t; const e = app.engine;
    t.advance(2);
    (chain as { withdrawHouse: typeof chain.withdrawHouse }).withdrawHouse = async () => { throw new OfflineChainError('EnforcedPause', 'vault paused'); };
    const r = await app.withdrawSurplus('1000', meta);
    expect(r).toMatchObject({ ok: false, status: 502, code: 'CHAIN_ERROR', opId: 'T1' });
    expect(e.pendingTreasury).toBeUndefined();
    expect(e.riskEquity()).toBe(e.equity());
    expect(e.auditLog(5).find(a => a.action === 'treasury-withdraw-surplus')!.result).toMatch(/^failed: /);
  });

  it('a pending withdrawal survives a restart (journaled reservation) and is booked from the persisted vault afterwards', async () => {
    const statePath = join(tempDir('treasury-restart-'), 'offline-chain.json');
    const journal = new MemoryJournal();
    const a = await startTestApp({ chain: { statePath }, journal, bootId: 'ts7' }); open.push(a);
    a.advance(2);
    const real = a.chain.withdrawHouse.bind(a.chain);
    (a.chain as { withdrawHouse: typeof a.chain.withdrawHouse }).withdrawHouse = async (w, to) => { const tx = await real(w, to); throw new ChainError('TX_TIMEOUT', 'no receipt', { txHash: tx.txHash }); };
    expect(await a.app.withdrawSurplus('2000000', meta)).toMatchObject({ ok: false, code: 'CHAIN_OUTCOME_UNKNOWN' });
    const reserved = a.app.engine.riskEquity();
    await a.close(); open.length = 0;
    const b = await startTestApp({ chain: { statePath }, records: journal.records<EngineEvent>(), bootId: 'ts8' }); open.push(b);
    expect(b.app.engine.pendingTreasury).toMatchObject({ opId: 'T1', state: 'unknown', amountCenti: '2000000' });
    expect(b.app.engine.riskEquity()).toBe(reserved);
    await b.app.checkChainHealth();
    expect(b.app.engine.pendingTreasury).toBeUndefined();
    expect(b.app.engine.reconcile(await b.chain.vaultState()).match).toBe(true);
  });

  it('other chain actions with an unknown outcome also answer 504 and are audited as unknown (vault pause)', async () => {
    const t = await startTestApp({ bootId: 'ts9' }); open.push(t);
    (t.chain as { pauseVault: typeof t.chain.pauseVault }).pauseVault = async () => { throw new ChainError('TX_TIMEOUT', 'no receipt (outcome unknown; it may still be mined)', { txHash: TX }); };
    const r = await admin(t, 'POST', '/vault/pause', { reason: 'incident: pause the vault', confirm: 'vault-pause' });
    expect(r.status).toBe(504);
    expect(r.body.error).toMatchObject({ code: 'CHAIN_OUTCOME_UNKNOWN', txHash: TX });
    expect(t.app.engine.auditLog(3).find(a => a.action === 'vault-pause')).toMatchObject({ result: expect.stringMatching(/^unknown: /), txHash: TX });
    (t.chain as { pauseVault: typeof t.chain.pauseVault }).pauseVault = async () => { throw new ChainError('RPC_UNAVAILABLE', 'rpc down'); };
    const failed = await admin(t, 'POST', '/vault/pause', { reason: 'incident: pause the vault again', confirm: 'vault-pause' });
    expect(failed).toMatchObject({ status: 502, body: { error: { code: 'CHAIN_ERROR' } } });
    expect(t.app.engine.auditLog(3).find(a => a.action === 'vault-pause')!.result).toMatch(/^failed: /);
  });
});

describe('operator balances in /admin-api/chain (CC-15)', () => {
  it('reports a failed balance read as unavailable, never as 0 ETH / 0 tOPEN', async () => {
    const t = await startTestApp({ bootId: 'ts10' }); open.push(t);
    const ok = await admin(t, 'GET', '/chain');
    expect(ok.body.operator).toMatchObject({ ethWei: expect.stringMatching(/^\d+$/), tokenCenti: expect.stringMatching(/^\d+$/) });
    expect(ok.body.operator.unavailable).toBeUndefined();
    (t.chain as { balances: typeof t.chain.balances }).balances = async () => { throw new Error('RPC blip'); };
    const down = await admin(t, 'GET', '/chain');
    expect(down.status).toBe(200);
    expect(down.body.operator).toEqual({ address: ok.body.operator.address, ethWei: null, tokenCenti: null, unavailable: true, error: 'RPC blip' });
  });
});
