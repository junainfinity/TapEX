/** Locked demo market identities (mirror of @maya/config DEMO markets; feedIds are public Pyth price-feed IDs). */
export const MARKETS = Object.freeze({
  1: Object.freeze({ pairId: 1, id: 'btc-usd', symbol: 'BTC/USD', feedId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43', binanceSymbol: 'BTCUSDT' }),
  2: Object.freeze({ pairId: 2, id: 'eth-usd', symbol: 'ETH/USD', feedId: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace', binanceSymbol: 'ETHUSDT' }),
});
/** Same wire shape the market-data client parses: { chain, pair, feedId, count, prices:[{p,t}] } with raw numeric lexemes. */
export function priceBuffer(market, rows) {
  return `{"chain":"bsc","pair":${market.pairId},"feedId":"${market.feedId}","count":${rows.length},"prices":[${rows.map(r => `{"p":${r.p},"t":${r.t}}`).join(',')}]}`;
}
export const BUFFER_SECONDS = 120;
