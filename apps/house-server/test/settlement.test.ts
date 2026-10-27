import { describe, expect, it } from 'vitest';
import { OBSERVED_PATH_POLICY, OBSERVED_PATH_RULE_VERSION, createCell, observedSampleId, parseDecimal, sampleTouchesCell, segmentTouchesCell, type CellTerms } from '@maya/contracts';
import { getMarket } from '@maya/config';
import { resolveCell, type CellOutcome } from '../src/engine/settlement.js';
import { PathStore } from '../src/market/path-store.js';
import { ACCOUNTS } from '../src/ledger/ledger.js';
import { HISTORY, T0, deliver, makeEngine, offered, rng, simPlayer, walk } from './helpers.js';

const feedId = getMarket('btc-usd').feedId;

/** Independent transcription of packages/engine settleObservedPosition over a sorted sample list. */
function reference(cell: CellTerms, samples: readonly { t: number; price: string }[], nowMs: number): CellOutcome | undefined {
  const list = samples.map(s => ({ marketId: 'btc-usd' as const, sourceTimeMs: s.t * 1000, price: parseDecimal(s.price), sampleId: observedSampleId({ feedId, sourceTimeMs: s.t * 1000 }) }))
    .filter(s => s.sourceTimeMs <= nowMs).sort((a, b) => a.sourceTimeMs - b.sourceTimeMs);
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    if (a.sourceTimeMs >= cell.endMs) break;
    if (sampleTouchesCell(a, cell)) return { status: 'won', evidenceSampleIds: [a.sampleId], touchTimeMs: a.sourceTimeMs, reason: '' };
    const b = list[i + 1];
    if (!b || b.sourceTimeMs - a.sourceTimeMs !== 1000) continue;
    const hit = segmentTouchesCell(a, b, cell, 1000);
    if (hit) return { status: 'won', evidenceSampleIds: [a.sampleId, b.sampleId], touchTimeMs: hit.firstTouchTimeMs, reason: '' };
  }
  if (nowMs < cell.endMs) return undefined;
  const evidence = list.filter(s => s.sourceTimeMs >= cell.startMs && s.sourceTimeMs <= cell.endMs);
  const times = new Set(evidence.map(s => s.sourceTimeMs));
  let complete = true;
  for (let t = cell.startMs; t <= cell.endMs; t += 1000) if (!times.has(t)) complete = false;
  if (complete && nowMs >= cell.endMs + OBSERVED_PATH_POLICY.lateArrivalGraceMs) return { status: 'lost', evidenceSampleIds: evidence.map(s => s.sampleId), reason: '' };
  if (nowMs >= cell.endMs + OBSERVED_PATH_POLICY.recoveryDeadlineMs) return { status: 'refunded', evidenceSampleIds: evidence.map(s => s.sampleId), reason: '' };
  return undefined;
}

function cellAt(startS: number, lowerBand: number): CellTerms {
  const h = getMarket('btc-usd').bandHeight;
  return createCell('btc-usd', startS * 1000, { coefficient: (BigInt(h.coefficient) * BigInt(lowerBand)).toString(), exponent: h.exponent }, { coefficient: (BigInt(h.coefficient) * BigInt(lowerBand + 1)).toString(), exponent: h.exponent }, OBSERVED_PATH_RULE_VERSION);
}
const strip = (o: CellOutcome | undefined) => o && { status: o.status, evidenceSampleIds: o.evidenceSampleIds, ...(o.status === 'won' ? { touchTimeMs: o.touchTimeMs } : {}) };

describe('settlement parity with @maya/contracts', () => {
  it('matches the reference on 6,000 random cells with gaps, flats, edge touches and every clock phase', () => {
    const random = rng(99);
    let won = 0, lost = 0, refunded = 0, pending = 0, edge = 0;
    for (let trial = 0; trial < 60; trial++) {
      const t0 = 1_790_000_000 + trial * 1000;
      const raw: { t: number; price: string }[] = [];
      let p = 60_000 + random() * 1000;
      for (let i = 0; i < 120; i++) {
        const t = t0 + i;
        const r = random();
        if (r < 0.04) continue; // gap
        if (r < 0.10) { /* flat second */ } else p += (random() - 0.5) * 12;
        // Sometimes land exactly on a band edge.
        const text = random() < 0.08 ? (Math.round(p / 10) * 10).toFixed(2) : p.toFixed(2);
        if (text.endsWith('0.00')) edge++;
        raw.push({ t, price: text });
      }
      const store = new PathStore('btc-usd');
      for (const s of raw) store.pin({ t: s.t, priceText: s.price, price: parseDecimal(s.price), value: Number(s.price), receivedAtMs: s.t * 1000 });
      for (let k = 0; k < 100; k++) {
        const start = Math.ceil((t0 + 5 + Math.floor(random() * 100)) / 5) * 5;
        const base = Math.floor(Number(raw[Math.floor(random() * raw.length)]!.price) / 10) + Math.floor(random() * 5) - 2;
        const cell = cellAt(start, base);
        const nowMs = cell.endMs + Math.floor(random() * 40_000) - 8_000;
        const expected = reference(cell, raw, nowMs);
        const actual = resolveCell(cell, store, { nowMs, uncertaintyMs: 0 });
        expect(strip(actual)).toEqual(strip(expected));
        if (!actual) pending++; else if (actual.status === 'won') won++; else if (actual.status === 'lost') lost++; else refunded++;
      }
    }
    expect(won).toBeGreaterThan(300); expect(lost).toBeGreaterThan(300); expect(refunded).toBeGreaterThan(20); expect(pending).toBeGreaterThan(50); expect(edge).toBeGreaterThan(50);
  });

  it('treats the band inclusively and the window half-open', () => {
    const store = new PathStore('btc-usd');
    const pin = (t: number, price: string) => store.pin({ t, priceText: price, price: parseDecimal(price), value: Number(price), receivedAtMs: t * 1000 });
    const start = 1_790_000_100;
    for (let i = -2; i <= 6; i++) pin(start + i, '60005.00');
    const touchUpper = cellAt(start, 5999); // [59990, 60000]
    expect(resolveCell(touchUpper, store, { nowMs: (start + 7) * 1000, uncertaintyMs: 0 })?.status).toBe('lost');
    const store2 = new PathStore('btc-usd');
    const pin2 = (t: number, price: string) => store2.pin({ t, priceText: price, price: parseDecimal(price), value: Number(price), receivedAtMs: t * 1000 });
    for (let i = -2; i <= 6; i++) pin2(start + i, i === 5 ? '60000.00' : '60005.00');
    // Exactly at the upper edge, but at t = end: outside [start, end).
    expect(resolveCell(touchUpper, store2, { nowMs: (start + 7) * 1000, uncertaintyMs: 0 })?.status).toBe('lost');
    const store3 = new PathStore('btc-usd');
    for (let i = -2; i <= 6; i++) store3.pin({ t: start + i, priceText: i === 4 ? '60000.00' : '60005.00', price: parseDecimal(i === 4 ? '60000.00' : '60005.00'), value: 0 + (i === 4 ? 60000 : 60005), receivedAtMs: 0 });
    expect(resolveCell(touchUpper, store3, { nowMs: (start + 4) * 1000, uncertaintyMs: 0 })).toMatchObject({ status: 'won', touchTimeMs: (start + 4) * 1000 });
  });
});

describe('engine settlement', () => {
  it('settles won, lost and refunded legs with exact credits and releases liability', () => {
    const { engine } = makeEngine();
    const p0 = HISTORY.get(T0 - 1)!;
    deliver(engine, 'btc-usd', T0, p0);
    const quotes = offered(engine);
    const account = simPlayer(engine, '10000000');
    const centre = quotes.find(q => q.bandOffset === 0 && q.window === 2)!;
    const far = quotes.find(q => q.bandOffset === 3 && q.window === 2)!;
    const later = quotes.find(q => Math.abs(q.bandOffset) >= 1 && q.window === 4)!;
    const bet = (q: typeof centre, id: string) => { const r = engine.placeBet({ requestId: id, account, quoteId: q.quoteId, revision: 1, cellId: q.cellId, stakeCenti: '1000' }); if (r.status !== 'accepted') throw new Error(r.reason); return r.leg; };
    const legWin = bet(centre, 'win'), legLose = bet(far, 'lose'), legRefund = bet(later, 'refund');
    const balanceAfterStakes = engine.balanceOf(account);
    // Flat path at spot keeps the centre band touched and the far band missed; a gap covers the later window.
    const gapFrom = later.cell.startMs / 1000 + 1;
    for (let t = T0 + 1; t <= later.cell.endMs / 1000 + 40; t++) {
      if (t >= gapFrom && t < gapFrom + 2) engine.step(t * 1000 + 500, []);
      else deliver(engine, 'btc-usd', t, p0);
    }
    const won = engine.legView(legWin.legId)!, lost = engine.legView(legLose.legId)!, refunded = engine.legView(legRefund.legId)!;
    expect(won.status).toBe('won'); expect(lost.status).toBe('lost'); expect(refunded.status).toBe('refunded');
    expect(won.settlement!.creditCenti).toBe(legWin.payoutCenti);
    expect(lost.settlement!.creditCenti).toBe('0');
    expect(refunded.settlement!.creditCenti).toBe('1000');
    expect(engine.balanceOf(account)).toBe(balanceAfterStakes + BigInt(legWin.payoutCenti) + 1000n);
    expect(engine.book.globalLiability()).toBe(0n);
    expect(engine.ledger.balance(ACCOUNTS.escrowSim)).toBe(0n);
    expect(engine.simPnl()).toBe(1000n - (BigInt(legWin.payoutCenti) - 1000n));
    // A won leg is final: later evidence never re-credits.
    engine.step(engine.nowMs + 60_000, []);
    expect(engine.balanceOf(account)).toBe(balanceAfterStakes + BigInt(legWin.payoutCenti) + 1000n);
    expect(engine.invariants()).toMatchObject({ ledgerSumZero: true, escrowMatchesOpenStakes: true, simIdentity: true });
  });

  it('settles a win as soon as the touch is observed, before the window ends', () => {
    const { engine } = makeEngine();
    const future = walk({ t0: T0, seconds: 60, start: Number(HISTORY.get(T0 - 1)), sigma: 3e-5, seed: 5 });
    deliver(engine, 'btc-usd', T0, future.get(T0)!);
    const q = offered(engine).find(x => x.bandOffset === 0 && x.window === 1)!;
    const account = simPlayer(engine);
    const r = engine.placeBet({ requestId: 'early', account, quoteId: q.quoteId, revision: 1, cellId: q.cellId, stakeCenti: '100' });
    expect(r.status).toBe('accepted');
    const inside = (Number(q.cell.lowerPrice.coefficient) * 10 ** q.cell.lowerPrice.exponent + 5).toFixed(2);
    for (let t = T0 + 1; t < q.cell.startMs / 1000; t++) deliver(engine, 'btc-usd', t, future.get(t)!);
    deliver(engine, 'btc-usd', q.cell.startMs / 1000, inside);
    expect(engine.legView((r as { leg: { legId: string } }).leg.legId)).toMatchObject({ status: 'won', settlement: { touchTimeMs: expect.any(Number) } });
    expect(engine.nowMs).toBeLessThan(q.cell.endMs);
  });
});
