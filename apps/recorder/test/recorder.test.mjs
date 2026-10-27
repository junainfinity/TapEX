import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { MARKETS } from '@maya/config';
import { ODDS_HEADER, PRICE_HEADER, REASON_CODES, createRecorder, streamHeaders } from '../src/recorder.mjs';
import { SEGMENT_MS, SegmentWriter, segmentLabel, segmentStart } from '../src/segments.mjs';

// Segments are aligned to the Unix epoch, so they start at 07:00, 12:00, 17:00 ... UTC on this date.
const START = Date.UTC(2026, 8, 21, 7, 0, 0);
function temp(t) { const dir = mkdtempSync(join(tmpdir(), 'maya-recorder-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const lines = (file) => readFileSync(file, 'utf8').trim().split('\n');
const sample = (t, price, receivedAtMs = t + 400) => ({ sampleId: `s${t}`, marketId: 'btc-usd', pairId: 1, feedId: MARKETS[0].feedId, sourceTimeMs: t, receivedAtMs, price: { coefficient: String(Math.round(price * 100)), exponent: -2 } });

test('REC-1 five-hour segments: header once, closed segment gzipped once and removed', async (t) => {
  let now = START + 1000;
  assert.equal(segmentStart(START), START); assert.equal(segmentLabel(START), '20260921T0700Z');
  const writer = new SegmentWriter({ root: temp(t), headers: { 'prices-btc-usd': PRICE_HEADER }, now: () => now });
  const open = writer.file('prices-btc-usd');
  writer.append('prices-btc-usd', '1,2,3,4'); writer.append('prices-btc-usd', '2,3,4,5');
  now += SEGMENT_MS;
  writer.append('prices-btc-usd', '9,9,9,9');
  await writer.close();
  assert.equal(existsSync(open), false);
  assert.deepEqual(gunzipSync(readFileSync(open + '.gz')).toString().trim().split('\n'), [PRICE_HEADER, '1,2,3,4', '2,3,4,5']);
  assert.deepEqual(lines(writer.file('prices-btc-usd')), [PRICE_HEADER, '9,9,9,9']);
  assert.equal(writer.lastLine('prices-btc-usd'), '9,9,9,9');
});

function harness(t, root = temp(t)) {
  const state = { nowMs: 0, display: [], stable: [], paths: [] };
  const source = { getClock: () => ({ ready: true, nowMs: state.nowMs, uncertaintyMs: 50 }), getDisplaySamples: () => state.display, getSamples: () => state.stable, getHealth: () => ({ status: 'ready' }) };
  const book = {
    updateMarket: (_market, path) => state.paths.push(path), getSigma: () => 0.000123456789123,
    candidates: () => Array.from({ length: 42 }, (_, i) => ({ startMs: 1_000_000 + Math.floor(i / 7) * 5000, index: i })),
    quoteCell: (cell) => cell.index % 2 ? { available: false, reason: 'too-late' } : { available: true, quote: { grossX100: String(150 + cell.index) } },
  };
  const writer = new SegmentWriter({ root, headers: streamHeaders(), now: () => START + 1000 });
  return { state, writer, root, recorder: createRecorder({ source, book, writer, describe: () => ({ tableId: 'table' }) }) };
}

test('REC-2 first-seen price is pinned, final comes from stabilized samples, odds only on a new point', async (t) => {
  const { state, writer, recorder } = harness(t);
  state.nowMs = 4400; state.display = [1000, 2000, 3000, 4000].map((time) => sample(time, 60000 + time / 1000));
  recorder.onMarket('btc-usd');
  // The source revises 2000 and 4000; the revision must not replace the pinned first value.
  state.nowMs = 5400; state.display = [sample(1000, 60001), sample(2000, 60009.5), sample(3000, 60003), sample(4000, 59999), sample(5000, 60005)];
  state.stable = [sample(1000, 60001), sample(2000, 60009.5)];
  recorder.onMarket('btc-usd');
  recorder.onMarket('btc-usd');
  recorder.onMarket('unknown-market');
  // Two seconds in one poll: each gets its own odds row, priced on the path up to that second.
  state.nowMs = 7400; state.display = [...state.display, sample(6000, 60006, 7400), sample(7000, 60007, 7400)];
  recorder.onMarket('btc-usd');
  await writer.close();
  assert.deepEqual(lines(writer.file('prices-btc-usd')), [PRICE_HEADER, '1,60001,60001,400', '2,60002,60009.5,400']);
  const odds = lines(writer.file('odds-btc-usd'));
  assert.deepEqual(odds.slice(1).map((line) => line.split(',').slice(0, 3).join(',')), ['4,400,60004', '5,400,60005', '6,1400,60006', '7,400,60007']);
  assert.equal(odds[0], ODDS_HEADER); assert.deepEqual(state.paths.map((path) => path.at(-1).sourceTimeMs), [4000, 5000, 6000, 7000]);
  const row = odds[2].split(',');
  assert.equal(row.length, 48);
  assert.deepEqual(row.slice(0, 8), ['5', '400', '60005', '0.000123456789', '1000', '6000', '150', String(REASON_CODES['too-late'])]);
  assert.equal(state.paths[1].find((s) => s.sourceTimeMs === 4000).price.coefficient, '6000400');
  assert.match(state.paths[1][0].sampleId, /^maya-observed-v2:/);
  const meta = lines(writer.file('meta')).map(JSON.parse);
  assert.equal(meta.length, 1); assert.equal(meta[0].tableId, 'table');
});

test('REC-3 a restart resumes after the last price row already on disk', async (t) => {
  const first = harness(t);
  first.state.nowMs = 5400; first.state.display = [1000, 2000, 3000].map((time) => sample(time, 60000)); first.state.stable = first.state.display.slice(0, 2);
  first.recorder.onMarket('btc-usd'); await first.writer.close();
  const second = harness(t, first.root);
  second.recorder.resume();
  second.state.nowMs = 6400; second.state.display = [1000, 2000, 3000].map((time) => sample(time, 60000, 6400)); second.state.stable = second.state.display;
  second.recorder.onMarket('btc-usd'); await second.writer.close();
  assert.deepEqual(lines(second.writer.file('prices-btc-usd')).map((line) => line.split(',')[0]), ['t', '1', '2', '3']);
});
