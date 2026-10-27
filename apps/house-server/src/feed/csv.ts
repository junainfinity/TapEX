import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { MarketId } from '@maya/contracts';

/** One market-log row: first-seen price for a source second and its first-sighting lag. */
export interface LogRow { readonly t: number; readonly priceText: string; readonly lagMs: number }

export const SEGMENT_MS = 5 * 3_600_000;
const FILE_RE = /^prices-(btc-usd|eth-usd)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z\.csv\.gz$/;
const PRICE_RE = /^\d{1,15}(?:\.\d{1,18})?$/;

export interface SegmentFile { readonly file: string; readonly market: MarketId; readonly startMs: number }

/** Every price segment under `root` (recursive), sorted by market then start. */
export function listSegments(root: string): SegmentFile[] {
  const out: SegmentFile[] = [];
  for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    const name = entry.replaceAll('\\', '/').split('/').pop()!;
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const startMs = Date.UTC(Number(m[2]), Number(m[3]) - 1, Number(m[4]), Number(m[5]), Number(m[6]));
    out.push({ file: join(root, entry), market: m[1] as MarketId, startMs });
  }
  return out.sort((a, b) => (a.market < b.market ? -1 : a.market > b.market ? 1 : a.startMs - b.startMs));
}

/** Parse one gz segment; malformed rows are skipped (they cannot become evidence). */
export function parseSegment(bytes: Uint8Array): LogRow[] {
  const lines = gunzipSync(bytes).toString('utf8').split('\n');
  const rows: LogRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const [t, first, final, lag] = line.split(',');
    const priceText = first || final || '';
    const ts = Number(t);
    if (!Number.isSafeInteger(ts) || ts <= 0 || !PRICE_RE.test(priceText) || !(Number(priceText) > 0)) continue;
    const lagMs = Number(lag);
    rows.push({ t: ts, priceText, lagMs: Number.isFinite(lagMs) && lagMs >= 0 ? lagMs : 0 });
  }
  return rows;
}

/**
 * First-seen rows for one market over [fromMs, toMs): segments are read in order and duplicate
 * seconds (a restart can repeat rows across a boundary) keep the first row, as the recorder notes.
 */
export function loadMarketRows(root: string, market: MarketId, fromMs: number, toMs: number): LogRow[] {
  const seen = new Set<number>();
  const rows: LogRow[] = [];
  for (const seg of listSegments(root)) {
    if (seg.market !== market || seg.startMs + SEGMENT_MS + 120_000 <= fromMs || seg.startMs - 120_000 >= toMs) continue;
    for (const row of parseSegment(readFileSync(seg.file))) {
      if (row.t * 1000 < fromMs || row.t * 1000 >= toMs || seen.has(row.t)) continue;
      seen.add(row.t); rows.push(row);
    }
  }
  return rows.sort((a, b) => a.t - b.t);
}

/** First logged second (ms) and the end of the last segment for a market, or undefined when empty. */
export function logCoverage(root: string, market: MarketId): { readonly fromMs: number; readonly toMs: number } | undefined {
  const segs = listSegments(root).filter(s => s.market === market);
  for (const seg of segs) {
    const rows = parseSegment(readFileSync(seg.file));
    if (!rows.length) continue;
    let first = rows[0]!.t; for (const r of rows) if (r.t < first) first = r.t;
    return { fromMs: first * 1000, toMs: segs.at(-1)!.startMs + SEGMENT_MS };
  }
  return undefined;
}
