import { MARKETS, priceBuffer, BUFFER_SECONDS } from './markets.mjs';

/** Optional live source: Binance public market-data REST (no key). 1 s kline close prices for BTCUSDT / ETHUSDT.
 * Note: USDT-quoted, used as a proxy for the USD display markets. */
export function createBinanceSource({ fetchImpl = fetch, baseUrl = process.env.BINANCE_BASE_URL ?? 'https://data-api.binance.vision' } = {}) {
  return {
    name: 'binance',
    async prices(pairId, now) {
      const market = MARKETS[pairId]; const started = now();
      const response = await fetchImpl(`${baseUrl}/api/v3/klines?symbol=${market.binanceSymbol}&interval=1s&limit=${BUFFER_SECONDS}`, { method: 'GET', signal: AbortSignal.timeout(10_000), cache: 'no-store', redirect: 'error' });
      if (!response.ok) {
        const error = new Error(`Binance returned HTTP ${response.status}`); error.upstreamStatus = response.status;
        const seconds = Number(response.headers.get('retry-after')); error.retryAfter = Number.isFinite(seconds) && seconds > 0 ? Math.min(300, Math.ceil(seconds)) : 2; throw error;
      }
      const date = response.headers.get('date');
      if (!date || !Number.isFinite(Date.parse(date))) throw new Error('Public source Date header missing');
      const text = await response.text(); if (text.length > 2_000_000) throw new Error('Source response exceeds size limit');
      const klines = JSON.parse(text);
      if (!Array.isArray(klines) || klines.length < 2) throw new Error('Binance kline payload invalid');
      const rows = klines.map(k => {
        const close = String(k[4]); const t = Number(k[0]) / 1000;
        if (!/^\d+(\.\d+)?$/.test(close) || !Number.isSafeInteger(t)) throw new Error('Binance kline row invalid');
        return { p: close.includes('.') ? close.replace(/0+$/, '').replace(/\.$/, '') : close, t };
      });
      return { bytes: Buffer.from(priceBuffer(market, rows)), upstreamDate: date, upstreamRttMs: now() - started };
    },
  };
}
