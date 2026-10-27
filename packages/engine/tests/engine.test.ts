import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createCell, parseDecimal, sampleId } from '@maya/contracts';
import type { CoverageReport, MarketDataPort, MarketId, PlacementIntent, PriceSample, QuoteSnapshot, SettlementPolicy } from '@maya/contracts';
import { getMarket } from '@maya/config';
import { PaperEngine } from '../src/index.js';

const engines: PaperEngine[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const engine of engines.splice(0)) engine.dispose(); });
const policy: SettlementPolicy = { policyId: 'fixture-sampled-v1', expectedSampleIntervalMs: 1000, lateArrivalGraceMs: 2000, recoveryDeadlineMs: 10000 };

it('bounds idle source retention while preserving the evidence for a recorded win', async () => {
  const db = new IDBFactory(); const f = fixture(db); await f.engine.initialize();
  await f.engine.placeBet(f.intent(f.quote()));
  const winner=observation('btc-usd',10000,'105');f.samples.push(winner);f.setTime(10000);await f.engine.tick();
  f.samples.splice(0,f.samples.length,...Array.from({length:80},(_,i)=>observation('btc-usd',200000+i*1000,'105')));
  f.setTime(280000);await f.engine.tick();
  const stored=await new Promise<any>((resolve,reject)=>{const request=db.open('test',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const connection=request.result;const read=connection.transaction('paper').objectStore('paper').get('ledger');read.onsuccess=()=>{connection.close();resolve(read.result);};};});
  expect(stored.samples[winner.sampleId]).toBeDefined();
  expect(stored.samples[observation('btc-usd',5000,'100').sampleId]).toBeUndefined();
  expect(Object.keys(stored.samples)).toHaveLength(81);
  expect(f.engine.getSnapshot().positions[0]?.status).toBe('won');
  expect(f.engine.getSnapshot().balanceCents).toBe('100150');
});
function observation(marketId: MarketId, time: number, price: string): PriceSample {
  const market = getMarket(marketId);
  return { sampleId: sampleId(market.feedId, time), marketId, pairId: market.pairId, feedId: market.feedId, sourceTimeMs: time, receivedAtMs: time + 50, price: parseDecimal(price) };
}
function fixture(factory = new IDBFactory(), databaseName = 'test', pageLoadId = crypto.randomUUID(), startingBalanceCents = '100000', ledgerKey?: string) {
  let nowMs = 5000;
  let health: 'ready' | 'stale' = 'ready';
  let coverageStatus: CoverageReport['status'] = 'recovering';
  const samples: PriceSample[] = [observation('btc-usd', 5000, '100'), observation('eth-usd', 5000, '100')];
  const quotes = new Map<string, QuoteSnapshot>();
  const conflicts: string[] = [];
  const data: MarketDataPort = {
    getHealth: marketId => ({ marketId, status: health, observedAtMs: nowMs, lastSourceTimeMs: nowMs }),
    getSamples: (marketId, from = 0, to = Infinity) => samples.filter(sample => sample.marketId === marketId && sample.sourceTimeMs >= from && sample.sourceTimeMs < to),
    getCoverage: (marketId, startMs, endMs) => ({ marketId, startMs, endMs, status: coverageStatus, policyId: policy.policyId, watermarkMs: nowMs, sampleIds: samples.filter(sample => sample.marketId === marketId && sample.sourceTimeMs >= startMs && sample.sourceTimeMs < endMs).map(sample => sample.sampleId) }),
    getConflictingSampleIds: marketId => conflicts.filter(id => id.includes(getMarket(marketId).feedId)),
    subscribe: () => () => undefined
  };
  const engine = new PaperEngine({ pageLoadId, databaseName, ledgerKey, indexedDB: factory, clock: { getClock: () => ({ nowMs, ready: true, uncertaintyMs: 0 }) }, quotes: { getQuote: quoteId => quotes.get(quoteId) }, marketData: data, settlementPolicy: policy, minLeadMs: () => 3000, broadcast: false, startingBalanceCents });
  engines.push(engine);
  const quote = (marketId: MarketId = 'btc-usd', lower = '100', upper = marketId === 'btc-usd' ? '110' : '100.5', grossX100 = '250', startMs = 10000) => {
    const quote: QuoteSnapshot = { ...createCell(marketId, startMs, parseDecimal(lower), parseDecimal(upper)), quoteId: crypto.randomUUID(), revision: 1, grossX100, sourceTimeMs: 5000, generatedAtMs: 5000, validUntilMs: 8000, provenance: { modelId: 'fixture-model', configId: 'fixture-config', tableId: 'fixture-table', policyId: policy.policyId, sourceSampleId: observation(marketId, 5000, '100').sampleId }, simulated: true };
    quotes.set(quote.quoteId, quote); return quote;
  };
  const intent = (quote: QuoteSnapshot, stakeCents = '100', requestId = crypto.randomUUID()): PlacementIntent => ({ pageLoadId, requestId, quoteId: quote.quoteId, revision: quote.revision, cellId: quote.cellId, stakeCents });
  return { engine, quote, intent, samples, quotes, data, conflicts, setTime: (time: number) => { nowMs = time; }, setHealth: (value: typeof health) => { health = value; }, setCoverage: (value: typeof coverageStatus) => { coverageStatus = value; } };
}

describe('Fresh per-document demo sessions', () => {
  it('grants exactly $1,000 and ten plays independently of a previous balance and history', async () => {
    const db=new IDBFactory();const old=fixture(db);await old.engine.initialize();
    await old.engine.refill('old-refill');await old.engine.placeBet(old.intent(old.quote(),'500'));
    const fresh=fixture(db,'test',crypto.randomUUID(),'100000','session:fresh');await fresh.engine.initialize();
    expect(fresh.engine.getSnapshot()).toMatchObject({balanceCents:'100000',positions:[],ready:true});
    expect(fresh.engine.getAllowance()).toMatchObject({acceptedCount:0,remaining:10,offerShown:false});
    await old.engine.tick();expect(old.engine.getSnapshot().balanceCents).toBe('199500');
    expect(old.engine.getSnapshot().positions).toHaveLength(1);
  });
  it('cannot credit a new session when a position in an older tab wins', async () => {
    const db=new IDBFactory();const old=fixture(db,'test',crypto.randomUUID(),'100000','session:old');
    await old.engine.initialize();await old.engine.placeBet(old.intent(old.quote(),'500'));
    const fresh=fixture(db,'test',crypto.randomUUID(),'100000','session:new');await fresh.engine.initialize();
    old.samples.push(observation('btc-usd',10000,'105'));old.setTime(10000);await old.engine.tick();await fresh.engine.tick();
    expect(old.engine.getSnapshot()).toMatchObject({balanceCents:'100750',positions:[{status:'won'}]});
    expect(fresh.engine.getSnapshot()).toMatchObject({balanceCents:'100000',positions:[]});
    expect(Object.values(fresh.engine.getAuditSnapshot().entries).map(e=>e.amountCents)).toEqual(['100000']);
  });
  it('retains a session debit through reconnect and gives a new scope a fresh grant', async () => {
    const db=new IDBFactory(),page=crypto.randomUUID();const first=fixture(db,'test',page,'100000','session:first');
    await first.engine.initialize();const intent=first.intent(first.quote(),'1000');await first.engine.placeBet(intent);first.engine.dispose();
    const reconnect=fixture(db,'test',page,'100000','session:first');await reconnect.engine.initialize();
    expect(reconnect.engine.getSnapshot().balanceCents).toBe('99000');
    expect(await reconnect.engine.placeBet(intent)).toMatchObject({status:'accepted',newlyCommitted:false});
    const reload=fixture(db,'test',crypto.randomUUID(),'100000','session:reload');await reload.engine.initialize();
    expect(reload.engine.getSnapshot()).toMatchObject({balanceCents:'100000',positions:[]});
  });
});

describe('QA pass 1 — exact terms, sampled outcomes and normal persistence', () => {
  it('freezes visible odds, debits once and credits gross return for BTC and ETH', async () => {
    const f = fixture(); await f.engine.initialize();
    for (const market of ['btc-usd', 'eth-usd'] as const) {
      const quote = f.quote(market);
      expect((await f.engine.placeBet(f.intent(quote, '500'))).status).toBe('accepted');
      f.quotes.set(quote.quoteId, { ...quote, grossX100: '900' });
      f.samples.push(observation(market, 10000, '100'));
    }
    f.setTime(10000); await f.engine.tick(); await f.engine.tick();
    expect(f.engine.getSnapshot().balanceCents).toBe('101500');
    expect(f.engine.getSnapshot().positions.map(position => [position.status, position.grossX100, position.grossReturnCents])).toEqual([['won', '250', '1250'], ['won', '250', '1250']]);
  });
  it('rounds final half cents up exactly without hidden multiplier precision', async () => {
    const f = fixture(); await f.engine.initialize();
    await f.engine.placeBet(f.intent(f.quote('btc-usd', '100', '110', '105'), '10'));
    await f.engine.placeBet(f.intent(f.quote('btc-usd', '100', '110', '104'), '10'));
    f.samples.push(observation('btc-usd', 10000, '100')); f.setTime(10000); await f.engine.tick();
    expect(f.engine.getSnapshot().positions.map(position => position.grossReturnCents).sort()).toEqual(['10', '11']);
    expect(f.engine.getSnapshot().balanceCents).toBe('100001');
  });
  it('does not interpolate a price jump or include the end timestamp', async () => {
    const f = fixture(); await f.engine.initialize(); await f.engine.placeBet(f.intent(f.quote()));
    for (let time = 10000; time < 15000; time += 1000) f.samples.push(observation('btc-usd', time, time < 12000 ? '99' : '111'));
    f.samples.push(observation('btc-usd', 15000, '105'));
    f.setCoverage('complete'); f.setTime(17000); await f.engine.tick();
    expect(f.engine.getSnapshot().positions[0]?.status).toBe('lost');
    expect(f.engine.getSnapshot().balanceCents).toBe('99900');
  });
  it('includes both price edges and lets adjacent squares both win at an exact shared edge', async () => {
    const f = fixture(); await f.engine.initialize();
    await f.engine.placeBet(f.intent(f.quote('btc-usd', '100', '110')));
    await f.engine.placeBet(f.intent(f.quote('btc-usd', '110', '120')));
    f.samples.push(observation('btc-usd', 10000, '110')); f.setTime(10000); await f.engine.tick();
    expect(f.engine.getSnapshot().positions.every(position => position.status === 'won')).toBe(true);
    expect(f.engine.getSnapshot().balanceCents).toBe('100300');
  });
  it('preserves open terms and balance on refresh while granting a new allowance', async () => {
    const db = new IDBFactory(); const original = fixture(db); await original.engine.initialize();
    const intent = original.intent(original.quote(), '500'); await original.engine.placeBet(intent);
    const refreshed = fixture(db); await refreshed.engine.initialize();
    expect(refreshed.engine.getAllowance().acceptedCount).toBe(0);
    expect(refreshed.engine.getSnapshot().balanceCents).toBe('99500');
    expect(refreshed.engine.getSnapshot().positions[0]?.requestId).toBe(intent.requestId);
    refreshed.samples.push(observation('btc-usd', 10000, '105')); refreshed.setTime(10000); await refreshed.engine.tick();
    expect(refreshed.engine.getSnapshot().balanceCents).toBe('100750');
    expect(refreshed.engine.getAllowance().acceptedCount).toBe(0);
  });
  it('recovers incomplete windows and refunds rather than guessing a loss', async () => {
    const f = fixture(); await f.engine.initialize(); await f.engine.placeBet(f.intent(f.quote()));
    f.setTime(17000); await f.engine.tick(); expect(f.engine.getSnapshot().positions[0]?.status).toBe('open');
    f.setTime(25000); await f.engine.tick(); await f.engine.tick();
    expect(f.engine.getSnapshot().positions[0]?.status).toBe('refunded');
    expect(f.engine.getSnapshot().balanceCents).toBe('100000');
  });
  it('rejects a malformed/off-grid cell and a quote with no authoritative source observation', async () => {
    const f = fixture(); await f.engine.initialize();
    const offGrid = f.quote('btc-usd', '100.5', '110.5');
    expect(await f.engine.placeBet(f.intent(offGrid))).toMatchObject({ status: 'rejected', reason: 'UNSUPPORTED_CELL' });
    const quote = f.quote(); f.samples.length = 0;
    expect(await f.engine.placeBet(f.intent(quote))).toMatchObject({ status: 'rejected', reason: 'INPUT_NOT_READY' });
    expect(f.engine.getSnapshot().balanceCents).toBe('100000'); expect(f.engine.getAllowance().acceptedCount).toBe(0);
  });
});

describe('QA pass 2 — adversarial transactions, allowance and coverage', () => {
  it('allows only ten concurrent accepted placements and excludes retries and rejection from counting', async () => {
    const f = fixture(); await f.engine.initialize(); const quote = f.quote();
    const first = f.intent(quote); await f.engine.placeBet(first);
    expect(await f.engine.placeBet(first)).toMatchObject({ status: 'accepted', newlyCommitted: false });
    expect(await f.engine.placeBet({ ...first, stakeCents: '500' })).toMatchObject({ status: 'rejected', reason: 'REQUEST_CONFLICT' });
    await f.engine.placeBet(f.intent(quote, '250'));
    const results = await Promise.all(Array.from({ length: 12 }, () => f.engine.placeBet(f.intent(quote))));
    expect(results.filter(result => result.status === 'accepted')).toHaveLength(9);
    expect(f.engine.getAllowance()).toMatchObject({ acceptedCount: 10, remaining: 0, offerShown: false });
    expect(f.engine.getSnapshot().balanceCents).toBe('99000');
    expect(await f.engine.placeBet(first)).toMatchObject({ status: 'accepted', newlyCommitted: false });
  });
  it('keeps the tenth bet valid behind the acknowledged offer, including throwing subscribers and refill', async () => {
    const f = fixture(); await f.engine.initialize(); const quote = f.quote();
    f.engine.subscribe(() => { throw new Error('broken view'); });
    expect(() => f.engine.acknowledgeOfferShown({ pageLoadId: f.engine.pageLoadId, presentationId: 'early' })).toThrow();
    for (let index = 0; index < 10; index += 1) await f.engine.placeBet(f.intent(quote));
    expect(() => f.engine.acknowledgeOfferShown({ pageLoadId: 'wrong', presentationId: 'wrong' })).toThrow();
    const ack = { pageLoadId: f.engine.pageLoadId, presentationId: 'shown' };
    expect(f.engine.acknowledgeOfferShown(ack).offerShown).toBe(true);
    expect(f.engine.acknowledgeOfferShown(ack).acceptedCount).toBe(10);
    f.samples.push(observation('btc-usd', 10000, '105')); f.setTime(10000); await f.engine.tick();
    expect(f.engine.getSnapshot().positions.every(position => position.status === 'won')).toBe(true);
    await f.engine.refill('same-refill'); await f.engine.refill('same-refill');
    expect(f.engine.getSnapshot().balanceCents).toBe('201500');
    expect(f.engine.getAllowance()).toMatchObject({ acceptedCount: 10, remaining: 0, offerShown: true });
  });
  it('revalidates expiry inside the transaction rather than at tap time', async () => {
    const f = fixture(); await f.engine.initialize();
    const pending = f.engine.placeBet(f.intent(f.quote())); f.setTime(9000);
    expect(await pending).toMatchObject({ status: 'rejected', reason: 'QUOTE_EXPIRED' });
    expect(f.engine.getSnapshot().balanceCents).toBe('100000'); expect(f.engine.getAllowance().acceptedCount).toBe(0);
  });
  it('atomically initializes one grant and prevents cross-tab overspend', async () => {
    const db = new IDBFactory(); const a = fixture(db, 'race', 'page-a', '1000'); const b = fixture(db, 'race', 'page-b', '1000');
    await Promise.all([a.engine.initialize(), b.engine.initialize()]);
    const result = await Promise.all([a.engine.placeBet(a.intent(a.quote(), '1000')), b.engine.placeBet(b.intent(b.quote(), '1000'))]);
    expect(result.filter(item => item.status === 'accepted')).toHaveLength(1);
    await Promise.all([a.engine.refresh(), b.engine.refresh()]);
    expect(a.engine.getSnapshot().balanceCents).toBe('0'); expect(b.engine.getSnapshot().balanceCents).toBe('0');
    expect(a.engine.getAllowance().acceptedCount + b.engine.getAllowance().acceptedCount).toBe(1);
  });
  it('enforces the shared square cap across tabs and quote/config revisions', async () => {
    const db = new IDBFactory(); const a = fixture(db); const b = fixture(db);
    await Promise.all([a.engine.initialize(), b.engine.initialize()]);
    for (let index = 0; index < 5; index += 1) await a.engine.placeBet(a.intent(a.quote(), '1000'));
    const quote = b.quote(); b.quotes.set(quote.quoteId, { ...quote, provenance: { ...quote.provenance, configId: 'new-compatible-revision' } });
    expect(await b.engine.placeBet(b.intent(quote, '10'))).toMatchObject({ status: 'rejected', reason: 'CELL_CAP_EXCEEDED' });
    expect(b.engine.getAllowance().acceptedCount).toBe(0);
  });
  it('settles a shared position only once when two tabs process the same hit', async () => {
    const db = new IDBFactory(); const a = fixture(db); const b = fixture(db);
    await Promise.all([a.engine.initialize(), b.engine.initialize()]); await a.engine.placeBet(a.intent(a.quote(), '500'));
    for (const f of [a, b]) { f.samples.push(observation('btc-usd', 10000, '105')); f.setTime(10000); }
    await Promise.all([a.engine.tick(), b.engine.tick()]); await Promise.all([a.engine.refresh(), b.engine.refresh()]);
    expect(a.engine.getSnapshot().balanceCents).toBe('100750'); expect(b.engine.getSnapshot().balanceCents).toBe('100750');
  });
  it('aborts debit and count together if persistence fails', async () => {
    const db = new IDBFactory(); const a = fixture(db); await a.engine.initialize();
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new DOMException('disk full', 'QuotaExceededError'); });
    expect(await a.engine.placeBet(a.intent(a.quote()))).toMatchObject({ status: 'rejected', reason: 'STORAGE_UNAVAILABLE' });
    expect(a.engine.getAllowance().acceptedCount).toBe(0);
    const b = fixture(db); await b.engine.initialize();
    expect(b.engine.getSnapshot().positions).toHaveLength(0); expect(b.engine.getSnapshot().balanceCents).toBe('100000');
  });
  it('quarantines conflicting samples and refunds unresolved positions', async () => {
    const f = fixture(); await f.engine.initialize(); await f.engine.placeBet(f.intent(f.quote()));
    const hit = observation('btc-usd', 10000, '105');
    f.samples.push(hit, { ...hit, price: parseDecimal('120') }); f.setTime(10000); await f.engine.tick();
    expect(f.engine.getSnapshot().positions[0]?.status).toBe('open');
    f.setCoverage('complete'); f.setTime(25000); await f.engine.tick();
    expect(f.engine.getSnapshot().positions[0]?.status).toBe('refunded');
  });
  it('quarantines persisted observations when provider conflict notifications arrive separately', async () => {
    const f = fixture(); await f.engine.initialize(); await f.engine.placeBet(f.intent(f.quote()));
    const hit = observation('btc-usd', 10000, '105'); f.samples.push(hit); f.conflicts.push(hit.sampleId);
    f.setTime(10000); await f.engine.tick();
    expect(f.engine.getSnapshot().positions[0]?.status).toBe('open');
  });
  it('rejects stale source health and incomplete source evidence despite a malformed complete report', async () => {
    const f = fixture(); await f.engine.initialize(); const quote = f.quote();
    f.setHealth('stale'); expect(await f.engine.placeBet(f.intent(quote))).toMatchObject({ status: 'rejected', reason: 'INPUT_NOT_READY' });
    f.setHealth('ready'); await f.engine.placeBet(f.intent(quote));
    f.samples.push(observation('btc-usd', 10000, '120')); f.setCoverage('complete'); f.setTime(17000); await f.engine.tick();
    expect(f.engine.getSnapshot().positions[0]?.status).toBe('open');
  });
});

describe('QA pass 3 — corrected regression and lifecycle integrity', () => {
  it('reconstructs a complete no-hit window from persisted samples after the provider buffer has rolled off', async () => {
    const db = new IDBFactory(); const a = fixture(db); await a.engine.initialize(); await a.engine.placeBet(a.intent(a.quote()));
    for (let time = 10000; time < 15000; time += 1000) a.samples.push(observation('btc-usd', time, '120'));
    a.setTime(14000); await a.engine.tick(); expect(a.engine.getSnapshot().positions[0]?.status).toBe('open');
    const refreshed = fixture(db); refreshed.setTime(25000); refreshed.setCoverage('unrecoverable'); await refreshed.engine.initialize(); await refreshed.engine.tick();
    expect(refreshed.engine.getSnapshot().positions[0]?.status).toBe('lost');
    expect(refreshed.engine.getSnapshot().balanceCents).toBe('99900');
  });
  it('cannot settle from a future-dated observation before its source time', async () => {
    const f = fixture(); await f.engine.initialize(); await f.engine.placeBet(f.intent(f.quote()));
    f.samples.push(observation('btc-usd', 10000, '105')); await f.engine.tick();
    expect(f.engine.getSnapshot().positions[0]?.status).toBe('open');
    f.setTime(10000); await f.engine.tick(); expect(f.engine.getSnapshot().positions[0]?.status).toBe('won');
  });
  it('honors a persisted qualifying sample before a later tab can declare a miss', async () => {
    const db = new IDBFactory(); const a = fixture(db); const b = fixture(db);
    await Promise.all([a.engine.initialize(), b.engine.initialize()]);
    await a.engine.placeBet(a.intent(a.quote()));
    a.samples.push(observation('btc-usd', 10000, '105')); a.setTime(10000); await a.engine.tick();
    for (let time = 11000; time < 15000; time += 1000) b.samples.push(observation('btc-usd', time, '120'));
    b.setCoverage('complete'); b.setTime(17000); await b.engine.tick();
    expect(b.engine.getSnapshot().positions[0]?.status).toBe('won'); expect(b.engine.getSnapshot().balanceCents).toBe('100150');
  });
  it('preserves terminal outcomes when a delayed contradiction or hit arrives after refund', async () => {
    const f = fixture(); await f.engine.initialize(); await f.engine.placeBet(f.intent(f.quote()));
    f.setTime(25000); await f.engine.tick();
    f.samples.push(observation('btc-usd', 10000, '105')); await f.engine.tick();
    expect(f.engine.getSnapshot().positions[0]?.status).toBe('refunded'); expect(f.engine.getSnapshot().balanceCents).toBe('100000');
  });
  it('does not accept a revision mismatch, wrong document, unsupported stake or short lead time', async () => {
    const f = fixture(); await f.engine.initialize(); const quote = f.quote(); const intent = f.intent(quote);
    expect(await f.engine.placeBet({ ...intent, revision: 2 })).toMatchObject({ reason: 'QUOTE_CHANGED' });
    expect(await f.engine.placeBet({ ...intent, pageLoadId: 'another-page' })).toMatchObject({ reason: 'REQUEST_CONFLICT' });
    expect(await f.engine.placeBet({ ...intent, stakeCents: '-100' })).toMatchObject({ reason: 'STAKE_NOT_ALLOWED' });
    f.setTime(7001); expect(await f.engine.placeBet(intent)).toMatchObject({ reason: 'TOO_LATE' });
    expect(f.engine.getAllowance().acceptedCount).toBe(0); expect(f.engine.getSnapshot().balanceCents).toBe('100000');
  });
  it('returns deeply immutable view terms and replays accepted requests without replacing terms', async () => {
    const f = fixture(); await f.engine.initialize(); const intent = f.intent(f.quote()); const accepted = await f.engine.placeBet(intent);
    expect(accepted.status).toBe('accepted');
    const position = f.engine.getSnapshot().positions[0]!;
    expect(() => { (position.lowerPrice as { coefficient: string }).coefficient = '0'; }).toThrow();
    expect(() => { (position as { grossX100: string }).grossX100 = '999'; }).toThrow();
    expect(await f.engine.placeBet(intent)).toMatchObject({ status: 'accepted', newlyCommitted: false, position: { grossX100: '250' } });
  });
  it('preserves an unsupported persisted schema rather than silently resetting it', async () => {
    const db = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const request = db.open('corrupt', 1); request.onupgradeneeded = () => request.result.createObjectStore('paper');
      request.onsuccess = () => { const tx = request.result.transaction('paper', 'readwrite'); tx.objectStore('paper').put({ schemaVersion: 9, balanceCents: '42' }, 'ledger'); tx.oncomplete = () => { request.result.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    });
    const f = fixture(db, 'corrupt'); await f.engine.initialize();
    expect(f.engine.getSnapshot()).toMatchObject({ ready: false, error: expect.stringContaining('preserved') });
    expect(await f.engine.placeBet(f.intent(f.quote()))).toMatchObject({ status: 'rejected', reason: 'STATE_NOT_READY' });
  });
});
