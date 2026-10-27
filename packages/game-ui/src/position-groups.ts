import type { CellTerms, Cents, PositionSnapshot, PositionStatus } from '@maya/contracts';

export type PositionGroupStatus = PositionStatus | 'mixed';

/** Presentation totals only. Every constituent retains its own accepted odds and settlement. */
export interface PositionGroup extends CellTerms {
  readonly groupId: string;
  readonly positions: readonly PositionSnapshot[];
  readonly count: number;
  readonly totalStakeCents: Cents;
  readonly totalPotentialReturnCents: Cents;
  readonly totalActualReturnCents: Cents;
  readonly status: PositionGroupStatus;
}

/** Canonical cell IDs include the market, time window, and exact price bounds. */
export function groupPositions(positions: readonly PositionSnapshot[]): readonly PositionGroup[] {
  const byCell = new Map<string, PositionSnapshot[]>();
  for (const position of positions) {
    const group = byCell.get(position.cellId);
    if (group) group.push(position);
    else byCell.set(position.cellId, [position]);
  }

  return Object.freeze([...byCell.values()].map((members): PositionGroup => {
    const first = members[0]!;
    let stake = 0n, potentialReturn = 0n, actualReturn = 0n;
    const statuses = new Set<PositionStatus>();
    for (const position of members) {
      stake += BigInt(position.stakeCents);
      potentialReturn += BigInt(position.grossReturnCents);
      if (position.status === 'won') actualReturn += BigInt(position.grossReturnCents);
      else if (position.status === 'refunded') actualReturn += BigInt(position.stakeCents);
      statuses.add(position.status);
    }
    const status: PositionGroupStatus = statuses.has('open') ? 'open'
      : statuses.size === 1 ? first.status : 'mixed';
    return Object.freeze({
      groupId: first.cellId,
      cellId: first.cellId,
      marketId: first.marketId,
      startMs: first.startMs,
      endMs: first.endMs,
      lowerPrice: first.lowerPrice,
      upperPrice: first.upperPrice,
      ruleVersion: first.ruleVersion,
      positions: Object.freeze(members),
      count: members.length,
      totalStakeCents: stake.toString(),
      totalPotentialReturnCents: potentialReturn.toString(),
      totalActualReturnCents: actualReturn.toString(),
      status,
    });
  }));
}
