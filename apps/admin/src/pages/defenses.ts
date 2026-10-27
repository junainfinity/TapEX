/**
 * Defenses (SPEC-10): live hold, toxicity and controller metrics; the adaptive edge per multiplier range
 * (realized vs target, with the recent nudges); the reference-feed status; and one form per defense
 * section. Every change goes through the diff dialog with a reason; switching a defense off needs
 * "defenses-disable", an edge move over 2 pts needs "edge-change" (the server enforces both).
 */
import { Poller, type AppContext, type Page } from '../app.js';
import { rtpBarChart, type RtpBarGroup } from '../charts/svg-charts.js';
import { onThemeChange, token } from '../charts/theme.js';
import { formatMinutes } from '../controls.js';
import {
  DEFENSE_SECTIONS, DEFENSE_TITLES, DEFENSE_TOGGLES, defensesPlan, flattenDefenses, overridesPlan, parseOverride,
} from '../defense-controls.js';
import { formatAge, formatDateTime, formatInt, formatPct, formatPts, formatTime, formatValue, marketLabel } from '../format.js';
import { formatOpen } from '../money.js';
import type { AuditEntry, ControllerRangeView, DefensesView } from '../types.js';
import { chartCard, dataTable, errorNotice, legend, tile } from '../ui/components.js';
import { h, replace, setText, statusIcon, statusLabel, uid, type StatusKind } from '../ui/dom.js';
import { formSection } from '../ui/forms.js';

const rangeLabel = (key: string) => `${key.replace('-', '–')}×`;
const NUDGE_ACTIONS = new Set(['controller-adjust']);

export function createDefensesPage(ctx: AppContext): Page {
  const { api, store } = ctx;
  let view: DefensesView | null = null;
  let configKey = '';
  const unsubs: (() => void)[] = [];

  const errorHost = h('div');
  const chipsHost = h('div', { class: 'chips', attrs: { role: 'list', 'aria-label': 'Defense status' } });
  const lede = h('p', { class: 'lede', text: 'Latency-arbitrage and model-drift defenses. Waiting for the server…' });

  const tPending = tile('Holds pending');
  const tReject = tile('Hold reject rate · 1 h');
  const tLatency = tile('Hold latency p95');
  const tToxic = tile('Toxic-flow share · 1 h');
  const tFlagged = tile('Flagged · blocked');
  const tSurcharge = tile('Flow surcharge');

  const outcomesHost = h('div', { class: 'table-wrap' });
  const outcomesCard = h('section', { class: 'card', attrs: { 'aria-labelledby': 'hold-outcomes' } },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, h('h2', { id: 'hold-outcomes', text: 'Hold outcomes' }), h('span', { class: 'sub', text: 'all resolutions since boot, by outcome detail' }))), outcomesHost);

  const referenceHost = h('div');
  const referenceCard = h('section', { class: 'card', attrs: { 'aria-labelledby': 'ref-title' } },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, h('h2', { id: 'ref-title', text: 'Fast reference feed' }), h('span', { class: 'sub', text: 'sub-second Pyth Hermes stream that retires quotes early (live mode only)' }))), referenceHost);

  const controllerCard = chartCard('Adaptive edge by multiplier range', 'bars = realized RTP of clean flow · black tick = policy target · gray band = target ± 2 SE (window)');
  const controllerMeta = h('div', { class: 'row muted tabular' });

  const nudgesHost = h('div', { class: 'table-wrap', style: { 'max-height': '300px' } });
  const nudgesCard = h('section', { class: 'card', attrs: { 'aria-labelledby': 'nudges-title' } },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, h('h2', { id: 'nudges-title', text: 'Recent nudges and changes' }), h('span', { class: 'sub', text: 'controller adjustments and admin changes to the defenses, newest first' }))), nudgesHost);

  // Overrides form: one input per range; blank = unchanged, "auto" releases a pin.
  const overrideInputs = new Map<string, { input: HTMLInputElement; error: HTMLElement }>();
  const overridesTable = h('div', { class: 'table-wrap' });
  const overridesError = h('div', { class: 'form-error', attrs: { role: 'alert' } });
  const overridesReview = h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: 'Review pins…' });
  const overridesClear = h('button', { class: 'btn ghost', attrs: { type: 'button' }, text: 'Clear' });
  const overridesForm = h('form', { attrs: { novalidate: true, 'aria-labelledby': 'pins-title' } },
    overridesTable,
    h('div', { class: 'form-actions' }, overridesReview, overridesClear, h('span', { class: 'spacer' }), h('span', { class: 'muted', text: 'Blank = unchanged · auto = release the pin · e.g. 1.5 or -0.5 (pts)' })),
    overridesError);
  const overridesCard = h('section', { class: 'card', attrs: { 'aria-labelledby': 'pins-title' } },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, h('h2', { id: 'pins-title', text: 'Pin controller adjustments' }), h('span', { class: 'sub', text: 'an admin pin wins over the learned adjustment; moves over 2 pts need typed confirmation' }))), overridesForm);

  const sections = DEFENSE_SECTIONS.map(section => formSection<DefensesView>(ctx, {
    title: section.title, sub: section.sub, fields: section.fields,
    before: v => flattenDefenses(v.config),
    plan: (v, draft) => defensesPlan(v, section, draft),
    notLoaded: 'The defenses have not loaded from the server yet; current values are unknown.',
  }));

  const el = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Defenses' }), lede), h('div', { class: 'page-head-actions' }, chipsHost)),
    errorHost,
    h('div', { class: 'tiles' }, tPending.el, tReject.el, tLatency.el, tToxic.el, tFlagged.el, tSurcharge.el),
    h('div', { class: 'grid-2 collapse-md' }, outcomesCard, referenceCard),
    controllerCard.el,
    h('div', { class: 'grid-2 collapse-md' }, overridesCard, nudgesCard),
    h('h2', { class: 'section-title', text: 'Configuration' }),
    ...sections.map(s => s.el));

  controllerCard.el.querySelector('.card-head')?.after(controllerMeta);

  function chips(v: DefensesView): void {
    const c = v.config;
    const key = DEFENSE_TOGGLES.map(t => `${t}:${c[t].enabled}`).join('|') + `|${c.minLeadS}`;
    if (chipsHost.dataset['key'] === key) return;
    chipsHost.dataset['key'] = key;
    replace(chipsHost, ...DEFENSE_TOGGLES.map(t => h('span', { class: `badge ${c[t].enabled ? 'good' : t === 'hold' ? 'critical' : 'warning'}`, attrs: { role: 'listitem' } }, statusIcon(c[t].enabled ? 'good' : t === 'hold' ? 'critical' : 'warning'), `${DEFENSE_TITLES[t]}: ${c[t].enabled ? 'on' : 'off'}`)),
      h('span', { class: 'badge', attrs: { role: 'listitem' }, text: `Min lead ${c.minLeadS} s` }));
  }

  function renderTiles(v: DefensesView): void {
    const hold = v.hold; const c = v.config;
    tPending.update({ value: formatInt(hold.pending), sub: hold.enabled ? `${formatInt(hold.created)} held since boot` : 'hold is off: bets accept at once' });
    tReject.update({ value: formatPct(hold.rejectRate1h, 1), sub: `all time ${formatPct(hold.rejectRateAll, 1)} · ${formatInt(hold.rejected)} of ${formatInt(hold.accepted + hold.rejected)}` });
    const p95 = hold.latencyMs.p95;
    const atCap = p95 !== null && p95 >= c.hold.maxHoldMs;
    tLatency.update({
      value: p95 === null ? '—' : `${(p95 / 1000).toFixed(2)} s`,
      sub: `p50 ${hold.latencyMs.p50 === null ? '—' : `${(hold.latencyMs.p50 / 1000).toFixed(2)} s`} · cap ${(c.hold.maxHoldMs / 1000).toFixed(2)} s`,
      delta: p95 === null ? null : { text: atCap ? 'at the cap' : 'under the cap', tone: atCap ? 'bad' : 'good', label: atCap ? 'p95 hold latency is at the maximum hold (feed gaps time out)' : 'p95 hold latency is under the maximum hold' },
    });
    tToxic.update({ value: formatPct(v.toxicity.toxicFlowShare1h, 1), sub: `all time ${formatPct(v.toxicity.toxicFlowShareAll, 1)} of handle` });
    tFlagged.update({ value: `${formatInt(v.toxicity.flagged)} · ${formatInt(v.toxicity.blocked)}`, sub: `by the monitor: ${formatInt(v.toxicity.flaggedByMonitor)} flagged · ${formatInt(v.toxicity.blockedByMonitor)} blocked` });
    tSurcharge.update({ value: formatPct(v.toxicity.flowEdge, 1), sub: v.toxicity.mode === 'graduated' ? 'extra edge on flagged accounts' : 'monitor mode: flag only' });
  }

  function renderOutcomes(v: DefensesView): void {
    const total = Object.values(v.hold.byDetail).reduce((a, b) => a + b, 0);
    const rows = Object.entries(v.hold.byDetail).map(([detail, n]) => ({ detail, n })).sort((a, b) => b.n - a.n);
    // Resolution details as the engine journals them (resolveHold / commitHoldRejection).
    const describe: Record<string, string> = {
      ok: 'accepted at the original quote', 'fair-value': 'fair value moved beyond the tolerance', 'fair-value-unavailable': 'the square could not be re-priced at the fresh price',
      timeout: 'no fresh sample in time (fail closed)', ramp: 'over the new-account liability ramp', 'flag-variant': 'account was flagged or unflagged during the hold (quote variant changed)',
      blocked: 'account was blocked during the hold', 'quote-gone': 'the quote was no longer available', late: 'the square starts too soon to accept after the hold',
      stale: 'price feed went stale during the hold', paused: 'quoting was paused during the hold',
    };
    replace(outcomesHost, dataTable({
      caption: 'Hold outcomes by detail', rows, empty: 'No holds resolved yet.',
      columns: [
        { key: 'd', label: 'Outcome', render: r => statusLabel(r.detail === 'ok' ? 'good' : 'warning', r.detail) },
        { key: 'x', label: 'Meaning', wrap: true, render: r => describe[r.detail] ?? '—' },
        { key: 'n', label: 'Holds', num: true, render: r => formatInt(r.n) },
        { key: 's', label: 'Share', num: true, render: r => formatPct(total ? r.n / total : null, 1) },
      ],
    }));
  }

  function renderReference(v: DefensesView): void {
    const f = v.referenceFeed; const r = v.reference; const now = v.clockMs;
    const guard = h('div', { class: 'row' }, r.enabled ? statusLabel('good', 'Invalidation on') : statusLabel('warning', 'Invalidation off'),
      h('span', { class: 'muted', text: `threshold ${r.moveSigma} σ · ${formatInt(r.invalidations)} invalidations · last observation ${r.lastObservationMs === null ? 'never' : `${formatAge(Math.max(0, now - r.lastObservationMs))} ago`}` }));
    if (!f) {
      replace(referenceHost, h('div', { class: 'stack' }, statusLabel('neutral', 'No reference feed on this server (replay mode, or MAYA_REFERENCE_FEED=off)'), guard,
        h('p', { class: 'muted', text: 'Quotes are then retired only by the next first-seen sample plus the grace period.' })));
      return;
    }
    const kind: StatusKind = f.connected ? (f.lastError ? 'warning' : 'good') : 'critical';
    replace(referenceHost, h('div', { class: 'stack' },
      statusLabel(kind, `${f.source}: ${f.connected ? 'connected' : 'disconnected'}`), guard,
      h('dl', { class: 'kv' },
        h('dt', { text: 'Messages · prices' }), h('dd', { text: `${formatInt(f.messages)} · ${formatInt(f.prices)}` }),
        h('dt', { text: 'Reconnects' }), h('dd', { text: formatInt(f.reconnects) }),
        h('dt', { text: 'Last message' }), h('dd', { text: f.lastMessageMs === undefined ? 'never' : `${formatAge(Math.max(0, Date.now() - f.lastMessageMs))} ago` }),
        ...(f.lastError ? [h('dt', { text: 'Last error' }), h('dd', { text: f.lastError })] : []),
        ...f.markets.flatMap(m => [h('dt', { text: marketLabel(m.market) }), h('dd', { text: m.lastPublishMs === undefined ? 'no price yet' : `${m.value ?? '—'} · published ${formatTime(m.lastPublishMs)} UTC` })]))));
  }

  function renderController(v: DefensesView): void {
    const ranges = v.controller.ranges;
    const c = v.config.controller;
    replace(controllerMeta,
      v.controller.enabled ? statusLabel('good', 'Controller on') : statusLabel('warning', 'Controller off: learned adjustments are not applied'),
      h('span', { text: `window ${formatMinutes(c.windowMs)} · evaluates every ${formatMinutes(c.evalEveryMs)} · next ${v.controller.nextEvalMs === null ? '—' : formatDateTime(v.controller.nextEvalMs)} · moves need ${formatInt(c.minBets)} clean bets` }));
    const groups: RtpBarGroup[] = ranges.map(r => ({
      key: r.key, label: rangeLabel(r.key),
      bars: [{ series: 0, seriesName: 'Clean flow', realized: r.realized, expected: r.target ?? 0, low: r.target !== null && r.se != null ? Math.max(0, r.target - 2 * r.se) : null, high: r.target !== null && r.se != null ? r.target + 2 * r.se : null, bets: r.bets }],
    }));
    const width = Math.max(320, controllerCard.body.clientWidth || 800);
    replace(controllerCard.body, ranges.some(r => r.realized !== null) ? rtpBarChart(groups, width, 240) : h('div', { class: 'empty', text: 'No settled clean flow in the window yet.' }));
    controllerCard.setLegend(legend([
      { label: 'Realized RTP (clean flow)', color: token('series-1'), kind: 'swatch' },
      { label: 'Policy target', color: token('ink'), kind: 'line' },
      { label: 'Target ± 2 SE', kind: 'band' },
    ]));
    controllerCard.setTable(() => h('div', { class: 'table-wrap' }, controllerTable(ranges, v)));
  }

  function controllerTable(ranges: readonly ControllerRangeView[], v: DefensesView): HTMLTableElement {
    return dataTable({
      caption: 'Adaptive edge by multiplier range', rows: ranges,
      columns: [
        { key: 'r', label: 'Range', render: r => rangeLabel(r.key) },
        { key: 'b', label: 'Clean bets', num: true, render: r => formatInt(r.bets) },
        { key: 'h', label: 'Handle', num: true, render: r => (r.handleCenti ? formatOpen(r.handleCenti) : '—') },
        { key: 'rl', label: 'Realized', num: true, render: r => formatPct(r.realized) },
        { key: 't', label: 'Target', num: true, render: r => formatPct(r.target) },
        { key: 'g', label: 'Gap', num: true, render: r => (r.realized === null || r.target === null ? '—' : formatPts(r.realized - r.target)) },
        { key: 'se', label: 'SE', num: true, render: r => (r.se == null ? '—' : formatPts(r.se)) },
        { key: 'a', label: 'Learned', num: true, render: r => formatPct(r.adjust, 2, true) },
        { key: 'o', label: 'Pinned', num: true, render: r => (r.override === undefined ? '—' : formatPct(r.override, 2, true)) },
        { key: 'e', label: 'Effective', num: true, render: r => h('strong', { text: formatPct(r.effective, 2, true) }) },
        { key: 'l', label: 'Last change', render: r => (r.lastChangeMs === undefined ? '—' : formatDateTime(r.lastChangeMs)) },
      ],
      empty: v.controller.enabled ? 'No ranges reported.' : 'Controller off.',
    });
  }

  /**
   * The pin table is built once per set of ranges; live values update in place, so a refresh never
   * moves (and unfocuses) an input the operator is typing in.
   */
  const pinCells = new Map<string, { learned: HTMLElement; pinned: HTMLElement; effective: HTMLElement }>();
  function renderOverrides(v: DefensesView): void {
    const shape = v.controller.ranges.map(r => r.key).join('|');
    if (overridesTable.dataset['shape'] !== shape) {
      overridesTable.dataset['shape'] = shape;
      pinCells.clear();
      const rows = v.controller.ranges.map(r => {
        let entry = overrideInputs.get(r.key);
        if (!entry) {
          const errId = uid('pin-err');
          const input = h('input', { class: 'input tabular', attrs: { type: 'text', autocomplete: 'off', 'aria-label': `New pin for ${rangeLabel(r.key)} (percentage points)`, 'aria-describedby': errId, placeholder: 'unchanged' } });
          const error = h('span', { class: 'error', id: errId, attrs: { 'aria-live': 'polite' } });
          input.addEventListener('input', () => { setText(error, ''); input.removeAttribute('aria-invalid'); });
          entry = { input, error };
          overrideInputs.set(r.key, entry);
        }
        const cells = { learned: h('span', { class: 'tabular' }), pinned: h('span', { class: 'tabular' }), effective: h('span', { class: 'tabular' }) };
        pinCells.set(r.key, cells);
        return { key: r.key, entry, cells };
      });
      replace(overridesTable, dataTable({
        caption: 'Controller adjustments and pins', rows,
        columns: [
          { key: 'r', label: 'Range', render: x => rangeLabel(x.key) },
          { key: 'a', label: 'Learned', num: true, render: x => x.cells.learned },
          { key: 'o', label: 'Pinned', num: true, render: x => x.cells.pinned },
          { key: 'e', label: 'Effective', num: true, render: x => x.cells.effective },
          { key: 'n', label: 'New pin (pts)', render: x => h('div', { class: 'stack', style: { gap: '2px' } }, x.entry.input, x.entry.error) },
        ],
      }));
    }
    for (const r of v.controller.ranges) {
      const cells = pinCells.get(r.key);
      if (!cells) continue;
      setText(cells.learned, formatPct(r.adjust, 2, true));
      setText(cells.pinned, r.override === undefined ? 'auto' : formatPct(r.override, 2, true));
      setText(cells.effective, formatPct(r.effective, 2, true));
    }
  }

  overridesForm.addEventListener('submit', e => {
    e.preventDefault();
    setText(overridesError, '');
    for (const { input, error } of overrideInputs.values()) { setText(error, ''); input.removeAttribute('aria-invalid'); }
    const draft = Object.fromEntries([...overrideInputs].map(([k, v]) => [k, v.input.value]));
    for (const [k, raw] of Object.entries(draft)) {
      if (!raw.trim()) continue;
      const parsed = parseOverride(raw);
      if (!parsed.ok) { const entry = overrideInputs.get(k)!; setText(entry.error, parsed.error); entry.input.setAttribute('aria-invalid', 'true'); }
    }
    const result = overridesPlan(view, draft);
    if (!result.ok) {
      for (const [k, message] of Object.entries(result.errors)) {
        const entry = overrideInputs.get(k);
        if (entry) { setText(entry.error, message); entry.input.setAttribute('aria-invalid', 'true'); } else replace(overridesError, statusIcon('critical'), h('span', { text: message }));
      }
      [...overrideInputs.values()].find(x => x.input.getAttribute('aria-invalid') === 'true')?.input.focus();
      return;
    }
    void ctx.act(result.plan, () => { for (const { input } of overrideInputs.values()) input.value = ''; poller.kick(); });
  });
  overridesClear.addEventListener('click', () => { for (const { input, error } of overrideInputs.values()) { input.value = ''; setText(error, ''); input.removeAttribute('aria-invalid'); } setText(overridesError, ''); });

  function renderNudges(): void {
    const rows = store.snapshot.audit.filter(e => NUDGE_ACTIONS.has(e.action) || e.action === 'defenses' || e.target === 'defenses').slice(0, 50);
    replace(nudgesHost, dataTable<AuditEntry>({
      caption: 'Recent controller nudges and defense changes', rows, empty: 'No controller nudges or defense changes yet. The controller moves a range only after enough clean bets.',
      columns: [
        { key: 'ms', label: 'When (UTC)', render: e => formatDateTime(e.ms) },
        { key: 'who', label: 'Actor', render: e => e.actor },
        { key: 'what', label: 'Change', render: e => (NUDGE_ACTIONS.has(e.action) ? `${rangeLabel(e.target ?? '?')} ${pts(e.before)} → ${pts(e.after)}` : e.action) },
        { key: 'why', label: 'Reason', wrap: true, render: e => e.reason ?? '—' },
      ],
    }));
  }
  const pts = (value: unknown) => (typeof value === 'number' ? formatPct(value, 2, true) : formatValue(value));

  function render(): void {
    if (!view) return;
    const v = view;
    setText(lede, `Latency-arbitrage and model-drift defenses · server clock ${formatDateTime(v.clockMs)} · ${v.hold.enabled ? `holds up to ${formatInt(v.config.hold.maxHoldMs)} ms` : 'acceptance hold OFF'}`);
    chips(v); renderTiles(v); renderOutcomes(v); renderReference(v); renderController(v); renderOverrides(v);
    const key = JSON.stringify(v.config);
    if (key !== configKey) { configKey = key; for (const s of sections) s.refresh(v); }
  }

  async function load(): Promise<void> {
    controllerCard.setLoading(true);
    const result = await api.defenses();
    controllerCard.setLoading(false);
    replace(errorHost, result.ok ? null : errorNotice(result.error));
    if (result.ok) { view = result.data; render(); }
  }
  async function loadAudit(): Promise<void> {
    const result = await api.audit(500);
    if (result.ok) store.seedAudit(result.data);
  }

  const poller = new Poller(load, ctx.demo ? 3_000 : 5_000);
  const auditPoller = new Poller(loadAudit, 30_000);
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const onResize = () => { if (resizeTimer) clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (view) renderController(view); }, 150); };

  return {
    el,
    mount() {
      unsubs.push(store.on('audit', renderNudges), onThemeChange(() => { if (view) renderController(view); }));
      window.addEventListener('resize', onResize);
      configKey = '';
      render(); renderNudges();
      poller.start(); auditPoller.start();
    },
    unmount() {
      for (const u of unsubs.splice(0)) u();
      window.removeEventListener('resize', onResize);
      poller.stop(); auditPoller.stop();
    },
  };
}
