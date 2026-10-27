import { describe, expect, it } from 'vitest';
import { offerX100 } from '@maya/house';
import { HISTORY, T0, deliver, makeEngine, offered, simPlayer } from './helpers.js';

const meta = (reason = 'launch schedule change', confirm?: string) => ({ actor: 'admin', reason, ...(confirm ? { confirm } : {}) });

describe('launch boost', () => {
  it('prices at the launch edge until exactly the 10,000th registered player, then at the standard edge', () => {
    const { engine } = makeEngine();
    const p = HISTORY.get(T0 - 1)!;
    for (let i = 1; i <= 9_998; i++) expect(engine.register(`sim:L${i}`, 'sim').ok).toBe(true);
    const bettor = simPlayer(engine); // 9,999th
    expect(engine.registeredPlayers).toBe(9_999);
    deliver(engine, 'btc-usd', T0, p);
    const launchGrid = engine.latestGrid('btc-usd')!;
    expect(launchGrid.grid.edge).toMatchObject({ phase: 'launch', edge: 0.03 });
    expect(engine.launchView()).toEqual({ enabled: true, active: true, edge: 0.03, untilPlayers: 10_000, standardEdge: 0.08 });
    const launchQuote = offered(engine).find(q => q.window === 5 && !q.capped)!;

    expect(engine.register('sim:L10000', 'sim')).toMatchObject({ ok: true, created: true });
    expect(engine.registeredPlayers).toBe(10_000);
    expect(engine.launchView().active).toBe(false);
    expect(engine.phaseLog.at(-1)).toMatchObject({ phase: 'standard', registered: 10_000 });
    // Registering the same account again does not count twice.
    expect(engine.register('sim:L10000', 'sim')).toMatchObject({ ok: true, created: false });
    expect(engine.registeredPlayers).toBe(10_000);

    deliver(engine, 'btc-usd', T0 + 1, p);
    const std = engine.latestGrid('btc-usd')!;
    expect(std.grid.edge).toMatchObject({ phase: 'standard', edge: 0.08 });
    // Every offered cell is priced at the edge of its grid's phase.
    const repriced = (grid: typeof std, edge: number) => grid.grid.cells.filter(c => c.available && !c.capped).map(c => [c.available ? c.x100 : 0, offerX100(c.p!, c.se!, { edge, z: 0, minX100: 101, capX100: 5000, aboveCap: 'hide' }, c.impact ?? 0)]);
    for (const [x, o] of repriced(launchGrid, 0.03)) expect(o).toMatchObject({ ok: true, x100: x });
    for (const [x, o] of repriced(std, 0.08)) expect(o).toMatchObject({ ok: true, x100: x });
    expect(repriced(std, 0.08).length).toBeGreaterThan(5);
    // The launch quote is immutable: accepted at its launch terms and phase.
    const r = engine.placeBet({ requestId: 'launch-terms', account: bettor, quoteId: launchQuote.quoteId, revision: 1, cellId: launchQuote.cellId, stakeCenti: '1000' });
    expect(r).toMatchObject({ status: 'accepted', leg: { x100: launchQuote.x100, phase: 'launch', edge: 0.03 } });
  });

  it('admin can extend, end early (with confirmation) and change the threshold, each journaled', () => {
    const { engine } = makeEngine();
    for (let i = 1; i <= 50; i++) engine.register(`sim:E${i}`, 'sim');
    expect(engine.setLaunch({ untilPlayers: 40 }, meta())).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    const lowered = engine.setLaunch({ untilPlayers: 40 }, meta('threshold lowered for test', 'edge-change'));
    expect(lowered).toMatchObject({ ok: true, before: { active: true, untilPlayers: 10_000 }, after: { active: false, untilPlayers: 40 } });
    expect(engine.setLaunch({ untilPlayers: 100 }, meta())).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    expect(engine.setLaunch({ untilPlayers: 100 }, meta('extend the launch boost', 'edge-change'))).toMatchObject({ ok: true, after: { active: true } });
    expect(engine.setLaunch({ edge: 0.04 }, meta('launch edge tweak'))).toMatchObject({ ok: true, after: { edge: 0.04 } });
    expect(engine.setLaunch({ edge: 0.07 }, meta('big launch edge change'))).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    expect(engine.setLaunch({ enabled: false }, meta('end the boost early'))).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    const ended = engine.setLaunch({ enabled: false }, meta('end the boost early', 'edge-change'));
    expect(ended).toMatchObject({ ok: true, after: { enabled: false, active: false } });
    expect(engine.setLaunch({ enabled: false }, meta('again the same'))).toMatchObject({ ok: false, code: 'NO_CHANGE' });
    expect(engine.setLaunch({ edge: 0.5 }, meta('out of range edge'))).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(engine.setLaunch({ untilPlayers: -1 }, meta('negative threshold'))).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    const audit = engine.auditLog(50).filter(a => a.action === 'launch');
    expect(audit).toHaveLength(4);
    expect(audit.every(a => a.actor === 'admin' && a.reason && a.before !== undefined && a.after !== undefined)).toBe(true);
  });
});
