import { bucketIndex, decimalToString, observedSampleId } from '@maya/contracts';
import { MARKETS, getMarket } from '@maya/config';

/** Unavailable cells are logged as a negative code in place of the multiplier. */
export const REASON_CODES = Object.freeze({ 'warming-up': -1, 'stale-source': -2, 'clock-uncertain': -3, 'insufficient-history': -4, 'invalid-volatility': -5, 'out-of-domain': -6, 'below-minimum': -7, 'too-late': -8, 'model-incompatible': -9, 'unsafe-numeric-range': -10 });
const UNKNOWN_REASON = -99;
const CELLS = 42;
const PATH_RETENTION_MS = 120_000;
const MAX_CATCH_UP = 10;
export const PRICE_HEADER = 't,first,final,lag_ms';
// Same order as PaperQuoteBook.candidates(): six 5-second windows, each with price bands -3..+3.
export const ODDS_HEADER = ['t', 'age_ms', 'spot', 'sigma', 'start', 'bucket', ...Array.from({ length: CELLS }, (_, i) => `w${Math.floor(i / 7)}b${i % 7 - 3}`)].join(',');
export const streamHeaders = (markets = MARKETS) => Object.fromEntries(markets.flatMap((m) => [[`prices-${m.id}`, PRICE_HEADER], [`odds-${m.id}`, ODDS_HEADER]]));

/**
 * Records what the game plays on. `first` is the first value seen for a second
 * (the game pins it and ignores later source revisions); `final` is the value
 * after the three-second stabilization. Odds come from the production quote
 * book fed with the same first-seen path the browser uses.
 */
export function createRecorder({ source, book, writer, markets = MARKETS, describe = () => ({}) }) {
  const states = new Map(markets.map((m) => [m.id, { first: new Map(), lastPriceMs: 0, lastOddsMs: 0 }]));
  let metaWritten = false;
  function resume() {
    for (const [marketId, state] of states) {
      const seconds = Number(writer.lastLine(`prices-${marketId}`)?.split(',')[0]);
      if (Number.isSafeInteger(seconds) && seconds > 0) state.lastPriceMs = seconds * 1000;
    }
  }
  function writeMeta() {
    writer.append('meta', JSON.stringify({ writtenAt: new Date().toISOString(), ...describe(), priceColumns: PRICE_HEADER, oddsColumns: 't,age_ms,spot,sigma,start,bucket,then 42 cells w<window 0-5>b<band offset -3..3>', reasonCodes: REASON_CODES }));
    metaWritten = true;
  }
  function onMarket(marketId) {
    const state = states.get(marketId);
    if (!state) return;
    const clock = source.getClock();
    if (!clock.ready) return;
    if (writer.roll() || !metaWritten) writeMeta();
    const fresh = [];
    for (const sample of source.getDisplaySamples(marketId)) {
      const t = sample.sourceTimeMs;
      if (t % 1000 !== 0 || t > clock.nowMs + clock.uncertaintyMs || state.first.has(t)) continue;
      state.first.set(t, sample); if (t > state.lastOddsMs) fresh.push(t);
    }
    const stable = new Map(source.getSamples(marketId).map((sample) => [sample.sourceTimeMs, sample]));
    const frontier = Math.max(0, ...stable.keys());
    const due = [...new Set([...state.first.keys(), ...stable.keys()])].filter((t) => t > state.lastPriceMs && t <= frontier).sort((a, b) => a - b);
    for (const t of due) {
      const first = state.first.get(t), final = stable.get(t);
      writer.append(`prices-${marketId}`, `${t / 1000},${first ? decimalToString(first.price) : ''},${final ? decimalToString(final.price) : ''},${first ? first.receivedAtMs - t : ''}`);
    }
    if (due.length) state.lastPriceMs = due.at(-1);
    // One poll can deliver two new seconds; the browser then prices only the newest.
    // The log prices each of them so the odds series has no holes. A start or a
    // long outage delivers a whole buffer at once and is not replayed.
    fresh.sort((a, b) => a - b);
    for (const t of state.lastOddsMs ? fresh.slice(-MAX_CATCH_UP) : fresh.slice(-1)) writeOdds(marketId, state, clock, t);
    if (fresh.length) state.lastOddsMs = fresh.at(-1);
    const keepFrom = Math.max(...state.first.keys(), 0) - PATH_RETENTION_MS;
    for (const t of state.first.keys()) if (t < keepFrom && t <= state.lastPriceMs) state.first.delete(t);
  }
  function writeOdds(marketId, state, clock, throughMs) {
    const path = [...state.first.values()].filter((sample) => sample.sourceTimeMs <= throughMs).sort((a, b) => a.sourceTimeMs - b.sourceTimeMs).map((sample) => ({ ...sample, sampleId: observedSampleId(sample) }));
    const latest = path.at(-1);
    book.updateMarket(marketId, path, source.getHealth(marketId), clock);
    const cells = book.candidates(marketId, clock);
    const values = cells.length === CELLS
      ? cells.map((cell) => { const result = book.quoteCell(cell, clock); return result.available ? result.quote.grossX100 : REASON_CODES[result.reason] ?? UNKNOWN_REASON; })
      : Array(CELLS).fill(REASON_CODES['clock-uncertain']);
    const sigma = book.getSigma(marketId);
    writer.append(`odds-${marketId}`, [latest.sourceTimeMs / 1000, Math.round(clock.nowMs - latest.sourceTimeMs), decimalToString(latest.price), sigma ? Number(sigma.toPrecision(9)) : 0, cells.length === CELLS ? cells[0].startMs / 1000 : 0, bucketIndex(latest.price, getMarket(marketId).bandHeight), ...values].join(','));
  }
  return { onMarket, resume };
}
