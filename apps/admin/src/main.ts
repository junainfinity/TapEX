/**
 * Entry point. `?demo` swaps the network for the bundled simulator (loaded as
 * a separate chunk) so the console runs end to end — same client, same SSE
 * parser — without a server.
 */
import './styles.css';
import { createAlertThrottle, toastText } from './alert-throttle.js';
import { AdminApi, type FetchLike } from './api.js';
import type { AppContext } from './app.js';
import type { PageId } from './keys.js';
import { createAuditPage } from './pages/audit.js';
import { createControlsPage } from './pages/controls.js';
import { createDefensesPage } from './pages/defenses.js';
import { createExposurePage } from './pages/exposure.js';
import { createOddsPage } from './pages/odds.js';
import { createOverviewPage } from './pages/overview.js';
import { createPlayersPage } from './pages/players.js';
import { createTreasuryPage } from './pages/treasury.js';
import { createTokenStore, Settings } from './settings.js';
import { SseConnection } from './sse.js';
import { Store } from './store.js';
import { toast } from './ui/components.js';
import { openActionDialog } from './ui/dialog.js';
import { showTokenGate } from './ui/gate.js';
import { createShell } from './ui/shell.js';
import { UnknownOutcomeLog } from './write-session.js';

async function main(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app missing');
  const demo = new URLSearchParams(location.search).has('demo');
  const settings = new Settings();
  settings.applyTheme();

  let fetchImpl: FetchLike | undefined;
  if (demo) {
    const { createDemoServer } = await import('./demo/server.js');
    fetchImpl = createDemoServer().fetch;
  }
  const tokens = createTokenStore(demo ? 'demo-token' : undefined);
  let onUnauthorized = () => {};
  // Same origin by default (Vite proxies /admin-api in dev); VITE_ADMIN_API_BASE points a static build at another origin.
  const baseUrl = demo ? '' : (import.meta.env['VITE_ADMIN_API_BASE'] as string | undefined) ?? '';
  const api = new AdminApi({ getToken: tokens.get, baseUrl, ...(fetchImpl ? { fetch: fetchImpl } : {}), onUnauthorized: () => onUnauthorized() });

  const start = () => {
    const store = new Store();
    let stopped = false;
    const stream = new SseConnection({
      url: api.url('/stream'), headers: () => api.authHeaders(), fetch: api.fetcher,
      onMessage: message => store.ingest(message),
      onState: state => store.setStream(state),
    });

    // A poll answer older than an overview that arrived meanwhile is dropped (store.setOverview); a failure is shown while nothing else arrives.
    const refreshOverview = async () => {
      const requestedAtMs = store.nowMs();
      const result = await api.overview();
      if (result.ok) store.setOverview(result.data, { requestedAtMs });
      else store.setPollError(result.error);
    };
    // The banner strip needs the vault state on every page (an unreadable vault is critical); pages that poll /chain also feed the store.
    const refreshChain = async () => { const result = await api.chain(); if (result.ok) store.setChain(result.data); };
    const chainTimer = setInterval(() => { if (!stopped) void refreshChain(); }, 30_000);
    // Poll the overview while the stream is not delivering (SSE carries it every 1 s when healthy).
    const fallback = setInterval(() => { if (!stopped && store.snapshot.stream.status !== 'open') void refreshOverview(); }, 5_000);
    const onOnline = () => stream.reconnectNow();
    window.addEventListener('online', onOnline);

    const signOut = (message: string | null = null) => {
      stopped = true;
      stream.stop();
      clearInterval(fallback);
      clearInterval(chainTimer);
      window.removeEventListener('online', onOnline);
      if (demo) { location.href = location.pathname; return; }
      tokens.clear();
      // A full reload drops every page timer and listener cleanly.
      if (message) sessionStorage.setItem('maya-admin.gateMessage', message);
      location.hash = '';
      location.reload();
    };
    onUnauthorized = () => { if (!stopped) signOut('The server rejected the admin token (HTTP 401). Paste a valid token.'); };

    let openPlayerHook: (account: string) => void = () => {};
    const unknownLog = new UnknownOutcomeLog();
    const ctx: AppContext = {
      api, store, settings, demo,
      act: (plan, onApplied) => openActionDialog(plan, {
        api, chainId: () => ctx.chainId(), unknownLog,
        network: () => { const o = store.snapshot.overview; return o ? { network: o.network, chainId: o.chainId } : null; },
        onApplied: (_plan, ack) => { onApplied?.(ack); void refreshOverview(); toast(`${plan.title}: acknowledged by the server.`, 'good'); },
        openAudit: () => shell.navigate('audit'),
      }),
      navigate: page => shell.navigate(page),
      openPlayer: account => openPlayerHook(account),
      chainId: () => store.snapshot.overview?.chainId ?? 0,
    };
    const pages: Record<PageId, () => ReturnType<typeof createOverviewPage>> = {
      overview: () => createOverviewPage(ctx), odds: () => createOddsPage(ctx), exposure: () => createExposurePage(ctx), players: () => createPlayersPage(ctx),
      controls: () => createControlsPage(ctx), defenses: () => createDefensesPage(ctx), treasury: () => createTreasuryPage(ctx), audit: () => createAuditPage(ctx),
    };
    const shell = createShell({ ctx, stream, pages, signOut: () => signOut() });
    openPlayerHook = account => {
      shell.navigate('players');
      (shell.page('players') as ReturnType<typeof createPlayersPage> & { openAccount?: (a: string) => void }).openAccount?.(account);
    };
    // One toast per alert code per minute (the toxicity monitor alerts per account); critical ones stay until dismissed.
    const throttle = createAlertThrottle(60_000);
    store.on('alerts', () => {
      const latest = store.snapshot.alerts[0];
      if (!latest) return;
      const decision = throttle(latest);
      if (decision.show) toast(toastText(latest, decision.folded), latest.level === 'critical' ? 'critical' : latest.level === 'warning' ? 'warning' : 'info', latest.level === 'critical' ? 0 : 8000, latest.code ? `alert:${latest.code}` : undefined);
    });
    root.replaceChildren(shell.root);
    shell.start();
    void refreshOverview();
    void refreshChain();
    stream.start();
  };

  if (tokens.get()) { start(); return; }
  let message: string | null = null;
  try { message = sessionStorage.getItem('maya-admin.gateMessage'); sessionStorage.removeItem('maya-admin.gateMessage'); } catch { /* storage blocked */ }
  showTokenGate(root, api, tokens, message, start);
}

void main();
