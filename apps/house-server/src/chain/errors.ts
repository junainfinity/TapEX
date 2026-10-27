import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Abi, type Hex } from 'viem';

export type ChainErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNKNOWN_ROLE'
  | 'SECRETS_MISSING'
  | 'SECRETS_INVALID'
  | 'ARTIFACT_MISSING'
  | 'ARTIFACT_INVALID'
  | 'DEPLOYMENT_MISSING'
  | 'DEPLOYMENT_INVALID'
  | 'DEPLOYMENT_MISMATCH'
  | 'RPC_UNAVAILABLE'
  | 'CHAIN_ID_MISMATCH'
  | 'NOT_STARTED'
  | 'INDEXER_NOT_READY'
  | 'INDEXER_UNDELIVERED'
  | 'SIGNER_MISMATCH'
  | 'INSUFFICIENT_GAS_FUNDS'
  | 'INSUFFICIENT_TOKEN_BALANCE'
  | 'CONTRACT_REVERT'
  | 'TX_SEND_FAILED'
  | 'TX_REVERTED'
  | 'TX_TIMEOUT';

/** Decoded custom error from a reverted call, e.g. `{ name: 'ExceedsHouseSurplus', args: [5n, 3n] }`. */
export interface RevertInfo {
  readonly name: string;
  readonly args: readonly unknown[];
}

/**
 * Every failure of the chain adapter surfaces as a ChainError with a stable `code`, so callers can
 * branch on it (and the admin API can report it) without parsing viem messages.
 */
export class ChainError extends Error {
  override readonly name = 'ChainError';
  readonly code: ChainErrorCode;
  readonly revert: RevertInfo | undefined;
  readonly txHash: string | undefined;

  constructor(code: ChainErrorCode, message: string, options: { cause?: unknown; revert?: RevertInfo; txHash?: string } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.revert = options.revert;
    this.txHash = options.txHash;
  }
}

export function isChainError(value: unknown, code?: ChainErrorCode): value is ChainError {
  return value instanceof ChainError && (code === undefined || value.code === code);
}

/** Extracts a decoded custom error from a viem failure, decoding raw revert data against `abi` when needed. */
export function revertInfo(error: unknown, abi: Abi): RevertInfo | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk(e => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) {
    if (reverted.data?.errorName) return Object.freeze({ name: reverted.data.errorName, args: Object.freeze([...(reverted.data.args ?? [])]) });
    if (reverted.raw) {
      try {
        const decoded = decodeErrorResult({ abi, data: reverted.raw });
        return Object.freeze({ name: decoded.errorName, args: Object.freeze([...(decoded.args ?? [])]) });
      } catch { /* selector unknown to abi */ }
    }
    if (reverted.reason) return Object.freeze({ name: 'Error', args: Object.freeze([reverted.reason]) });
  }
  const withData = error.walk(e => typeof (e as { data?: unknown }).data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test((e as { data: string }).data));
  const data = (withData as { data?: Hex } | null)?.data;
  if (data) {
    try {
      const decoded = decodeErrorResult({ abi, data });
      return Object.freeze({ name: decoded.errorName, args: Object.freeze([...(decoded.args ?? [])]) });
    } catch { /* not an ABI error; fall through */ }
  }
  return undefined;
}

/** Human-readable one-liner for an unknown failure (viem's shortMessage when present). */
export function describe(error: unknown): string {
  if (error instanceof ChainError) return `${error.code}: ${error.message}`;
  if (error instanceof BaseError) return error.shortMessage || error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function formatRevert(info: RevertInfo): string {
  return `${info.name}(${info.args.map(a => (typeof a === 'bigint' ? a.toString() : String(a))).join(', ')})`;
}
