import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCell, multiplyDecimalInteger, OBSERVED_PATH_RULE_VERSION, type QuoteSnapshot } from '@maya/contracts';
import { getMarket } from '@maya/config';
import { centiToWei, parseOpenAmount, weiToCentiFloor } from '../../src/live/amounts.js';
import { HouseError, type HouseApi, type QuotesResponse } from '../../src/live/house-api.js';
import { HouseMarketFeed } from '../../src/live/market-feed.js';
import { PlacementBook, rejectionText, type PlacementOutcome } from '../../src/live/placement.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('OPEN amounts', () => {
  it('parses exact Centi with at most two decimals and converts to wei without floats', () => {
    expect(parseOpenAmount('25')).toEqual({ ok: true, centi: '2500' });
    expect(parseOpenAmount('12.5')).toEqual({ ok: true, centi: '1250' });
    expect(parseOpenAmount(' 1,000.25 ')).toEqual({ ok: true, centi: '100025' });
    expect(parseOpenAmount('0.01')).toEqual({ ok: true, centi: '1' });
    for (const bad of ['', '0', '0.00', '-1', '1.234', 'abc', '1e3', '.5x']) expect(parseOpenAmount(bad).ok).toBe(false);
    expect(centiToWei('2500')).toBe(25n * 10n ** 18n);
    expect(weiToCentiFloor(25n * 10n ** 18n + 9_999_999_999_999_999n)).toBe('2500');
  });
});

const cell = createCell('btc-usd', 1_800_000_000_000, multiplyDecimalInteger(getMarket('btc-usd').bandHeight, 10_000n), multiplyDecimalInteger(getMarket('btc-usd').bandHeight, 10_001n), OBSERVED_PATH_RULE_VERSION);
function quote(validUntilMs: number): QuoteSnapshot {
  return { ...cell, quoteId: 'Q1', revision: 1, grossX100: '250', sourceTimeMs: 0, generatedAtMs: 0, validUntilMs, provenance: { modelId: 'm', configId: 'c', tableId: 't', policyId: 'p', sourceSampleId: 's' }, simulated: true };
}
type Api = Pick<HouseApi, 'placeBet' | 'betByRequest'>;
async function run(api: Api, q: QuoteSnapshot, houseNow = 0): Promise<{ outcomes: PlacementOutcome[]; book: PlacementBook }> {
  const outcomes: PlacementOutcome[] = [];
  const book = new PlacementBook(api as HouseApi, () => houseNow, o => outcomes.push(o));
  await book.place(q, '500');
  return { outcomes, book };
}

describe('placement through the house', () => {
  it('names the quote the player saw (never odds) and reports acceptance', async () => {
    const placeBet = vi.fn(async (intent: Parameters<HouseApi['placeBet']>[0]) => { void intent; return { status: 200, body: { status: 'accepted' as const } }; });
    const { outcomes } = await run({ placeBet, betByRequest: vi.fn() }, quote(10_000));
    expect(placeBet).toHaveBeenCalledTimes(1);
    const intent = placeBet.mock.calls[0]![0];
    expect(Object.keys(intent).sort()).toEqual(['cellId', 'quoteId', 'requestId', 'revision', 'stakeCenti']);
    expect(intent).toMatchObject({ quoteId: 'Q1', revision: 1, cellId: cell.cellId, stakeCenti: '500' });
    expect(outcomes).toEqual([{ kind: 'accepted', requestId: intent.requestId }]);
  });

  it('shows Confirming while held (202) and follows the same requestId to the final answer', async () => {
    let polls = 0;
    const placeBet = vi.fn(async () => ({ status: 202, body: { status: 'pending' as const, retryAfterMs: 150 } }));
    const betByRequest = vi.fn(async (_id: string) => (++polls < 2 ? { status: 200, body: { status: 'pending' as const, retryAfterMs: 150 } } : { status: 200, body: { status: 'rejected' as const, reason: 'QUOTE_CHANGED' } }));
    const outcomes: PlacementOutcome[] = [];
    const book = new PlacementBook({ placeBet, betByRequest } as unknown as HouseApi, () => 0, o => outcomes.push(o));
    const done = book.place(quote(10_000), '500');
    await vi.waitFor(() => expect(book.pending()).toHaveLength(1));
    expect(book.pending()[0]).toMatchObject({ phase: 'confirming', cellId: cell.cellId, stakeCents: '500', grossX100: '250' });
    await done;
    const id = outcomes[0]!.requestId;
    expect(betByRequest.mock.calls.every(c => c[0] === id)).toBe(true);
    expect(outcomes).toEqual([expect.objectContaining({ kind: 'rejected', reason: 'QUOTE_CHANGED', message: 'Price moved — try again' })]);
    expect(book.pending()).toHaveLength(0);
  });

  it('maps typed rejections to clear messages', async () => {
    const { outcomes } = await run({ placeBet: vi.fn(async () => ({ status: 422, body: { status: 'rejected' as const, reason: 'INSUFFICIENT_BALANCE' } })), betByRequest: vi.fn() }, quote(10_000));
    expect(outcomes[0]).toMatchObject({ kind: 'rejected', message: 'Not enough OPEN — deposit to play' });
    expect(rejectionText('TOO_LATE')).toMatch(/later square/);
    expect(rejectionText('SOMETHING_NEW')).toBe('That square is unavailable — try another');
    const auth = await run({ placeBet: vi.fn(async () => ({ status: 401, body: undefined, error: { code: 'AUTH_REQUIRED' } })), betByRequest: vi.fn() }, quote(10_000));
    expect(auth.outcomes[0]!.kind).toBe('auth');
  });

  it('reconciles a timeout with GET by-request using the SAME requestId and never re-sends', async () => {
    const placeBet = vi.fn(async () => { throw new HouseError(0, 'TIMEOUT', 'no answer'); });
    let calls = 0;
    const betByRequest = vi.fn(async () => (++calls < 2 ? { status: 404, body: undefined } : { status: 200, body: { status: 'accepted' as const } }));
    const { outcomes } = await run({ placeBet, betByRequest }, quote(10_000), 0);
    expect(placeBet).toHaveBeenCalledTimes(1);
    const ids = new Set(betByRequest.mock.calls.map(c => (c as unknown[])[0]));
    expect(ids.size).toBe(1);
    expect(outcomes).toEqual([{ kind: 'accepted', requestId: [...ids][0] }]);
  });

  it('calls a lost tap "not placed" only once the quote can no longer be accepted by the house', async () => {
    const placeBet = vi.fn(async () => { throw new HouseError(0, 'NETWORK', 'offline'); });
    const betByRequest = vi.fn(async () => ({ status: 404, body: undefined }));
    // House clock far past the quote's validity + hold window: a request that never arrived can no longer be accepted.
    const { outcomes } = await run({ placeBet, betByRequest }, quote(1_000), 60_000);
    expect(placeBet).toHaveBeenCalledTimes(1);
    expect(outcomes[0]).toMatchObject({ kind: 'rejected', reason: 'NOT_RECEIVED' });
  });
});

describe('house market feed', () => {
  it('offers only house quotes by cell id and fails closed when the house cannot be read', async () => {
    const q: QuotesResponse = { market: 'btc-usd', t: 1_799_999_990, clockMs: 1_799_999_990_500, generatedAtMs: 1_799_999_990_400, phase: 'launch', edge: 0.03, tableId: 'T', acceptance: { hold: true, maxHoldMs: 1500, minLeadS: 4 }, cells: [
      { cellId: cell.cellId, start: cell.startMs, end: cell.endMs, lower: '100000', upper: '100010', available: true, quoteId: 'Q9', revision: 1, x100: 317, maxStakeCenti: '9999', validUntilMs: 1_799_999_992_000, window: 2, bandOffset: 0 },
      { cellId: 'maya-cell-v1:btc-usd:1:2:3:4', start: 1, end: 2, lower: '3', upper: '4', available: false, reason: 'too-late', window: 0, bandOffset: 1 },
    ] };
    let fail = false;
    const api = { quotes: vi.fn(async () => { if (fail) throw new HouseError(503, 'X', 'down'); return q; }), path: vi.fn(async () => ({ market: 'btc-usd', feedId: 'f', pairId: 1 as const, clockMs: 1_799_999_990_500, speed: 1, latestT: 1_799_999_990, samples: [{ t: 1_799_999_989, sourceTimeMs: 1_799_999_989_000, price: '100004.5', sampleId: 's1', receivedAtMs: 1 }, { t: 1_799_999_990, sourceTimeMs: 1_799_999_990_000, price: '100005', sampleId: 's2', receivedAtMs: 2 }] })) };
    const feed = new HouseMarketFeed(api as unknown as HouseApi, 'btc-usd');
    feed.start();
    await vi.waitFor(() => expect(feed.quoteFor(cell.cellId)).toBeDefined());
    expect(feed.quoteFor(cell.cellId)).toMatchObject({ quoteId: 'Q9', grossX100: '317', validUntilMs: 1_799_999_992_000, cellId: cell.cellId });
    expect(feed.quoteFor('maya-cell-v1:btc-usd:1:2:3:4')).toBeUndefined();
    expect(feed.minLeadS).toBe(4);
    await vi.waitFor(() => expect(feed.getSamples()).toHaveLength(2));
    expect(feed.getSamples().map(s => s.sampleId)).toEqual(['s1', 's2']);
    expect(feed.nowMs()).toBeGreaterThanOrEqual(1_799_999_990_500);
    fail = true;
    await vi.waitFor(() => expect(feed.quoteFor(cell.cellId)).toBeUndefined(), { timeout: 3000 });
    expect(feed.health().status).toBe('unavailable');
    feed.stop();
  });
});
