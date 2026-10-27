/**
 * Controls: markets, pricing, launch boost, limits, simulation. Inputs start
 * blank ("blank = unchanged") so a stale form can never silently revert a
 * change another admin made; every submission goes through the diff dialog.
 */
import type { AppContext, Page } from '../app.js';
import {
  launchPlan, LAUNCH_FIELDS, LIMIT_FIELDS, limitsPlan, marketControl, marketPlan, pauseAllPlan, PRICING_FIELDS, pricingPlan, resumeAllPlan, simPlan, SIM_FIELDS,
} from '../controls.js';
import { formatAge, formatInt, formatPrice, marketLabel } from '../format.js';
import { breakerTitle, isBreakerActive, launchProgress } from '../health.js';
import type { Overview } from '../types.js';
import { dataTable } from '../ui/components.js';
import { h, replace, setText, statusLabel } from '../ui/dom.js';
import { formSection } from '../ui/forms.js';

export function createControlsPage(ctx: AppContext): Page {
  const { store } = ctx;
  const unsubs: (() => void)[] = [];

  const marketsHost = h('div', { class: 'table-wrap' });
  const pauseAllBtn = h('button', { class: 'btn danger', attrs: { type: 'button' }, text: 'Pause all markets…' });
  const resumeAllBtn = h('button', { class: 'btn', attrs: { type: 'button' }, text: 'Resume all…' });
  const breakersHost = h('div', { class: 'stack' });
  pauseAllBtn.addEventListener('click', () => { const o = store.snapshot.overview; if (o) void ctx.act(pauseAllPlan(o.markets)); });
  resumeAllBtn.addEventListener('click', () => { const o = store.snapshot.overview; if (o) void ctx.act(resumeAllPlan(o.markets)); });
  const marketsCard = h('section', { class: 'card', attrs: { 'aria-labelledby': 'markets-title' } },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, h('h2', { id: 'markets-title', text: 'Markets' }), h('span', { class: 'sub', text: 'Pausing stops new quotes; open legs always settle. Drawdown and manual pauses need an admin to resume.' })), h('div', { class: 'row', style: { 'flex-wrap': 'nowrap' } }, resumeAllBtn, pauseAllBtn)),
    breakersHost, marketsHost);

  const pricing = formSection<Overview>(ctx, {
    title: 'Pricing', sub: 'q = min(1, p + z·se + impact); x100 = ⌊100·(1 − edge)/q⌋. Edge moves over 2 pts need typed confirmation.',
    fields: PRICING_FIELDS,
    before: o => o.pricing ? { ...o.pricing } : { standardEdge: o.launch.standardEdge },
    plan: (o, d) => pricingPlan(o.pricing ?? undefined, d, { launch: o.launch, registeredPlayers: o.registeredPlayers }),
    extra: o => o.pricing ? null : h('p', { class: 'muted', text: 'The server did not report cap, impact or z; only the standard edge (from the launch block) is known.' }),
  });
  const launch = formSection<Overview>(ctx, {
    title: 'Launch boost', sub: 'Lower edge until registered players reach the threshold. Ending it early is a > 2 pt edge change.',
    fields: LAUNCH_FIELDS,
    before: o => ({ enabled: o.launch.enabled, edge: o.launch.edge, untilPlayers: o.launch.untilPlayers }),
    plan: (o, d) => launchPlan(o.launch, o.registeredPlayers, d),
    extra: o => {
      const lp = launchProgress(o.launch, o.registeredPlayers);
      const fill = h('div', { class: 'fill', style: { width: `${(lp.share * 100).toFixed(2)}%` } });
      return h('div', { class: 'stack', style: { 'margin-bottom': '14px', gap: '6px' } },
        h('div', { class: 'row' }, h('strong', { class: 'tabular', text: lp.label }), h('span', { class: `badge ${lp.state === 'active' ? 'info' : lp.state === 'ended' ? 'good' : ''}`, text: lp.state === 'active' ? 'Active' : lp.state === 'ended' ? 'Ended' : 'Off' }), h('span', { class: 'muted', text: lp.detail })),
        h('div', { class: `progress${lp.state !== 'active' ? ' done' : ''}`, attrs: { role: 'progressbar', 'aria-label': 'Launch boost progress', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': (lp.share * 100).toFixed(1), 'aria-valuetext': lp.label } }, fill));
    },
    shortcuts: (o, apply) => {
      if (!o.launch.enabled || !o.launch.active) return null;
      const end = h('button', { class: 'btn danger-outline', attrs: { type: 'button' }, text: 'End boost now…' });
      end.addEventListener('click', () => apply({ enabled: 'false' }));
      const extend = h('button', { class: 'btn', attrs: { type: 'button' }, text: `Extend to ${formatInt(o.launch.untilPlayers + 5_000)}…` });
      extend.addEventListener('click', () => apply({ untilPlayers: String(o.launch.untilPlayers + 5_000) }));
      return h('div', { class: 'row' }, extend, end);
    },
  });
  const limits = formSection<Overview>(ctx, {
    title: 'Risk limits', sub: 'Fractions of live house equity. Limits must nest: cell ≤ column ≤ global, account ≤ global.',
    fields: LIMIT_FIELDS,
    before: o => (o.limits ? { ...o.limits } : undefined),
    plan: (o, d) => limitsPlan(o.limits ?? undefined, d),
    extra: o => o.limits ? null : h('p', { class: 'muted', text: 'The server did not report current limits; "before" will show as not reported.' }),
  });
  const sim = formSection<Overview>(ctx, {
    title: 'Simulation', sub: 'Crowd simulator (replay feed only). Synthetic players use sim credits, never on-chain funds.',
    fields: SIM_FIELDS,
    before: o => (o.sim ? { ...o.sim } : undefined),
    plan: (o, d) => simPlan(o.sim ?? undefined, d),
  });

  const el = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Controls' }), h('p', { class: 'lede', text: 'Every change shows before → after, needs a reason, and waits for the server to acknowledge. Nothing changes on this page until it does.' }))),
    marketsCard, pricing.el, launch.el, limits.el, sim.el);

  function renderMarkets(o: Overview): void {
    const now = store.feedNow(); // uncapped: a price age keeps growing when overviews stop
    // Row state follows each market's own manual breaker; pause-all, drawdown, equity floor and feed stale are named as other causes.
    const controls = new Map(o.markets.map(m => [m.id, marketControl(m, o.breakers)]));
    const key = o.markets.map(m => `${m.id}:${m.paused}:${m.enabled}:${controls.get(m.id)!.label}`).join('|');
    if (marketsHost.dataset['key'] !== key) {
      marketsHost.dataset['key'] = key;
      replace(marketsHost, dataTable({
        caption: 'Markets', rows: o.markets,
        columns: [
          { key: 'id', label: 'Market', render: m => h('strong', { title: m.id, text: marketLabel(m.id) }) },
          { key: 'state', label: 'Quoting', wrap: true, render: m => { const c = controls.get(m.id)!; return !m.enabled ? statusLabel('neutral', 'Disabled') : c.gateClosed ? statusLabel('warning', c.label) : statusLabel('good', 'Quoting'); } },
          { key: 'spot', label: 'Spot', num: true, render: m => h('span', { class: 'tabular', dataset: { spot: m.id }, text: formatPrice(m.spot) }) },
          { key: 'age', label: 'Last price', num: true, render: m => h('span', { class: 'tabular', dataset: { age: m.id }, text: now === null ? '—' : formatAge(now - m.lastPriceMs) }) },
          { key: 'table', label: 'Table', wrap: true, render: m => h('code', { text: m.tableId }) },
          { key: 'act', label: 'Action', render: m => {
            const action = controls.get(m.id)!.action;
            const b = h('button', { class: action === 'resume' ? 'btn small' : 'btn small danger-outline', attrs: { type: 'button', 'aria-label': action === 'resume' ? `Resume ${marketLabel(m.id)} (its own manual pause)` : `Pause ${marketLabel(m.id)}` }, text: action === 'resume' ? 'Resume…' : 'Pause…' });
            b.addEventListener('click', () => {
              // Plan from the latest overview, so a breaker that changed since this row rendered is reflected in the dialog.
              const latest = store.snapshot.overview; const breakers = latest?.breakers ?? o.breakers; const current = latest?.markets.find(x => x.id === m.id) ?? m;
              void ctx.act(marketPlan(current, marketControl(current, breakers).action, breakers));
            });
            return b;
          } },
        ],
      }));
    } else {
      for (const m of o.markets) {
        const spot = marketsHost.querySelector(`[data-spot="${CSS.escape(m.id)}"]`); if (spot) setText(spot, formatPrice(m.spot));
        const age = marketsHost.querySelector(`[data-age="${CSS.escape(m.id)}"]`); if (age) setText(age, now === null ? '—' : formatAge(now - m.lastPriceMs));
      }
    }
    const active = o.breakers.filter(isBreakerActive);
    const bkey = active.map(b => `${b.id}:${b.market}:${b.state}`).join('|');
    if (breakersHost.dataset['key'] !== bkey) {
      breakersHost.dataset['key'] = bkey;
      replace(breakersHost, ...active.map(b => h('div', { class: 'row' }, statusLabel('critical', breakerTitle(b)), h('span', { class: 'muted', text: b.reason }))));
    }
  }

  function refresh(): void {
    const o = store.snapshot.overview;
    if (!o) return;
    renderMarkets(o);
    pricing.refresh(o); launch.refresh(o); limits.refresh(o); sim.refresh(o);
    sim.el.hidden = o.feedMode === 'live';
  }

  // Form placeholders and "current" lines only need to follow config changes, not every 1 s tick.
  let lastConfigKey = '';
  function onOverview(): void {
    const o = store.snapshot.overview;
    if (!o) return;
    const configKey = JSON.stringify([o.launch, o.pricing, o.limits, o.sim, o.feedMode, o.registeredPlayers >= o.launch.untilPlayers]);
    if (configKey !== lastConfigKey) { lastConfigKey = configKey; refresh(); }
    else { renderMarkets(o); launch.refreshExtra(o); }
  }

  return {
    el,
    mount() { unsubs.push(store.on('overview', onOverview)); lastConfigKey = ''; onOverview(); },
    unmount() { for (const u of unsubs.splice(0)) u(); },
  };
}
