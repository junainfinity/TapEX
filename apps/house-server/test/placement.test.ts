import { describe, expect, it } from 'vitest';
import { payoutCenti } from '@maya/house';
import type { BetIntent } from '../src/engine/types.js';
import { ACCOUNTS } from '../src/ledger/ledger.js';
import { HISTORY, T0, deliver, makeEngine, offered, simPlayer, walk } from './helpers.js';

const FUTURE = walk({ t0: T0, seconds: 600, start: Number(HISTORY.get(T0 - 1)), sigma: 3e-5, seed: 11 });

function setup(options: Parameters<typeof makeEngine>[0] = {}) {
  const { engine, journal } = makeEngine(options);
  deliver(engine, 'btc-usd', T0, FUTURE.get(T0)!);
  const quotes = offered(engine);
  expect(quotes.length).toBeGreaterThan(10);
  const account = simPlayer(engine);
  return { engine, journal, quotes, account };
}
const intent = (account: string, q: { quoteId: string; cellId: string }, stakeCenti = '1000', requestId = `r-${Math.random().toString(36).slice(2)}`): BetIntent => ({ requestId, account, quoteId: q.quoteId, revision: 1, cellId: q.cellId, stakeCenti });

describe('placement', () => {
  it('accepts a bet on a stored quote with exact escrow, payout and liability', () => {
    const { engine, quotes, account } = setup();
    const q = quotes[0]!;
    const before = engine.balanceOf(account);
    const r = engine.placeBet(intent(account, q, '1234', 'req-1'));
    expect(r.status).toBe('accepted');
    if (r.status !== 'accepted') return;
    expect(r.newlyCommitted).toBe(true);
    expect(r.leg).toMatchObject({ status: 'open', stakeCenti: '1234', x100: q.x100, payoutCenti: payoutCenti('1234', q.x100), phase: 'launch', quoteId: q.quoteId, cell: q.cell });
    expect(BigInt(r.leg.liabilityCenti)).toBe(BigInt(r.leg.payoutCenti) - 1234n);
    expect(engine.balanceOf(account)).toBe(before - 1234n);
    expect(engine.ledger.balance(ACCOUNTS.escrowSim)).toBe(1234n);
    expect(engine.book.cellLiability(q.cellId)).toBe(BigInt(r.leg.liabilityCenti));
    expect(engine.ledger.sum()).toBe(0n);
    expect(Object.isFrozen(r.leg)).toBe(true);
  });

  it('is idempotent by requestId: same intent returns the original leg, a changed intent is REQUEST_CONFLICT', () => {
    const { engine, quotes, account } = setup();
    const first = engine.placeBet(intent(account, quotes[0]!, '500', 'dup-1'));
    const again = engine.placeBet(intent(account, quotes[0]!, '500', 'dup-1'));
    expect(first.status).toBe('accepted'); expect(again.status).toBe('accepted');
    if (first.status !== 'accepted' || again.status !== 'accepted') return;
    expect(again.newlyCommitted).toBe(false);
    expect(again.leg.legId).toBe(first.leg.legId);
    expect(engine.balanceOf(account)).toBe(1_000_000n - 500n);
    expect(engine.placeBet(intent(account, quotes[0]!, '501', 'dup-1'))).toMatchObject({ status: 'rejected', reason: 'REQUEST_CONFLICT' });
    expect(engine.placeBet(intent(account, quotes[1]!, '500', 'dup-1'))).toMatchObject({ status: 'rejected', reason: 'REQUEST_CONFLICT' });
    expect(engine.openLegCount).toBe(1);
    expect(engine.receiptFor('dup-1')).toMatchObject({ status: 'accepted', leg: { legId: first.leg.legId } });
  });

  it('stores rejections by requestId so a retry of the same intent gets the same answer', () => {
    const { engine, quotes, account } = setup();
    const r1 = engine.placeBet(intent(account, quotes[0]!, '5', 'small'));
    expect(r1).toMatchObject({ status: 'rejected', reason: 'STAKE_NOT_ALLOWED' });
    expect(engine.placeBet(intent(account, quotes[0]!, '5', 'small'))).toBe(r1);
    expect(engine.placeBet(intent(account, quotes[0]!, '50', 'small'))).toMatchObject({ reason: 'REQUEST_CONFLICT' });
  });

  it('rejects each failure with its typed reason', () => {
    const { engine, quotes, account } = setup({ limits: { maxStakePerBetCenti: '100000', maxStakePerCellCenti: '150000' } });
    const q = quotes.filter(x => x.window >= 2).reduce((a, b) => (b.x100 < a.x100 ? b : a));
    expect(q.x100).toBeLessThan(200);
    const rej = (i: Partial<BetIntent> & { requestId: string }) => engine.placeBet({ ...intent(account, q), ...i });
    expect(rej({ requestId: '' })).toMatchObject({ reason: 'INVALID_REQUEST' });
    expect(rej({ requestId: 'bad acct', account: 'nobody' })).toMatchObject({ reason: 'INVALID_REQUEST' });
    expect(rej({ requestId: 'unknown', account: 'sim:never-registered' })).toMatchObject({ reason: 'UNKNOWN_ACCOUNT' });
    expect(rej({ requestId: 'zero', stakeCenti: '0' })).toMatchObject({ reason: 'STAKE_NOT_ALLOWED' });
    expect(rej({ requestId: 'frac', stakeCenti: '1.5' })).toMatchObject({ reason: 'STAKE_NOT_ALLOWED' });
    expect(rej({ requestId: 'huge', stakeCenti: '100001' })).toMatchObject({ reason: 'STAKE_NOT_ALLOWED' });
    expect(rej({ requestId: 'noquote', quoteId: 'nope' })).toMatchObject({ reason: 'QUOTE_CHANGED' });
    expect(rej({ requestId: 'cellmismatch', cellId: quotes.find(x => x.cellId !== q.cellId)!.cellId })).toMatchObject({ reason: 'QUOTE_CHANGED' });
    expect(rej({ requestId: 'revision', revision: 2 })).toMatchObject({ reason: 'QUOTE_CHANGED' });
    const poor = simPlayer(engine, '100');
    expect(engine.placeBet({ ...intent(poor, q, '101'), requestId: 'poor' })).toMatchObject({ reason: 'INSUFFICIENT_BALANCE' });
    expect(rej({ requestId: 'cap-1', stakeCenti: '100000' }).status).toBe('accepted');
    expect(rej({ requestId: 'cap-2', stakeCenti: '60000' })).toMatchObject({ reason: 'CELL_CAP_EXCEEDED' });
    // Blocked accounts cannot bet.
    expect(engine.setPlayerFlag(account, 'block', { actor: 'admin', reason: 'test block reason' }).ok).toBe(true);
    expect(rej({ requestId: 'blocked' })).toMatchObject({ reason: 'ACCOUNT_BLOCKED' });
  });

  it('rejects expired quotes, late windows, stale feeds and paused markets', () => {
    const { engine, quotes, account } = setup();
    const near = quotes.reduce((a, b) => (b.validUntilMs < a.validUntilMs ? b : a));
    const far = quotes.find(q => q.window === 5)!;
    // Advance the clock past the near quote's expiry without new prices.
    engine.step(near.validUntilMs, []);
    expect(engine.placeBet(intent(account, near))).toMatchObject({ reason: 'QUOTE_EXPIRED' });
    // TOO_LATE: inside its TTL until 1 ms before the lead cut-off, then the square is too close.
    const late = makeEngine({ config: { quoteTtlMs: 60_000, freshnessMs: 60_000 } });
    deliver(late.engine, 'btc-usd', T0, FUTURE.get(T0)!);
    const lq = offered(late.engine).reduce((a, b) => (b.cell.startMs < a.cell.startMs ? b : a));
    expect(lq.validUntilMs).toBe(lq.cell.startMs - 3000);
    const who = simPlayer(late.engine);
    late.engine.step(lq.validUntilMs - 1, []);
    expect(late.engine.placeBet(intent(who, lq)).status).toBe('accepted');
    late.engine.step(lq.validUntilMs + 1, []);
    expect(late.engine.placeBet(intent(who, lq))).toMatchObject({ status: 'rejected', reason: 'TOO_LATE' });
    // Stale feed: 8 s without a price trips feedStale; acceptance fails closed.
    const s2 = setup();
    s2.engine.step(T0 * 1000 + 8_600, []);
    expect(s2.engine.placeBet(intent(s2.account, s2.quotes.find(q => q.window === 5)!))).toMatchObject({ reason: 'QUOTE_EXPIRED' });
    const s3 = setup({ config: { quoteTtlMs: 60_000, freshnessMs: 60_000 } });
    s3.engine.step(T0 * 1000 + 8_600, []);
    expect(s3.engine.placeBet(intent(s3.account, s3.quotes.find(q => q.window === 5)!))).toMatchObject({ reason: 'INPUT_NOT_READY' });
    // Paused market.
    expect(engine.pauseMarket('btc-usd', { actor: 'admin', reason: 'maintenance window' }).ok).toBe(true);
    expect(engine.placeBet(intent(account, far))).toMatchObject({ reason: 'MARKET_PAUSED' });
  });

  it('price-move guard rejects a quote once the observed price moved beyond guardSigma·sigma·spot·√age', () => {
    const { engine, quotes, account } = setup({ config: { quoteTtlMs: 5000 } });
    const q = quotes.find(x => x.window >= 3)!;
    const spot = Number(q.spotText);
    const jump = (spot * (1 + 10 * q.sigma)).toFixed(2); // 10σ in one second
    deliver(engine, 'btc-usd', T0 + 1, jump, T0 * 1000 + 900);
    expect(engine.placeBet(intent(account, q))).toMatchObject({ reason: 'PRICE_MOVED' });
    const small = setup({ config: { quoteTtlMs: 5000 } });
    const q2 = small.quotes.find(x => x.window >= 3)!;
    deliver(small.engine, 'btc-usd', T0 + 1, (Number(q2.spotText) * (1 + 0.5 * q2.sigma)).toFixed(2), T0 * 1000 + 900);
    expect(small.engine.placeBet(intent(small.account, q2)).status).toBe('accepted');
  });

  it('enforces cell, column, account and global liability limits under a burst and never exceeds them', () => {
    // Bankroll 1,000,000 Centi: cell 1,000, column 5,000, account 2,000, global 20,000 Centi of liability.
    const { engine, quotes } = setup({ bankrollCenti: '1000000', limits: { maxStakePerBetCenti: '100000000', maxStakePerCellCenti: '100000000' } });
    const players = Array.from({ length: 40 }, () => simPlayer(engine, '10000000'));
    const seen = new Set<string>();
    let accepted = 0;
    for (let i = 0; i < 2000; i++) {
      const q = quotes[i % quotes.length]!;
      const r = engine.placeBet(intent(players[i % players.length]!, q, String(50 + (i % 7) * 37), `burst-${i}`));
      if (r.status === 'accepted') accepted++; else { expect(r.reason).toBe('LIABILITY_LIMIT'); seen.add(r.limit!); }
      const a = engine.limitAmounts();
      expect(engine.book.globalLiability()).toBeLessThanOrEqual(a.global);
      for (const qq of quotes) expect(engine.book.cellLiability(qq.cellId)).toBeLessThanOrEqual(a.cell);
      expect(engine.equity() - engine.book.globalLiability()).toBeGreaterThanOrEqual(0n);
    }
    expect(accepted).toBeGreaterThan(20);
    expect([...seen].sort()).toEqual(expect.arrayContaining(['cell']));
    expect(engine.invariants()).toMatchObject({ ledgerSumZero: true, negativeAccounts: [], escrowMatchesOpenStakes: true, solvencyViolations: 0, simIdentity: true });
  });

  it('keeps on-chain legs within the real bankroll even when sim results inflate equity', () => {
    const { engine, quotes } = setup({ bankrollCenti: '1000', limits: { cellFraction: 1, columnFraction: 1, globalFraction: 1, accountFraction: 1 } });
    // Sim players lost 10,000,000 Centi to the house: E grows, the on-chain bankroll does not.
    engine.ledger.post({ kind: 'loss', ref: 'seed', atMs: 0, postings: [{ account: ACCOUNTS.simCredit, delta: -10_000_000n }, { account: ACCOUNTS.simPnl, delta: 10_000_000n }] });
    const address = '0x' + '1'.repeat(40);
    engine.creditDeposit({ player: address, amountWei: 10n ** 22n, depositId: 1n, txHash: '0x' + 'a'.repeat(64), logIndex: 0, blockNumber: 5n });
    const q = quotes.find(x => x.x100 >= 300)!;
    const r = engine.placeBet(intent(address, q, '100000', 'onchain-big'));
    expect(r).toMatchObject({ status: 'rejected', reason: 'LIABILITY_LIMIT', limit: 'global' });
    const sim = simPlayer(engine, '1000000');
    expect(engine.placeBet(intent(sim, q, '100000', 'sim-big')).status).toBe('accepted');
  });
});
