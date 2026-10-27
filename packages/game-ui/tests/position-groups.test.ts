import { describe, expect, it } from 'vitest';
import { createCell, formatCents, parseDecimal, type PositionSnapshot, type PositionStatus } from '@maya/contracts';
import { groupPositions } from '../src/position-groups.js';

const cell = createCell('btc-usd', 10000, parseDecimal('100'), parseDecimal('110'));
function position(id: string, overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return Object.freeze({
    ...cell,
    positionId: id,
    requestId: `request-${id}`,
    pageLoadId: 'page',
    quoteId: `quote-${id}`,
    stakeCents: '100',
    grossX100: '250',
    grossReturnCents: '250',
    acceptedAtMs: 5000,
    status: 'open',
    provenance: Object.freeze({ modelId: 'fixture', configId: 'fixture', tableId: 'fixture', policyId: 'fixture', sourceSampleId: `sample-${id}` }),
    ...overrides,
  });
}

describe('canonical-cell presentation groups', () => {
  it('returns no fabricated group for an empty ledger', () => {
    expect(groupPositions([])).toEqual([]);
  });

  it('sums repeated stakes and each locked return without averaging or repricing the odds', () => {
    const positions = [
      position('one', { grossX100: '280', grossReturnCents: '280' }),
      position('two', { stakeCents: '50', grossX100: '221', grossReturnCents: '111' }),
      position('three', { stakeCents: '1000', grossX100: '1250', grossReturnCents: '12500' }),
    ];
    const groups = groupPositions(positions);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      ...cell,
      groupId: cell.cellId,
      count: 3,
      totalStakeCents: '1150',
      totalPotentialReturnCents: '12891',
      totalActualReturnCents: '0',
      status: 'open',
    });
    expect(groups[0]!.positions.map(p => p.grossX100)).toEqual(['280', '221', '1250']);
    expect(groups[0]).not.toHaveProperty('grossX100');
    expect(formatCents(groups[0]!.totalStakeCents)).toBe('$11.50');
    expect(formatCents(groups[0]!.totalPotentialReturnCents)).toBe('$128.91');
  });

  it('preserves sums and formatting beyond JavaScript safe integers', () => {
    const amount = '9007199254740993123456789';
    const group = groupPositions([
      position('large-win', { stakeCents: amount, grossReturnCents: '18014398509481986246913579', status: 'won' }),
      position('large-refund', { stakeCents: amount, grossReturnCents: '27021597764222979370370367', status: 'refunded' }),
    ])[0]!;
    expect(group.totalStakeCents).toBe('18014398509481986246913578');
    expect(group.totalPotentialReturnCents).toBe('45035996273704965617283946');
    expect(group.totalActualReturnCents).toBe('27021597764222979370370368');
    expect(formatCents(group.totalStakeCents)).toBe('$180,143,985,094,819,862,469,135.78');
  });

  it('keeps a partially settled group open and counts only actual winning or refunded credits', () => {
    const group = groupPositions([
      position('open'),
      position('won', { grossReturnCents: '375', status: 'won' }),
      position('lost', { status: 'lost' }),
      position('refunded', { stakeCents: '50', grossReturnCents: '125', status: 'refunded' }),
    ])[0]!;
    expect(group.status).toBe('open');
    expect(group.count).toBe(4);
    expect(group.totalStakeCents).toBe('350');
    expect(group.totalPotentialReturnCents).toBe('1000');
    expect(group.totalActualReturnCents).toBe('425');
  });

  it.each<PositionStatus>(['open', 'won', 'lost', 'refunded'])('keeps homogeneous %s status', status => {
    const group = groupPositions([position('one', { status }), position('two', { status })])[0]!;
    expect(group.status).toBe(status);
    expect(group.totalActualReturnCents).toBe(status === 'won' ? '500' : status === 'refunded' ? '200' : '0');
  });

  it('reports mixed terminal outcomes consistently regardless of constituent order', () => {
    for (const statuses of [['won', 'lost'], ['won', 'refunded'], ['lost', 'refunded']] as const) {
      const positions = statuses.map((status, index) => position(String(index), { status }));
      const forward = groupPositions(positions)[0]!;
      const reversed = groupPositions([...positions].reverse())[0]!;
      expect(forward.status).toBe('mixed');
      expect(reversed.status).toBe('mixed');
      expect(reversed.totalActualReturnCents).toBe(forward.totalActualReturnCents);
      expect(reversed.groupId).toBe(forward.groupId);
    }
  });

  it('does not merge different markets, windows, or price bands', () => {
    const otherMarket = createCell('eth-usd', 10000, parseDecimal('100'), parseDecimal('110'));
    const otherWindow = createCell('btc-usd', 15000, parseDecimal('100'), parseDecimal('110'));
    const otherBand = createCell('btc-usd', 10000, parseDecimal('110'), parseDecimal('120'));
    const groups = groupPositions([
      position('btc'), position('eth', otherMarket), position('later', otherWindow),
      position('higher', otherBand), position('btc-again'),
    ]);
    expect(groups.map(group => group.groupId)).toEqual([cell.cellId, otherMarket.cellId, otherWindow.cellId, otherBand.cellId]);
    expect(groups.map(group => group.count)).toEqual([2, 1, 1, 1]);
  });

  it('retains immutable constituent snapshots and stable identity when a second stake is added', () => {
    const first = position('first');
    const input = Object.freeze([first]);
    const initial = groupPositions(input)[0]!;
    const updated = groupPositions([position('second', { stakeCents: '500', grossReturnCents: '1000' }), first])[0]!;
    expect(initial.groupId).toBe(updated.groupId);
    expect(initial.totalStakeCents).toBe('100');
    expect(updated.totalStakeCents).toBe('600');
    expect(initial.positions[0]).toBe(first);
    expect(input).toEqual([first]);
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.positions)).toBe(true);
  });
});
