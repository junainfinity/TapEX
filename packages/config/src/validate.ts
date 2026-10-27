import { compareDecimal, integer } from '@maya/contracts';
import { DEMO_CONFIG } from './demo.js';
export function validateDemoConfig(config: typeof DEMO_CONFIG = DEMO_CONFIG): void {
  if (config.productName !== 'Maya' || config.mode !== 'paper-demo' || config.maxNewBetsPerPage !== 10) throw new RangeError('Invalid demo identity/mode/allowance');
  if (config.markets.map(m => m.id).join(',') !== 'btc-usd,eth-usd') throw new RangeError('Only two configured USD markets are supported');
  if (config.stakeMenuCents.join(',') !== DEMO_CONFIG.stakeMenuCents.join(',')) throw new RangeError('Stake menu differs from locked demo settings');
  let previous = 0n;
  for (const stake of config.stakeMenuCents) { const n = integer(stake); if (n <= previous || n > integer(config.maxStakePerBetCents)) throw new RangeError('Stake menu must be increasing and within cap'); previous = n; }
  if (!config.stakeMenuCents.includes(config.initialStakeCents) || previous !== integer(config.maxStakePerBetCents)) throw new RangeError('Invalid default or maximum stake');
  if (integer(config.maxAcceptedStakePerCellCents) < previous || integer(config.startingBalanceCents) <= 0n || integer(config.refillCents) <= 0n) throw new RangeError('Invalid money limits');
  if (!(config.zoom.min > 0 && config.zoom.min <= config.zoom.initial && config.zoom.initial <= config.zoom.max)) throw new RangeError('Invalid zoom bounds');
  for (const key of ['min', 'max', 'initial', 'inFactor', 'outFactor'] as const) if (config.zoom[key] !== DEMO_CONFIG.zoom[key]) throw new RangeError('Zoom differs from researched controls');
  if (config.windowMs !== 5000 || config.gridDivisor !== 6) throw new RangeError('Invalid researched grid');
  for (const market of config.markets) {
    const expected = DEMO_CONFIG.markets.find(item => item.id === market.id)!;
    if (compareDecimal(market.bandHeight, expected.bandHeight) !== 0 || market.feedId !== expected.feedId || market.pairId !== expected.pairId || market.symbol !== expected.symbol || market.pricePath !== expected.pricePath || market.chain !== expected.chain) throw new RangeError('Market geometry/source identity differs from locked demo');
  }
  if (new URL(config.consultationUrl).protocol !== 'https:') throw new RangeError('Consultation must use HTTPS');
}
