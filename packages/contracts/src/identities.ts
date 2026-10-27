import type { CellTerms, DecimalValue, MarketId, PriceSample } from './contracts.js';
import { compareDecimal, decimalToString, normalizeDecimal } from './units.js';

export function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Expected nonnegative integer Unix milliseconds');
}
export function windowStart(timeMs: number, widthMs = 5000): number {
  assertTimestamp(timeMs); if (!Number.isSafeInteger(widthMs) || widthMs <= 0) throw new RangeError('Invalid window width');
  return Math.floor(timeMs / widthMs) * widthMs;
}
export function cellId(cell: Pick<CellTerms, 'marketId' | 'startMs' | 'endMs' | 'lowerPrice' | 'upperPrice'>): string {
  if (cell.marketId !== 'btc-usd' && cell.marketId !== 'eth-usd') throw new TypeError('Unsupported market');
  assertTimestamp(cell.startMs); assertTimestamp(cell.endMs);
  if (cell.endMs <= cell.startMs || compareDecimal(cell.lowerPrice, cell.upperPrice) >= 0) throw new RangeError('Invalid cell bounds');
  return `maya-cell-v1:${cell.marketId}:${cell.startMs}:${cell.endMs}:${decimalToString(cell.lowerPrice)}:${decimalToString(cell.upperPrice)}`;
}
export function createCell(marketId: MarketId, startMs: number, lowerPrice: DecimalValue, upperPrice: DecimalValue, ruleVersion = 'maya-sampled-v1'): CellTerms {
  const terms = { marketId, startMs, endMs: startMs + 5000, lowerPrice: Object.freeze(normalizeDecimal(lowerPrice)), upperPrice: Object.freeze(normalizeDecimal(upperPrice)), ruleVersion };
  if (windowStart(startMs) !== startMs) throw new RangeError('Cell must align to five-second epoch grid');
  return Object.freeze({ ...terms, cellId: cellId(terms) });
}
export const createCellTerms = createCell;
export function sampleId(feedId: string, sourceTimeMs: number): string {
  assertTimestamp(sourceTimeMs); if (!feedId || feedId.includes(':')) throw new TypeError('Invalid feed identity');
  return `lynx:bsc:${feedId}:${sourceTimeMs}`;
}
export function sampleTouchesCell(sample: Pick<PriceSample, 'marketId' | 'sourceTimeMs' | 'price'>, cell: CellTerms): boolean {
  return sample.marketId === cell.marketId && sample.sourceTimeMs >= cell.startMs && sample.sourceTimeMs < cell.endMs && compareDecimal(sample.price, cell.lowerPrice) >= 0 && compareDecimal(sample.price, cell.upperPrice) <= 0;
}
