import type { SettlementPolicy } from '@maya/contracts';

/** Observed 2026-09-20: source buckets revise through age2s; emit only age>=3s. */
export const LIVE_POLICY = Object.freeze({
  policyId: 'maya-lynx-sampled-1s-stabilized-3s-v1',
  expectedSampleIntervalMs: 1000,
  stabilizationMs: 3000,
  lateArrivalGraceMs: 1000,
  recoveryDeadlineMs: 30_000,
  pollIntervalMs: 1000,
  staleAfterMs: 7000,
  maxHealthySourceAgeS: 7,
  quoteTtlMs: 1800,
  historyRetentionMs: 120_000,
  historyWarmupSamples: 30,
});
export const SETTLEMENT_POLICY: SettlementPolicy = Object.freeze({ policyId: LIVE_POLICY.policyId, expectedSampleIntervalMs: LIVE_POLICY.expectedSampleIntervalMs, lateArrivalGraceMs: LIVE_POLICY.lateArrivalGraceMs, recoveryDeadlineMs: LIVE_POLICY.recoveryDeadlineMs });
