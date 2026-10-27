import {
  BaseError, ContractFunctionRevertedError, ExecutionRevertedError, TransactionNotFoundError, WaitForTransactionReceiptTimeoutError,
  encodeDeployData, encodeFunctionData, keccak256,
  type Abi, type Address, type Chain, type Hex, type PublicClient,
} from 'viem';
import type { LocalAccount } from 'viem/accounts';
import { ChainError, describe, formatRevert, revertInfo } from './errors.js';
import { realSleep, type Sleep } from './retry.js';

export type TxCall =
  | { readonly kind: 'call'; readonly label: string; readonly to: Address; readonly abi: Abi; readonly functionName: string; readonly args: readonly unknown[]; readonly value?: bigint }
  | { readonly kind: 'deploy'; readonly label: string; readonly abi: Abi; readonly bytecode: Hex; readonly args: readonly unknown[] }
  | { readonly kind: 'transfer'; readonly label: string; readonly to: Address; readonly value: bigint };

export interface TxReceipt {
  readonly hash: Hex;
  readonly status: 'success' | 'reverted';
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly contractAddress: Address | null;
  readonly gasUsed: bigint;
  /** Raw logs, when the backend reports them (used to read e.g. the amount `sweepExcess` moved). */
  readonly logs?: readonly { readonly address: Address; readonly topics: readonly Hex[]; readonly data: Hex }[];
}

/** Narrow RPC surface the sender needs; `viemTxBackend` implements it, tests fake it. */
export interface TxBackend {
  /** Throws ChainError CONTRACT_REVERT (decoded when possible) if the call would revert. */
  estimateGas(from: Address, call: TxCall): Promise<bigint>;
  pendingNonce(address: Address): Promise<number>;
  /** Fills fees and signs locally; returns the serialized signed transaction. */
  sign(account: LocalAccount, call: TxCall, fields: { readonly nonce: number; readonly gas: bigint }): Promise<Hex>;
  sendRaw(serialized: Hex): Promise<void>;
  hasTransaction(hash: Hex): Promise<boolean>;
  waitForReceipt(hash: Hex, timeoutMs: number): Promise<TxReceipt>;
}

export interface TxSenderOptions {
  readonly receiptTimeoutMs: number;
  /** Extra gas over the estimate, in basis points (default +20 %). */
  readonly gasBufferBps?: number;
  readonly maxNonceAttempts?: number;
  readonly nonceRetryDelayMs?: number;
  readonly log?: (line: string) => void;
  readonly sleep?: Sleep;
}

export interface Submitted {
  readonly hash: Hex;
  readonly nonce: number;
  wait(): Promise<TxReceipt>;
}

const NONCE_TOO_LOW = /nonce too low|nonce is too low|nonce has already been used|oldnonce|nonce.*(?:lower|less) than/i;
const ALREADY_KNOWN = /already known|known transaction|already imported|transaction already exists/i;

function fullMessage(error: unknown): string {
  if (error instanceof BaseError) return `${error.shortMessage}\n${error.details ?? ''}\n${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sequential sender with local nonce management. Per account, nonce assignment + broadcast run
 * under a lock, so concurrent callers get consecutive nonces even when a load-balanced RPC's
 * pending count lags; receipts are awaited outside the lock so independent transactions pipeline.
 * A broadcast that errors but whose hash the node already knows counts as sent (retried
 * `eth_sendRawTransaction` calls report "already known"); any uncertain outcome drops the cached
 * nonce so the next send resynchronises from the chain.
 */
export class TxSender {
  private readonly nextNonce = new Map<Address, number>();
  private readonly locks = new Map<Address, Promise<void>>();
  private readonly gasBufferBps: bigint;
  private readonly maxNonceAttempts: number;
  private readonly nonceRetryDelayMs: number;
  private readonly sleep: Sleep;

  constructor(private readonly backend: TxBackend, private readonly options: TxSenderOptions) {
    this.gasBufferBps = BigInt(options.gasBufferBps ?? 2_000);
    this.maxNonceAttempts = options.maxNonceAttempts ?? 4;
    this.nonceRetryDelayMs = options.nonceRetryDelayMs ?? 250;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Broadcasts and awaits a successful receipt. */
  async send(account: LocalAccount, call: TxCall): Promise<TxReceipt> {
    return (await this.submit(account, call)).wait();
  }

  /** Broadcasts under the account lock and returns once the node accepted the transaction. */
  async submit(account: LocalAccount, call: TxCall): Promise<Submitted> {
    const { hash, nonce } = await this.withLock(account.address, () => this.broadcast(account, call));
    let receipt: Promise<TxReceipt> | undefined;
    return Object.freeze({ hash, nonce, wait: () => (receipt ??= this.awaitReceipt(account.address, call, hash)) });
  }

  /** Forget cached nonces (e.g. after an external send from the same key). */
  resetNonces(address?: Address): void {
    if (address) this.nextNonce.delete(address); else this.nextNonce.clear();
  }

  private async broadcast(account: LocalAccount, call: TxCall): Promise<{ hash: Hex; nonce: number }> {
    const address = account.address;
    const estimate = await this.backend.estimateGas(address, call);
    const gas = estimate + (estimate * this.gasBufferBps) / 10_000n;
    for (let attempt = 1; ; attempt++) {
      const chainNonce = await this.pendingNonce(address, call);
      const cached = this.nextNonce.get(address);
      const nonce = cached === undefined ? chainNonce : Math.max(cached, chainNonce);
      const serialized = await this.backend.sign(account, call, { nonce, gas });
      const hash = keccak256(serialized);
      try {
        await this.backend.sendRaw(serialized);
      } catch (error) {
        const message = fullMessage(error);
        const known = ALREADY_KNOWN.test(message) || await this.backend.hasTransaction(hash).catch(() => false);
        if (!known) {
          if (NONCE_TOO_LOW.test(message) && attempt < this.maxNonceAttempts) {
            // The chain has consumed `nonce`, whatever the (possibly lagging) pending count said.
            this.nextNonce.set(address, nonce + 1);
            this.options.log?.(`chain: ${call.label}: nonce ${nonce} already used by ${address}; retrying with a fresh nonce`);
            await this.sleep(this.nonceRetryDelayMs);
            continue;
          }
          this.nextNonce.delete(address);
          throw new ChainError('TX_SEND_FAILED', `${call.label}: broadcast rejected: ${describe(error)}`, { cause: error });
        }
      }
      this.nextNonce.set(address, nonce + 1);
      return { hash, nonce };
    }
  }

  private async pendingNonce(address: Address, call: TxCall): Promise<number> {
    try { return await this.backend.pendingNonce(address); } catch (error) {
      if (error instanceof ChainError) throw error;
      throw new ChainError('RPC_UNAVAILABLE', `${call.label}: cannot read nonce for ${address}: ${describe(error)}`, { cause: error });
    }
  }

  private async awaitReceipt(address: Address, call: TxCall, hash: Hex): Promise<TxReceipt> {
    let receipt: TxReceipt;
    try {
      receipt = await this.backend.waitForReceipt(hash, this.options.receiptTimeoutMs);
    } catch (error) {
      this.nextNonce.delete(address);
      if (error instanceof ChainError) throw error;
      throw new ChainError('TX_TIMEOUT', `${call.label}: no receipt for ${hash} (outcome unknown; it may still be mined): ${describe(error)}`, { cause: error, txHash: hash });
    }
    if (receipt.status !== 'success') throw new ChainError('TX_REVERTED', `${call.label}: transaction ${hash} reverted in block ${receipt.blockNumber}`, { txHash: hash });
    return receipt;
  }

  private async withLock<T>(key: Address, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.then(() => new Promise<void>(resolve => { release = resolve; }));
    this.locks.set(key, current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

function isRevert(error: unknown): boolean {
  return error instanceof BaseError && error.walk(e => e instanceof ContractFunctionRevertedError || e instanceof ExecutionRevertedError) !== null;
}

/** Maps a failed estimate/call to CONTRACT_REVERT (with the decoded custom error) or RPC_UNAVAILABLE. */
export function classifyCallError(error: unknown, label: string, abi: Abi | undefined): ChainError {
  if (error instanceof ChainError) return error;
  const revert = abi ? revertInfo(error, abi) : undefined;
  if (revert) return new ChainError('CONTRACT_REVERT', `${label} would revert: ${formatRevert(revert)}`, { cause: error, revert });
  if (isRevert(error)) return new ChainError('CONTRACT_REVERT', `${label} would revert: ${describe(error)}`, { cause: error });
  if (/insufficient funds/i.test(fullMessage(error))) return new ChainError('INSUFFICIENT_GAS_FUNDS', `${label}: sender cannot pay for gas: ${describe(error)}`, { cause: error });
  return new ChainError('RPC_UNAVAILABLE', `${label}: RPC call failed: ${describe(error)}`, { cause: error });
}

export function callData(call: TxCall): { to: Address | undefined; data: Hex | undefined; value: bigint | undefined } {
  if (call.kind === 'call') return { to: call.to, data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as Parameters<typeof encodeFunctionData>[0]), value: call.value };
  if (call.kind === 'deploy') return { to: undefined, data: encodeDeployData({ abi: call.abi, bytecode: call.bytecode, args: call.args } as Parameters<typeof encodeDeployData>[0]), value: undefined };
  return { to: call.to, data: undefined, value: call.value };
}

export function viemTxBackend(client: PublicClient, chain: Chain, options: { readonly pollingIntervalMs: number }): TxBackend {
  return {
    async estimateGas(from, call) {
      const { to, data, value } = callData(call);
      try {
        return await client.estimateGas({ account: from, to, data, value });
      } catch (error) {
        throw classifyCallError(error, call.label, call.kind === 'transfer' ? undefined : call.abi);
      }
    },
    pendingNonce: address => client.getTransactionCount({ address, blockTag: 'pending' }),
    async sign(account, call, { nonce, gas }) {
      const { to, data, value } = callData(call);
      let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
      try { fees = await client.estimateFeesPerGas({ chain, type: 'eip1559' }); } catch (error) {
        throw new ChainError('RPC_UNAVAILABLE', `${call.label}: cannot estimate fees: ${describe(error)}`, { cause: error });
      }
      return account.signTransaction({
        chainId: chain.id, type: 'eip1559', nonce, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        ...(to ? { to } : {}), ...(data ? { data } : {}), ...(value !== undefined ? { value } : {}),
      });
    },
    async sendRaw(serialized) {
      await client.sendRawTransaction({ serializedTransaction: serialized });
    },
    async hasTransaction(hash) {
      try { await client.getTransaction({ hash }); return true; } catch (error) {
        if (error instanceof BaseError && error.walk(e => e instanceof TransactionNotFoundError)) return false;
        throw error;
      }
    },
    async waitForReceipt(hash, timeoutMs) {
      try {
        const r = await client.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: options.pollingIntervalMs });
        const logs = Object.freeze(r.logs.map(l => Object.freeze({ address: l.address, topics: Object.freeze([...l.topics]), data: l.data })));
        return Object.freeze({ hash, status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash, contractAddress: r.contractAddress ?? null, gasUsed: r.gasUsed, logs });
      } catch (error) {
        if (error instanceof WaitForTransactionReceiptTimeoutError) throw new ChainError('TX_TIMEOUT', `No receipt for ${hash} within ${timeoutMs} ms (outcome unknown; it may still be mined)`, { cause: error, txHash: hash });
        throw error;
      }
    },
  };
}
