// Explicit developer entry only. Never imported by production index.html.
import { MayaGame } from '@maya/game-ui';
import { createCell, decimalToNumber, grossReturn, multiplyDecimalInteger, parseDecimal } from '@maya/contracts';
import type { CellTerms, MarketId, PositionSnapshot, PositionStatus, PriceSample, QuoteSnapshot } from '@maya/contracts';
import { DEMO_CONFIG, getMarket } from '@maya/config';

const BASE_TIME = Date.UTC(2026, 8, 20, 12, 0, 0);
const provenance = { modelId: 'DEVELOPER-MOTION-FIXTURE', configId: 'fixture', tableId: 'fixture', policyId: 'explicit-presentation-events', sourceSampleId: 'fixture' };
const host = document.querySelector<HTMLElement>('#app')!;
let game: MayaGame;
let selected: MarketId = 'eth-usd';
let positions: PositionSnapshot[] = [];
let balance = BigInt(DEMO_CONFIG.startingBalanceCents);
let count = 0;
let sequence = 0;
let offset = 0;
let startedAt = performance.now();
let running = true;
let ready = true;
let disposed = false;
let lastPlaced: string | undefined;
let fixedQuoteGrossX100: string | undefined;
const intents: { cellId: string; stakeCents: string; positionId: string }[] = [];

const toolbar = document.createElement('div');
toolbar.dataset.motionFixture = 'true';
toolbar.style.cssText = 'position:fixed;z-index:80;right:18px;top:94px;display:flex;gap:5px;flex-wrap:wrap;max-width:370px;padding:8px;border:1px solid #ad779561;border-radius:12px;background:#24101eee;font:10px DM Sans,sans-serif;';
toolbar.innerHTML = '<span style="flex-basis:100%;color:#f5aacc;letter-spacing:1px;margin-bottom:3px">DEVELOPER MOTION FIXTURE</span><button data-fixture-action="place">Place</button><button data-fixture-action="won">Win</button><button data-fixture-action="lost">Miss</button><button data-fixture-action="refunded">Return stake</button><button data-fixture-action="sequence">Play motion sequence</button>';
for (const button of toolbar.querySelectorAll<HTMLButtonElement>('button')) button.style.cssText = 'background:#4b273d;color:#f4d5e7;border-radius:6px;padding:7px 9px;font:inherit;min-height:32px;';
document.body.append(toolbar);

function now(): number { return BASE_TIME + offset + (running ? performance.now() - startedAt : 0); }

function fixturePrice(marketId: MarketId, time: number): number {
  const second = (time - BASE_TIME) / 1000;
  const shape = .82 * Math.sin(second / 5.4) + .19 * Math.sin(second * .76) + .04 * Math.sin(second * 2.1);
  return marketId === 'eth-usd' ? 2992.5 + shape : 90_000 + shape * 20;
}

function samples(marketId: MarketId): PriceSample[] {
  const market = getMarket(marketId);
  const latest = Math.floor(now() / 1000) * 1000;
  return Array.from({ length: 121 }, (_, index) => {
    const time = latest - (120 - index) * 1000;
    return { sampleId: `motion:${marketId}:${time}`, marketId, pairId: market.pairId, feedId: market.feedId, sourceTimeMs: time, receivedAtMs: time + 35, price: parseDecimal(fixturePrice(marketId, time).toFixed(4)) };
  });
}

function makeCell(marketId: MarketId, start: number, bucket: number): CellTerms {
  const band = getMarket(marketId).bandHeight;
  return createCell(marketId, start, multiplyDecimalInteger(band, BigInt(bucket)), multiplyDecimalInteger(band, BigInt(bucket + 1)));
}

function quote(cell: CellTerms): QuoteSnapshot | undefined {
  if (!ready || cell.startMs < now() + 3000 || cell.startMs > now() + 65_000) return undefined;
  const band = decimalToNumber(getMarket(cell.marketId).bandHeight);
  const distance = Math.abs((decimalToNumber(cell.lowerPrice) + band / 2 - fixturePrice(cell.marketId, now())) / band);
  if (distance > 6) return undefined;
  return { ...cell, quoteId: `motion-quote:${cell.cellId}`, revision: 1, grossX100: fixedQuoteGrossX100 ?? String(Math.round(200 + distance * 150)), sourceTimeMs: now(), generatedAtMs: now(), validUntilMs: now() + 60_000, simulated: true, provenance };
}

function publish(): void {
  if (disposed) return;
  game.update({ marketId: selected, samples: samples(selected), positions: positions.map(position => ({ ...position })), balanceCents: balance.toString(), acceptedCount: count, health: ready ? 'ready' : 'stale', healthMessage: 'DEVELOPER MOTION FIXTURE · deterministic sample prices · explicit outcomes', ready, nowMs: now(), maxHealthySourceAgeS: 7, leadTimeS: 3 });
}

function createView(): void {
  game = new MayaGame(host, {
    makeCell,
    quoteFor: quote,
    onBet: (value, stakeCents) => { accept(value, stakeCents); },
    onMarket: market => { selected = market; publish(); },
    onRefill: () => { balance += 100_000n; publish(); },
    onReload: () => location.reload(),
  });
  publish();
}

function accept(value: QuoteSnapshot, stakeCents: string): string {
  const id = `motion-position-${++sequence}`;
  const position: PositionSnapshot = { ...value, positionId: id, requestId: id, pageLoadId: 'motion-fixture', stakeCents, grossX100: value.grossX100, grossReturnCents: grossReturn(stakeCents, value.grossX100), acceptedAtMs: now(), status: 'open', provenance };
  positions = [position, ...positions];
  balance -= BigInt(stakeCents);
  count++;
  lastPlaced = id;
  intents.push({ cellId: value.cellId, stakeCents, positionId: id });
  publish();
  return id;
}

function place(options: { marketId?: MarketId; bucketOffset?: number; windowsAhead?: number; stakeCents?: string; grossX100?: string; sameAs?: string } = {}): string {
  const marketId = options.marketId ?? selected;
  const band = decimalToNumber(getMarket(marketId).bandHeight);
  const bucket = Math.floor(fixturePrice(marketId, now()) / band) + (options.bucketOffset ?? 0);
  const start = Math.ceil(now() / 5000) * 5000 + (options.windowsAhead ?? 1) * 5000;
  const existing = options.sameAs ? positions.find(position => position.positionId === options.sameAs) : undefined;
  if (options.sameAs && !existing) throw new Error('The fixture position to repeat does not exist');
  const cell: CellTerms = existing ? { cellId: existing.cellId, marketId: existing.marketId, startMs: existing.startMs, endMs: existing.endMs, lowerPrice: existing.lowerPrice, upperPrice: existing.upperPrice, ruleVersion: existing.ruleVersion } : makeCell(marketId, start, bucket);
  const value = { ...cell, quoteId: `motion-quote:${cell.cellId}`, revision: 1, grossX100: options.grossX100 ?? '251', sourceTimeMs: now(), generatedAtMs: now(), validUntilMs: now() + 60_000, simulated: true as const, provenance };
  return accept(value, options.stakeCents ?? '500');
}

function settle(id: string, status: Exclude<PositionStatus, 'open'>, options: { touchTimeMs?: number } = {}): void {
  const position = positions.find(item => item.positionId === id);
  if (!position || position.status !== 'open') { publish(); return; }
  const touchTimeMs = status === 'won' ? options.touchTimeMs ?? position.startMs + 1000 : undefined;
  if (touchTimeMs !== undefined && (!Number.isFinite(touchTimeMs) || touchTimeMs < position.startMs || touchTimeMs >= position.endMs)) throw new Error('Fixture touch time must be inside its canonical window');
  positions = positions.map(item => item.positionId === id ? { ...item, status, touchTimeMs, settledAtMs: now(), settlementReason: 'Developer explicitly triggered presentation event' } : item);
  if (status === 'won') balance += BigInt(position.grossReturnCents);
  if (status === 'refunded') balance += BigInt(position.stakeCents);
  publish();
}

/** Advances fixture data only; the production visual-time guard still decides when to show effects. */
function reveal(id: string): void {
  const position = positions.find(item => item.positionId === id);
  if (!position) return;
  const touch = (position as PositionSnapshot & { touchTimeMs?: number }).touchTimeMs;
  const resultTime = position.status === 'won' ? touch ?? position.endMs : position.endMs;
  offset += Math.max(0, resultTime + 3000 - now());
  publish();
}

function setMarket(marketId: MarketId): void {
  const select = game.root.querySelector<HTMLSelectElement>('select')!;
  select.value = marketId;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function reset(options: { historical?: boolean; marketId?: MarketId } = {}): void {
  game.dispose();
  selected = options.marketId ?? 'eth-usd'; positions = []; balance = BigInt(DEMO_CONFIG.startingBalanceCents); count = 0; offset = 0; startedAt = performance.now(); running = true; ready = true; lastPlaced = undefined; fixedQuoteGrossX100 = undefined; intents.length = 0;
  if (options.historical) {
    const band = getMarket(selected).bandHeight;
    const bucket = Math.floor(fixturePrice(selected, now()) / decimalToNumber(band));
    positions = ['won', 'lost', 'refunded'].map((status, index) => ({ ...makeCell(selected, BASE_TIME - 5000, bucket + index), positionId: `motion-history-${++sequence}`, requestId: `motion-history-${sequence}`, pageLoadId: 'historical-fixture', quoteId: 'historical', stakeCents: '500', grossX100: '251', grossReturnCents: '1255', acceptedAtMs: BASE_TIME - 10_000, settledAtMs: BASE_TIME, status: status as PositionStatus, provenance }));
  }
  disposed = false;
  createView();
}

async function sequenceDemo(): Promise<void> {
  reset();
  const first = place({ bucketOffset: 1 });
  const second = place({ bucketOffset: 0 });
  const third = place({ bucketOffset: -1 });
  await new Promise(resolve => setTimeout(resolve, 2400));
  settle(first, 'lost');
  reveal(first);
  await new Promise(resolve => setTimeout(resolve, 1900));
  settle(second, 'won');
  reveal(second);
  await new Promise(resolve => setTimeout(resolve, 2200));
  settle(third, 'refunded');
  reveal(third);
}

toolbar.addEventListener('click', event => {
  const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-fixture-action]')?.dataset.fixtureAction;
  if (action === 'place') place();
  else if (action === 'sequence') void sequenceDemo();
  else if (lastPlaced && (action === 'won' || action === 'lost' || action === 'refunded')) { settle(lastPlaced, action); reveal(lastPlaced); }
});

createView();
const timer = setInterval(publish, 100);
const api = {
  intents,
  place,
  settle,
  reveal,
  publish,
  reset,
  setMarket,
  replayView: () => { game.dispose(); createView(); },
  diagnostics: () => game.diagnostics(),
  snapshot: () => ({ marketId: selected, positions: positions.map(position => ({ ...position })), nowMs: now(), acceptedCount: count }),
  setReady: (value: boolean) => { ready = value; publish(); },
  setQuoteGross: (value: string | undefined) => { fixedQuoteGrossX100 = value; publish(); },
  setRunning: (value: boolean) => { offset = now() - BASE_TIME; startedAt = performance.now(); running = value; publish(); },
  advance: (milliseconds: number) => { offset += milliseconds; publish(); },
  showTools: (value: boolean) => { toolbar.hidden = !value; },
  runSequence: sequenceDemo,
  dispose: () => { disposed = true; clearInterval(timer); game.dispose(); toolbar.remove(); },
};
Object.assign(window, { __mayaMotionFixture: api });
