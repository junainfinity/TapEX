import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDecimal, type MarketId } from '@maya/contracts';
import {
  DEFAULT_EDGE_SCHEDULE, DEFAULT_PRICING_CONFIG, DEFAULT_PROMO, DEFAULT_RISK_LIMITS, LiabilityBook, buildQuoteGrid, refitTable, tierPricing, type CalibratedTable, type OfferedGridCell,
  type QuoteGrid, type TierId,
} from '@maya/house';
import { loadMarketRows } from './feed/csv.js';
import { PathStore } from './market/path-store.js';
import { loadPublishedTable } from './refit/tables.js';

/**
 * SPEC-12 §8: the payout table players see per tier, from the recorded market path and the current tables. Every
 * `everyS` seconds over the period it builds the quote grid each tier would publish (nominal tier pricing: no controller
 * or guard adjustment, empty book, production minimum lead of 4 s) and reports, per tier, the distribution of the
 * multiplier on: the lowest-odds offered square; the most common square (the current band in the nearest offered window,
 * where the casual, grinder, streaker and farmer strategies concentrate); one band away (±1, same window); three bands
 * away (±3, same window); and the share of priced squares hidden below the tier's minimum win.
 */
export interface PayoutOptions {
  readonly marketDataDir: string;
  readonly fromMs: number;
  readonly hours: number;
  readonly everyS: number;
  readonly markets: readonly MarketId[];
  /** 'published': the tables shipped with @maya/house; 'refit': refit from the trailing 36 h at the period start (what the server quotes with). */
  readonly tables: 'published' | 'refit';
  readonly minLeadS?: number;
}

type Dist = { n: number; offered: number; median: number | null; p10: number | null; p90: number | null; min: number | null; max: number | null; medianP: number | null };
function dist(xs: number[], ps: number[], total: number): Dist {
  const s = [...xs].sort((a, b) => a - b), sp = [...ps].sort((a, b) => a - b);
  const q = (arr: number[], f: number) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(f * arr.length))]! : null);
  return { n: total, offered: xs.length, median: q(s, 0.5), p10: q(s, 0.1), p90: q(s, 0.9), min: s[0] ?? null, max: s.at(-1) ?? null, medianP: q(sp, 0.5) };
}

export function payoutTable(opts: PayoutOptions): Record<string, unknown> {
  const promo = DEFAULT_PROMO;
  const tiers: TierId[] = ['launch', 'growth', 'scale', 'standard'];
  const pricings = tiers.map(tier => {
    const t = promo.tiers.find(x => x.id === tier);
    const resolved = t ? { tier, label: t.label, config: t, untilPlayers: t.untilPlayers, untilTurnoverCenti: BigInt(t.untilTurnoverCenti) } : { tier, label: promo.standardLabel, untilPlayers: null, untilTurnoverCenti: null };
    const p = tierPricing(resolved, DEFAULT_EDGE_SCHEDULE.standard);
    return { tier, pricing: p, promo: p.boosted ? { tier, boosted: true, baseEdge: p.baseEdge, minWinX100: p.minWinX100! } : { tier, boosted: false, baseEdge: p.baseEdge } };
  });
  const acc = new Map<string, { lowest: number[]; lowestP: number[]; common: number[]; commonP: number[]; one: number[]; oneP: number[]; three: number[]; threeP: number[]; grids: number; priced: number; hidden: number; aboveCap: { one: number; three: number } }>();
  const tableInfo: Record<string, string> = {};
  const minLeadS = opts.minLeadS ?? 4;
  const toMs = opts.fromMs + opts.hours * 3_600_000;
  for (const market of opts.markets) {
    const rows = loadMarketRows(opts.marketDataDir, market, opts.fromMs - (opts.tables === 'refit' ? 37 * 3_600_000 : 700_000), toMs);
    const path = new PathStore(market);
    for (const r of rows) path.pin({ t: r.t, priceText: r.priceText, price: parseDecimal(r.priceText), value: Number(r.priceText), receivedAtMs: r.t * 1000 });
    let table: CalibratedTable;
    if (opts.tables === 'refit') {
      const now = Math.floor(opts.fromMs / 1000) - 1;
      const res = refitTable([...path.values].filter(([t]) => t <= now), { market, now, trainHours: 36, minRows: 600 });
      if (!res.ok) throw new Error(`refit ${market}: ${res.reason} ${res.detail}`);
      table = res.table;
    } else table = loadPublishedTable(market);
    tableInfo[market] = table.id;
    const book = new LiabilityBook();
    for (let t = Math.ceil(opts.fromMs / 1000); t * 1000 < toMs; t += opts.everyS) {
      const spot = path.sample(t);
      if (!spot) continue;
      for (const { tier, promo: tierPromo } of pricings) {
        const grid: QuoteGrid = buildQuoteGrid({
          market, t, spot: spot.price, path, table, pricing: DEFAULT_PRICING_CONFIG, schedule: DEFAULT_EDGE_SCHEDULE, registeredPlayers: 0, limits: DEFAULT_RISK_LIMITS, book,
          equityCenti: 500_000_000n, minLeadS, promo: tierPromo,
        });
        if (grid.reason) continue;
        let a = acc.get(tier);
        if (!a) { a = { lowest: [], lowestP: [], common: [], commonP: [], one: [], oneP: [], three: [], threeP: [], grids: 0, priced: 0, hidden: 0, aboveCap: { one: 0, three: 0 } }; acc.set(tier, a); }
        a.grids++;
        const offered = grid.cells.filter((c): c is OfferedGridCell => c.available);
        for (const c of grid.cells) { if (c.p === undefined) continue; a.priced++; if (!c.available && c.reason === 'below-minimum') a.hidden++; }
        if (!offered.length) continue;
        const low = offered.reduce((x, y) => (y.x100 < x.x100 ? y : x));
        a.lowest.push(low.x100); a.lowestP.push(low.p!);
        // The nearest window with an offered square in the current band.
        const nearest = Math.min(...grid.cells.filter(c => c.available && c.bandOffset === 0).map(c => c.window));
        if (!Number.isFinite(nearest)) continue;
        const inWindow = (b: number) => grid.cells.find(c => c.window === nearest && c.bandOffset === b);
        const common = inWindow(0);
        if (common?.available) { a.common.push(common.x100); a.commonP.push(common.p!); }
        for (const b of [-1, 1]) { const c = inWindow(b); if (c?.available) { a.one.push(c.x100); a.oneP.push(c.p!); } else if (c && !c.available && c.reason === 'hidden-above-cap') a.aboveCap.one++; }
        for (const b of [-3, 3]) { const c = inWindow(b); if (c?.available) { a.three.push(c.x100); a.threeP.push(c.p!); } else if (c && !c.available && c.reason === 'hidden-above-cap') a.aboveCap.three++; }
      }
    }
  }
  const result = tiers.map(tier => {
    const a = acc.get(tier);
    const p = pricings.find(x => x.tier === tier)!.pricing;
    if (!a) return { tier, grids: 0 };
    return {
      tier, label: p.label, baseEdge: p.baseEdge, expectedReturn: 1 - p.baseEdge, minWinX100: p.boosted ? p.minWinX100 : DEFAULT_PRICING_CONFIG.minX100, grids: a.grids,
      lowest: dist(a.lowest, a.lowestP, a.grids), mostCommon: dist(a.common, a.commonP, a.grids), oneBandAway: dist(a.one, a.oneP, a.grids * 2), threeBandsAway: dist(a.three, a.threeP, a.grids * 2),
      aboveCapHidden: a.aboveCap, pricedCells: a.priced, hiddenBelowMinWin: a.hidden, hiddenShare: a.priced ? a.hidden / a.priced : null,
    };
  });
  return {
    generatedAt: new Date().toISOString(), period: { from: new Date(opts.fromMs).toISOString(), hours: opts.hours, everyS: opts.everyS }, markets: opts.markets, tables: opts.tables, tableIds: tableInfo, minLeadS,
    note: 'Nominal tier pricing (floor(100 × (1 − edge) / q), q = p + impact with an empty book), before the adaptive controller and the budget guard; standard pricing uses the standard edge 8 % and the 1.01× minimum; squares above 50× are hidden.',
    tiers: result,
  };
}

const fx = (x100: number | null | undefined) => (x100 === null || x100 === undefined ? '—' : `${(x100 / 100).toFixed(2)}×`);
export function renderPayoutMarkdown(r: Record<string, unknown>): string {
  const tiers = r['tiers'] as Record<string, any>[];
  const lines = [`Tables: ${String(r['tables'])} (${Object.entries(r['tableIds'] as Record<string, string>).map(([m, id]) => `${m} \`${id}\``).join(', ')}); ${String((r['period'] as Record<string, unknown>)['from'])} + ${String((r['period'] as Record<string, unknown>)['hours'])} h, one grid every ${String((r['period'] as Record<string, unknown>)['everyS'])} s per market, minimum lead ${String(r['minLeadS'])} s. ${String(r['note'])}`, ''];
  lines.push('| Tier | Expected return | Min win | Lowest odds (median; p10–p90; min) | Most common square: current band, nearest window (median; p10–p90) | 1 band away (median; p10–p90) | 3 bands away (median; p10–p90; offered) | Squares hidden below min win |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const t of tiers) {
    if (!t['grids']) continue;
    const d = (k: string, extra = false) => { const v = t[k] as Dist; return `${fx(v.median)}; ${fx(v.p10)}–${fx(v.p90)}${k === 'lowest' ? `; ${fx(v.min)}` : ''}${extra ? `; ${(100 * v.offered / Math.max(1, v.n)).toFixed(1)}%` : ''} (p ≈ ${v.medianP === null ? '—' : v.medianP.toFixed(3)})`; };
    lines.push(`| ${String(t['tier'])} | ${(100 * (t['expectedReturn'] as number)).toFixed(0)}% | ${fx(t['minWinX100'] as number)} | ${d('lowest')} | ${d('mostCommon')} | ${d('oneBandAway')} | ${d('threeBandsAway', true)} | ${String(t['hiddenBelowMinWin'])} of ${String(t['pricedCells'])} (${(100 * ((t['hiddenShare'] as number) ?? 0)).toFixed(3)}%) |`);
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const get = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const out = get('--out');
  const opts: PayoutOptions = {
    marketDataDir: resolve(get('--market-data', '../market-data')!), fromMs: Date.parse(get('--from', '2026-09-23T02:00:00Z')!), hours: Number(get('--hours', '24')),
    everyS: Number(get('--every', '30')), markets: (get('--markets', 'btc-usd,eth-usd')!).split(',') as MarketId[], tables: get('--tables', 'published') === 'refit' ? 'refit' : 'published',
    minLeadS: Number(get('--min-lead', '4')),
  };
  const r = payoutTable(opts);
  const md = renderPayoutMarkdown(r);
  if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, `payouts-${opts.tables}-lead${opts.minLeadS}.json`), JSON.stringify(r, null, 2) + '\n'); writeFileSync(join(out, `payouts-${opts.tables}-lead${opts.minLeadS}.md`), md); }
  console.log(md);
}
