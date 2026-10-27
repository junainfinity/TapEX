import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellId, grossReturn, sampleId, sampleTouchesCell, segmentTouchesCell, observedSampleId, OBSERVED_PATH_POLICY, OBSERVED_PATH_RULE_VERSION, OBSERVED_SAMPLE_PREFIX } from '../packages/contracts/dist/index.js';
import { getMarket } from '../packages/config/dist/index.js';

const LEGACY_RULE = 'maya-sampled-v1';
const LEGACY_POLICY = 'maya-lynx-sampled-1s-stabilized-3s-v1';
const terminalKinds = new Set(['win', 'loss', 'refund']);

function firstPathTouch(samples, position) {
  const sorted = [...samples].sort((a, b) => a.sourceTimeMs - b.sourceTimeMs);
  let first;
  for (let index = 0; index < sorted.length; index++) {
    const sample = sorted[index];
    if (sampleTouchesCell(sample, position)) first = Math.min(first ?? Infinity, sample.sourceTimeMs);
    const next = sorted[index + 1];
    if (next) {
      const hit = segmentTouchesCell(sample, next, position);
      if (hit) first = Math.min(first ?? Infinity, hit.firstTouchTimeMs);
    }
  }
  return first;
}

/** Read-only arithmetic/evidence audit. It never reinterprets or changes accepted positions. */
export function auditLedger(ledger, file = 'composed capture') {
  if (!ledger || !ledger.positions || !ledger.entries || !ledger.samples) throw new Error('Capture contains no supported paper ledger');
  const checks = [];
  const check = (name, predicate) => {
    try { checks.push({ name, pass: Boolean(typeof predicate === 'function' ? predicate() : predicate) }); }
    catch (error) { checks.push({ name, pass: false, error: String(error.message ?? error) }); }
  };
  const entries = Object.values(ledger.entries);
  // Full ledgers separate the tapes to protect old running tabs. Diagnostic
  // snapshots have already combined the two sample-ID namespaces.
  const allSamples = { ...ledger.samples, ...ledger.observedSamples };
  const positions = Object.values(ledger.positions);
  check('balance equals exact journal sum', () => entries.reduce((n, entry) => n + BigInt(entry.amountCents), 0n) === BigInt(ledger.balanceCents));
  for (const position of positions) {
    const prefix = position.positionId;
    const observed = position.ruleVersion === OBSERVED_PATH_RULE_VERSION;
    const knownRule = observed || position.ruleVersion === LEGACY_RULE;
    const policy = position.settlementPolicy;
    const debits = entries.filter(entry => entry.positionId === prefix && entry.kind === 'debit');
    const terminals = entries.filter(entry => entry.positionId === prefix && terminalKinds.has(entry.kind));
    check(`${prefix}: known pinned rule`, knownRule);
    check(`${prefix}: canonical square`, () => position.cellId === cellId(position));
    check(`${prefix}: exact payout`, () => grossReturn(position.stakeCents, position.grossX100) === position.grossReturnCents);
    check(`${prefix}: correct model`, position.provenance?.modelId === (observed ? 'maya-gaussian-linear-six-v2' : 'maya-gaussian-discrete-five-v1'));
    check(`${prefix}: matching pinned policy`, () => policy?.policyId === (observed ? OBSERVED_PATH_POLICY.policyId : LEGACY_POLICY) && position.provenance?.policyId === policy.policyId);
    if (observed) check(`${prefix}: exact v2 policy parameters`, () => ['expectedSampleIntervalMs', 'lateArrivalGraceMs', 'recoveryDeadlineMs'].every(key => policy?.[key] === OBSERVED_PATH_POLICY[key]));
    check(`${prefix}: one exact debit`, () => debits.length === 1 && BigInt(debits[0].amountCents) === -BigInt(position.stakeCents));
    if (position.status === 'open') { check(`${prefix}: no premature terminal entry`, terminals.length === 0); continue; }
    check(`${prefix}: known terminal outcome`, ['won', 'lost', 'refunded'].includes(position.status));
    check(`${prefix}: one exact terminal credit`, () => {
      const kind = position.status === 'won' ? 'win' : position.status === 'lost' ? 'loss' : 'refund';
      const amount = position.status === 'won' ? position.grossReturnCents : position.status === 'lost' ? '0' : position.stakeCents;
      return terminals.length === 1 && terminals[0].kind === kind && BigInt(terminals[0].amountCents) === BigInt(amount);
    });
    const ids = position.evidenceSampleIds ?? [];
    const samples = ids.map(id => allSamples[id]);
    const retained = samples.every(Boolean);
    check(`${prefix}: recorded evidence retained`, retained);
    check(`${prefix}: evidence IDs unique`, new Set(ids).size === ids.length);
    if (!retained || !knownRule) continue;
    check(`${prefix}: evidence uses its pinned tape and market`, () => {
      const market = getMarket(position.marketId);
      return samples.every(sample => sample.marketId === position.marketId && sample.feedId === market.feedId && sample.pairId === market.pairId && sample.sampleId === (observed ? observedSampleId(sample) : sampleId(sample.feedId, sample.sourceTimeMs)) && sample.sampleId.startsWith(OBSERVED_SAMPLE_PREFIX) === observed);
    });
    if (position.status === 'won') {
      if (observed) {
        const touch = firstPathTouch(samples, position);
        check(`${prefix}: exact recorded segment or point touch`, touch !== undefined);
        check(`${prefix}: animation time matches recorded touch`, Number.isFinite(position.touchTimeMs) && touch !== undefined && Math.abs(position.touchTimeMs - touch) < .001);
      } else check(`${prefix}: actual sampled touch`, samples.some(sample => sampleTouchesCell(sample, position)));
    }
    if (position.status === 'lost') {
      const count = observed ? 6 : 5;
      check(`${prefix}: all ${count} slots present`, Array.from({ length: count }, (_, i) => position.startMs + i * 1000).every(time => samples.some(sample => sample.sourceTimeMs === time)));
      check(`${prefix}: no ${observed ? 'recorded path' : 'sampled'} touch`, observed ? firstPathTouch(samples, position) === undefined : samples.every(sample => !sampleTouchesCell(sample, position)));
    }
  }
  return {
    at: new Date().toISOString(), file, checks: checks.length, pass: checks.every(check => check.pass), balanceCents: ledger.balanceCents,
    positions: positions.length, rules: Object.fromEntries([LEGACY_RULE, OBSERVED_PATH_RULE_VERSION].map(rule => [rule, positions.filter(position => position.ruleVersion === rule).length])),
    outcomes: Object.fromEntries(['open', 'won', 'lost', 'refunded'].map(status => [status, positions.filter(position => position.status === status).length])), details: checks,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node tooling/audit-browser-ledger.mjs <capture.json>');
  const capture = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  if (capture.success === false) throw new Error('Browser capture failed');
  const resultValue = capture.data?.result ?? capture;
  const ledger = resultValue.ledger ?? resultValue.audit ?? resultValue;
  const result = auditLedger(ledger, file);
  const target = file.replace(/\.json$/i, '') + '-audit.json';
  await writeFile(target, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, details: undefined, failures: result.details.filter(check => !check.pass) }, null, 2));
  if (!result.pass) process.exitCode = 1;
}
