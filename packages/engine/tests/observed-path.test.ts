import { afterEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createCell, parseDecimal, sampleId, observedSampleId, segmentTouchesCell, OBSERVED_PATH_POLICY, OBSERVED_PATH_RULE_VERSION, OBSERVED_SAMPLE_PREFIX } from '@maya/contracts';
import type { MarketDataPort, MarketId, PriceSample, QuoteSnapshot, SettlementPolicy } from '@maya/contracts';
import { getMarket } from '@maya/config';
import { PaperEngine } from '../src/index.js';

const engines: PaperEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });
const legacyPolicy: SettlementPolicy = { policyId: 'maya-lynx-sampled-1s-stabilized-3s-v1', expectedSampleIntervalMs: 1000, lateArrivalGraceMs: 1000, recoveryDeadlineMs: 30000 };
function observation(time: number, price: string, marketId: MarketId = 'btc-usd'): PriceSample {
  const market = getMarket(marketId);
  return { sampleId: sampleId(market.feedId, time), marketId, pairId: market.pairId, feedId: market.feedId, sourceTimeMs: time, receivedAtMs: time + 50, price: parseDecimal(price) };
}
function fixture(factory = new IDBFactory(), policy = OBSERVED_PATH_POLICY, databaseName = 'observed-path', firstPrice = '95') {
  let now = 5000;
  const confirmed: PriceSample[] = [observation(5000, '95')];
  const observed: PriceSample[] = [observation(5000, firstPrice)];
  const conflicts: string[] = [];
  const quotes = new Map<string, QuoteSnapshot>();
  const data: MarketDataPort = {
    getSamples: (marketId, start = 0, end = Infinity) => confirmed.filter(sample => sample.marketId === marketId && sample.sourceTimeMs >= start && sample.sourceTimeMs < end),
    getHealth: marketId => ({ marketId, status: 'ready', observedAtMs: now }),
    getConflictingSampleIds: () => conflicts,
    getCoverage: (marketId, startMs, endMs) => ({ marketId, startMs, endMs, policyId: legacyPolicy.policyId, status: 'complete', watermarkMs: now, sampleIds: confirmed.filter(sample => sample.marketId === marketId && sample.sourceTimeMs >= startMs && sample.sourceTimeMs < endMs).map(sample => sample.sampleId) }),
    subscribe: () => () => undefined,
  };
  const engine = new PaperEngine({ indexedDB: factory, databaseName, marketData: data, observedSamples: () => observed, settlementPolicy: policy, clock: { getClock: () => ({ nowMs: now, uncertaintyMs: 0, ready: true }) }, quotes: { getQuote: id => quotes.get(id) }, broadcast: false });
  engines.push(engine);
  const quote = (grossX100 = '250') => {
    const v2 = policy.policyId === OBSERVED_PATH_POLICY.policyId;
    const quote: QuoteSnapshot = { ...createCell('btc-usd', 10000, parseDecimal('100'), parseDecimal('110'), v2 ? OBSERVED_PATH_RULE_VERSION : 'maya-sampled-v1'), quoteId: crypto.randomUUID(), revision: 1, grossX100, sourceTimeMs: 5000, generatedAtMs: 5000, validUntilMs: 8000, provenance: { modelId: 'fixture', configId: 'fixture', tableId: 'fixture', policyId: policy.policyId, sourceSampleId: v2 ? observedSampleId(observed[0]!) : confirmed[0]!.sampleId }, simulated: true };
    quotes.set(quote.quoteId, quote); return quote;
  };
  const place = (stakeCents = '100', selected = quote()) => engine.placeBet({ requestId: crypto.randomUUID(), pageLoadId: engine.pageLoadId, quoteId: selected.quoteId, cellId: selected.cellId, revision: selected.revision, stakeCents });
  return { engine, observed, confirmed, conflicts, data, quote, place, setTime: (value: number) => { now = value; } };
}

describe('exact observed segment collision', () => {
  const cell = createCell('btc-usd', 10000, parseDecimal('100'), parseDecimal('110'), OBSERVED_PATH_RULE_VERSION);
  it('finds a crossing even when both observed endpoints miss, with exact fractional evidence', () => {
    const touch = segmentTouchesCell(observation(10000, '99'), observation(11000, '111'), cell)!;
    expect(touch.firstTouchTimeMs).toBeCloseTo(10083.333333, 5);
    expect(touch.time).toEqual({ numerator: '30250', denominator: '3' });
    expect(touch.price).toEqual({ numerator: '100', denominator: '1' });
  });
  it('clips time at the start and excludes a sole touch at the end', () => {
    expect(segmentTouchesCell(observation(9000, '95'), observation(10000, '105'), cell)?.firstTouchTimeMs).toBe(10000);
    expect(segmentTouchesCell(observation(14000, '99'), observation(15000, '100'), cell)).toBeUndefined();
    expect(segmentTouchesCell(observation(14000, '111'), observation(15000, '110'), cell)).toBeUndefined();
    expect(segmentTouchesCell(observation(14000, '99'), observation(15000, '105'), cell)?.firstTouchTimeMs).toBeCloseTo(14166.666666, 5);
  });
  it('does not bridge missing seconds or another market and includes constant boundary prices', () => {
    expect(segmentTouchesCell(observation(10000, '99'), observation(12000, '111'), cell)).toBeUndefined();
    expect(segmentTouchesCell(observation(10000, '99'), observation(11000, '111', 'eth-usd'), cell)).toBeUndefined();
    expect(segmentTouchesCell(observation(10000, '100'), observation(11000, '100'), cell)?.firstTouchTimeMs).toBe(10000);
  });
  it('compares tiny decimal differences beyond floating-point precision exactly', () => {
    const tinyCell = createCell('btc-usd', 10000, parseDecimal('100.000000000000000001'), parseDecimal('100.000000000000000002'), OBSERVED_PATH_RULE_VERSION);
    const touch = segmentTouchesCell(observation(10000, '100.000000000000000000'), observation(11000, '100.000000000000000003'), tinyCell)!;
    expect(touch.time).toEqual({ numerator: '31000', denominator: '3' });
    expect(touch.price).toEqual({ numerator: '100000000000000000001', denominator: '1000000000000000000' });
  });
});

describe('v2 persisted game path and legacy isolation', () => {
  it('credits two stakes on the same crossed square independently and exactly once', async () => {
    const f = fixture(); await f.engine.initialize();
    expect(await f.place('100', f.quote('250'))).toMatchObject({ status: 'accepted' });
    expect(await f.place('50', f.quote('400'))).toMatchObject({ status: 'accepted' });
    f.observed.push(observation(10000, '99'), observation(11000, '111'));
    f.setTime(11000); await f.engine.tick(); await f.engine.tick();
    const paper = f.engine.getSnapshot();
    expect(paper.positions.every(p => p.status === 'won')).toBe(true);
    expect(paper.positions.map(p => p.grossReturnCents).sort()).toEqual(['200', '250']);
    expect(paper.positions.every(p => p.touchTimeMs! > 10000 && p.touchTimeMs! < 11000)).toBe(true);
    expect(paper.positions.every(p => p.evidenceSampleIds?.length === 2)).toBe(true);
    expect(paper.balanceCents).toBe('100300');
    expect(Object.values(f.engine.getAuditSnapshot().entries).filter(entry => entry.kind === 'win')).toHaveLength(2);
  });
  it('counts a last-second segment crossing before end, but not an exact-end-only touch', async () => {
    for (const [endPrice, outcome] of [['105', 'won'], ['100', 'lost']] as const) {
      const f = fixture(new IDBFactory()); await f.engine.initialize(); await f.place();
      for (let t = 10000; t < 15000; t += 1000) f.observed.push(observation(t, '99'));
      f.observed.push(observation(15000, endPrice));
      f.setTime(16000); await f.engine.tick();
      expect(f.engine.getSnapshot().positions[0]?.status).toBe(outcome);
    }
  });
  it('requires six complete slots for loss, waits for grace, and refunds an unrecoverable gap', async () => {
    const f = fixture(); await f.engine.initialize(); await f.place();
    for (let t = 10000; t < 15000; t += 1000) f.observed.push(observation(t, '120'));
    f.setTime(16000); await f.engine.tick(); expect(f.engine.getSnapshot().positions[0]?.status).toBe('open');
    f.observed.push(observation(15000, '120')); f.setTime(15000); await f.engine.tick(); expect(f.engine.getSnapshot().positions[0]?.status).toBe('open');
    f.setTime(16000); await f.engine.tick(); expect(f.engine.getSnapshot().positions[0]?.status).toBe('lost');
    const g = fixture(new IDBFactory()); await g.engine.initialize(); await g.place();
    g.observed.push(observation(10000, '99'), observation(12000, '111'));
    g.setTime(16000); await g.engine.tick(); expect(g.engine.getSnapshot().positions[0]?.status).toBe('open');
    g.setTime(45000); await g.engine.tick(); expect(g.engine.getSnapshot().positions[0]?.status).toBe('refunded');
    expect(g.engine.getSnapshot().balanceCents).toBe('100000');
  });
  it('pins first observed prices while confirmed revisions still quarantine legacy samples', async () => {
    const f = fixture(); await f.engine.initialize(); await f.place();
    f.observed.push(observation(10000, '99')); f.confirmed.push(observation(10000, '99'));
    f.setTime(10000); await f.engine.tick();
    f.observed.splice(1, 1, observation(10000, '105')); f.confirmed.splice(1, 1, observation(10000, '105'));
    const originalId = sampleId(getMarket('btc-usd').feedId, 10000);
    f.conflicts.push(originalId, OBSERVED_SAMPLE_PREFIX + originalId);
    await f.engine.tick();
    expect(f.engine.getGameSamples('btc-usd').find(sample => sample.sourceTimeMs === 10000)?.price).toEqual(parseDecimal('99'));
    expect(f.engine.getSnapshot().positions[0]?.status).toBe('open');
    f.observed.push(observation(11000, '111')); f.setTime(11000); await f.engine.tick();
    expect(f.engine.getSnapshot().positions[0]?.status).toBe('won');
  });
  it('retains the same immutable path through reload and publishes another tab’s first writer', async () => {
    const db = new IDBFactory(); const a = fixture(db); await a.engine.initialize();
    const b = fixture(db, OBSERVED_PATH_POLICY, 'observed-path', '105'); await b.engine.initialize();
    expect(b.engine.getGameSamples('btc-usd')[0]?.price).toEqual(parseDecimal('95'));
    a.observed.push(observation(10000, '98')); b.observed.push(observation(10000, '108'));
    a.setTime(10000); b.setTime(10000); await Promise.all([a.engine.tick(), b.engine.tick()]);
    await Promise.all([a.engine.refresh(), b.engine.refresh()]);
    expect(a.engine.getGameSamples('btc-usd')).toEqual(b.engine.getGameSamples('btc-usd'));
    const first = a.engine.getGameSamples('btc-usd').find(sample => sample.sourceTimeMs === 10000)!;
    expect(['98', '108']).toContain(first.price.coefficient);
    const c = fixture(db, OBSERVED_PATH_POLICY, 'observed-path', '115'); c.setTime(10000); await c.engine.initialize();
    expect(c.engine.getGameSamples('btc-usd')).toEqual(a.engine.getGameSamples('btc-usd'));
    expect(() => { (first.price as { coefficient: string }).coefficient = '0'; }).toThrow();
  });
  it('continues old sampled bets without awarding a crossing or an end-boundary observation', async () => {
    const db = new IDBFactory(); const old = fixture(db, legacyPolicy); await old.engine.initialize(); await old.place();
    const current = fixture(db); await current.engine.initialize(); await current.place();
    for (let t = 10000; t < 15000; t += 1000) {
      const sample = observation(t, t < 12000 ? '99' : '111');
      current.confirmed.push(sample); current.observed.push(sample);
    }
    current.confirmed.push(observation(15000, '105')); current.observed.push(observation(15000, '105'));
    current.setTime(17000); await current.engine.tick();
    expect(current.engine.getSnapshot().positions.find(p => p.ruleVersion === 'maya-sampled-v1')?.status).toBe('lost');
    expect(current.engine.getSnapshot().positions.find(p => p.ruleVersion === OBSERVED_PATH_RULE_VERSION)?.status).toBe('won');
    expect(current.engine.getSnapshot().balanceCents).toBe('100050');
  });
  it('can still settle a legacy observed hit from the confirmed stream after upgrade', async () => {
    const db = new IDBFactory(); const old = fixture(db, legacyPolicy); await old.engine.initialize(); await old.place();
    const current = fixture(db); await current.engine.initialize();
    current.confirmed.push(observation(10000, '105')); current.setTime(10000); await current.engine.tick();
    expect(current.engine.getSnapshot().positions[0]).toMatchObject({ ruleVersion: 'maya-sampled-v1', status: 'won', grossReturnCents: '250' });
    expect(current.engine.getSnapshot().balanceCents).toBe('100150');
  });
  it('preserves an unknown persisted policy without silently applying a new outcome rule', async () => {
    const db = new IDBFactory(); const f = fixture(db); await f.engine.initialize(); await f.place();
    await new Promise<void>((resolve, reject) => {
      const request = db.open('observed-path'); request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const connection = request.result, tx = connection.transaction('paper', 'readwrite'), store = tx.objectStore('paper'), read = store.get('ledger');
        read.onsuccess = () => { const state = read.result; const p = Object.values(state.positions)[0] as any; p.settlementPolicy.policyId = 'unknown-future-policy'; store.put(state, 'ledger'); };
        tx.oncomplete = () => { connection.close(); resolve(); }; tx.onabort = () => reject(tx.error);
      };
    });
    f.observed.push(observation(10000, '105')); f.setTime(50000); await f.engine.tick();
    expect(f.engine.getSnapshot().positions[0]?.status).toBe('open');
    expect(f.engine.getSnapshot().balanceCents).toBe('99900');
  });
  it('never puts v2 observations into the legacy sample bag read by already-open old tabs', async () => {
    const db = new IDBFactory(); const f = fixture(db); await f.engine.initialize();
    f.observed.push(observation(10000, '105')); f.setTime(10000); await f.engine.tick();
    const stored = await new Promise<any>((resolve, reject) => {
      const request = db.open('observed-path'); request.onerror = () => reject(request.error);
      request.onsuccess = () => { const connection = request.result; const read = connection.transaction('paper').objectStore('paper').get('ledger'); read.onsuccess = () => { connection.close(); resolve(read.result); }; };
    });
    expect(Object.keys(stored.samples).some(id => id.startsWith(OBSERVED_SAMPLE_PREFIX))).toBe(false);
    expect(Object.keys(stored.observedSamples)).toHaveLength(2);
    expect(Object.keys(f.engine.getAuditSnapshot().samples)).toHaveLength(3);
  });
  it('ignores future and malformed raw observations until valid source evidence is available', async () => {
    const f = fixture(); await f.engine.initialize(); await f.place();
    f.observed.push(observation(10000, '105'), { ...observation(6000, '105'), sampleId: 'wrong' }); await f.engine.tick();
    expect(f.engine.getGameSamples('btc-usd')).toHaveLength(1);
    expect(f.engine.getSnapshot().positions[0]?.status).toBe('open');
    f.setTime(10000); await f.engine.tick(); expect(f.engine.getSnapshot().positions[0]?.status).toBe('won');
  });
  it('rejects a v2 quote that references raw or non-persisted source evidence', async () => {
    const f = fixture(); await f.engine.initialize();
    const quote = f.quote(); const raw = { ...quote, provenance: { ...quote.provenance, sourceSampleId: f.observed[0]!.sampleId } };
    const engine = new PaperEngine({ indexedDB: new IDBFactory(), marketData: f.data, observedSamples: () => f.observed, settlementPolicy: OBSERVED_PATH_POLICY, clock: { getClock: () => ({ nowMs: 5000, uncertaintyMs: 0, ready: true }) }, quotes: { getQuote: () => raw }, broadcast: false }); engines.push(engine); await engine.initialize();
    expect(await engine.placeBet({ requestId: 'bad-reference', pageLoadId: engine.pageLoadId, quoteId: raw.quoteId, cellId: raw.cellId, stakeCents: '100' })).toMatchObject({ status: 'rejected', reason: 'INPUT_NOT_READY' });
  });
});
