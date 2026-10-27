/**
 * The single path for every admin write: before → after diff, required
 * reason, typed confirmation for dangerous actions, then *wait for the
 * server's acknowledgement* (no optimistic UI) and show its result or its
 * error code inline. An unknown outcome (timeout, dropped connection, any 5xx,
 * a chain error) locks resubmission, points to the audit log and offers only a
 * retry of the identical request under the same Idempotency-Key.
 */
import type { AdminApi } from '../api.js';
import { prepareSubmission, REASON_MAX, REASON_MIN, type ActionPlan } from '../controls.js';
import { explorerUrl, formatDisplayValue, formatTime, isTxHash, networkLine } from '../format.js';
import { formatWeiOpen } from '../money.js';
import type { ApiResult, WriteAck } from '../types.js';
import { WriteSession, type UnknownOutcomeLog } from '../write-session.js';
import { errorNotice, kv } from './components.js';
import { h, replace, setText, statusIcon, uid } from './dom.js';

export interface DialogDeps {
  readonly api: AdminApi;
  readonly chainId: () => number;
  /** Network of the vault, named in every on-chain action dialog (null before the first overview). */
  readonly network?: () => { readonly network: string; readonly chainId: number } | null;
  /** Unknown outcomes across dialogs, so reopening the same action warns first. */
  readonly unknownLog?: UnknownOutcomeLog;
  readonly onApplied?: (plan: ActionPlan, ack: WriteAck) => void;
  readonly openAudit?: () => void;
}

export type DialogOutcome = 'applied' | 'cancelled' | 'unknown';

export function openActionDialog(plan: ActionPlan, deps: DialogDeps): Promise<DialogOutcome> {
  return new Promise(resolve => {
    let outcome: DialogOutcome = 'cancelled';
    let pending = false;
    // One session per dialog: a fresh Idempotency-Key per new submission, the same key for a retry after an unknown outcome.
    const session = new WriteSession(deps.api);
    const titleId = uid('dlg-title'); const descId = uid('dlg-desc');
    const reasonId = uid('reason'); const reasonHelpId = uid('reason-help'); const confirmId = uid('confirm'); const confirmHelpId = uid('confirm-help');
    const dangerous = plan.confirmName !== null;

    const diff = h('table', { class: 'data diff' },
      h('caption', { class: 'sr-only', text: 'Changes: before and after' }),
      h('thead', {}, h('tr', {}, h('th', { attrs: { scope: 'col' }, text: 'Setting' }), h('th', { attrs: { scope: 'col' }, text: 'Before' }), h('th', { attrs: { scope: 'col', 'aria-hidden': 'true' } }), h('th', { attrs: { scope: 'col' }, text: 'After' }))),
      h('tbody', {}, ...plan.changes.map(c => h('tr', {},
        h('td', { text: c.label }),
        h('td', { class: c.beforeKnown ? 'before num' : 'muted', text: c.before }),
        h('td', { class: 'arrow', attrs: { 'aria-label': 'changes to' }, text: '→' }),
        h('td', { class: 'after num', text: c.after })))));

    // On-chain actions name the network they will hit (the header hides details on narrow screens).
    const net = plan.onChain ? deps.network?.() ?? null : null;
    const networkRow = plan.onChain ? h('div', { class: 'status status-info dialog-network', attrs: { role: 'note' } }, statusIcon('info'),
      h('span', { text: net ? `On-chain transaction on ${networkLine(net.network, net.chainId)}` : 'On-chain transaction: the network is not known yet (no overview from the server)' })) : null;
    const prior = deps.unknownLog?.recent(plan.path, Date.now()) ?? null;
    const priorWarning = prior ? h('div', { class: 'server-error', attrs: { role: 'alert' } }, statusIcon('critical'),
      h('span', { text: `An earlier “${prior.title}” request at ${formatTime(prior.atMs)} UTC (browser clock) had an unknown outcome (${prior.code}). It may have been applied: check the audit log before applying this again.` })) : null;
    const warnings = plan.warnings.length ? h('ul', { class: 'warnings' }, ...plan.warnings.map(w => h('li', {}, statusIcon('warning'), h('span', { text: w })))) : null;

    const reason = h('textarea', { class: 'input', id: reasonId, attrs: { rows: 3, maxlength: REASON_MAX + 50, required: true, 'aria-describedby': reasonHelpId, placeholder: 'Why are you making this change? This is journaled with your action.' } });
    const counter = h('span', { class: 'help tabular', text: `0 / ${REASON_MAX}` });
    const reasonError = h('div', { class: 'error', attrs: { 'aria-live': 'polite' } });
    const reasonField = h('div', { class: 'field' },
      h('label', { attrs: { for: reasonId }, text: 'Reason (required)' }), reason,
      h('div', { class: 'row', style: { 'justify-content': 'space-between' } }, h('span', { class: 'help', id: reasonHelpId, text: `At least ${REASON_MIN} characters. Stored in the audit log with your action.` }), counter),
      reasonError);

    const confirmInput = h('input', { class: 'input', id: confirmId, attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': confirmHelpId } });
    const confirmError = h('div', { class: 'error', attrs: { 'aria-live': 'polite' } });
    const confirmBox = dangerous ? h('div', { class: 'confirm-box' },
      h('div', { class: 'status status-critical' }, statusIcon('critical'), h('strong', { text: 'Dangerous action' })),
      h('label', { attrs: { for: confirmId } }, 'Type ', h('span', { class: 'confirm-phrase', text: plan.confirmName ?? '' }), ' to confirm'),
      confirmInput,
      h('span', { class: 'help', id: confirmHelpId, text: 'Exact, case-sensitive. This is sent to the server as the confirm field.' }),
      confirmError) : null;

    const resultHost = h('div', { attrs: { 'aria-live': 'assertive' } });
    const pendingEl = h('span', { class: 'pending', hidden: true }, h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'Waiting for the server to acknowledge…' }));
    const cancel = h('button', { class: 'btn', attrs: { type: 'button' }, text: 'Cancel' });
    const submit = h('button', { class: `btn ${dangerous ? 'danger' : 'primary'}`, attrs: { type: 'submit' }, text: dangerous ? plan.title : 'Apply change' });
    const auditBtn = h('button', { class: 'btn', attrs: { type: 'button' }, hidden: true, text: 'Open audit log' });
    const retryBtn = h('button', { class: 'btn', attrs: { type: 'button', title: 'Resends the identical request with the same Idempotency-Key: a server that already applied it returns the stored result instead of applying it again.' }, hidden: true, text: 'Retry same request' });

    const body = h('div', { class: 'dialog-body' }, priorWarning, networkRow, diff, warnings, reasonField, confirmBox, resultHost);
    const form = h('form', { attrs: { method: 'dialog', novalidate: true } },
      h('div', { class: 'dialog-head' },
        h('h2', { id: titleId, text: plan.title }),
        h('p', { id: descId, class: 'secondary', text: plan.summary }),
        h('span', { class: 'endpoint', text: `${plan.method} /admin-api${plan.path}` })),
      body,
      h('div', { class: 'dialog-foot' }, pendingEl, auditBtn, retryBtn, cancel, submit));
    const dialog = h('dialog', { attrs: { 'aria-labelledby': titleId, 'aria-describedby': descId } }, form);

    const refresh = () => {
      setText(counter, `${reason.value.trim().length} / ${REASON_MAX}`);
      const check = prepareSubmission(plan, reason.value, confirmInput.value);
      submit.disabled = pending || !check.ok || outcome !== 'cancelled' || !session.canSubmit;
      retryBtn.disabled = pending || !session.canRetry;
    };
    reason.addEventListener('input', () => { setText(reasonError, ''); reason.removeAttribute('aria-invalid'); refresh(); });
    confirmInput.addEventListener('input', () => { setText(confirmError, ''); confirmInput.removeAttribute('aria-invalid'); refresh(); });
    confirmInput.addEventListener('paste', () => setTimeout(refresh, 0));

    const close = () => { if (!pending) dialog.close(); };
    cancel.addEventListener('click', close);
    auditBtn.addEventListener('click', () => { dialog.close(); deps.openAudit?.(); });
    dialog.addEventListener('cancel', e => { if (pending) e.preventDefault(); });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(outcome); });

    const setPending = (value: boolean) => {
      pending = value;
      pendingEl.hidden = !value;
      // After an unknown outcome the request is frozen: its reason and confirmation can no longer change.
      const frozen = value || session.locked || outcome === 'applied';
      reason.disabled = frozen; confirmInput.disabled = frozen; cancel.disabled = value;
      refresh();
    };

    const settle = (result: ApiResult<WriteAck>) => {
      if (result.ok) {
        outcome = 'applied';
        deps.unknownLog?.clear(plan.path);
        reason.disabled = true; confirmInput.disabled = true;
        replace(resultHost, success(result.data, deps.chainId(), session.attempts > 1));
        submit.hidden = true; retryBtn.hidden = true; auditBtn.hidden = true;
        cancel.textContent = 'Done';
        cancel.focus();
        deps.onApplied?.(plan, result.data);
        return;
      }
      replace(resultHost, errorNotice(result.error));
      if (session.locked) {
        outcome = 'unknown';
        auditBtn.hidden = false;
        cancel.textContent = 'Close';
        if (session.phase === 'unknown') {
          deps.unknownLog?.record(plan.path, plan.title, result.error, Date.now());
          retryBtn.hidden = false;
          resultHost.append(h('p', { class: 'secondary', text: 'The outcome is unknown: the server may already have applied this. Resubmitting is disabled so it cannot be applied twice. Check the audit log first. “Retry same request” resends the identical request with the same Idempotency-Key, so a server that already applied it returns its stored result instead (that memory does not survive a server restart).' }));
        } else {
          retryBtn.hidden = true;
          resultHost.append(h('p', { class: 'secondary', text: 'The retry got a definite answer, but the first attempt may still have been applied. Check the audit log, then start a new change if needed.' }));
        }
      }
      refresh();
    };

    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (pending || outcome !== 'cancelled' || !session.canSubmit) return;
      const check = prepareSubmission(plan, reason.value, confirmInput.value);
      if (!check.ok) {
        if (check.errors.reason) { setText(reasonError, check.errors.reason); reason.setAttribute('aria-invalid', 'true'); reason.focus(); }
        if (check.errors.confirm) { setText(confirmError, check.errors.confirm); confirmInput.setAttribute('aria-invalid', 'true'); if (!check.errors.reason) confirmInput.focus(); }
        return;
      }
      replace(resultHost);
      setPending(true);
      const result = await session.submit(check.request);
      setPending(false);
      settle(result);
    });

    retryBtn.addEventListener('click', async () => {
      if (pending || !session.canRetry) return;
      replace(resultHost);
      setPending(true);
      const result = await session.retry();
      setPending(false);
      settle(result);
    });

    document.body.append(dialog);
    dialog.showModal();
    refresh();
    reason.focus();
  });
}

function success(ack: WriteAck, chainId: number, afterRetry: boolean): HTMLElement {
  const pairs: [string, Node | string][] = [];
  if (afterRetry) pairs.push(['Retry', 'Acknowledged on a retry with the same Idempotency-Key (a server that had already applied it replays its stored answer).']);
  if (typeof ack.auditId === 'string') pairs.push(['Audit entry', ack.auditId]);
  if (typeof ack.jobId === 'string') pairs.push(['Job', ack.jobId]);
  if (typeof ack.txHash === 'string') {
    const url = isTxHash(ack.txHash) ? explorerUrl(chainId, 'tx', ack.txHash) : null;
    pairs.push(['Transaction', url ? h('a', { attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' }, text: `${ack.txHash.slice(0, 10)}…${ack.txHash.slice(-8)}` }) : ack.txHash]);
  }
  if (typeof ack['attestTxHash'] === 'string') {
    const hash = ack['attestTxHash'];
    const url = isTxHash(hash) ? explorerUrl(chainId, 'tx', hash) : null;
    pairs.push(['Pre-withdrawal attestation', url ? h('a', { attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' }, text: `${hash.slice(0, 10)}…${hash.slice(-8)}` }) : hash]);
  }
  if (typeof ack['amountWei'] === 'string' && /^\d+$/.test(ack['amountWei'])) pairs.push(['Amount', formatWeiOpen(ack['amountWei'])]);
  if (typeof ack['invalidatedVouchers'] === 'number') pairs.push(['Vouchers invalidated', String(ack['invalidatedVouchers'])]);
  if (Array.isArray(ack['disabled']) && ack['disabled'].length) pairs.push(['Switched off', ack['disabled'].map(String).join(', ')]);
  if (ack.after !== undefined) {
    // Money keys (…Centi, …Wei) read in OPEN; the raw JSON stays one click away. Whole configs (defenses) are shortened.
    const text = formatDisplayValue(ack.after);
    const shown = text.length <= 200 ? text : `${text.slice(0, 197)}…`;
    pairs.push(['Now', typeof ack.after !== 'object' || ack.after === null ? text
      : h('div', { class: 'stack', style: { gap: '4px' } }, h('span', { text: shown }), h('details', {}, h('summary', { text: 'Raw JSON' }), h('pre', { class: 'ack-json', text: JSON.stringify(ack.after, null, 2) })))]);
  }
  if (typeof ack['note'] === 'string') pairs.push(['Note', ack['note']]);
  const warning = typeof ack['warning'] === 'string' ? ack['warning'] : null;
  return h('div', { class: 'result-ok', attrs: { role: 'status' } },
    h('div', { class: 'status status-good' }, statusIcon('good'), h('strong', { text: 'Applied — acknowledged by the server' })),
    warning ? h('div', { class: 'status status-warning', attrs: { role: 'alert' } }, statusIcon('warning'), h('span', { text: warning })) : null,
    pairs.length ? kv(pairs) : null,
    h('span', { class: 'secondary', text: 'Values on the page refresh from the server; nothing was changed locally.' }));
}
