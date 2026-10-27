/**
 * Contract test: the console decoders against responses captured from the real house server
 * (src/live-fixtures.ts). A server change that breaks a field the console renders fails here.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeAudit, decodeBets, decodeChain, decodeDefenses, decodeExposure, decodeMetrics, decodeOverview, decodePlayerDetail, decodePlayers, decodeProof, decodeRtp,
  decodeStreamEvent, DecodeFailure,
} from './decode.js';
import { LIVE } from './live-fixtures.js';
import { flattenDefenses, DEFENSE_SECTIONS } from './defense-controls.js';
import { houseWithdrawableCenti } from './controls.js';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('live house-server responses decode', () => {
  it('overview, including the SPEC-10 defense summary and SPEC-11 chain alerts', () => {
    const o = decodeOverview(LIVE['overview']);
    expect(o.network).toBe('offline');
    expect(o.markets.map(m => m.id)).toEqual(['btc-usd', 'eth-usd']);
    expect(o.pricing).toBeDefined(); expect(o.limits).toBeDefined(); expect(o.sim).toBeDefined();
    expect(o.defenses).toMatchObject({ hold: true, quoteValidity: true, ramp: true, toxicity: 'graduated', controller: true });
    expect(typeof o.holdPending).toBe('number');
    expect(o.holdLatencyP95Ms === null || typeof o.holdLatencyP95Ms === 'number').toBe(true);
    expect(o.controller?.ranges.map(r => r.key)).toEqual(['1.01-2', '2-5', '5-10', '10-20', '20-50', '50-100']);
    expect(Array.isArray(o.chainAlerts)).toBe(true);
    expect(Object.isFrozen(o.controller)).toBe(true);
  });

  it('defenses: every config field the forms edit is present with the server type', () => {
    const d = decodeDefenses(LIVE['defenses']);
    const flat = flattenDefenses(d.config);
    for (const field of DEFENSE_SECTIONS.flatMap(s => s.fields)) expect(flat, field.key).toHaveProperty([field.key]);
    expect(d.config.controller.overrides).toEqual({});
    expect(d.hold.latencyMs.p95).not.toBeNull();
    expect(Object.keys(d.hold.byDetail)).toContain('ok');
    expect(d.controller.ranges).toHaveLength(6);
    expect(d.referenceFeed).toBeNull(); // replay: no Hermes reference
  });

  it('chain: SPEC-11 vault fields, balance-tree attestation, reconciliation', () => {
    const c = decodeChain(LIVE['chain']);
    expect(c.vault.ledgerSigner).toMatch(/^0x[0-9a-f]{40}$/);
    expect(c.vault.serverSigner).toBe(c.vault.ledgerSigner);
    expect(c.vault.signerMismatch).toBe(false);
    expect(c.vault.pendingSigner).toBeNull();
    expect(c.vault.signerChangeDelaySec).toBe(172_800);
    expect(c.vault.maxAttestationAgeSec).toBe(600);
    expect(c.vault.houseBufferBps).toBe(1000);
    expect(c.vault.escape).toMatchObject({ mode: false, escapeDelaySec: 604_800 });
    expect(c.lastAttestation?.tree?.leaves).toBeGreaterThan(0);
    expect(c.reconciliation).toMatchObject({ match: true, deltaWei: '0' });
    expect(c.withdrawals?.indexed).toBeGreaterThanOrEqual(0);
    expect(houseWithdrawableCenti(c)).toBe(BigInt(c.vault.houseWithdrawableCenti!));
  });

  it('rtp, exposure, metrics, players, player detail, bets and audit', () => {
    expect(decodeRtp(LIVE['rtp']).byRange.length).toBeGreaterThan(0);
    const e = decodeExposure(LIVE['exposure']);
    expect(e.cells.length).toBe(e.windows.length * e.bands.length);
    const m = decodeMetrics(LIVE['metrics']);
    expect(m.t.length).toBe(m.equity.length);
    const players = decodePlayers(LIVE['players']);
    expect(players.rows[0]).toHaveProperty('holds');
    const onchain = decodePlayers(LIVE['playersOnchain']).rows[0]!;
    expect(onchain.kind).toBe('onchain');
    expect(onchain.account).toMatch(/^0x[0-9a-f]{40}$/); // the server names on-chain accounts by bare address
    const detail = decodePlayerDetail(LIVE['playerDetail']);
    expect(detail.player.account).toBe(onchain.account);
    expect(detail.bets[0]?.heldMs).toEqual(expect.any(Number));
    expect(decodeBets(LIVE['bets']).rows.length).toBeGreaterThan(0);
    const audit = decodeAudit(LIVE['audit']);
    expect(audit.some(a => a.action === 'controller-adjust' && a.actor === 'edge-controller' && typeof a.after === 'number')).toBe(true);
  });

  it('proof: included leaf, and the no-leaf answer', () => {
    const p = decodeProof(LIVE['proof']);
    expect(p.included).toBe(true);
    expect(p.proof.length).toBeGreaterThan(0);
    expect(p.claim?.function).toBe('claimEscape(uint256,bytes32[])');
    expect(p.escape?.mode).toBe(false);
    const none = decodeProof(LIVE['proofNone']);
    expect(none).toMatchObject({ included: false, balanceWei: '0', proof: [] });
  });

  it('stream frames decode as typed events', () => {
    for (const [type, data] of Object.entries(LIVE.stream)) expect(decodeStreamEvent(type, data), type).not.toBeNull();
    // The server's alert and admin-action payloads (engine.alert / recordAudit).
    expect(decodeStreamEvent('alert', { level: 'warning', message: 'Toxicity monitor surcharged sim:1 (z=3.10)', ms: 1, code: 'TOXIC_FLOW' })).toMatchObject({ data: { code: 'TOXIC_FLOW' } });
    const entry = (LIVE['audit'] as { rows: unknown[] }).rows[0];
    expect(decodeStreamEvent('admin-action', entry)).not.toBeNull();
  });
});

describe('decoders stay strict on the new fields', () => {
  it('refuses a wrong type instead of rendering it', () => {
    const o = clone(LIVE['overview']) as Record<string, unknown>;
    o['holdRejectRate'] = '0.1';
    expect(() => decodeOverview(o)).toThrow(DecodeFailure);
    const c = clone(LIVE['chain']) as { vault: Record<string, unknown> };
    (c.vault['escape'] as Record<string, unknown>)['poolWei'] = 12;
    expect(() => decodeChain(c)).toThrow(/escape\.poolWei/);
    const d = clone(LIVE['defenses']) as { config: { hold: Record<string, unknown> } };
    d.config.hold['tolScale'] = 'cubic';
    expect(() => decodeDefenses(d)).toThrow(/tolScale/);
    const p = clone(LIVE['proof']) as { proof: unknown[] };
    p.proof[0] = '0x1234';
    expect(() => decodeProof(p)).toThrow(/proof\[0\]/);
  });

  it('keeps absent server extensions absent (older servers still decode)', () => {
    const o = clone(LIVE['overview']) as Record<string, unknown>;
    for (const key of ['holdPending', 'holdRejectRate', 'holdLatencyP95Ms', 'toxicFlowShare', 'defenses', 'controller', 'chainAlerts', 'ledgerSigner']) delete o[key];
    const decoded = decodeOverview(o);
    expect(decoded.defenses).toBeUndefined();
    expect('holdRejectRate' in decoded).toBe(false);
  });

  it('decodes a 503 PROOF_UNAVAILABLE body as unavailable, keeping attestation and escape', () => {
    const live = LIVE['proof'] as Record<string, unknown>;
    const body = { account: live['account'], chainId: live['chainId'], vault: live['vault'], error: { code: 'PROOF_UNAVAILABLE', message: 'The balance tree for attestation 3 is not available on this server' }, attestation: live['attestation'], escape: live['escape'] };
    const p = decodeProof(body);
    expect(p.unavailable).toEqual({ code: 'PROOF_UNAVAILABLE', message: expect.stringContaining('not available') });
    expect(p.proof).toEqual([]);
    expect(p.attestation?.seq).toBe((live['attestation'] as { seq: string }).seq);
  });
});
