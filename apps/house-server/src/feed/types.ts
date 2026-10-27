import type { DecimalValue, MarketId } from '@maya/contracts';

/** One first-seen 1 s price as delivered to the server. */
export interface FeedSample {
  readonly market: MarketId;
  /** Source time, integer Unix seconds. */
  readonly t: number;
  /** Exact source lexeme. */
  readonly priceText: string;
  readonly price: DecimalValue;
  /** Model projection of the price (never used for money or settlement). */
  readonly value: number;
  /** Server clock at delivery. */
  readonly receivedAtMs: number;
}

export type FeedMode = 'replay' | 'live';

export interface FeedStatus {
  readonly mode: FeedMode;
  readonly clockMs: number;
  readonly speed: number;
  readonly markets: readonly { readonly market: MarketId; readonly lastT?: number; readonly lastError?: string }[];
  readonly done?: boolean;
}

export interface Feed {
  readonly mode: FeedMode;
  readonly markets: readonly MarketId[];
  /** Clock uncertainty used by settlement (0 in replay: the server clock is the feed clock). */
  readonly uncertaintyMs: number;
  nowMs(): number;
  /**
   * Move the clock (replay: to `toMs`; live: to the wall clock) and return the newly delivered
   * first-seen samples in delivery order.
   */
  advance(toMs?: number): readonly FeedSample[];
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): FeedStatus;
}
