import { UINT256_MAX, UINT64_MAX } from './amounts.js';
import type { BlockRef } from './indexer.js';

export interface AttestationInput {
  readonly liabilitiesWei: bigint;
  readonly ledgerRoot: string;
  readonly asOf: bigint;
  readonly seq: bigint;
}

export type AttestationPlan =
  | { readonly ok: true; readonly liabilitiesWei: bigint; readonly ledgerRoot: `0x${string}`; readonly asOf: bigint; readonly seq: bigint; readonly clamped: boolean }
  | { readonly ok: false; readonly code: 'INVALID_ARGUMENT' | 'INDEXER_NOT_READY' | 'INDEXER_UNDELIVERED'; readonly message: string };

/**
 * Decides the `asOf` actually attested. The vault treats deposits mined at or after `asOf` as still
 * owed on top of `liabilities`, so the ledger's figure must cover every deposit mined strictly before
 * `asOf`. The ledger has only seen deposits up to the indexer watermark, so `asOf` is clamped down
 * to the watermark block's timestamp: moving `asOf` earlier only adds deposits to the vault's "owed"
 * side (never lets the owner reach player funds) and also keeps `asOf <= block.timestamp`.
 * Must be evaluated synchronously with the ledger snapshot (no await in between), so no deposit can
 * be delivered between the two.
 */
export function planAttestation(input: AttestationInput, watermark: BlockRef | null, undelivered: number): AttestationPlan {
  const bad = (message: string) => ({ ok: false, code: 'INVALID_ARGUMENT', message }) as const;
  if (typeof input.liabilitiesWei !== 'bigint' || input.liabilitiesWei < 0n || input.liabilitiesWei > UINT256_MAX) return bad('liabilitiesWei must be a uint256 bigint');
  if (typeof input.ledgerRoot !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(input.ledgerRoot)) return bad('ledgerRoot must be 0x-prefixed 32-byte hex');
  if (typeof input.seq !== 'bigint' || input.seq < 1n || input.seq > UINT64_MAX) return bad('seq must be a bigint in [1, 2^64)');
  if (typeof input.asOf !== 'bigint' || input.asOf < 1n || input.asOf > UINT64_MAX) return bad('asOf must be Unix seconds as a bigint in [1, 2^64)');
  if (!watermark) return { ok: false, code: 'INDEXER_NOT_READY', message: 'The deposit indexer has not completed a scan yet; cannot bound asOf by indexed chain time' };
  if (undelivered > 0) return { ok: false, code: 'INDEXER_UNDELIVERED', message: `${undelivered} indexed vault event(s) (deposits, and withdrawals once an onWithdrawn listener exists) have not been delivered to a listener, so the ledger cannot include them; subscribe before attesting` };
  const clamped = input.asOf > watermark.timestamp;
  return { ok: true, liabilitiesWei: input.liabilitiesWei, ledgerRoot: input.ledgerRoot.toLowerCase() as `0x${string}`, asOf: clamped ? watermark.timestamp : input.asOf, seq: input.seq, clamped };
}
