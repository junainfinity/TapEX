import { describe, expect, it } from 'vitest';
import { DEFAULT_EDGE_SCHEDULE } from '@maya/house';
import { TOXICITY_ACTOR, excessReturnZ } from '../src/engine/engine.js';
import type { EngineEvent } from '../src/engine/types.js';
import { MemoryJournal } from '../src/ledger/journal.js';
import { HISTORY, T0, deliver, makeEngine, offered, simPlayer } from './helpers.js';

describe('toxicity monitor and flow surcharge', () => {
  it('flags an account whose returns exceed the model by > 4 SE after 50 settled bets, journaled as a system action', () => {
    const journal = new MemoryJournal();
    const { engine } = makeEngine({ journal });
    const p = HISTORY.get(T0 - 1)!;
    const lucky = simPlayer(engine, '100000000', 'casual');
    const honest = simPlayer(engine, '100000000', 'casual');
    let n = 0;
    // A flat path: every centre-band square wins. Betting only those is "knowing the future".
    for (let t = T0; t < T0 + 200; t++) {
      deliver(engine, 'btc-usd', t, p);
      const centre = offered(engine).filter(q => q.bandOffset === 0 && q.window >= 1);
      const far = offered(engine).filter(q => Math.abs(q.bandOffset) >= 2);
      for (const q of centre.slice(0, 2)) engine.placeBet({ requestId: `lucky-${n++}`, account: lucky, quoteId: q.quoteId, revision: 1, cellId: q.cellId, stakeCenti: '1000' });
      const f = far[t % Math.max(1, far.length)];
      if (f) engine.placeBet({ requestId: `honest-${n++}`, account: honest, quoteId: f.quoteId, revision: 1, cellId: f.cellId, stakeCenti: '1000' });
    }
    const L = engine.player(lucky)!, H = engine.player(honest)!;
    expect(L.settledBets).toBeGreaterThan(50);
    expect(excessReturnZ(L)).toBeGreaterThan(4);
    expect(L.flagged).toBe(true);
    expect(L.flags[0]).toMatchObject({ actor: TOXICITY_ACTOR, action: 'flag', reason: expect.stringMatching(/^excess return z=/) });
    expect(H.flagged).toBe(false);
    expect(excessReturnZ(H)).toBeLessThan(0);
    const audit = journal.records<EngineEvent>().filter((r): r is Extract<EngineEvent, { type: 'audit' }> => r.type === 'audit' && r.entry.actor === TOXICITY_ACTOR);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.entry).toMatchObject({ kind: 'system', action: 'player-flag', target: lucky });
    // Rebuild reproduces the flag (it is a journaled event, not recomputed).
    const rebuilt = makeEngine({ records: journal.records<EngineEvent>(), journal: new MemoryJournal() }).engine;
    expect(rebuilt.player(lucky)!.flagged).toBe(true);
    expect(excessReturnZ(rebuilt.player(lucky)!)).toBe(excessReturnZ(L));
  });

  it('prices flagged accounts from their own grid with the flow surcharge and refuses the plain grid', () => {
    const { engine } = makeEngine({ schedule: { ...DEFAULT_EDGE_SCHEDULE, flowEdge: 0.05 } });
    const who = simPlayer(engine);
    const clean = simPlayer(engine);
    expect(engine.setPlayerFlag(who, 'flag', { actor: 'admin', reason: 'manual toxic flow flag' }).ok).toBe(true);
    deliver(engine, 'btc-usd', T0, HISTORY.get(T0 - 1)!);
    const plain = engine.latestGrid('btc-usd', false)!, flagged = engine.latestGrid('btc-usd', true)!;
    expect(plain.grid.edge.edge).toBeCloseTo(0.03, 12);
    expect(flagged.grid.edge).toMatchObject({ flow: 0.05 });
    expect(flagged.grid.edge.edge).toBeCloseTo(0.08, 12);
    const pq = plain.quotes.find(q => q && q.window === 4)!, fq = flagged.quotes.find(q => q && q.window === 4)!;
    expect(engine.placeBet({ requestId: 'f-plain', account: who, quoteId: pq.quoteId, revision: 1, cellId: pq.cellId, stakeCenti: '100' })).toMatchObject({ reason: 'QUOTE_CHANGED' });
    expect(engine.placeBet({ requestId: 'f-own', account: who, quoteId: fq.quoteId, revision: 1, cellId: fq.cellId, stakeCenti: '100' })).toMatchObject({ status: 'accepted', leg: { flagged: true } });
    expect(engine.placeBet({ requestId: 'c-flagged', account: clean, quoteId: fq.quoteId, revision: 1, cellId: fq.cellId, stakeCenti: '100' })).toMatchObject({ reason: 'QUOTE_CHANGED' });
  });
});
