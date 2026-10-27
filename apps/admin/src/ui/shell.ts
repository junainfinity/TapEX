/** App shell: header (network, clock, stream state, settings), nav, breaker banners, router, keyboard shortcuts. */
import type { AppContext, Page } from '../app.js';
import { notifyThemeChange } from '../charts/theme.js';
import { formatAge, formatDateTime, formatTime, networkLabel } from '../format.js';
import { bannerItems, isOverviewStale, type BannerAction, type BannerItem } from '../banners.js';
import { filterAlerts, type AlertFilter } from '../alert-throttle.js';
import { createShortcutHandler, isPageId, PAGES, type PageId } from '../keys.js';
import type { SseConnection } from '../sse.js';
import type { ThemeChoice } from '../settings.js';
import { h, isEditable, replace, setText, statusIcon, statusLabel } from './dom.js';

const statusLabelFor = (level: string) => statusLabel(level === 'critical' ? 'critical' : level === 'warning' ? 'warning' : 'info', level);

export interface ShellDeps {
  readonly ctx: AppContext;
  readonly stream: SseConnection;
  readonly pages: Record<PageId, () => Page>;
  readonly signOut: () => void;
}

export interface Shell {
  readonly root: HTMLElement;
  navigate(page: PageId): void;
  page(id: PageId): Page;
  /** Show the page named by the URL hash. */
  start(): void;
}

export function createShell(deps: ShellDeps): Shell {
  const { ctx, stream } = deps;
  const { store, settings } = ctx;
  const cache = new Map<PageId, Page>();
  let current: PageId | null = null;

  // Header. The network name stays visible at every width (the chain id drops below 1280 px; on-chain dialogs name both).
  const networkName = h('span', { class: 'net-name', text: 'Connecting…' });
  const networkChain = h('span', { class: 'net-chain' });
  const networkPill = h('span', { class: 'pill network', attrs: { 'aria-label': 'Network' } }, networkName, networkChain);
  const feedPill = h('span', { class: 'pill', text: '' });
  // Alerts panel: every SSE alert (last 50), so an expired or evicted toast is never the only record.
  const alertsCount = h('span', { class: 'badge', hidden: true });
  const alertsBtn = h('button', { class: 'btn small', attrs: { type: 'button', 'aria-haspopup': 'dialog', 'aria-label': 'Alerts' } }, h('span', { text: 'Alerts' }), alertsCount);
  alertsBtn.addEventListener('click', () => openAlerts());
  const clockPill = h('span', { class: 'pill clock', attrs: { 'aria-label': 'Server clock (UTC)' } });
  const connDot = h('span', { class: 'dot', attrs: { 'aria-hidden': 'true' } });
  const connLabel = h('span', { class: 'conn-label', text: 'Idle' });
  const retryBtn = h('button', { class: 'btn ghost small', attrs: { type: 'button' }, text: 'Retry now', hidden: true });
  retryBtn.addEventListener('click', () => stream.reconnectNow());
  const conn = h('div', { class: 'conn', attrs: { role: 'status', 'aria-live': 'polite', 'aria-label': 'Live stream connection' } }, connDot, connLabel, retryBtn);
  const themeSelect = h('select', { class: 'input', attrs: { 'aria-label': 'Theme' }, style: { width: '104px' } },
    ...(['system', 'light', 'dark'] as ThemeChoice[]).map(t => h('option', { attrs: { value: t, selected: settings.theme === t }, text: t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark' })));
  themeSelect.addEventListener('change', () => { settings.setTheme(themeSelect.value as ThemeChoice); notifyThemeChange(); });
  const usdBtn = h('button', { class: 'btn small', attrs: { type: 'button', 'aria-haspopup': 'dialog' } });
  usdBtn.addEventListener('click', () => openUsdDialog());
  const helpBtn = h('button', { class: 'btn small icon-only', attrs: { type: 'button', 'aria-label': 'Keyboard shortcuts (?)', 'aria-haspopup': 'dialog' }, text: '?' });
  helpBtn.addEventListener('click', () => openShortcuts());
  const signOutBtn = h('button', { class: 'btn small ghost', attrs: { type: 'button' }, text: ctx.demo ? 'Exit demo' : 'Sign out' });
  signOutBtn.addEventListener('click', () => deps.signOut());
  const header = h('header', { class: 'app-header' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-name', text: 'Maya-Live' }), h('span', { class: 'brand-sub', text: 'House console' })),
    h('div', { class: 'header-meta' }, ctx.demo ? h('span', { class: 'pill demo', title: 'Demo · bundled fixture' }, 'Demo', h('span', { class: 'demo-detail', text: ' · bundled fixture' })) : null, networkPill, feedPill, clockPill),
    h('div', { class: 'header-actions' }, conn, alertsBtn, usdBtn, themeSelect, helpBtn, signOutBtn));

  // Nav
  const chordHint = h('span', { class: 'muted', attrs: { 'aria-live': 'polite' } });
  const navLinks = new Map<PageId, HTMLAnchorElement>();
  const nav = h('nav', { class: 'nav', attrs: { 'aria-label': 'Console sections' } },
    ...PAGES.map(p => {
      const a = h('a', { attrs: { href: `#/${p.id}` } }, h('span', { text: p.title }), h('span', { class: 'kbd-hint', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'kbd', text: 'g' }), ' ', h('span', { class: 'kbd', text: p.key })));
      navLinks.set(p.id, a);
      return a;
    }),
    h('div', { class: 'nav-footer' }, h('span', {}, 'Press ', h('span', { class: 'kbd', text: '?' }), ' for shortcuts'), chordHint));

  const banners = h('div', { class: 'banners', id: 'banner-strip', attrs: { role: 'region', 'aria-label': 'Status banners', 'aria-live': 'polite' } });
  const main = h('main', { class: 'main', id: 'main', attrs: { tabindex: -1 } });
  const root = h('div', { class: 'app' }, header, nav, banners, main);

  function page(id: PageId): Page {
    let p = cache.get(id);
    if (!p) { p = deps.pages[id](); cache.set(id, p); }
    return p;
  }

  function show(id: PageId): void {
    if (current === id) return;
    if (current) { const prev = cache.get(current); prev?.dismiss?.(); prev?.unmount(); }
    current = id;
    const next = page(id);
    replace(main, next.el);
    next.mount();
    for (const [pid, a] of navLinks) { if (pid === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    const meta = PAGES.find(p => p.id === id);
    document.title = `${meta?.title ?? ''} · Maya-Live house console`;
    main.scrollTop = 0;
  }

  function fromHash(): PageId {
    const id = location.hash.replace(/^#\/?/, '').split('?')[0] ?? '';
    return isPageId(id) ? id : 'overview';
  }

  function navigate(id: PageId): void {
    if (location.hash !== `#/${id}`) location.hash = `#/${id}`;
    else show(id);
  }

  window.addEventListener('hashchange', () => show(fromHash()));

  function renderHeader(): void {
    const o = store.snapshot.overview;
    if (o) {
      setText(networkName, networkLabel(o.network, o.chainId));
      setText(networkChain, ` · ${o.chainId}`);
      networkPill.title = `${networkLabel(o.network, o.chainId)} · chain ${o.chainId}`;
      setText(feedPill, o.feedMode === 'replay' ? `Replay ×${o.speed}` : 'Live feed');
    }
    const now = store.serverNow();
    const stale = isOverviewStale(store.overviewAgeMs());
    setText(clockPill, now === null ? '--:--:-- UTC' : `${formatTime(now)} UTC${stale ? ' · stale' : ''}`);
    clockPill.classList.toggle('stale', stale);
    setText(usdBtn, settings.showUsd ? `USD @ $${settings.refPrice.text}` : 'USD off');
    usdBtn.title = 'Reference price used for USD estimates (admin-set, not a market price)';
  }

  function renderConn(): void {
    const s = store.snapshot.stream;
    if (conn.dataset['state'] !== s.status) conn.dataset['state'] = s.status;
    retryBtn.hidden = s.status !== 'reconnecting';
    switch (s.status) {
      case 'open': setText(connLabel, 'Live'); break;
      case 'connecting': setText(connLabel, s.attempt > 1 ? `Connecting (attempt ${s.attempt})` : 'Connecting…'); break;
      case 'reconnecting': setText(connLabel, `Reconnecting in ${formatAge(Math.max(0, s.retryAt - Date.now()))}`); conn.title = s.lastError; break;
      case 'unauthorized': setText(connLabel, 'Token rejected'); break;
      case 'closed': setText(connLabel, 'Stopped'); break;
      default: setText(connLabel, 'Idle');
    }
  }

  let bannerKey = '';
  let bannersExpanded = false;
  const ACTION_LABELS: Record<BannerAction, string> = { controls: 'Open controls', treasury: 'Open treasury', defenses: 'Open defenses', signin: 'Enter a new token' };
  function bannerEl(item: BannerItem, extra: HTMLElement | null): HTMLElement {
    const action = item.action;
    return h('div', { class: `banner ${item.severity}`, attrs: { role: item.severity === 'critical' ? 'alert' : 'status' } },
      statusIcon(item.severity), h('span', { class: 'banner-title', text: item.title }),
      item.detail ? h('span', { class: 'banner-detail', title: item.detail, text: item.detail }) : null,
      extra,
      h('div', { class: 'banner-actions' }, action ? h('button', { class: 'btn small', attrs: { type: 'button' }, text: ACTION_LABELS[action], on: { click: () => (action === 'signin' ? deps.signOut() : navigate(action)) } }) : null));
  }
  function renderBanners(): void {
    // SPEC-11 vault alerts, an unreadable vault and a switched-off acceptance hold (SPEC-10) are standing risks, not transient events.
    const items = bannerItems({
      overview: store.snapshot.overview, stream: store.snapshot.stream, overviewAgeMs: store.overviewAgeMs(), pollError: store.snapshot.pollError,
      vaultUnavailable: store.snapshot.chain?.vault.unavailable === true,
    });
    if (items.length <= 1) bannersExpanded = false;
    const key = `${bannersExpanded}#${items.map(i => `${i.key}|${i.title}|${i.detail}`).join('#')}`;
    if (key === bannerKey) return;
    bannerKey = key;
    banners.classList.toggle('expanded', bannersExpanded);
    const top = items[0];
    if (!top) {
      replace(banners, h('div', { class: 'banner ok', attrs: { role: 'status' } }, statusIcon('good'), h('span', { class: 'banner-title', text: 'All clear' }), h('span', { class: 'banner-detail', text: 'No breakers active · quoting normally' })));
      return;
    }
    // One fixed-height strip by default, so an alarm never shifts the page under the operator; the operator can expand it.
    const more = items.length > 1 ? h('button', {
      class: 'badge badge-button', attrs: { type: 'button', 'aria-expanded': String(bannersExpanded), 'aria-controls': 'banner-strip' },
      text: bannersExpanded ? 'Show fewer' : `+${items.length - 1} more`,
      on: { click: () => { bannersExpanded = !bannersExpanded; renderBanners(); } },
    }) : null;
    replace(banners, bannerEl(top, more), ...(bannersExpanded ? items.slice(1).map(i => bannerEl(i, null)) : []));
  }

  function renderAlertsCount(): void {
    const { unreadAlerts, alerts } = store.snapshot;
    const unreadCritical = alerts.slice(0, unreadAlerts).some(a => a.level === 'critical');
    alertsCount.hidden = unreadAlerts === 0;
    setText(alertsCount, unreadAlerts > 99 ? '99+' : String(unreadAlerts));
    alertsCount.className = `badge${unreadCritical ? ' critical' : unreadAlerts ? ' warning' : ''}`;
    alertsBtn.setAttribute('aria-label', unreadAlerts ? `Alerts, ${unreadAlerts} unread${unreadCritical ? ', including critical' : ''}` : 'Alerts');
  }

  // Dialogs
  function openAlerts(): void {
    if (document.querySelector('dialog[open]')) return;
    let filter: AlertFilter = 'all';
    const list = h('div', { class: 'table-wrap alerts-list' });
    const chips = h('div', { class: 'chips', attrs: { role: 'group', 'aria-label': 'Filter alerts by level' } });
    const counts = h('span', { class: 'muted tabular' });
    const render = () => {
      const all = store.snapshot.alerts;
      const rows = filterAlerts(all, filter);
      setText(counts, `${rows.length} of ${all.length} (the console keeps the last 50; critical alerts are kept first)`);
      const table = h('table', { class: 'data' }, h('caption', { class: 'sr-only', text: 'Alerts, newest first' }),
        h('thead', {}, h('tr', {}, ...['Time (UTC)', 'Level', 'Code', 'Message'].map(t => h('th', { attrs: { scope: 'col' }, text: t })))),
        h('tbody', {}, ...(rows.length ? rows.map(a => h('tr', {},
          h('td', { class: 'tabular', text: formatDateTime(a.ms) }),
          h('td', {}, statusLabelFor(a.level)),
          h('td', {}, a.code ? h('code', { text: a.code }) : '—'),
          h('td', { class: 'wrap', text: a.message }))) : [h('tr', {}, h('td', { class: 'empty', attrs: { colspan: 4 }, text: 'No alerts.' }))])));
      replace(list, table);
    };
    for (const [value, label] of [['all', 'All'], ['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']] as const) {
      const chip = h('button', { class: 'chip', attrs: { type: 'button', 'aria-pressed': String(value === filter) }, text: label });
      chip.addEventListener('click', () => { filter = value; for (const c of chips.children) c.setAttribute('aria-pressed', String(c === chip)); render(); });
      chips.append(chip);
    }
    const close = h('button', { class: 'btn', attrs: { type: 'button' }, text: 'Close' });
    const dialog = h('dialog', { class: 'wide', attrs: { 'aria-labelledby': 'alerts-title' } },
      h('div', { class: 'dialog-head' }, h('h2', { id: 'alerts-title', text: 'Alerts' }), h('p', { class: 'secondary', text: 'Every alert the live stream delivered since this page loaded. The server does not journal alerts; breaker transitions and admin actions are also in the audit log.' })),
      h('div', { class: 'dialog-body' }, h('div', { class: 'row' }, chips, h('span', { class: 'spacer' }), counts), list),
      h('div', { class: 'dialog-foot' }, close));
    const off = store.on('alerts', () => { render(); store.markAlertsRead(); });
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { off(); dialog.remove(); });
    document.body.append(dialog);
    render();
    store.markAlertsRead();
    dialog.showModal();
    close.focus();
  }

  function openShortcuts(): void {
    if (document.querySelector('dialog[open]')) return;
    const close = h('button', { class: 'btn', attrs: { type: 'button' }, text: 'Close' });
    const dialog = h('dialog', { attrs: { 'aria-labelledby': 'sc-title' } },
      h('div', { class: 'dialog-head' }, h('h2', { id: 'sc-title', text: 'Keyboard shortcuts' })),
      h('div', { class: 'dialog-body' }, h('dl', { class: 'shortcuts-list' },
        ...PAGES.flatMap(p => [h('dt', {}, h('span', { class: 'kbd', text: 'g' }), ' ', h('span', { class: 'kbd', text: p.key })), h('dd', { text: `Go to ${p.title}` })]),
        h('dt', {}, h('span', { class: 'kbd', text: '/' })), h('dd', { text: 'Focus search (Players, Audit log)' }),
        h('dt', {}, h('span', { class: 'kbd', text: '?' })), h('dd', { text: 'Show this help' }),
        h('dt', {}, h('span', { class: 'kbd', text: 'Esc' })), h('dd', { text: 'Close a dialog or side panel' }))),
      h('div', { class: 'dialog-foot' }, close));
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    close.focus();
  }

  function openUsdDialog(): void {
    const input = h('input', { class: 'input tabular', id: 'ref-price', attrs: { type: 'text', inputmode: 'decimal', value: settings.refPrice.text, 'aria-describedby': 'ref-help ref-err' } });
    const show = h('input', { attrs: { type: 'checkbox', id: 'show-usd', checked: settings.showUsd } });
    const err = h('span', { class: 'error', id: 'ref-err', attrs: { 'aria-live': 'polite' } });
    const save = h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: 'Save' });
    const cancel = h('button', { class: 'btn', attrs: { type: 'button' }, text: 'Cancel' });
    const form = h('form', { attrs: { method: 'dialog', novalidate: true } },
      h('div', { class: 'dialog-head' }, h('h2', { id: 'usd-title', text: 'USD estimates' }), h('p', { class: 'secondary', text: 'Amounts are exact in OPEN. USD figures are estimates at a reference price you set here; they are never used for accounting.' })),
      h('div', { class: 'dialog-body' },
        h('div', { class: 'field' }, h('label', { attrs: { for: 'ref-price' }, text: 'Reference price (USD per OPEN)' }), input, h('span', { class: 'help', id: 'ref-help', text: 'Default 0.138. Stored in this browser only.' }), err),
        h('label', { class: 'check', attrs: { for: 'show-usd' } }, show, 'Show USD estimates next to OPEN amounts')),
      h('div', { class: 'dialog-foot' }, cancel, save));
    const dialog = h('dialog', { attrs: { 'aria-labelledby': 'usd-title' } }, form);
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!settings.setRefPrice(input.value)) { setText(err, 'Enter a positive price such as 0.138 (up to 8 decimals).'); input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
      settings.setShowUsd(show.checked);
      renderHeader();
      dialog.close();
    });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    input.focus(); input.select();
  }

  // Keyboard
  const shortcuts = createShortcutHandler();
  document.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape' && current) { if (cache.get(current)?.dismiss?.()) e.preventDefault(); return; }
    const action = shortcuts.handle({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, editable: isEditable(e.target) });
    setText(chordHint, shortcuts.pending ? 'g … waiting for a page key' : '');
    if (!action) return;
    e.preventDefault();
    if (action.type === 'navigate') { navigate(action.page); main.focus({ preventScroll: true }); }
    else if (action.type === 'help') openShortcuts();
    else if (action.type === 'focus-search' && current) cache.get(current)?.focusSearch?.();
  });

  store.on('overview', () => { renderHeader(); renderBanners(); });
  store.on('stream', () => { renderConn(); renderBanners(); });
  store.on('chain', renderBanners);
  store.on('alerts', renderAlertsCount);
  settings.on(renderHeader);
  // Banners re-evaluate every second too: staleness grows while nothing arrives.
  setInterval(() => { renderHeader(); renderConn(); renderBanners(); setText(chordHint, shortcuts.pending ? 'g … waiting for a page key' : ''); }, 1000);
  renderHeader(); renderConn(); renderBanners(); renderAlertsCount();

  return { root, navigate, page, start: () => show(fromHash()) };
}
