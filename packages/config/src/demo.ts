import type { MarketDefinition } from '@maya/contracts';

export const MARKETS: readonly MarketDefinition[] = Object.freeze([
  Object.freeze({ id: 'btc-usd', symbol: 'BTC/USD', pairId: 1, feedId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43', chain: 'bsc', pricePath: '/gridy/prices/bsc/1', bandHeight: Object.freeze({ coefficient: '1', exponent: 1 }) }),
  Object.freeze({ id: 'eth-usd', symbol: 'ETH/USD', pairId: 2, feedId: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace', chain: 'bsc', pricePath: '/gridy/prices/bsc/2', bandHeight: Object.freeze({ coefficient: '5', exponent: -1 }) })
]);
/** Default destination for the wallet button's Contact link and the consultation CTA. Override at build time with VITE_MAYA_CONSULTATION_URL (HTTPS only; validated by validateDemoConfig). */
export const DEFAULT_CONSULTATION_URL = 'https://quantellics.com';
const consultationUrlOverride = (import.meta as { readonly env?: Readonly<Record<string, string | undefined>> }).env?.VITE_MAYA_CONSULTATION_URL?.trim();
export const DEMO_CONFIG = Object.freeze({
  productName: 'Maya', mode: 'paper-demo', currency: 'USD',
  markets: MARKETS, initialMarketId: 'btc-usd' as const,
  stakeMenuCents: Object.freeze(['10', '50', '100', '500', '1000']),
  initialStakeCents: '100', maxStakePerBetCents: '1000', maxAcceptedStakePerCellCents: '5000',
  startingBalanceCents: '100000', refillCents: '100000', maxNewBetsPerPage: 10,
  zoom: Object.freeze({ min: 0.345, max: 0.9, initial: 0.6, inFactor: 1.1, outFactor: 0.9 }),
  windowMs: 5000, gridDivisor: 6, ruleVersion: 'maya-observed-linear-v2',
  consultationUrl: consultationUrlOverride || DEFAULT_CONSULTATION_URL, consultationTitle: 'Launch Maya under your brand',
  consultationBody: "You've placed 10 demo bets. Book a consultation to purchase Maya as your white-label trading game. We'll customise it for your business, launch it for you and hand over the full project source code.",
  consultationAction: 'Book a consultation', consultationSecondary: 'View my results',
  consultationSupport: 'Your current bets will finish while this page stays open. Refresh for a fresh $1,000 balance and 10 new demo bets.'
});
export type DemoConfig = typeof DEMO_CONFIG;
export function getMarket(marketId: string): MarketDefinition {
  const market = MARKETS.find(item => item.id === marketId); if (!market) throw new RangeError('Unsupported Maya market'); return market;
}
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) throw new RangeError('Invalid zoom'); return Math.min(DEMO_CONFIG.zoom.max, Math.max(DEMO_CONFIG.zoom.min, zoom));
}
export function stepZoom(zoom: number, direction: 'in' | 'out'): number { return clampZoom(zoom * (direction === 'in' ? DEMO_CONFIG.zoom.inFactor : DEMO_CONFIG.zoom.outFactor)); }
export function stepStake(stakeCents: string, direction: 'up' | 'down'): string {
  const i = DEMO_CONFIG.stakeMenuCents.indexOf(stakeCents); if (i < 0) throw new RangeError('Unsupported stake');
  return DEMO_CONFIG.stakeMenuCents[Math.min(DEMO_CONFIG.stakeMenuCents.length - 1, Math.max(0, i + (direction === 'up' ? 1 : -1)))]!;
}
