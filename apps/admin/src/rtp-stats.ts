/**
 * Statistics for the RTP views. A realized RTP is only meaningful against its
 * sampling noise, which grows with the multiplier: the target band is
 * expected ± 2 standard errors, and calibration drift is the z-score.
 *
 * Per unit stake, a bet with multiplier m and expected RTP e wins with
 * p = e / m, so Var[R] = p·m² − e² = e·m − e². Over n equal-stake bets,
 * SE = √((e·m − e²) / n). The server may send an exact band instead.
 */
import type { RtpRow } from './types.js';

/** Representative multiplier for a range label such as "5-10": the geometric mean. */
export function rangeMidMultiplier(label: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/.exec(label);
  if (!m) return null;
  const lo = Number(m[1]); const hi = Number(m[2]);
  if (!(lo > 0) || !(hi >= lo)) return null;
  return Math.sqrt(lo * hi);
}

export interface RtpBand {
  readonly low: number;
  readonly high: number;
  readonly se: number;
  /** 'server' when expectedLow/High were provided, else 'approx'. */
  readonly source: 'server' | 'approx';
}

/**
 * The row's target RTP, or null when there is none to show: a range or phase with no bets carries
 * expected 0 (and a 0–0 band) from the server, which must not read as a policy target of 0 %.
 */
export function rtpTarget(row: RtpRow): number | null {
  return row.bets > 0 && row.expected > 0 && Number.isFinite(row.expected) ? row.expected : null;
}

export function rtpBand(row: RtpRow, multiplierHint?: number | null): RtpBand | null {
  if (rtpTarget(row) === null) return null;
  if (typeof row.expectedLow === 'number' && typeof row.expectedHigh === 'number' && row.expectedHigh >= row.expectedLow) {
    return { low: row.expectedLow, high: row.expectedHigh, se: (row.expectedHigh - row.expectedLow) / 4, source: 'server' };
  }
  const m = multiplierHint ?? rangeMidMultiplier(row.key);
  if (m === null || row.bets <= 0) return null;
  const variance = row.expected * m - row.expected * row.expected;
  if (!(variance > 0)) return null;
  const se = Math.sqrt(variance / row.bets);
  return { low: row.expected - 2 * se, high: row.expected + 2 * se, se, source: 'approx' };
}

/** (realized − expected) / SE; positive means players are being paid more than priced. */
export function driftZ(row: RtpRow, band: RtpBand | null): number | null {
  if (row.realized === null || !band || !(band.se > 0)) return null;
  return (row.realized - row.expected) / band.se;
}

export type DriftLevel = 'ok' | 'watch' | 'drift';

export function driftLevel(z: number | null): DriftLevel {
  if (z === null) return 'ok';
  const a = Math.abs(z);
  return a > 3 ? 'drift' : a > 2 ? 'watch' : 'ok';
}
