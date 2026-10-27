import type { CellTerms, MarketId } from '@maya/contracts';
import type { QuoteGrid, QuoteGridCell, TierId } from '@maya/house';
import { freezeDeep } from '../util.js';

export const QUOTE_TTL_MS = 1800;
export const MIN_LEAD_MS = 3000;
export const FRESHNESS_MS = 7000;

/** One immutable offered square. Acceptance resolves this record; clients never send odds. */
export interface HouseQuote {
  readonly quoteId: string;
  readonly revision: number;
  readonly market: MarketId;
  /** Quote instant (source second of the spot). */
  readonly t: number;
  readonly cellId: string;
  readonly cell: CellTerms;
  /** Absolute band index: lowerPrice / bandHeight. */
  readonly bandIndex: number;
  readonly window: number;
  readonly bandOffset: number;
  readonly tau: number;
  readonly x100: number;
  readonly grossX100: string;
  readonly capped: boolean;
  readonly p: number;
  readonly se: number;
  readonly q: number;
  readonly impact: number;
  /** Edge this square was priced with (grid edge plus any adaptive range adjustment). */
  readonly edge: number;
  /** Phase edge plus drawdown widening: the RTP the policy promises (flow surcharge and controller excluded). */
  readonly policyEdge: number;
  /** Adaptive controller adjustment included in `edge`. */
  readonly ctlAdjust: number;
  readonly phase: 'launch' | 'standard';
  readonly flagged: boolean;
  readonly tableId: string;
  readonly sourceTimeMs: number;
  readonly sourceSampleId: string;
  readonly spotText: string;
  readonly sigma: number;
  readonly generatedAtMs: number;
  readonly validUntilMs: number;
  readonly maxStakeCenti: string;
  /** SPEC-12 promo tier current when issued (absent in legacy launch-boost mode). */
  readonly tier?: TierId;
  /** SPEC-12: priced at the tier's boosted odds (the account's per-tier boost cap applies at acceptance). */
  readonly boosted?: boolean;
  /** SPEC-12 budget-guard adjustment included in a boosted edge. */
  readonly guardAdjust?: number;
  /** Which per-account grid the quote belongs to: main (boosted while a tier is current), standard (capped accounts) or flagged. */
  readonly variant?: QuoteVariant;
}

/**
 * Grid variants published per market and second. main: the grid every unflagged account sees (boosted odds while a promo
 * tier is current); standard: SPEC-12 standard pricing for accounts past their boost cap (only while main is boosted);
 * flagged: the toxicity surcharge grid.
 */
export type QuoteVariant = 'main' | 'standard' | 'flagged';
const VARIANT_SUFFIX: Readonly<Record<QuoteVariant, string>> = Object.freeze({ main: '', standard: '.s', flagged: '.f' });

export interface PublishedGrid {
  readonly market: MarketId;
  readonly flagged: boolean;
  readonly variant?: QuoteVariant;
  readonly generatedAtMs: number;
  readonly grid: QuoteGrid;
  /** Aligned with grid.cells; null where the cell is not offered (or its quote would expire at once). */
  readonly quotes: readonly (HouseQuote | null)[];
}

export interface PublishContext {
  readonly generatedAtMs: number;
  readonly sourceSampleId: string;
  readonly spotText: string;
  readonly flagged: boolean;
  readonly bootId: string;
  readonly ttlMs?: number;
  readonly minLeadMs?: number;
  readonly freshnessMs?: number;
  /** Grid variant (default: flagged → 'flagged', else 'main'). */
  readonly variant?: QuoteVariant;
  /** SPEC-12 promo facts stamped on every quote of the grid. */
  readonly promo?: { readonly tier: TierId; readonly boosted: boolean; readonly guardAdjust: number };
}

/** Expiry bound: source receive time + TTL, square start − minimum lead, source time + freshness. */
export function quoteValidUntil(generatedAtMs: number, startMs: number, sourceTimeMs: number, ttlMs = QUOTE_TTL_MS, minLeadMs = MIN_LEAD_MS, freshnessMs = FRESHNESS_MS): number {
  return Math.min(generatedAtMs + ttlMs, startMs - minLeadMs, sourceTimeMs + freshnessMs);
}

/** Issued quotes by id plus the latest grid per market; expired quotes are kept briefly for typed rejections. */
export class QuoteBook {
  private readonly quotes = new Map<string, HouseQuote>();
  private readonly order: { id: string; dropAtMs: number }[] = [];
  private orderHead = 0;
  private readonly latest = new Map<string, PublishedGrid>();
  issued = 0;

  constructor(private readonly keepExpiredMs = 60_000) {}

  publish(grid: QuoteGrid, ctx: PublishContext): PublishedGrid {
    const sourceTimeMs = grid.t * 1000;
    const variant: QuoteVariant = ctx.variant ?? (ctx.flagged ? 'flagged' : 'main');
    const quotes = grid.cells.map((cell: QuoteGridCell) => {
      if (!cell.available) return null;
      const validUntilMs = quoteValidUntil(ctx.generatedAtMs, cell.cell.startMs, sourceTimeMs, ctx.ttlMs, ctx.minLeadMs, ctx.freshnessMs);
      if (validUntilMs <= ctx.generatedAtMs) return null;
      const quote: HouseQuote = freezeDeep({
        quoteId: `${ctx.bootId}.${grid.market}.${grid.t}.${cell.index}${VARIANT_SUFFIX[variant]}`,
        revision: 1, market: grid.market, t: grid.t, cellId: cell.cell.cellId, cell: cell.cell,
        bandIndex: Number(BigInt(grid.bucket) + BigInt(cell.bandOffset)), window: cell.window, bandOffset: cell.bandOffset, tau: cell.tau,
        x100: cell.x100, grossX100: String(cell.x100), capped: cell.capped, p: cell.p!, se: cell.se!, q: cell.q!, impact: cell.impact ?? 0,
        // SPEC-12: a boosted quote's policy edge is the tier target (−lossBudget), without the budget guard's adjustment, so
        // the adaptive controller aims realized RTP at the tier target while the guard keeps the tier inside its budget.
        edge: cell.cellEdge, policyEdge: grid.edge.base + grid.edge.widen - (ctx.promo?.boosted ? ctx.promo.guardAdjust : 0), ctlAdjust: cell.rangeAdjust, phase: grid.edge.phase, flagged: ctx.flagged, tableId: grid.tableId,
        sourceTimeMs, sourceSampleId: ctx.sourceSampleId, spotText: ctx.spotText, sigma: grid.sigma!,
        generatedAtMs: ctx.generatedAtMs, validUntilMs, maxStakeCenti: cell.maxStakeCenti,
        ...(ctx.promo ? { tier: ctx.promo.tier, boosted: ctx.promo.boosted, guardAdjust: ctx.promo.guardAdjust, variant } : {}),
      });
      this.quotes.set(quote.quoteId, quote);
      this.order.push({ id: quote.quoteId, dropAtMs: validUntilMs + this.keepExpiredMs });
      this.issued++;
      return quote;
    });
    const published: PublishedGrid = Object.freeze({ market: grid.market, flagged: ctx.flagged, ...(ctx.promo ? { variant } : {}), generatedAtMs: ctx.generatedAtMs, grid, quotes: Object.freeze(quotes) });
    this.latest.set(`${grid.market}|${variant}`, published);
    // A standard grid only exists while main is boosted: drop a stale one so no account is quoted from it.
    if (variant === 'main' && !ctx.promo?.boosted) this.latest.delete(`${grid.market}|standard`);
    return published;
  }

  get(quoteId: string): HouseQuote | undefined { return this.quotes.get(quoteId); }
  latestGrid(market: MarketId, flagged = false): PublishedGrid | undefined { return this.latest.get(`${market}|${flagged ? 'flagged' : 'main'}`); }
  latestVariant(market: MarketId, variant: QuoteVariant): PublishedGrid | undefined { return this.latest.get(`${market}|${variant}`); }
  get size(): number { return this.quotes.size; }

  /** Forget quotes whose expiry passed more than `keepExpiredMs` ago (they are then QUOTE_CHANGED). */
  prune(nowMs: number): void {
    while (this.orderHead < this.order.length && this.order[this.orderHead]!.dropAtMs <= nowMs) {
      this.quotes.delete(this.order[this.orderHead]!.id); this.orderHead++;
    }
    if (this.orderHead > 50_000) { this.order.splice(0, this.orderHead); this.orderHead = 0; }
  }
}
