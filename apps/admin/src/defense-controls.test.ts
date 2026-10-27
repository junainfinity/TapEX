import { describe, expect, it } from 'vitest';
import { formatMinutes, parseField, prepareSubmission } from './controls.js';
import {
  classifyDefenseChange, DEFENSE_SECTIONS, defensesPlan, effectiveAdjustments, flattenDefenses, mergeDefenses, nestPatch, overridesPlan, parseOverride, validateDefenseRelations,
} from './defense-controls.js';
import { decodeDefenses } from './decode.js';
import { LIVE } from './live-fixtures.js';
import type { ControllerRangeView, DefenseConfig, DefensesView } from './types.js';

const REASON = 'Defense tuning after the ablation review';
const live = (): DefensesView => decodeDefenses(LIVE['defenses']);
const section = (id: string) => DEFENSE_SECTIONS.find(s => s.id === id)!;
function withRanges(view: DefensesView, adjust: Readonly<Record<string, number>>, config: Partial<DefenseConfig['controller']> = {}): DefensesView {
  const ranges: ControllerRangeView[] = view.controller.ranges.map(r => ({ ...r, adjust: adjust[r.key] ?? 0, effective: adjust[r.key] ?? 0 }));
  return { ...view, config: { ...view.config, controller: { ...view.config.controller, ...config } }, controller: { ...view.controller, ranges } };
}
function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

describe('defense field specs', () => {
  it('parse signed values, minute durations and zero-allowed OPEN amounts', () => {
    const f = (key: string) => DEFENSE_SECTIONS.flatMap(s => s.fields).find(x => x.key === key)!;
    expect(parseField(f('toxicity.unflagZ'), '-2.5')).toEqual({ ok: true, value: -2.5 });
    expect(parseField(f('toxicity.surchargeZ'), '-2')).toMatchObject({ ok: false });
    expect(parseField(f('controller.minAdjust'), '-1.5')).toEqual({ ok: true, value: -0.015 });
    expect(parseField(f('controller.minAdjust'), '1')).toMatchObject({ ok: false, error: expect.stringContaining('maximum') });
    expect(parseField(f('controller.windowMs'), '180')).toEqual({ ok: true, value: 10_800_000 });
    expect(parseField(f('controller.windowMs'), '5')).toMatchObject({ ok: false, error: expect.stringContaining('minimum is 10 min') });
    expect(parseField(f('ramp.perSettledBetCenti'), '0')).toEqual({ ok: true, value: '0' });
    expect(parseField(f('ramp.startCenti'), '0')).toMatchObject({ ok: false });
    expect(parseField(f('hold.maxHoldMs'), '5001')).toMatchObject({ ok: false });
    expect(formatMinutes(10_800_000)).toBe('3 h');
    expect(formatMinutes(900_000)).toBe('15 min');
    expect(formatMinutes(604_800_000)).toBe('7 d');
  });

  it('flatten and nest are inverse on the dotted keys', () => {
    const config = live().config;
    const flat = flattenDefenses(config);
    expect(flat['hold.tolRel']).toBe(config.hold.tolRel);
    expect(flat['minLeadS']).toBe(config.minLeadS);
    expect(nestPatch({ 'hold.tolRel': 1.1, minLeadS: 5, 'toxicity.enabled': false })).toEqual({ hold: { tolRel: 1.1 }, minLeadS: 5, toxicity: { enabled: false } });
  });
});

describe('defense change classification (mirrors engine.setDefenses)', () => {
  it('switching a defense off needs defenses-disable, even with an edge move', () => {
    const v = live();
    const after = mergeDefenses(v.config, { controller: { enabled: false } });
    const moved = classifyDefenseChange(v.config, after, withRanges(v, { '5-10': 0.03 }).controller.ranges);
    expect(moved).toMatchObject({ disabled: ['controller'], confirmName: 'defenses-disable' });
    expect(moved.edgeMove).toBeCloseTo(0.03);
    expect(ok(defensesPlan(v, section('hold'), { 'hold.enabled': 'false' })).plan.confirmName).toBe('defenses-disable');
    expect(ok(defensesPlan(v, section('hold'), { 'hold.enabled': 'false' })).plan.warnings.join(' ')).toMatch(/3 M OPEN/);
  });

  it('a pin or surcharge that moves an edge by more than 2 pts needs edge-change; 2 pts or less does not', () => {
    const v = withRanges(live(), { '2-5': 0.01 });
    const pin = (value: number) => classifyDefenseChange(v.config, mergeDefenses(v.config, { controller: { overrides: { '2-5': value } } }), v.controller.ranges);
    expect(pin(0.035).confirmName).toBe('edge-change'); // 1 → 3.5 pts
    expect(pin(0.03).confirmName).toBeNull(); // exactly 2 pts is not "more than 2"
    const base = v.config.toxicity.surchargeEdge;
    const surcharge = (edge: number) => classifyDefenseChange(v.config, mergeDefenses(v.config, { toxicity: { surchargeEdge: edge } }), v.controller.ranges);
    expect(surcharge(base + 0.025).confirmName).toBe('edge-change');
    expect(surcharge(base + 0.01).confirmName).toBeNull();
    expect(surcharge(Math.max(0, base - 0.025)).confirmName).toBe(base >= 0.025 ? 'edge-change' : null);
  });

  it('re-enabling the controller applies its learned adjustments: a move over 2 pts needs edge-change', () => {
    const off = withRanges(live(), { '5-10': 0.03 }, { enabled: false });
    expect(effectiveAdjustments(off.config, off.controller.ranges)['5-10']).toBe(0);
    const on = classifyDefenseChange(off.config, mergeDefenses(off.config, { controller: { enabled: true } }), off.controller.ranges);
    expect(on).toMatchObject({ disabled: [], confirmName: 'edge-change' });
  });

  it('a stale view errs towards confirming (one controller step of margin)', () => {
    const v = withRanges(live(), { '2-5': 0 });
    const after = mergeDefenses(v.config, { controller: { overrides: { '2-5': 0.015 } } });
    expect(classifyDefenseChange(v.config, after, v.controller.ranges, 0).confirmName).toBeNull();
    expect(classifyDefenseChange(v.config, after, v.controller.ranges, 0.01).confirmName).toBe('edge-change');
  });

  it('enforces the server cross-field rules before submitting', () => {
    const v = live();
    expect(defensesPlan(v, section('toxicity'), { 'toxicity.blockZ': '2' })).toMatchObject({ ok: false, errors: { _form: expect.stringContaining('Block z') } });
    expect(defensesPlan(v, section('toxicity'), { 'toxicity.unflagZ': '2.8' })).toMatchObject({ ok: false, errors: { _form: expect.stringContaining('surcharge z − 0.5') } });
    expect(defensesPlan(v, section('controller'), { 'controller.maxStepPerHour': '0.5' })).toMatchObject({ ok: false, errors: { _form: expect.stringContaining('hourly move') } });
    expect(validateDefenseRelations(v.config)).toBeNull();
    expect(defensesPlan(null, section('hold'), { 'hold.tolRel': '1' })).toMatchObject({ ok: false });
  });

  it('builds the exact PUT /defenses body the server expects', () => {
    const v = live();
    const plan = ok(defensesPlan(v, section('quotes'), { minLeadS: '5', 'quoteValidity.graceMs': '400' })).plan;
    expect(plan.changes.map(c => [c.label, c.before, c.after])).toEqual([['Grace after a newer sample', '500 ms', '400 ms'], ['Minimum lead', '4 s', '5 s']]);
    const sub = prepareSubmission(plan, REASON, '');
    expect(sub).toEqual({ ok: true, request: { method: 'PUT', path: '/defenses', body: { quoteValidity: { graceMs: 400 }, minLeadS: 5, reason: REASON } } });
  });

  it('warns when the adaptive edge would run without the hold or graduated toxicity', () => {
    const v = live();
    const plan = ok(defensesPlan(v, section('toxicity'), { 'toxicity.enabled': 'false' })).plan;
    expect(plan.warnings.join(' ')).toMatch(/adaptive edge would run without/);
  });
});

describe('controller pins', () => {
  it('parse pins: auto releases, signed percentages set, bounds enforced', () => {
    expect(parseOverride('auto')).toEqual({ ok: true, value: null });
    expect(parseOverride(' Clear ')).toEqual({ ok: true, value: null });
    expect(parseOverride('-0.5')).toEqual({ ok: true, value: -0.005 });
    expect(parseOverride('25')).toMatchObject({ ok: false });
    expect(parseOverride('abc')).toMatchObject({ ok: false });
  });

  it('plan pins and releases against the learned adjustment', () => {
    const v = withRanges(live(), { '1.01-2': 0.01, '5-10': 0.02 });
    const pinned = { ...v, config: { ...v.config, controller: { ...v.config.controller, overrides: { '5-10': 0.04 } } } };
    const plan = ok(overridesPlan(pinned, { '1.01-2': '3.5', '5-10': 'auto', '2-5': '' })).plan;
    expect(plan.changes.map(c => [c.key, c.before, c.after])).toEqual([
      ['override.1.01-2', 'auto (+1.00%)', 'pinned +3.50%'],
      ['override.5-10', 'pinned +4.00%', 'auto (+2.00%)'],
    ]);
    expect(plan.confirmName).toBe('edge-change'); // 1 → 3.5 pts
    expect(ok(prepareSubmission(plan, REASON, 'edge-change')).request.body).toEqual({ controller: { overrides: { '1.01-2': 0.035, '5-10': null } }, reason: REASON, confirm: 'edge-change' });
    expect(overridesPlan(pinned, { '5-10': '4' })).toMatchObject({ ok: false, errors: { _form: expect.stringContaining('Nothing to change') } });
    expect(overridesPlan(pinned, { '2-5': 'x' })).toMatchObject({ ok: false, errors: { '2-5': expect.any(String) } });
  });
});
