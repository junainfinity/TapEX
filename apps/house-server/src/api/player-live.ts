import type { MarketId } from '@maya/contracts';
import { getMarket } from '@maya/config';
import type { Ctx } from './context.js';
import { HttpError, Router, sendJson } from './http.js';

/** Most seconds one `GET /v1/path` answer carries (15 minutes of the pinned first-seen path). */
export const PATH_MAX_SECONDS = 900;
/** Seconds returned when the client names no `fromMs`. */
export const PATH_DEFAULT_SECONDS = 300;

const CHAIN_NAMES: Record<string, string> = { local: 'Anvil (local)', 'base-sepolia': 'Base Sepolia', offline: 'Offline vault (no chain)' };
const EXPLORERS: Record<string, string | null> = { local: null, 'base-sepolia': 'https://sepolia.basescan.org', offline: null };

/**
 * Public routes the live game needs besides quotes: the chain it should connect a wallet to, and the house's pinned
 * first-seen price path (the exact path settlement uses), so the chart never draws another source.
 */
export function playerLiveRoutes(router: Router<Ctx>): void {
  // One build serves anvil and Base Sepolia: the wallet reads everything chain-specific from here.
  router.add({ method: 'GET', pattern: '/v1/chain-config', handler: ctx => {
    const { app } = ctx.deps;
    const network = app.chain.network;
    const addr = app.chain.addresses();
    const wallet = network !== 'offline';
    sendJson(ctx.res, 200, {
      network, chainId: app.chain.chainId, chainName: CHAIN_NAMES[network] ?? network, testnet: true,
      walletSupported: wallet, rpcUrl: wallet ? ctx.deps.publicRpcUrl ?? null : null, explorer: EXPLORERS[network] ?? null,
      token: { address: addr.token, symbol: 'tOPEN', name: 'Test OPEN (Maya-Live mock)', decimals: 18, mockOf: '$OPEN' },
      vault: addr.vault, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      ...(ctx.deps.auth ? { siwe: { domain: ctx.deps.auth.domain, uri: ctx.deps.auth.publicOrigin, chainId: ctx.deps.auth.chainId } } : {}),
    });
  } });

  router.add({ method: 'GET', pattern: '/v1/path', handler: ctx => {
    const { engine, feed } = ctx.deps.app;
    const m = ctx.url.searchParams.get('market');
    if (!m || !engine.markets.includes(m as MarketId)) throw new HttpError(400, 'VALIDATION_ERROR', `market must be one of ${engine.markets.join(', ')}`);
    const market = m as MarketId;
    const fromRaw = ctx.url.searchParams.get('fromMs');
    if (fromRaw !== null && fromRaw !== '' && !/^\d{1,16}$/.test(fromRaw)) throw new HttpError(400, 'VALIDATION_ERROR', 'fromMs must be a non-negative integer (ms)');
    const store = engine.paths.get(market)!;
    const latest = store.latest();
    const definition = getMarket(market);
    const head = { market, feedId: definition.feedId, pairId: definition.pairId, clockMs: engine.nowMs, speed: feed.status().speed, ruleVersion: 'maya-observed-linear-v2' };
    if (!latest) { sendJson(ctx.res, 200, { ...head, latestT: null, samples: [] }); return; }
    const fromT = fromRaw ? Math.floor(Number(fromRaw) / 1000) + 1 : latest.t - PATH_DEFAULT_SECONDS + 1;
    const startT = Math.max(fromT, latest.t - PATH_MAX_SECONDS + 1);
    const samples: Record<string, unknown>[] = [];
    for (let t = startT; t <= latest.t; t++) {
      const s = store.sample(t);
      if (s) samples.push({ t: s.t, sourceTimeMs: s.sourceTimeMs, price: s.priceText, sampleId: s.sampleId, receivedAtMs: s.receivedAtMs });
    }
    sendJson(ctx.res, 200, { ...head, latestT: latest.t, samples });
  } });
}
