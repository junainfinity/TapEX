import type { MarketId } from '@maya/contracts';
import { getMarket } from '@maya/config';
import { lookup, type CalibratedTable } from '@maya/house';
import type { HouseQuote, PublishedGrid } from '../quotes/quote-book.js';
import type { Prng } from './prng.js';

export type Strategy = 'casual' | 'chaser' | 'grinder' | 'streaker' | 'whale' | 'sniper1s' | 'sniper2s' | 'splitter' | 'farmer';
/** The Stage A crowd and the SPEC-10 adversaries (the SPEC-12 promo farmer is listed apart: PROMO_STRATEGIES). */
export const STRATEGIES: readonly Strategy[] = Object.freeze(['casual', 'chaser', 'grinder', 'streaker', 'whale', 'sniper1s', 'sniper2s', 'splitter']);
/**
 * SPEC-12 promo abuse: the farmer opens many new accounts and bets the lowest-odds offered square at its maximum stake
 * to farm the boosted odds, moving to a fresh account as soon as one reaches its per-tier boost cap. No foresight.
 */
export const PROMO_STRATEGIES: readonly Strategy[] = Object.freeze(['farmer']);
/** Every strategy the crowd can run. */
export const ALL_STRATEGIES: readonly Strategy[] = Object.freeze([...STRATEGIES, ...PROMO_STRATEGIES]);
/** Uninformed players (the honest crowd the defenses must keep happy). */
export const HONEST_STRATEGIES: readonly Strategy[] = Object.freeze(['casual', 'chaser', 'grinder', 'streaker', 'whale']);
/** Players with foresight of the next first-seen price(s). */
export const ADVERSARIAL_STRATEGIES: readonly Strategy[] = Object.freeze(['sniper1s', 'sniper2s', 'splitter']);

/** Stage A mix (sniper1s = the Stage A `sniper`) plus the SPEC-10 adversaries (weights are normalised). */
export const DEFAULT_MIX: Readonly<Record<Strategy, number>> = Object.freeze({ casual: 0.47, chaser: 0.15, grinder: 0.15, streaker: 0.13, whale: 0.05, sniper1s: 0.05, sniper2s: 0.01, splitter: 0.01, farmer: 0 });

export interface StrategyProfile {
  /** Sim credit granted on arrival (per account for the splitter), OPEN. */
  readonly credit: readonly [number, number];
  /** Base stake range, OPEN (log-uniform). */
  readonly stake: readonly [number, number];
  readonly betsPerMin: number;
  readonly sessionMin: number;
  readonly breakMin: number;
  readonly returnProb: number;
  readonly rebuyProb: number;
  readonly maxSessions: number;
}

export const PROFILES: Readonly<Record<Strategy, StrategyProfile>> = Object.freeze({
  casual: { credit: [50, 300], stake: [0.5, 5], betsPerMin: 4, sessionMin: 15, breakMin: 120, returnProb: 0.5, rebuyProb: 0.2, maxSessions: 5 },
  chaser: { credit: [50, 200], stake: [0.2, 2], betsPerMin: 3, sessionMin: 12, breakMin: 150, returnProb: 0.4, rebuyProb: 0.3, maxSessions: 4 },
  grinder: { credit: [200, 1000], stake: [2, 20], betsPerMin: 8, sessionMin: 30, breakMin: 90, returnProb: 0.7, rebuyProb: 0.3, maxSessions: 6 },
  streaker: { credit: [100, 500], stake: [1, 5], betsPerMin: 5, sessionMin: 20, breakMin: 120, returnProb: 0.5, rebuyProb: 0.25, maxSessions: 5 },
  whale: { credit: [5000, 50000], stake: [50, 1000], betsPerMin: 2, sessionMin: 25, breakMin: 180, returnProb: 0.6, rebuyProb: 0.3, maxSessions: 5 },
  sniper1s: { credit: [500, 2000], stake: [5, 50], betsPerMin: 6, sessionMin: 45, breakMin: 60, returnProb: 0.8, rebuyProb: 0.5, maxSessions: 8 },
  sniper2s: { credit: [500, 2000], stake: [5, 50], betsPerMin: 6, sessionMin: 45, breakMin: 60, returnProb: 0.8, rebuyProb: 0.5, maxSessions: 8 },
  splitter: { credit: [150, 400], stake: [5, 50], betsPerMin: 6, sessionMin: 45, breakMin: 60, returnProb: 0.8, rebuyProb: 0.5, maxSessions: 8 },
  // Credit per farming account; the stake range is not used (the farmer always bets its maximum stake).
  farmer: { credit: [1500, 3000], stake: [100, 1000], betsPerMin: 10, sessionMin: 60, breakMin: 30, returnProb: 0.9, rebuyProb: 0.5, maxSessions: 10 },
});

/** The splitter moves to a fresh account after this many accepted bets (below the toxicity minimum), up to maxAccounts. */
export const SPLITTER = Object.freeze({ betsPerAccount: 15, maxAccounts: 25 });
/** The farmer moves to a fresh account once its boost allowance is used up, up to maxAccounts per farmer. */
export const FARMER = Object.freeze({ maxAccounts: 20 });

/** Seconds of foresight per adversarial strategy. */
export function foresightOf(strategy: Strategy): 0 | 1 | 2 { return strategy === 'sniper2s' ? 2 : strategy === 'sniper1s' || strategy === 'splitter' ? 1 : 0; }

export interface Choice { readonly quote: HouseQuote; readonly stakeFactor: number }

export interface ChoiceContext {
  readonly grid: PublishedGrid;
  readonly prng: Prng;
  readonly streak: number;
  /** Replay lookahead for the adversarial strategies (price of a future second). */
  readonly peek?: (market: MarketId, t: number) => number | undefined;
  readonly table?: CalibratedTable;
  /** Only quotes the house would still accept are shown to players (a client never offers an expired square). */
  readonly stands?: (quote: HouseQuote) => boolean;
}

const offered = (ctx: ChoiceContext): HouseQuote[] => ctx.grid.quotes.filter((q): q is HouseQuote => q !== null && (!ctx.stands || ctx.stands(q)));

/** Square selection per strategy; undefined means the player skips this turn. */
export function chooseCell(strategy: Strategy, ctx: ChoiceContext): Choice | undefined {
  const quotes = offered(ctx);
  if (!quotes.length) return undefined;
  const { prng } = ctx;
  switch (strategy) {
    case 'casual': {
      const near = quotes.filter(q => Math.abs(q.bandOffset) <= 1 && q.window <= 3);
      const q = prng.pick(near.length ? near : quotes);
      return q && { quote: q, stakeFactor: 1 };
    }
    case 'chaser': {
      const far = quotes.filter(q => Math.abs(q.bandOffset) >= 2);
      const q = prng.pick(far);
      return q && { quote: q, stakeFactor: 1 };
    }
    case 'grinder': {
      let best = quotes[0]!;
      for (const q of quotes) if (q.x100 < best.x100 || (q.x100 === best.x100 && q.tau < best.tau)) best = q;
      return { quote: best, stakeFactor: 1 };
    }
    case 'farmer': {
      // The lowest-odds offered square (the most likely win); the crowd stakes the maximum the account may place.
      let best = quotes[0]!;
      for (const q of quotes) if (q.x100 < best.x100 || (q.x100 === best.x100 && q.tau < best.tau)) best = q;
      return { quote: best, stakeFactor: Number.POSITIVE_INFINITY };
    }
    case 'streaker': {
      const near = quotes.filter(q => Math.abs(q.bandOffset) <= 1);
      const q = prng.pick(near.length ? near : quotes);
      return q && { quote: q, stakeFactor: Math.min(8, 2 ** Math.min(ctx.streak, 3)) };
    }
    case 'whale': {
      const mid = quotes.filter(q => Math.abs(q.bandOffset) <= 2 && q.window >= 1 && q.window <= 4);
      const q = prng.pick(mid.length ? mid : quotes);
      return q && { quote: q, stakeFactor: 1 };
    }
    case 'sniper1s': case 'splitter': return sniperChoice(quotes, ctx, 1);
    case 'sniper2s': return sniperChoice(quotes, ctx, 2);
  }
}

/**
 * Adversarial: sees the first-seen price `horizon` seconds ahead before the server does and
 * re-prices the nearest windows with the calibrated table from that price; bets only when the
 * re-priced expected return is at least 1.03 (the Stage A sniper is horizon 1).
 */
function sniperChoice(quotes: readonly HouseQuote[], ctx: ChoiceContext, horizon: 1 | 2): Choice | undefined {
  if (!ctx.peek || !ctx.table) return undefined;
  const t = ctx.grid.grid.t, sigma = ctx.grid.grid.sigma;
  const next = ctx.peek(ctx.grid.market, t + horizon);
  if (next === undefined || sigma === undefined) return undefined;
  const h = Number(getMarket(ctx.grid.market).bandHeight.coefficient) * 10 ** getMarket(ctx.grid.market).bandHeight.exponent;
  const nb = Math.floor(next / h);
  let best: { quote: HouseQuote; ev: number } | undefined;
  for (const q of quotes) {
    if (q.tau > 8 + horizon || q.tau - horizon < 3) continue;
    const b = q.bandIndex - nb;
    if (Math.abs(b) > 3) continue;
    const fair = lookup(ctx.table, { s: (sigma * next) / h, frac: next / h - nb, tau: q.tau - horizon, b });
    if (!fair) continue;
    const ev = (fair.p * q.x100) / 100;
    if (!best || ev > best.ev) best = { quote: q, ev };
  }
  if (!best || best.ev < 1.03) return undefined;
  return { quote: best.quote, stakeFactor: Math.min(4, 1 + (best.ev - 1) * 10) };
}
