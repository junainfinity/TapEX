import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import { mayaHouseVaultAbi } from './abi.js';
import { writeFileAtomic } from './deployment.js';
import { describe } from './errors.js';
import { backoffDelay } from './retry.js';

export interface DepositEvent {
  readonly player: string;
  readonly amountWei: bigint;
  readonly depositId: bigint;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
}

export interface DepositLog extends DepositEvent {
  readonly blockHash: string;
}

/** A vault `Withdrawn` event (redeemed voucher); identity `player:nonce`. */
export interface WithdrawalEvent {
  readonly player: string;
  readonly amountWei: bigint;
  readonly nonce: bigint;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
}

export interface WithdrawalLog extends WithdrawalEvent {
  readonly blockHash: string;
}

export interface VaultLogs {
  readonly deposits: readonly DepositLog[];
  readonly withdrawals: readonly WithdrawalLog[];
}

export interface BlockRef {
  readonly number: bigint;
  readonly hash: string;
  readonly timestamp: bigint;
}

/** What the indexer reads from a chain; `viemDepositSource` implements it over eth_getLogs. */
export interface DepositSource {
  head(): Promise<bigint>;
  block(number: bigint): Promise<BlockRef>;
  /** Vault `Deposited` logs in [fromBlock, toBlock], inclusive. */
  deposits(fromBlock: bigint, toBlock: bigint): Promise<readonly DepositLog[]>;
  /**
   * Vault `Deposited` and `Withdrawn` logs in [fromBlock, toBlock] in one query. When present the indexer
   * uses it instead of `deposits` and also indexes withdrawals; a deposit-only source indexes deposits only.
   */
  vaultLogs?(fromBlock: bigint, toBlock: bigint): Promise<VaultLogs>;
}

type EventKind = 'deposit' | 'withdrawal';

interface DeliveredRecord {
  readonly id: string;
  readonly kind: EventKind;
  blockNumber: bigint;
  orphaned: boolean;
}

interface Queued<E> {
  readonly key: string;
  readonly event: E;
}

export interface IndexerCursor {
  /** 2 = deposits and withdrawals; version-1 cursors (deposits only) are discarded and rescanned. */
  readonly version: 2;
  readonly chainId: number;
  readonly vault: string;
  readonly startBlock: string;
  readonly deploymentBlockHash: string | null;
  readonly scannedTo: string | null;
  readonly watermark: { readonly number: string; readonly hash: string; readonly timestamp: string } | null;
  /** Whether withdrawals were indexed with this cursor (a cursor from a deposit-only source is rescanned). */
  readonly withdrawalsIndexed: boolean;
  /** Reorg-stable key → delivered event (deposit keys `tx#ordinal`, withdrawal keys `w:player:nonce`), retained window only. */
  readonly delivered: readonly { readonly key: string; readonly id: string; readonly blockNumber: string; readonly orphaned: boolean }[];
  /** Found while nobody listened; delivered on the first subscription. */
  readonly pending: readonly { readonly key: string; readonly player: string; readonly amountWei: string; readonly depositId: string; readonly txHash: string; readonly logIndex: number; readonly blockNumber: string }[];
  readonly pendingWithdrawals: readonly { readonly key: string; readonly player: string; readonly amountWei: string; readonly nonce: string; readonly txHash: string; readonly logIndex: number; readonly blockNumber: string }[];
}

export interface CursorStore {
  load(): IndexerCursor | null;
  save(cursor: IndexerCursor): void;
}

export function memoryCursorStore(initial: IndexerCursor | null = null): CursorStore & { readonly current: IndexerCursor | null } {
  let current = initial;
  return {
    get current() { return current; },
    load: () => current,
    save: cursor => { current = cursor; },
  };
}

/** JSON cursor file, written atomically after every scanned chunk. A corrupt file is ignored (full rescan). */
export function fileCursorStore(file: string, log?: (line: string) => void): CursorStore {
  return {
    load() {
      let text: string;
      try { text = readFileSync(file, 'utf8'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      try {
        const parsed = JSON.parse(text) as IndexerCursor;
        if (parsed?.version !== 2) throw new Error(`unsupported cursor version ${String(parsed?.version)}`);
        return parsed;
      } catch (error) {
        log?.(`chain: ignoring unreadable indexer cursor ${file} (${describe(error)}); rescanning from the deployment block`);
        return null;
      }
    },
    save(cursor) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(file, `${JSON.stringify(cursor)}\n`);
    },
  };
}

export interface IndexerOptions {
  readonly chainId: number;
  readonly vault: string;
  /** First block that can hold a vault deposit (the deployment block). */
  readonly startBlock: bigint;
  readonly deploymentBlockHash?: string | undefined;
  readonly confirmations: number;
  readonly reorgDepth: number;
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly maxBackoffMs?: number;
  /** Delivered-deposit records are kept this many blocks behind the scan head (≥ 4 × reorgDepth). */
  readonly retainBlocks?: number;
  readonly store: CursorStore;
  readonly log?: (line: string) => void;
}

export interface PollResult {
  readonly head: bigint;
  readonly scannedFrom: bigint | null;
  readonly scannedTo: bigint | null;
  /** Deposits newly found in this poll (queued for, or already handed to, listeners). */
  readonly found: number;
  /** Withdrawals newly found in this poll. */
  readonly foundWithdrawals: number;
  readonly orphaned: number;
  readonly reorg: boolean;
}

export interface IndexerStatus {
  readonly running: boolean;
  readonly head: bigint | null;
  readonly scannedTo: bigint | null;
  readonly watermark: BlockRef | null;
  readonly confirmations: number;
  readonly lagBlocks: number;
  readonly delivered: number;
  readonly pending: number;
  readonly withdrawalsIndexed: boolean;
  readonly withdrawalsDelivered: number;
  readonly pendingWithdrawals: number;
  /** Ids of delivered deposits (`tx:logIndex`) and withdrawals (`w:player:nonce`) that left the canonical chain. */
  readonly orphaned: readonly string[];
  readonly reorgs: number;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
}

const RANGE_ERROR = /range|limit|too many|exceed|10000|block count|response size/i;

/** Reorg-stable identity: a re-included transaction keeps its hash and its sequence of Deposited logs. */
export function depositKey(txHash: string, ordinalInTx: number): string {
  return `${txHash.toLowerCase()}#${ordinalInTx}`;
}

export function depositId(event: Pick<DepositEvent, 'txHash' | 'logIndex'>): string {
  return `${event.txHash.toLowerCase()}:${event.logIndex}`;
}

/** Reorg-stable and replay-proof: the vault accepts each (account, nonce) once ever. */
export function withdrawalKey(event: Pick<WithdrawalEvent, 'player' | 'nonce'>): string {
  return `w:${event.player.toLowerCase()}:${event.nonce}`;
}

/**
 * Polls vault `Deposited` logs in block ranges, `confirmations` behind head, and delivers each
 * deposit to listeners exactly once per cursor lifetime (also across restarts when the cursor is
 * persisted). Every poll re-reads the last `reorgDepth` scanned blocks: a deposit that appears in
 * a replacement block is delivered then, one that moved block is recognised by its reorg-stable
 * key (tx hash + ordinal of its Deposited log within the tx) and not delivered again, and one that
 * disappeared is reported as orphaned (it cannot be un-delivered; the confirmations are the guard).
 * The watermark block's hash is checked each poll; if it changed, the whole retained window is
 * re-read. Deposits found while nobody listens are queued (and persisted) until the first listener
 * subscribes. With a source that implements `vaultLogs`, vault `Withdrawn` events get the same treatment
 * (keyed by `player:nonce`, delivered to `onWithdrawal` listeners, queued until the first one).
 */
export class DepositIndexer {
  private readonly listeners = new Set<(deposit: DepositEvent) => void>();
  private readonly withdrawalListeners = new Set<(withdrawal: WithdrawalEvent) => void>();
  private readonly records = new Map<string, DeliveredRecord>();
  private pending: Queued<DepositEvent>[] = [];
  private pendingWithdrawals: Queued<WithdrawalEvent>[] = [];
  private withdrawalsDelivered = 0;
  private readonly withdrawalsIndexed: boolean;
  private scannedTo: bigint | null = null;
  private currentWatermark: BlockRef | null = null;
  private lastHead: bigint | null = null;
  private deliveredTotal = 0;
  private reorgs = 0;
  private failures = 0;
  private lastError: string | null = null;
  private running = false;
  private loaded = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<unknown> | undefined;
  private flushScheduled = false;
  private readonly retainBlocks: bigint;
  private readonly maxBackoffMs: number;

  constructor(private readonly source: DepositSource, private readonly options: IndexerOptions) {
    if (!Number.isSafeInteger(options.confirmations) || options.confirmations < 0) throw new RangeError('confirmations must be a non-negative integer');
    if (!Number.isSafeInteger(options.reorgDepth) || options.reorgDepth < 0) throw new RangeError('reorgDepth must be a non-negative integer');
    if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1) throw new RangeError('batchSize must be a positive integer');
    this.retainBlocks = BigInt(Math.max(options.retainBlocks ?? 1_024, options.reorgDepth * 4, 1));
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.withdrawalsIndexed = typeof source.vaultLogs === 'function';
  }

  onDeposit(listener: (deposit: DepositEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.pending.length > 0) this.scheduleFlush();
    return () => { this.listeners.delete(listener); };
  }

  /** Vault `Withdrawn` events (only when the source implements `vaultLogs`). */
  onWithdrawal(listener: (withdrawal: WithdrawalEvent) => void): () => void {
    this.withdrawalListeners.add(listener);
    if (this.pendingWithdrawals.length > 0) this.scheduleFlush();
    return () => { this.withdrawalListeners.delete(listener); };
  }

  /** Loads the cursor, runs one poll (throwing if it fails) and then keeps polling in the background. */
  async start(): Promise<void> {
    if (this.running) return;
    this.load();
    await this.pollOnce();
    this.running = true;
    this.schedule(this.options.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inflight?.catch(() => undefined);
  }

  /** One scan step; exposed for tests and for callers that want to force a catch-up. */
  async pollOnce(): Promise<PollResult> {
    if (!this.loaded) this.load();
    // Serialise with the background loop.
    const run = (this.inflight ?? Promise.resolve()).catch(() => undefined).then(() => this.scan());
    this.inflight = run;
    return run;
  }

  lagBlocks(): number {
    if (this.lastHead === null) return 0;
    const scanned = this.scannedTo ?? this.options.startBlock - 1n;
    const lag = this.lastHead - scanned;
    return lag <= 0n ? 0 : lag > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(lag);
  }

  /** Latest fully scanned block: every deposit mined at or below it has been found. */
  watermark(): BlockRef | null { return this.currentWatermark; }

  pendingCount(): number { return this.pending.length; }

  pendingWithdrawalCount(): number { return this.pendingWithdrawals.length; }

  withdrawalListenerCount(): number { return this.withdrawalListeners.size; }

  status(): IndexerStatus {
    return Object.freeze({
      running: this.running, head: this.lastHead, scannedTo: this.scannedTo, watermark: this.currentWatermark,
      confirmations: this.options.confirmations, lagBlocks: this.lagBlocks(), delivered: this.deliveredTotal,
      pending: this.pending.length, withdrawalsIndexed: this.withdrawalsIndexed, withdrawalsDelivered: this.withdrawalsDelivered,
      pendingWithdrawals: this.pendingWithdrawals.length, orphaned: Object.freeze([...this.records.values()].filter(r => r.orphaned).map(r => r.id)),
      reorgs: this.reorgs, consecutiveFailures: this.failures, lastError: this.lastError,
    });
  }

  // ---------------------------------------------------------------- internals

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pollOnce().then(
        () => { this.failures = 0; this.lastError = null; this.schedule(this.options.pollIntervalMs); },
        error => {
          this.failures++;
          this.lastError = describe(error);
          const delay = backoffDelay(this.failures, this.options.pollIntervalMs, this.maxBackoffMs);
          this.options.log?.(`chain: deposit indexer poll failed (${this.lastError}); retrying in ${delay} ms`);
          this.schedule(delay);
        },
      );
    }, delayMs);
    this.timer.unref?.();
  }

  private load(): void {
    this.loaded = true;
    const cursor = this.options.store.load();
    if (!cursor) return;
    const why = cursor.chainId !== this.options.chainId ? 'chainId differs'
      : cursor.vault.toLowerCase() !== this.options.vault.toLowerCase() ? 'vault differs'
      : cursor.startBlock !== this.options.startBlock.toString() ? 'start block differs'
      : (cursor.deploymentBlockHash ?? null) !== (this.options.deploymentBlockHash?.toLowerCase() ?? null) ? 'deployment block hash differs (chain was reset)'
      : cursor.version !== 2 ? `cursor version ${String(cursor.version)} predates withdrawal indexing`
      : cursor.withdrawalsIndexed !== this.withdrawalsIndexed ? 'withdrawal indexing changed'
      : null;
    if (why) {
      this.options.log?.(`chain: discarding indexer cursor (${why}); rescanning from block ${this.options.startBlock}`);
      return;
    }
    this.scannedTo = cursor.scannedTo === null ? null : BigInt(cursor.scannedTo);
    this.currentWatermark = cursor.watermark ? Object.freeze({ number: BigInt(cursor.watermark.number), hash: cursor.watermark.hash, timestamp: BigInt(cursor.watermark.timestamp) }) : null;
    for (const r of cursor.delivered) this.records.set(r.key, { id: r.id, kind: kindOf(r.key), blockNumber: BigInt(r.blockNumber), orphaned: r.orphaned });
    this.pending = cursor.pending.map(p => ({
      key: p.key,
      event: Object.freeze({ player: p.player, amountWei: BigInt(p.amountWei), depositId: BigInt(p.depositId), txHash: p.txHash, logIndex: p.logIndex, blockNumber: BigInt(p.blockNumber) }),
    }));
    this.pendingWithdrawals = (cursor.pendingWithdrawals ?? []).map(p => ({
      key: p.key,
      event: Object.freeze({ player: p.player, amountWei: BigInt(p.amountWei), nonce: BigInt(p.nonce), txHash: p.txHash, logIndex: p.logIndex, blockNumber: BigInt(p.blockNumber) }),
    }));
    for (const p of this.pending) if (!this.records.has(p.key)) this.records.set(p.key, { id: depositId(p.event), kind: 'deposit', blockNumber: p.event.blockNumber, orphaned: false });
    for (const p of this.pendingWithdrawals) if (!this.records.has(p.key)) this.records.set(p.key, { id: p.key, kind: 'withdrawal', blockNumber: p.event.blockNumber, orphaned: false });
  }

  private resetState(reason: string): void {
    this.options.log?.(`chain: resetting deposit indexer (${reason}); rescanning from block ${this.options.startBlock}`);
    this.scannedTo = null;
    this.currentWatermark = null;
    this.records.clear();
    this.pending = [];
    this.pendingWithdrawals = [];
  }

  private async scan(): Promise<PollResult> {
    // Deposits restored from the cursor (or queued before anyone listened) go out first, in order.
    if (this.deliver()) this.persist();
    const head = await this.source.head();
    this.lastHead = head;
    let reorg = false;
    if (this.scannedTo !== null && this.scannedTo > head) {
      // Head fell below what we already scanned: a reorg to a shorter chain or a reset dev chain.
      if (this.scannedTo - head > this.retainBlocks) this.resetState(`head ${head} is below scanned block ${this.scannedTo}`);
      else { reorg = true; this.reorgs++; this.options.log?.(`chain: head ${head} fell below scanned block ${this.scannedTo}; re-reading the retained window`); }
    }
    if (!reorg && this.currentWatermark && this.currentWatermark.number <= head) {
      const now = await this.source.block(this.currentWatermark.number);
      if (now.hash.toLowerCase() !== this.currentWatermark.hash.toLowerCase()) {
        reorg = true; this.reorgs++;
        this.options.log?.(`chain: block ${this.currentWatermark.number} was reorganised; re-reading the retained window`);
      }
    }
    const target = head - BigInt(this.options.confirmations);
    const start = this.options.startBlock;
    // Block hashes chain to their parents: an unchanged watermark hash proves nothing at or below it changed.
    if (!reorg && this.currentWatermark && this.scannedTo === target && this.currentWatermark.number === target) {
      return Object.freeze({ head, scannedFrom: null, scannedTo: this.scannedTo, found: 0, foundWithdrawals: 0, orphaned: 0, reorg });
    }
    const overlap = reorg ? this.retainBlocks : BigInt(this.options.reorgDepth);
    const base = this.scannedTo === null ? null : (this.scannedTo < target ? this.scannedTo : target);
    let from = base === null ? start : base + 1n - overlap;
    if (from < start) from = start;
    let found = 0; let foundWithdrawals = 0; let orphaned = 0;
    if (target < start || from > target) {
      // Anything delivered from blocks that no longer exist is orphaned.
      if (this.scannedTo !== null && target < this.scannedTo) orphaned += this.markVanished(head);
      this.persist();
      return Object.freeze({ head, scannedFrom: null, scannedTo: this.scannedTo, found, foundWithdrawals, orphaned, reorg });
    }
    let batch = BigInt(this.options.batchSize);
    for (let chunkFrom = from; chunkFrom <= target;) {
      let chunkTo = chunkFrom + batch - 1n; if (chunkTo > target) chunkTo = target;
      let logs: VaultLogs;
      try {
        logs = await this.fetch(chunkFrom, chunkTo);
      } catch (error) {
        if (batch > 1n && RANGE_ERROR.test(describe(error))) {
          batch /= 2n;
          this.options.log?.(`chain: getLogs range rejected (${describe(error)}); retrying with ${batch}-block ranges`);
          continue;
        }
        throw error;
      }
      const result = this.apply(logs, chunkFrom, chunkTo);
      found += result.found; foundWithdrawals += result.foundWithdrawals; orphaned += result.orphaned;
      // Deliver in the same tick as discovery (never across an await), so a caller never sees found-but-undelivered
      // deposits, and before persisting: a crash in between re-delivers (the ledger is idempotent) instead of losing one.
      this.deliver();
      // The cursor only moves back on a rewind (target below what was scanned), and then only once the rewound range is re-read.
      if (this.scannedTo === null || chunkTo > this.scannedTo || chunkTo === target) this.scannedTo = chunkTo;
      if (chunkTo === target) {
        // The watermark only advances after everything at or below it was delivered.
        const wm = await this.source.block(target);
        this.currentWatermark = Object.freeze({ number: wm.number, hash: wm.hash, timestamp: wm.timestamp });
        orphaned += this.markVanished(head);
      }
      this.prune();
      this.persist();
      chunkFrom = chunkTo + 1n;
    }
    return Object.freeze({ head, scannedFrom: from, scannedTo: this.scannedTo, found, foundWithdrawals, orphaned, reorg });
  }

  private async fetch(fromBlock: bigint, toBlock: bigint): Promise<VaultLogs> {
    if (this.source.vaultLogs) return this.source.vaultLogs(fromBlock, toBlock);
    return { deposits: await this.source.deposits(fromBlock, toBlock), withdrawals: [] };
  }

  private apply(logs: VaultLogs, fromBlock: bigint, toBlock: bigint): { found: number; foundWithdrawals: number; orphaned: number } {
    const inRange = (l: { blockNumber: bigint }) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock;
    const byChainOrder = (a: { blockNumber: bigint; logIndex: number }, b: { blockNumber: bigint; logIndex: number }) =>
      (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);
    const sorted = [...logs.deposits]
      .filter(inRange)
      .sort(byChainOrder);
    const ordinals = new Map<string, number>();
    const seen = new Set<string>();
    let found = 0; let foundWithdrawals = 0; let orphaned = 0;
    for (const log of sorted) {
      const tx = log.txHash.toLowerCase();
      const ordinal = ordinals.get(tx) ?? 0; ordinals.set(tx, ordinal + 1);
      const key = depositKey(tx, ordinal);
      seen.add(key);
      if (this.reconfirm(key, log.blockNumber)) continue;
      const event: DepositEvent = Object.freeze({ player: log.player, amountWei: log.amountWei, depositId: log.depositId, txHash: log.txHash, logIndex: log.logIndex, blockNumber: log.blockNumber });
      this.records.set(key, { id: depositId(event), kind: 'deposit', blockNumber: log.blockNumber, orphaned: false });
      this.pending.push({ key, event });
      found++;
    }
    for (const log of [...logs.withdrawals].filter(inRange).sort(byChainOrder)) {
      const key = withdrawalKey(log);
      seen.add(key);
      if (this.reconfirm(key, log.blockNumber)) continue;
      const event: WithdrawalEvent = Object.freeze({ player: log.player, amountWei: log.amountWei, nonce: log.nonce, txHash: log.txHash, logIndex: log.logIndex, blockNumber: log.blockNumber });
      this.records.set(key, { id: key, kind: 'withdrawal', blockNumber: log.blockNumber, orphaned: false });
      this.pendingWithdrawals.push({ key, event });
      foundWithdrawals++;
    }
    for (const [key, record] of this.records) {
      if (record.orphaned || record.blockNumber < fromBlock || record.blockNumber > toBlock || seen.has(key)) continue;
      if (this.orphan(key, record)) orphaned++;
    }
    return { found, foundWithdrawals, orphaned };
  }

  /** A known event seen again (possibly in another block after a reorg): refresh it, never re-deliver. */
  private reconfirm(key: string, blockNumber: bigint): boolean {
    const known = this.records.get(key);
    if (!known) return false;
    if (known.orphaned) { known.orphaned = false; this.options.log?.(`chain: ${known.kind} ${known.id} is back on the canonical chain at block ${blockNumber}`); }
    known.blockNumber = blockNumber;
    return true;
  }

  /** Delivered deposits from blocks above the current head no longer exist. */
  private markVanished(head: bigint): number {
    let orphaned = 0;
    for (const [key, record] of this.records) if (!record.orphaned && record.blockNumber > head && this.orphan(key, record)) orphaned++;
    return orphaned;
  }

  /** Returns true when an already-delivered deposit was orphaned; an undelivered one is simply dropped. */
  private orphan(key: string, record: DeliveredRecord): boolean {
    const queue: Queued<unknown>[] = record.kind === 'deposit' ? this.pending : this.pendingWithdrawals;
    const queued = queue.findIndex(p => p.key === key);
    if (queued >= 0) {
      queue.splice(queued, 1);
      this.records.delete(key);
      this.options.log?.(`chain: undelivered ${record.kind} ${record.id} left the canonical chain; dropped`);
      return false;
    }
    record.orphaned = true;
    this.options.log?.(`chain: ALERT ${record.kind} ${record.id} (block ${record.blockNumber}) left the canonical chain after it was delivered; reconcile the ledger`);
    return true;
  }

  private prune(): void {
    if (this.scannedTo === null) return;
    const floor = this.scannedTo - this.retainBlocks;
    const pendingKeys = new Set([...this.pending.map(p => p.key), ...this.pendingWithdrawals.map(p => p.key)]);
    for (const [key, record] of this.records) if (record.blockNumber < floor && !record.orphaned && !pendingKeys.has(key)) this.records.delete(key);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      if (this.deliver()) this.persist();
    });
  }

  /** Hands queued events to the current listeners of their kind, in chain order; returns whether anything was delivered. */
  private deliver(): boolean {
    let delivered = false;
    if (this.listeners.size > 0 && this.pending.length > 0) {
      const batch = this.pending; this.pending = [];
      for (const { event } of batch) {
        this.deliveredTotal++;
        for (const listener of [...this.listeners]) {
          try { listener(event); } catch (error) {
            this.options.log?.(`chain: deposit listener threw for ${depositId(event)}: ${describe(error)}`);
          }
        }
      }
      delivered = true;
    }
    if (this.withdrawalListeners.size > 0 && this.pendingWithdrawals.length > 0) {
      const batch = this.pendingWithdrawals; this.pendingWithdrawals = [];
      for (const { key, event } of batch) {
        this.withdrawalsDelivered++;
        for (const listener of [...this.withdrawalListeners]) {
          try { listener(event); } catch (error) {
            this.options.log?.(`chain: withdrawal listener threw for ${key}: ${describe(error)}`);
          }
        }
      }
      delivered = true;
    }
    return delivered;
  }

  private persist(): void {
    const cursor: IndexerCursor = {
      version: 2, chainId: this.options.chainId, withdrawalsIndexed: this.withdrawalsIndexed, vault: this.options.vault.toLowerCase(), startBlock: this.options.startBlock.toString(),
      deploymentBlockHash: this.options.deploymentBlockHash?.toLowerCase() ?? null,
      scannedTo: this.scannedTo === null ? null : this.scannedTo.toString(),
      watermark: this.currentWatermark ? { number: this.currentWatermark.number.toString(), hash: this.currentWatermark.hash, timestamp: this.currentWatermark.timestamp.toString() } : null,
      delivered: [...this.records.entries()].map(([key, r]) => ({ key, id: r.id, blockNumber: r.blockNumber.toString(), orphaned: r.orphaned })),
      pending: this.pending.map(({ key, event }) => ({ key, player: event.player, amountWei: event.amountWei.toString(), depositId: event.depositId.toString(), txHash: event.txHash, logIndex: event.logIndex, blockNumber: event.blockNumber.toString() })),
      pendingWithdrawals: this.pendingWithdrawals.map(({ key, event }) => ({ key, player: event.player, amountWei: event.amountWei.toString(), nonce: event.nonce.toString(), txHash: event.txHash, logIndex: event.logIndex, blockNumber: event.blockNumber.toString() })),
    };
    this.options.store.save(cursor);
  }
}

function kindOf(key: string): EventKind {
  return key.startsWith('w:') ? 'withdrawal' : 'deposit';
}

const depositedEvent = getAbiItem({ abi: mayaHouseVaultAbi, name: 'Deposited' });
const withdrawnEvent = getAbiItem({ abi: mayaHouseVaultAbi, name: 'Withdrawn' });

function located(l: { transactionHash: Hex | null; logIndex: number | null; blockNumber: bigint | null; blockHash: Hex | null }) {
  if (l.transactionHash === null || l.logIndex === null || l.blockNumber === null || l.blockHash === null) throw new Error('getLogs returned a pending log');
  return { txHash: l.transactionHash, logIndex: l.logIndex, blockNumber: l.blockNumber, blockHash: l.blockHash };
}

export function viemDepositSource(client: PublicClient, vault: Address): DepositSource {
  return {
    async vaultLogs(fromBlock, toBlock) {
      // One eth_getLogs for both event signatures (topic0 OR-filter).
      const logs = await client.getLogs({ address: vault, events: [depositedEvent, withdrawnEvent], fromBlock, toBlock, strict: true });
      const deposits: DepositLog[] = [];
      const withdrawals: WithdrawalLog[] = [];
      for (const l of logs) {
        if (l.removed) continue;
        if (l.eventName === 'Deposited') {
          deposits.push(Object.freeze({ player: l.args.player, amountWei: l.args.amount, depositId: l.args.depositId, ...located(l) }));
        } else if (l.eventName === 'Withdrawn') {
          withdrawals.push(Object.freeze({ player: l.args.player, amountWei: l.args.amount, nonce: l.args.nonce, ...located(l) }));
        }
      }
      return { deposits, withdrawals };
    },
    head: () => client.getBlockNumber({ cacheTime: 0 }),
    async block(number) {
      const b = await client.getBlock({ blockNumber: number });
      if (b.hash === null || b.number === null) throw new Error(`block ${number} is pending`);
      return Object.freeze({ number: b.number, hash: b.hash, timestamp: b.timestamp });
    },
    async deposits(fromBlock, toBlock) {
      const logs = await client.getLogs({ address: vault, event: depositedEvent, fromBlock, toBlock, strict: true });
      return logs.filter(l => !l.removed).map(l => {
        if (l.transactionHash === null || l.logIndex === null || l.blockNumber === null || l.blockHash === null) throw new Error('getLogs returned a pending log');
        return Object.freeze({
          player: l.args.player, amountWei: l.args.amount, depositId: l.args.depositId,
          txHash: l.transactionHash as Hex, logIndex: l.logIndex, blockNumber: l.blockNumber, blockHash: l.blockHash as Hex,
        });
      });
    },
  };
}
