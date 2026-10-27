import { keccak256, toHex } from 'viem';
import type { BlockRef, DepositLog, DepositSource, VaultLogs, WithdrawalLog } from '../../src/chain/indexer.js';

export interface FakeDeposit {
  readonly player: string;
  readonly amountWei: bigint;
  /** Defaults to a fresh unique hash. */
  readonly txHash?: string;
}

export interface FakeWithdrawal {
  readonly player: string;
  readonly amountWei: bigint;
  readonly nonce: bigint;
  /** Defaults to a fresh unique hash. */
  readonly txHash?: string;
}

interface FakeBlock {
  readonly number: bigint;
  readonly hash: string;
  readonly timestamp: bigint;
  readonly logs: DepositLog[];
  readonly withdrawals: WithdrawalLog[];
}

/**
 * In-memory chain of blocks carrying vault Deposited and Withdrawn logs, with reorgs. Block hashes depend
 * on the fork generation, so a replaced block gets a new hash (as its parent link would change on a real chain).
 * It serves both log kinds through `vaultLogs` (one query, like the viem source); `depositOnly(chain)` hides
 * that to exercise a deposit-only source.
 */
export class FakeChain implements DepositSource {
  private blocks: FakeBlock[] = [];
  private fork = 0;
  private txCounter = 0;
  private nextDepositId = 1n;
  /** `deposits` counts log queries of either API. */
  calls = { head: 0, block: 0, deposits: 0 };
  ranges: [bigint, bigint][] = [];
  /** Queue of errors thrown by the next source calls (any method). */
  failures: Error[] = [];
  /** Reject getLogs spans wider than this many blocks. */
  maxRange: bigint | null = null;
  /** Called synchronously whenever the indexer awaits a source call. */
  onCall: ((method: 'head' | 'block' | 'deposits') => void) | null = null;

  constructor(genesisBlocks = 1) {
    for (let i = 0; i < genesisBlocks; i++) this.mine();
  }

  get headNumber(): bigint { return BigInt(this.blocks.length - 1); }

  /** Mines one block holding `deposits` (logIndex in order); returns its number. */
  mine(deposits: readonly FakeDeposit[] = [], extraLogsBefore = 0): bigint {
    return this.mineWith({ deposits, extraLogsBefore });
  }

  /** Mines one block with deposits then withdrawals (log indexes in that order, after `extraLogsBefore`). */
  mineWith({ deposits = [], withdrawals = [], extraLogsBefore = 0 }: { deposits?: readonly FakeDeposit[]; withdrawals?: readonly FakeWithdrawal[]; extraLogsBefore?: number }): bigint {
    const number = BigInt(this.blocks.length);
    const logs: DepositLog[] = deposits.map((d, i) => Object.freeze({
      player: d.player, amountWei: d.amountWei, depositId: this.nextDepositId++, txHash: d.txHash ?? this.txHash(),
      logIndex: extraLogsBefore + i, blockNumber: number, blockHash: this.hashOf(number),
    }));
    const out: WithdrawalLog[] = withdrawals.map((w, i) => Object.freeze({
      player: w.player, amountWei: w.amountWei, nonce: w.nonce, txHash: w.txHash ?? this.txHash(),
      logIndex: extraLogsBefore + deposits.length + i, blockNumber: number, blockHash: this.hashOf(number),
    }));
    this.blocks.push({ number, hash: this.hashOf(number), timestamp: 1_800_000_000n + number * 2n, logs, withdrawals: out });
    return number;
  }

  mineEmpty(count: number): void { for (let i = 0; i < count; i++) this.mine(); }

  txHash(): string { return keccak256(toHex(`tx:${++this.txCounter}`)); }

  /** Drops the top `depth` blocks and bumps the fork so re-mined blocks get new hashes. */
  reorg(depth: number): void {
    this.fork++;
    this.blocks = this.blocks.slice(0, this.blocks.length - depth);
  }

  async head(): Promise<bigint> { this.calls.head++; this.onCall?.('head'); this.maybeFail(); return this.headNumber; }

  async block(number: bigint): Promise<BlockRef> {
    this.calls.block++; this.onCall?.('block'); this.maybeFail();
    const b = this.blocks[Number(number)];
    if (!b) throw new Error(`no block ${number}`);
    return { number: b.number, hash: b.hash, timestamp: b.timestamp };
  }

  async deposits(fromBlock: bigint, toBlock: bigint): Promise<readonly DepositLog[]> {
    return (await this.vaultLogs(fromBlock, toBlock)).deposits;
  }

  async vaultLogs(fromBlock: bigint, toBlock: bigint): Promise<VaultLogs> {
    this.calls.deposits++; this.onCall?.('deposits'); this.maybeFail();
    if (this.maxRange !== null && toBlock - fromBlock + 1n > this.maxRange) throw new Error(`query exceeds max block range ${this.maxRange}`);
    this.ranges.push([fromBlock, toBlock]);
    const blocks = this.blocks.filter(b => b.number >= fromBlock && b.number <= toBlock);
    return { deposits: blocks.flatMap(b => b.logs), withdrawals: blocks.flatMap(b => b.withdrawals) };
  }

  timestampOf(number: bigint): bigint { return this.blocks[Number(number)]!.timestamp; }

  private hashOf(number: bigint): string { return keccak256(toHex(`block:${this.fork}:${number}`)); }

  private maybeFail(): void {
    const error = this.failures.shift();
    if (error) throw error;
  }
}

/** The same chain seen through a source without `vaultLogs` (deposits only, as before SPEC-11). */
export function depositOnly(chain: FakeChain): DepositSource {
  return { head: () => chain.head(), block: n => chain.block(n), deposits: (from, to) => chain.deposits(from, to) };
}
