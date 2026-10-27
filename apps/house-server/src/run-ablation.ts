import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultRepoRoot } from './config.js';
import { formatOpen } from '@maya/house';

/**
 * SPEC-10 ablation: runs `run-sim` for every defense profile over every period (child processes,
 * bounded concurrency; each run in its own never-overwritten folder) and writes the comparison.
 */
export interface AblationRun { readonly profile: string; readonly label: string; readonly period: string; readonly periodIndex: number; readonly dir: string }
export interface AblationOptions {
  readonly periods: readonly string[];
  readonly hours: number;
  readonly profiles: readonly { readonly label: string; readonly profile: string; readonly tunes: readonly string[] }[];
  readonly outRoot: string;
  readonly prefix: string;
  readonly concurrency: number;
  readonly marketData?: string;
  readonly summary: string;
  readonly extraArgs: readonly string[];
  readonly summarizeOnly: boolean;
  readonly log: (line: string) => void;
}

export function planRuns(o: Pick<AblationOptions, 'periods' | 'profiles' | 'outRoot' | 'prefix'>): AblationRun[] {
  return o.periods.flatMap((period, i) => o.profiles.map(p => ({ profile: p.profile, label: p.label, period, periodIndex: i + 1, dir: join(o.outRoot, `${o.prefix}-${p.label}-p${i + 1}`) })));
}

function runOne(run: AblationRun, o: AblationOptions, tunes: readonly string[]): Promise<{ code: number; log: string }> {
  const script = fileURLToPath(new URL('./run-sim.js', import.meta.url));
  const args = [script, '--from', run.period, '--hours', String(o.hours), '--defenses', run.profile, '--name', `${o.prefix}-${run.label}-p${run.periodIndex}`, '--out', run.dir,
    ...(o.marketData ? ['--market-data', o.marketData] : []), ...tunes.flatMap(t => ['--tune', t]), ...o.extraArgs];
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: string[] = [];
    child.stdout.on('data', d => chunks.push(String(d)));
    child.stderr.on('data', d => chunks.push(String(d)));
    child.on('close', code => resolvePromise({ code: code ?? 1, log: `$ node ${args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n${chunks.join('')}` }));
  });
}

export async function runAblation(o: AblationOptions): Promise<string> {
  const runs = planRuns(o);
  if (!o.summarizeOnly) {
    const clash = runs.filter(r => existsSync(r.dir) && readdirSync(r.dir).length);
    if (clash.length) throw new Error(`Refusing to overwrite existing run folders: ${clash.map(r => r.dir).join(', ')}`);
    const queue = [...runs];
    const workers = Array.from({ length: Math.max(1, o.concurrency) }, async () => {
      for (let run = queue.shift(); run; run = queue.shift()) {
        const tunes = o.profiles.find(p => p.label === run.label)!.tunes;
        o.log(`ablation: start ${run.label} p${run.periodIndex} (${run.profile}${tunes.length ? ` + ${tunes.join(' ')}` : ''})`);
        const r = await runOne(run, o, tunes);
        if (existsSync(run.dir)) writeFileSync(join(run.dir, 'run.log'), r.log);
        o.log(`ablation: ${r.code === 0 ? 'done' : `FAILED (${r.code})`} ${run.label} p${run.periodIndex}`);
      }
    });
    await Promise.all(workers);
  }
  const md = renderAblation(runs, o);
  writeFileSync(o.summary, md);
  return md;
}

type Report = { run: Record<string, unknown>; config: Record<string, unknown>; pnl: Record<string, string>; phases: Record<string, unknown>[]; strategies: Record<string, Record<string, unknown>>; defenses: Record<string, unknown>; headline: Record<string, unknown>; invariants: Record<string, unknown>; reconciliation: Record<string, unknown> };
const pct = (v: unknown, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const open = (c: unknown) => formatOpen(String(c ?? '0'));
const kopen = (c: unknown) => { const n = Number(c ?? 0) / 100; return `${n < 0 ? '−' : ''}${Math.abs(n / 1000).toFixed(1)}k`; };

export function renderAblation(runs: readonly AblationRun[], o: Pick<AblationOptions, 'periods' | 'hours' | 'profiles'>): string {
  const load = (r: AblationRun): Report | undefined => { const f = join(r.dir, 'report.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as Report : undefined; };
  const lines: string[] = [];
  lines.push('# SPEC-10 defenses: ablation', '');
  lines.push(`Real \`run-sim\` (house engine, offline chain) over ${o.periods.length} replay periods of ${o.hours} h of recorded BTC/ETH prices, 12,000 synthetic players (plus the 11 on-chain players), 5,000,000 OPEN bankroll. Every row is one run folder under \`artifacts/verification/\`. RTP is realized return / settled stake; *policy* is the RTP the pricing promises (1 − phase edge − drawdown widening); honest = casual, chaser, grinder, streaker, whale; adversaries see the next first-seen price (sniper1s, splitter: 1 s; sniper2s: 2 s).`, '');
  for (const [i, period] of o.periods.entries()) {
    lines.push(`## Period ${i + 1}: ${period} + ${o.hours} h`, '');
    lines.push('| Profile | House P&L | Launch GGR | Honest RTP | Policy | Honest rejected | Hold p95 | sniper1s RTP (bets) | splitter RTP (bets) | sniper2s RTP (bets) | Adversary P&L | Folder |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const run of runs.filter(r => r.periodIndex === i + 1)) {
      const r = load(run);
      if (!r) { lines.push(`| ${run.label} | (missing) | | | | | | | | | | \`${run.dir.split(/[\\/]/).pop()}\` |`); continue; }
      const d = r.defenses as { honest?: Record<string, unknown>; adversarial?: Record<string, unknown>; hold?: { latencyMs?: { p95?: number | null }; created?: number } };
      const s = (k: string) => r.strategies[k] ? `${pct(r.strategies[k]!['rtp'], 1)} (${String(r.strategies[k]!['bets'])})` : '—';
      const launch = r.phases.find(p => p['phase'] === 'launch');
      lines.push(`| ${run.label} | ${kopen(r.pnl['totalPnlCenti'])} | ${kopen(launch?.['ggrCenti'])} | ${pct(d.honest?.['rtp'])} | ${pct(d.honest?.['policyTarget'])} | ${pct(d.honest?.['rejectionRate'], 1)} | ${d.hold?.created ? `${String(d.hold.latencyMs?.p95 ?? '—')} ms` : '—'} | ${s('sniper1s')} | ${s('splitter')} | ${s('sniper2s')} | ${kopen(d.adversarial?.['housePnlCenti'])} | \`${run.dir.split(/[\\/]/).pop()}\` |`);
    }
    lines.push('');
  }
  const allRuns = runs.filter(r => r.label === 'all');
  if (allRuns.length) {
    lines.push('## Targets with all defenses', '');
    lines.push('| Target | ' + allRuns.map(r => `Period ${r.periodIndex}`).join(' | ') + ' |');
    lines.push('| --- | ' + allRuns.map(() => '---').join(' | ') + ' |');
    const reps = allRuns.map(load);
    const row = (name: string, f: (r: Report) => string) => lines.push(`| ${name} | ${reps.map(r => (r ? f(r) : '(missing)')).join(' | ')} |`);
    const mark = (ok: boolean) => (ok ? 'met' : '**not met**');
    row('House P&L > 0', r => `${open(r.pnl['totalPnlCenti'])} — ${mark(BigInt(r.pnl['totalPnlCenti'] ?? '0') > 0n)}`);
    row('sniper1s RTP < 97%', r => `${pct(r.strategies['sniper1s']?.['rtp'])} over ${String(r.strategies['sniper1s']?.['bets'])} bets — ${mark(Number(r.strategies['sniper1s']?.['rtp'] ?? 9) < 0.97)}`);
    row('splitter RTP < 97%', r => `${pct(r.strategies['splitter']?.['rtp'])} over ${String(r.strategies['splitter']?.['bets'])} bets — ${mark(Number(r.strategies['splitter']?.['rtp'] ?? 9) < 0.97)}`);
    row('sniper2s RTP (best effort < 100%)', r => `${pct(r.strategies['sniper2s']?.['rtp'])} over ${String(r.strategies['sniper2s']?.['bets'])} bets — ${mark(Number(r.strategies['sniper2s']?.['rtp'] ?? 9) < 1)}`);
    for (const k of ['casual', 'chaser', 'grinder', 'streaker', 'whale']) row(`${k} RTP within ±1.5 pts of policy`, r => {
      const s = r.strategies[k]; if (!s) return '—';
      const gap = Number(s['rtp']) - Number(s['policyTarget']);
      return `${pct(s['rtp'])} vs ${pct(s['policyTarget'])} (${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(2)} pts, ±${pct(s['rtpSe'])} SE) — ${mark(Math.abs(gap) <= 0.015)}`;
    });
    row('Honest rejection rate < 10%', r => { const h = (r.defenses as { honest: Record<string, unknown> }).honest; return `${pct(h['rejectionRate'])} — ${mark(Number(h['rejectionRate']) < 0.1)}`; });
    row('Hold latency p95 ≤ 1.5 s', r => { const h = (r.defenses as { hold: { latencyMs: { p95: number | null } } }).hold; return `${String(h.latencyMs.p95)} ms — ${mark((h.latencyMs.p95 ?? 99_999) <= 1500)}`; });
    row('Launch-phase GGR ≥ 0 (goal)', r => { const l = r.phases.find(p => p['phase'] === 'launch'); return `${open(l?.['ggrCenti'])} — ${mark(BigInt(String(l?.['ggrCenti'] ?? '0')) >= 0n)}`; });
    row('Reconciliation / invariants', r => `${String(r.headline['reconciliation'])} / ${String(r.headline['invariants'])}`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

// ------------------------------------------------------------------ CLI

const USAGE = `Usage: node apps/house-server/dist/run-ablation.js [options]
  --periods <ISO,ISO,...>    replay starts (default 2026-09-23T02:00:00Z,2026-09-24T02:00:00Z)
  --hours <n>                hours per run (default 24)
  --profile <label>=<spec>   a profile row (repeatable; spec as run-sim --defenses, optional "|path=value|..." tunes)
  --out-root <dir>           folder for the run folders (default artifacts/verification)
  --prefix <text>            run folder prefix (default house-sim-2026-09-26-abl)
  --concurrency <n>          parallel runs (default 4)
  --summary <file>           markdown summary path (default artifacts/verification/defenses-ablation-2026-09-26.md)
  --market-data <dir>        market log root
  --summarize-only           only (re)write the summary from existing run folders
  -- <args>                  extra arguments passed to every run-sim`;

export function parseAblationArgs(argv: readonly string[], repoRoot = defaultRepoRoot()): { ok: true; options: AblationOptions } | { ok: false; message: string } {
  let periods = ['2026-09-23T02:00:00Z', '2026-09-24T02:00:00Z'], hours = 24, concurrency = 4, summarizeOnly = false;
  let outRoot = join(repoRoot, 'artifacts', 'verification'), prefix = 'house-sim-2026-09-26-abl', summary = join(repoRoot, 'artifacts', 'verification', 'defenses-ablation-2026-09-26.md');
  let marketData: string | undefined;
  const profiles: { label: string; profile: string; tunes: string[] }[] = [];
  const extraArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    try {
      if (a === '--') { extraArgs.push(...argv.slice(i + 1)); break; }
      else if (a === '--help' || a === '-h') return { ok: false, message: USAGE };
      else if (a === '--periods') periods = value().split(',').map(s => s.trim()).filter(Boolean);
      else if (a === '--hours') hours = Number(value());
      else if (a === '--concurrency') concurrency = Number(value());
      else if (a === '--out-root') outRoot = resolve(value());
      else if (a === '--prefix') { prefix = value(); if (!/^[A-Za-z0-9._-]{1,64}$/.test(prefix)) return { ok: false, message: '--prefix may only use letters, digits, dot, dash, underscore' }; }
      else if (a === '--summary') summary = resolve(value());
      else if (a === '--market-data') marketData = resolve(value());
      else if (a === '--summarize-only') summarizeOnly = true;
      else if (a === '--profile') {
        const v = value(); const eq = v.indexOf('=');
        if (eq <= 0) return { ok: false, message: '--profile expects <label>=<spec>' };
        const label = v.slice(0, eq); const [spec, ...tunes] = v.slice(eq + 1).split('|');
        if (!/^[A-Za-z0-9._-]{1,32}$/.test(label)) return { ok: false, message: `bad profile label ${label}` };
        profiles.push({ label, profile: spec!, tunes });
      } else return { ok: false, message: `Unknown option ${a}\n${USAGE}` };
    } catch (error) { return { ok: false, message: (error as Error).message }; }
  }
  if (!periods.length || periods.some(p => !Number.isFinite(Date.parse(p)))) return { ok: false, message: '--periods must be ISO date-times' };
  if (!(hours > 0 && hours <= 240) || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) return { ok: false, message: '--hours 0–240, --concurrency 1–32' };
  if (!profiles.length) for (const p of ['none', 'hold', 'validity', 'lead4', 'lead5', 'ramp', 'toxicity', 'controller', 'all']) profiles.push({ label: p, profile: p.startsWith('lead') ? `none,${p}` : p === 'none' || p === 'all' ? p : `none,${p}`, tunes: [] });
  return { ok: true, options: { periods, hours, profiles, outRoot, prefix, concurrency, ...(marketData ? { marketData } : {}), summary, extraArgs, summarizeOnly, log: line => console.log(`${new Date().toISOString()} ${line}`) } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseAblationArgs(process.argv.slice(2));
  if (!parsed.ok) { console.error(parsed.message); process.exit(parsed.message === USAGE ? 0 : 2); }
  runAblation(parsed.options).then(md => { console.log(md); }).catch(error => { console.error(`ablation: failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`); process.exit(1); });
}
