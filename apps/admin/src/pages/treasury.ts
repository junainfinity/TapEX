/**
 * Treasury & chain: vault state and identity check, reconciliation, attestation and the escape-hatch
 * clock, ledger-signer rotation (SPEC-11 timelock), operator balances, treasury actions, excess sweep,
 * withdrawal vouchers and anomalies, and the per-player proof lookup.
 *
 * Forms are built once and never re-rendered by polling, so a refresh cannot steal focus or wipe input.
 */
import { Poller, type AppContext, type Page } from '../app.js';
import { attestationHealth, chainNowMs, escapeHealth, escapeMissingNotice, signerHealth, vaultBadges, worstAlertLevel } from '../chain-health.js';
import {
  attestPlan, fundPlan, houseWithdrawableCenti, signerAcceptPlan, signerCancelPlan, signerProposePlan, sweepExcessPlan, vaultPlan, withdrawSurplusPlan, type PlanResult,
} from '../controls.js';
import { explorerUrl, formatAge, formatDateTime, formatInt, networkLabel, shortAddress } from '../format.js';
import { formatEth, formatOpen, formatWeiOpen, groupThousands, parseCenti } from '../money.js';
import type { ChainState } from '../types.js';
import { dataTable, errorNotice, kv, money, usdNote } from '../ui/components.js';
import { h, replace, setText, statusIcon, statusLabel, uid, type Child, type StatusKind } from '../ui/dom.js';
import { proofLookup } from '../ui/proof.js';

const LOW_GAS_WEI = 10n ** 16n; // 0.01 ETH

function addressLink(chainId: number, address: string): Child {
  const url = explorerUrl(chainId, 'address', address);
  return url ? h('a', { class: 'mono', attrs: { href: url, target: '_blank', rel: 'noopener noreferrer', title: address }, text: shortAddress(address) }) : h('span', { class: 'mono', title: address, text: shortAddress(address) });
}

function txLink(chainId: number, hash: string | undefined): Child {
  if (!hash) return '—';
  const url = explorerUrl(chainId, 'tx', hash);
  const text = `${hash.slice(0, 10)}…${hash.slice(-6)}`;
  return url ? h('a', { class: 'mono', attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' }, text }) : h('span', { class: 'mono', title: hash, text });
}

function bps(value: number | undefined): string {
  return value === undefined ? '—' : `${(value / 100).toFixed(value % 100 === 0 ? 0 : 2)} % (${formatInt(value)} bps)`;
}

export function createTreasuryPage(ctx: AppContext): Page {
  const { api, settings, store } = ctx;
  let chain: ChainState | null = null;
  const unsubs: (() => void)[] = [];
  const now = () => chainNowMs(chain?.network ?? store.snapshot.overview?.network, ctx.demo, store.serverNow());

  const errorHost = h('div');
  const alertsHost = h('div');
  const vaultHost = h('div');
  const attestHost = h('div');
  const escapeHost = h('div');
  const signerHost = h('div');
  const operatorHost = h('div');
  const vouchersHost = h('div');
  const indexerHost = h('div');
  const excessHost = h('div');
  const usd = h('p', { class: 'muted', text: usdNote(settings) });

  const card = (title: string, sub: string, body: HTMLElement, actions?: HTMLElement | null) => {
    const id = uid('tcard');
    return h('section', { class: 'card', attrs: { 'aria-labelledby': id } },
      h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, h('h2', { id, text: title }), sub ? h('span', { class: 'sub', text: sub }) : null), actions ?? null), body);
  };

  // ---------- actions (static) ----------
  const attestBtn = h('button', { class: 'btn primary', attrs: { type: 'button' }, text: 'Attest now…' });
  attestBtn.addEventListener('click', () => { if (chain) void ctx.act(attestPlan(chain), () => poller.kick()); });

  /** An input + submit that turns its text into a plan; errors render inline, success opens the confirm dialog. */
  function planForm(opts: { label: string; unit?: string; button: string; danger: boolean; placeholder: string; mono?: boolean; plan: (c: ChainState, text: string) => PlanResult; max?: (c: ChainState) => string | null; maxLabel?: string; help?: string }) {
    const id = uid('pf'); const errId = uid('pf-err'); const helpId = uid('pf-help');
    const input = h('input', { class: `input ${opts.mono ? 'mono' : 'tabular'}`, id, attrs: { type: 'text', inputmode: opts.mono ? 'text' : 'decimal', autocomplete: 'off', spellcheck: 'false', placeholder: opts.placeholder, 'aria-describedby': `${helpId} ${errId}` } });
    const error = h('span', { class: 'error', id: errId, attrs: { 'aria-live': 'polite' } });
    const submit = h('button', { class: opts.danger ? 'btn danger' : 'btn primary', attrs: { type: 'submit' }, text: opts.button });
    const maxBtn = opts.max ? h('button', { class: 'btn ghost small', attrs: { type: 'button' }, text: opts.maxLabel ?? 'Max' }) : null;
    maxBtn?.addEventListener('click', () => { if (chain && opts.max) { const m = opts.max(chain); if (m) { input.value = m; input.focus(); } } });
    const form = h('form', { class: 'field', attrs: { novalidate: true } },
      h('label', { attrs: { for: id }, text: `${opts.label}${opts.unit ? ` (${opts.unit})` : ''}` }),
      h('div', { class: 'row', style: { 'flex-wrap': 'nowrap' } }, input, maxBtn, submit),
      h('span', { class: 'help', id: helpId, text: opts.help ?? '' }), error);
    input.addEventListener('input', () => { setText(error, ''); input.removeAttribute('aria-invalid'); });
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!chain) { setText(error, 'Chain state not loaded yet.'); return; }
      const result = opts.plan(chain, input.value);
      if (!result.ok) { setText(error, Object.values(result.errors)[0] ?? 'Invalid input.'); input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
      void ctx.act(result.plan, () => { input.value = ''; poller.kick(); });
    });
    return form;
  }
  const plain = (centi: bigint | string) => formatOpen(centi, { unit: false }).replace(/,/g, '');
  const fundForm = planForm({ label: 'Fund the house', unit: 'OPEN', button: 'Review funding…', danger: false, placeholder: '0.00', plan: fundPlan, max: c => plain(c.operator.tokenCenti), help: 'Operator → vault fundHouse(amount).' });
  const withdrawForm = planForm({
    label: 'Withdraw house surplus', unit: 'OPEN', button: 'Review withdrawal…', danger: true, placeholder: '0.00', plan: (c, t) => withdrawSurplusPlan(c, t, now()), max: c => plain(houseWithdrawableCenti(c)),
    help: 'Capped by what the vault allows now (surplus less the obligations buffer, within the daily house cap). The server attests first.',
  });
  const vaultToggleHost = h('div', { class: 'row' });

  // Signer rotation
  const proposeForm = planForm({
    label: 'Propose a new ledger signer', button: 'Review proposal…', danger: true, placeholder: '0x… new signer address', mono: true,
    plan: (c, t) => signerProposePlan(c, t, store.snapshot.overview?.operator), help: 'Timelocked: it can only be accepted after the signer-change delay.',
  });
  const signerActionsHost = h('div', { class: 'row' });
  const signerActionError = h('div', { class: 'form-error', attrs: { role: 'alert' } });
  const acceptBtn = h('button', { class: 'btn danger', attrs: { type: 'button' }, text: 'Accept rotation…' });
  const cancelBtn = h('button', { class: 'btn', attrs: { type: 'button' }, text: 'Cancel rotation…' });
  const runPlan = (build: (c: ChainState) => PlanResult) => {
    setText(signerActionError, '');
    if (!chain) return;
    const r = build(chain);
    if (!r.ok) { replace(signerActionError, statusIcon('critical'), h('span', { text: Object.values(r.errors)[0] ?? 'Not possible now.' })); return; }
    void ctx.act(r.plan, () => poller.kick());
  };
  acceptBtn.addEventListener('click', () => runPlan(signerAcceptPlan));
  cancelBtn.addEventListener('click', () => runPlan(signerCancelPlan));
  signerActionsHost.append(acceptBtn, cancelBtn);

  // Excess sweep
  const sweepForm = planForm({
    label: 'Sweep excess to', button: 'Review sweep…', danger: true, placeholder: '0x… recipient', mono: true, plan: sweepExcessPlan,
    max: c => store.snapshot.overview?.operator ?? (c.operator.address || null), maxLabel: 'Operator', help: 'Moves only balanceOf(vault) − assets; accounted assets never change.',
  });

  const proof = proofLookup(api, { chainId: () => chain?.chainId ?? ctx.chainId(), nowMs: now });

  const el = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Treasury & chain' }), h('p', { class: 'lede', text: 'The on-chain vault must always hold at least player balances + outstanding vouchers + open max payouts. Only the attested surplus, less the obligations buffer, is withdrawable.' }))),
    errorHost,
    alertsHost,
    h('div', { class: 'grid-2' },
      card('Vault', 'MayaHouseVault · internal accounting', vaultHost),
      h('div', { class: 'stack', style: { gap: '16px' } },
        card('Attestation', 'liabilities = player balances + outstanding vouchers + open max payouts · balance-tree root', attestHost, attestBtn),
        card('Treasury actions', 'on-chain transactions from the $OPEN operator', h('div', { class: 'stack' }, fundForm, withdrawForm, h('div', { class: 'divider' }), vaultToggleHost)))),
    h('div', { class: 'grid-2' },
      card('Escape hatch', 'anyone may trigger irreversible escape mode after escapeDelay without an attestation', escapeHost),
      card('Ledger signer', 'timelocked rotation: propose → wait the signer-change delay → accept (or cancel)', h('div', { class: 'stack' }, signerHost, signerActionsHost, signerActionError, h('div', { class: 'divider' }), proposeForm))),
    card('Withdrawal vouchers', 'signed withdrawals not yet seen redeemed on chain · redemptions are claimed from Withdrawn events', vouchersHost),
    h('div', { class: 'grid-3' },
      card('Operator', '$OPEN operator wallet', operatorHost),
      card('Deposit indexer', 'idempotent by txHash:logIndex', indexerHost),
      card('Excess tokens', 'tokens sent to the vault outside deposit() / fundHouse()', h('div', { class: 'stack' }, excessHost, sweepForm))),
    card('Escape-hatch proof lookup', 'a player’s leaf and Merkle proof under the attestation the vault holds', proof.el),
    usd);

  // ---------- rendering ----------
  function renderAlerts(c: ChainState): void {
    const alerts = c.alerts ?? [];
    const key = alerts.map(a => `${a.code}:${a.level}:${a.message}`).join('|');
    if (alertsHost.dataset['key'] === key) return;
    alertsHost.dataset['key'] = key;
    if (!alerts.length) { replace(alertsHost); return; }
    const level = worstAlertLevel(alerts) ?? 'info';
    replace(alertsHost, h('section', { class: `alert-list ${level}`, attrs: { 'aria-label': 'Vault alerts', role: level === 'critical' ? 'alert' : 'status' } },
      ...alerts.map(a => h('div', { class: 'row' }, statusLabel(a.level === 'critical' ? 'critical' : a.level === 'warning' ? 'warning' : 'info', a.code), h('span', { text: a.message })))));
  }

  function render(): void {
    if (!chain) { replace(vaultHost, h('div', { class: 'empty', text: 'Loading chain state…' })); return; }
    const c = chain; const v = c.vault; const id = c.chainId;
    const nowMs = now();
    renderAlerts(c);
    const rec = c.reconciliation;
    const vaultRows: [string, Child][] = [
      ['Network', `${networkLabel(c.network, id)} · chain ${id}`],
      ['Vault', addressLink(id, v.address)],
      ['Token', v.token ? h('span', {}, addressLink(id, v.token), h('span', { class: 'muted', text: ' tOPEN (Test OPEN, Maya-Live mock)' })) : '—'],
      ['Assets', money(v.assetsCenti, settings)],
      ['House funded', formatOpen(v.houseFundedCenti)],
      ['Player deposits', formatOpen(v.totalPlayerDepositsCenti)],
      ['Player withdrawals', formatOpen(v.totalPlayerWithdrawalsCenti)],
      ['House withdrawn', v.houseWithdrawnCenti ? formatOpen(v.houseWithdrawnCenti) : '—'],
      ['Surplus (SPEC §5)', money(v.surplusCenti, settings)],
      ['Obligations buffer', bps(v.houseBufferBps)],
      ['House daily cap', v.houseDailyCapCenti ? formatOpen(v.houseDailyCapCenti) : '—'],
      ['House withdrawable now', v.houseWithdrawableCenti !== undefined ? h('strong', {}, money(v.houseWithdrawableCenti, settings)) : '—'],
      ['Max voucher', v.maxVoucherAmountCenti ? formatOpen(v.maxVoucherAmountCenti) : '—'],
      ['Player daily outflow cap', v.dailyOutflowCapCenti ? formatOpen(v.dailyOutflowCapCenti) : '—'],
      ['Max attestation age', v.maxAttestationAgeSec !== undefined ? formatAge(v.maxAttestationAgeSec * 1000) : '—'],
    ];
    if (v.pendingHouseLimits) vaultRows.push(['Pending house limits', `buffer ${bps(v.pendingHouseLimits.houseBufferBps)}, cap ${formatOpen(v.pendingHouseLimits.houseDailyCapCenti)} · applies in ${formatAge(Math.max(0, v.pendingHouseLimits.etaMs - nowMs))}`]);
    if (rec) {
      const dust = rec.dustWei !== '0' ? ` (includes ${groupThousands(rec.dustWei)} wei of deposit dust)` : '';
      vaultRows.push(['Ledger vs vault', rec.match ? `equal at ${formatWeiOpen(rec.vaultAssetsWei)}${dust}` : `ledger ${formatWeiOpen(rec.ledgerAssetsWei)} · vault ${formatWeiOpen(rec.vaultAssetsWei)} · delta ${rec.deltaWei} wei`]);
    }
    // Placeholders from an unreadable vault never produce an "open" or "identity holds" status (chain-health.vaultBadges).
    replace(vaultHost, h('div', { class: 'stack' },
      h('div', { class: 'row' }, ...vaultBadges(c).map(b => statusLabel(b.kind, b.label))),
      kv(vaultRows)));

    const att = attestationHealth(c, nowMs);
    const a = c.lastAttestation;
    replace(attestHost, h('div', { class: 'stack' },
      statusLabel(att.level, att.label),
      a ? kv([
        ['Sequence', formatInt(a.seq)],
        ['As of', formatDateTime(a.asOfMs)],
        ['Liabilities', money(a.liabilitiesCenti, settings)],
        ['Ledger root', h('span', { class: 'mono', title: a.ledgerRoot, text: `${a.ledgerRoot.slice(0, 14)}…${a.ledgerRoot.slice(-6)}` })],
        ['Balance tree', a.tree ? `${a.tree.leaves === null ? '—' : formatInt(a.tree.leaves)} leaves · ${a.tree.leafTotalWei === null ? '—' : formatWeiOpen(a.tree.leafTotalWei)}` : '—'],
        ['Tree file', a.tree?.treeFile ? h('span', { class: 'mono', title: `${a.tree.treeFile}${a.tree.treeSha256 ? `\nsha256 ${a.tree.treeSha256}` : ''}`, text: a.tree.treeFile.replace(/(0x[0-9a-f]{8})[0-9a-f]{50,}([0-9a-f]{6})/i, '$1…$2') }) : '—'],
        ['Transaction', txLink(id, a.txHash)],
        ['Block', a.blockNumber !== undefined ? formatInt(a.blockNumber) : '—'],
      ]) : h('p', { class: 'muted', text: 'The server attests every 10 minutes and immediately before any surplus withdrawal.' })));

    renderEscape(c, nowMs);
    renderSigner(c, nowMs);

    const eth = parseCenti(c.operator.ethWei) ?? 0n;
    replace(operatorHost, h('div', { class: 'stack' },
      eth < LOW_GAS_WEI ? statusLabel('warning', 'Low gas: under 0.01 ETH') : null,
      kv([
        ['Address', addressLink(id, c.operator.address)],
        ['ETH (gas)', formatEth(c.operator.ethWei)],
        ['tOPEN', money(c.operator.tokenCenti, settings)],
      ])));

    renderVouchers(c, nowMs);

    const lag = c.indexer.lagBlocks;
    replace(indexerHost, h('div', { class: 'stack' },
      !Number.isFinite(lag) ? statusLabel('neutral', 'Lag not reported') : lag > 5 ? statusLabel('warning', `Behind by ${formatInt(lag)} blocks`) : statusLabel('good', `In sync (${formatInt(lag)} block${lag === 1 ? '' : 's'} behind)`),
      kv([
        ['Last indexed block', c.indexer.lastBlock !== undefined ? formatInt(c.indexer.lastBlock) : '—'],
        ['Chain head', c.indexer.headBlock !== undefined ? formatInt(c.indexer.headBlock) : '—'],
        ['Confirmations', c.indexer.confirmations !== undefined ? formatInt(c.indexer.confirmations) : '—'],
        ['Withdrawals indexed', c.withdrawals ? formatInt(c.withdrawals.indexed) : '—'],
      ])));

    const excess = v.excessWei === undefined ? null : BigInt(v.excessWei);
    replace(excessHost, h('div', { class: 'stack' },
      excess === null ? statusLabel('neutral', 'Excess not reported') : excess === 0n ? statusLabel('good', 'Nothing to sweep') : statusLabel('warning', `${formatWeiOpen(excess)} above accounted assets`)));

    if (vaultToggleHost.dataset['paused'] !== String(v.paused)) {
      vaultToggleHost.dataset['paused'] = String(v.paused);
      const toggle = h('button', { class: v.paused ? 'btn' : 'btn danger-outline', attrs: { type: 'button' }, text: v.paused ? 'Unpause vault…' : 'Pause vault…' });
      toggle.addEventListener('click', () => { if (chain) void ctx.act(vaultPlan(chain, chain.vault.paused ? 'unpause' : 'pause'), () => poller.kick()); });
      replace(vaultToggleHost, h('div', { class: 'stack', style: { gap: '4px' } }, h('span', { class: 'field-label', text: 'Emergency' }), h('span', { class: 'help muted', text: 'Pausing the vault blocks every player withdrawal on-chain (escape claims still work).' })), h('span', { class: 'spacer' }), toggle);
    }
  }

  function renderEscape(c: ChainState, nowMs: number): void {
    const e = c.vault.escape;
    if (!e) { const notice = escapeMissingNotice(c); replace(escapeHost, statusLabel(notice.kind, notice.label)); return; }
    const hlt = escapeHealth(e, nowMs);
    const warnAt = 50; const critAt = 75;
    const pct = Math.round(hlt.fraction * 1000) / 10;
    const bar = h('div', { class: `progress escape-bar level-${hlt.level}`, attrs: { role: 'meter', 'aria-label': 'Escape clock: time since the last attestation as a share of escapeDelay', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-valuetext': `${pct}% of the escape delay elapsed` } },
      h('div', { class: 'fill', style: { width: `${pct}%` } }),
      h('span', { class: 'tick', style: { left: `${warnAt}%` }, attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'tick', style: { left: `${critAt}%` }, attrs: { 'aria-hidden': 'true' } }));
    replace(escapeHost, h('div', { class: 'stack' },
      statusLabel(hlt.level, hlt.label),
      bar,
      h('div', { class: 'row muted tabular', style: { 'justify-content': 'space-between', 'font-size': '0.8rem' } }, h('span', { text: 'last attestation' }), h('span', { text: 'warn 50 % · critical 75 %' }), h('span', { text: 'escape available' })),
      kv([
        ['Last attestation (chain)', `${formatDateTime(e.lastAttestationAtMs)} · ${formatAge(hlt.ageMs)} ago`],
        ['Escape delay', formatAge(e.escapeDelaySec * 1000)],
        ['Available at', e.mode ? '—' : `${formatDateTime(e.availableAtMs)}${hlt.leftMs > 0 ? ` · in ${formatAge(hlt.leftMs)}` : ' · now'}`],
        ['Mode', e.mode ? 'Escape mode (irreversible): deposits, vouchers, house withdrawals and attestations stopped' : 'Normal'],
        ...(e.mode || BigInt(e.poolWei) > 0n ? [['Escape pool', formatWeiOpen(e.poolWei)] as [string, string], ['Claimed', formatWeiOpen(e.claimedWei)] as [string, string]] : []),
      ]),
      h('p', { class: 'muted', text: 'Every attestation (automatic every 10 minutes, or Attest now) restarts this clock.' })));
  }

  function renderSigner(c: ChainState, nowMs: number): void {
    const v = c.vault; const id = c.chainId;
    const s = signerHealth(c);
    const p = v.pendingSigner;
    replace(signerHost, h('div', { class: 'stack' },
      statusLabel(s.level, s.label),
      kv([
        ['Vault signer', v.ledgerSigner ? addressLink(id, v.ledgerSigner) : '—'],
        ['Key this server holds', v.serverSigner ? addressLink(id, v.serverSigner) : v.serverSigner === null ? 'unknown' : '—'],
        ['Signer-change delay', v.signerChangeDelaySec !== undefined ? formatAge(v.signerChangeDelaySec * 1000) : '—'],
        ['Pending rotation', p ? h('span', {}, addressLink(id, p.address), ' · ', p.due ? h('strong', { class: 'status-critical', text: 'due now' }) : h('span', { class: 'tabular', dataset: { eta: String(p.etaMs) }, text: `accept in ${formatAge(Math.max(0, p.etaMs - nowMs))}` }), h('span', { class: 'muted', text: ` (eta ${formatDateTime(p.etaMs)})` })) : 'none'],
        ...(v.pendingSignerChangeDelay ? [['Pending delay change', `${formatAge(v.pendingSignerChangeDelay.delaySec * 1000)} at ${formatDateTime(v.pendingSignerChangeDelay.etaMs)}`] as [string, string]] : []),
      ])));
    acceptBtn.disabled = !p || !p.due;
    acceptBtn.title = !p ? 'No rotation is pending' : p.due ? '' : 'Not due yet: the vault would revert (TimelockNotElapsed)';
    cancelBtn.disabled = !p;
    signerActionsHost.hidden = !p;
  }

  function renderVouchers(c: ChainState, nowMs: number): void {
    const items = c.pendingVouchers.items ?? [];
    const anomalies = c.withdrawals?.anomalies ?? [];
    const statusKind = (s: string | undefined): StatusKind => (s === 'pending' ? 'info' : s === 'signing' ? 'warning' : 'neutral');
    replace(vouchersHost, h('div', { class: 'stack' },
      kv([['Outstanding', `${formatInt(c.pendingVouchers.count)} voucher${c.pendingVouchers.count === 1 ? '' : 's'} · ${formatOpen(c.pendingVouchers.totalCenti)} (still counted as liabilities)`]]),
      h('div', { class: 'table-wrap', style: { 'max-height': '260px' } }, dataTable({
        caption: 'Outstanding withdrawal vouchers', rows: items, empty: 'No outstanding vouchers.',
        columns: [
          { key: 'id', label: 'Voucher', render: p => p.voucherId ? h('code', { text: p.voucherId }) : '—' },
          { key: 'a', label: 'Player', render: p => { const b = h('button', { class: 'btn ghost small', attrs: { type: 'button', title: `Open ${p.account}` }, text: shortAddress(p.account) }); b.addEventListener('click', () => ctx.openPlayer(p.account)); return b; } },
          { key: 'm', label: 'Amount', num: true, render: p => formatOpen(p.amountCenti) },
          { key: 's', label: 'Status', render: p => statusLabel(statusKind(p.status), p.status ?? '—') },
          { key: 'n', label: 'Nonce', render: p => h('span', { class: 'mono', title: p.nonce, text: p.nonce.length > 14 ? `${p.nonce.slice(0, 6)}…${p.nonce.slice(-6)}` : p.nonce }) },
          { key: 'e', label: 'Expires', num: true, render: p => (p.expiryMs <= nowMs ? h('span', { class: 'status-warning', text: `${formatAge(nowMs - p.expiryMs)} ago` }) : `in ${formatAge(p.expiryMs - nowMs)}`) },
          { key: 't', label: 'Redemption tx', render: p => txLink(c.chainId, p.submittedTxHash) },
        ],
      })),
      h('h3', { text: `Withdrawal anomalies (${formatInt(anomalies.length)})` }),
      anomalies.length ? h('div', { class: 'table-wrap', style: { 'max-height': '220px' } }, dataTable({
        caption: 'Withdrawal anomalies', rows: [...anomalies].reverse(),
        columns: [
          { key: 'ms', label: 'When (UTC)', render: x => formatDateTime(x.ms) },
          { key: 'o', label: 'Outcome', render: x => statusLabel('critical', x.outcome) },
          { key: 'p', label: 'Player', render: x => h('span', { class: 'mono', title: x.player, text: shortAddress(x.player) }) },
          { key: 'a', label: 'Amount', num: true, render: x => formatWeiOpen(x.amountWei) },
          { key: 'v', label: 'Voucher', render: x => x.voucherId ? h('code', { text: x.voucherId }) : '—' },
          { key: 't', label: 'Transaction', render: x => txLink(c.chainId, x.txHash) },
        ],
      })) : h('p', { class: 'muted', text: 'None: every Withdrawn event matched a voucher of this ledger.' })));
  }

  /** Countdown texts tick every second without re-rendering (no focus loss, no layout shift). */
  function tick(): void {
    const nowMs = now();
    if (chain) renderEscape(chain, nowMs); // no focusable content: safe to redraw every second
    for (const node of el.querySelectorAll<HTMLElement>('[data-eta]')) {
      const eta = Number(node.dataset['eta']);
      setText(node, eta > nowMs ? `accept in ${formatAge(eta - nowMs)}` : 'due at next refresh');
    }
  }

  async function load(): Promise<void> {
    const result = await api.chain();
    replace(errorHost, result.ok ? null : errorNotice(result.error));
    if (result.ok) { chain = result.data; store.setChain(result.data); render(); }
  }

  const poller = new Poller(load, ctx.demo ? 5_000 : 10_000);
  let ticker: ReturnType<typeof setInterval> | null = null;
  return {
    el,
    mount() { unsubs.push(settings.on(() => { setText(usd, usdNote(settings)); render(); }), store.on('run', () => poller.kick())); render(); poller.start(); ticker = setInterval(tick, 1000); },
    unmount() { for (const u of unsubs.splice(0)) u(); poller.stop(); if (ticker) clearInterval(ticker); },
  };
}
