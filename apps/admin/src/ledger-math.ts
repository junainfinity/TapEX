/** Exact bigint derivations shown in the console (no floats). */
import { parseCenti } from './money.js';
import type { BetLeg, ChainState } from './types.js';

/** Cumulative player P&L over settled legs, in settlement order (running bigint sum, Centi strings). */
export function cumulativePnl(bets: readonly BetLeg[]): { t: number[]; centi: string[] } {
  const settled = bets.filter(b => b.status !== 'open' && b.settledMs !== undefined).sort((a, b) => (a.settledMs ?? 0) - (b.settledMs ?? 0));
  let running = 0n;
  const t: number[] = []; const centi: string[] = [];
  for (const b of settled) {
    const stake = parseCenti(b.stakeCenti) ?? 0n; const payout = parseCenti(b.payoutCenti) ?? 0n;
    // Won: net payout − stake. Lost: −stake. Refunded: stake returned, net zero.
    running += b.status === 'won' ? payout - stake : b.status === 'lost' ? -stake : 0n;
    t.push(b.settledMs ?? 0); centi.push(running.toString());
  }
  return { t, centi };
}

/** SPEC §5 identity: assets = deposits + houseFunded − playerWithdrawals − houseWithdrawn, checked exactly. */
export function vaultIdentity(chain: ChainState): { ok: boolean; expected: bigint; actual: bigint } | null {
  const v = chain.vault;
  const parts = [v.totalPlayerDepositsCenti, v.houseFundedCenti, v.totalPlayerWithdrawalsCenti, v.houseWithdrawnCenti ?? '0', v.assetsCenti].map(parseCenti);
  if (parts.some(p => p === null)) return null;
  const [deposits, funded, withdrawals, houseOut, assets] = parts as [bigint, bigint, bigint, bigint, bigint];
  const expected = deposits + funded - withdrawals - houseOut;
  return { ok: expected === assets, expected, actual: assets };
}
