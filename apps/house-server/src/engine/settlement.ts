import { OBSERVED_PATH_POLICY, sampleTouchesCell, segmentTouchesCell, type CellTerms, type SettlementPolicy } from '@maya/contracts';
import type { PinnedSample } from '../market/path-store.js';

export interface SampleSource { sample(t: number): PinnedSample | undefined }
export interface SettlementClock { readonly nowMs: number; readonly uncertaintyMs: number }

export type CellOutcome =
  | { readonly status: 'won'; readonly evidenceSampleIds: readonly string[]; readonly touchTimeMs: number; readonly reason: string }
  | { readonly status: 'lost' | 'refunded'; readonly evidenceSampleIds: readonly string[]; readonly reason: string };

export const WON_REASON = 'The recorded price path touched your square.';
export const LOST_REASON = 'The completed recorded path missed your square.';
export const REFUND_REASON = 'Price history could not be recovered; stake refunded.';

/**
 * maya-observed-linear-v2 settlement of one cell over the pinned first-seen path, mirroring
 * packages/engine `settleObservedPosition` with the exact @maya/contracts touch functions:
 * a touch is final as soon as it is observed; a loss needs every second of [start, end] and the
 * late-arrival grace; without that evidence the stake is refunded at the recovery deadline.
 * Returns undefined while the outcome is still pending.
 */
export function resolveCell(cell: CellTerms, path: SampleSource, clock: SettlementClock, policy: SettlementPolicy = OBSERVED_PATH_POLICY): CellOutcome | undefined {
  const step = policy.expectedSampleIntervalMs;
  const first = cell.startMs - step, last = cell.endMs - step;
  for (let ms = first; ms <= last; ms += step) {
    const a = path.sample(ms / 1000);
    if (!a || a.sourceTimeMs > clock.nowMs + clock.uncertaintyMs) continue;
    if (sampleTouchesCell(a, cell)) return { status: 'won', evidenceSampleIds: [a.sampleId], touchTimeMs: a.sourceTimeMs, reason: WON_REASON };
    const b = path.sample(ms / 1000 + 1);
    if (!b || b.sourceTimeMs > clock.nowMs + clock.uncertaintyMs) continue;
    const hit = segmentTouchesCell(a, b, cell, step);
    if (hit) return { status: 'won', evidenceSampleIds: [a.sampleId, b.sampleId], touchTimeMs: hit.firstTouchTimeMs, reason: WON_REASON };
  }
  const settledView = clock.nowMs - clock.uncertaintyMs;
  if (settledView < cell.endMs) return undefined;
  const evidence: string[] = [];
  let complete = true;
  for (let ms = cell.startMs; ms <= cell.endMs; ms += step) {
    const s = path.sample(ms / 1000);
    if (s) evidence.push(s.sampleId); else complete = false;
  }
  if (complete && settledView >= cell.endMs + policy.lateArrivalGraceMs) return { status: 'lost', evidenceSampleIds: evidence, reason: LOST_REASON };
  if (settledView >= cell.endMs + policy.recoveryDeadlineMs) return { status: 'refunded', evidenceSampleIds: evidence, reason: REFUND_REASON };
  return undefined;
}
