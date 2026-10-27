import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OBSERVED_PATH_POLICY, decimalToString } from '@maya/contracts';
import { MARKETS } from '@maya/config';
import { LynxMarketData, LIVE_POLICY } from '@maya/market-data';
import { PaperQuoteBook } from '@maya/pricing';
import { createRecorder, streamHeaders } from './recorder.mjs';
import { SegmentWriter } from './segments.mjs';
import { DATA_README } from './readme.mjs';

const root = process.env.MARKET_LOG_DIR ?? '/data';
const baseUrl = process.env.RELAY_URL ?? 'http://feed-relay:8787/api';
const INCOMPATIBLE_RESTART_MS = 5 * 60_000;

const writer = new SegmentWriter({ root, headers: streamHeaders() });
writeFileSync(join(root, 'README.md'), DATA_README);
await writer.compressClosed();

const source = new LynxMarketData({ baseUrl });
let heartbeatAt = 0;
const heartbeat = () => { if (Date.now() - heartbeatAt >= 10_000) { heartbeatAt = Date.now(); writeFileSync(join(root, '.heartbeat'), String(heartbeatAt)); } };
// The relay may still be starting; the source keeps retrying config and prices on its own cycle.
await source.start();
while (true) { try { source.getConfig(); source.getTable(); break; } catch { heartbeat(); await new Promise((resolve) => setTimeout(resolve, 2000)); } }

const book = new PaperQuoteBook({ table: source.getTable(), tableId: source.getTableId(), getConfig: () => source.getConfig(), policyId: OBSERVED_PATH_POLICY.policyId, quoteTtlMs: LIVE_POLICY.quoteTtlMs });
const recorder = createRecorder({ source, book, writer, describe: () => ({
  modelId: 'maya-gaussian-linear-six-v2', tableId: source.getTableId(), config: source.getConfig(), quotePolicyId: OBSERVED_PATH_POLICY.policyId, livePolicy: LIVE_POLICY,
  markets: MARKETS.map((m) => ({ id: m.id, symbol: m.symbol, pairId: m.pairId, feedId: m.feedId, bandHeight: decimalToString(m.bandHeight) })),
}) });
recorder.resume();
source.subscribe((marketId) => { heartbeat(); try { recorder.onMarket(marketId); } catch (error) { console.error('Maya recorder write failed', error); } });
console.log(`Maya recorder writing ${root} from ${baseUrl}`);

// A changed public config or table pins the source to "incompatible" until it is
// rebuilt. Exit so the container restarts and logs the new configuration.
let incompatibleSince = 0;
const watchdog = setInterval(() => {
  const stuck = MARKETS.every((m) => source.getHealth(m.id).status === 'incompatible');
  incompatibleSince = stuck ? incompatibleSince || Date.now() : 0;
  if (stuck && Date.now() - incompatibleSince >= INCOMPATIBLE_RESTART_MS) { console.error('Maya recorder restarting: public inputs changed'); void stop(1); }
}, 60_000);
async function stop(code) { clearInterval(watchdog); source.stop(); await writer.close(); process.exit(code); }
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void stop(0));
