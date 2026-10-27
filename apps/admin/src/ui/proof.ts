/**
 * Escape-hatch proof lookup (SPEC-11): the account's leaf and Merkle proof under the attestation the
 * vault currently holds, from the public player route GET /v1/account/:address/proof. Read-only.
 */
import type { AdminApi } from '../api.js';
import { explorerUrl, formatAge, formatDateTime, isEvmAddress, isTxHash, shortAddress } from '../format.js';
import { formatWeiOpen } from '../money.js';
import type { AccountProof, ApiErrorBody } from '../types.js';
import { errorNotice, kv } from './components.js';
import { h, replace, setText, statusLabel, uid } from './dom.js';

/** 'player:0xabc…' or '0xabc…' → lower-case 0x address, else null. */
export function proofAddress(input: string): string | null {
  const text = input.trim().replace(/^player:/i, '');
  return isEvmAddress(text) ? text.toLowerCase() : null;
}

function shortHash(hash: string): string { return hash.length > 20 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash; }

export function renderProof(p: AccountProof, chainId: number, nowMs: number): HTMLElement {
  const a = p.attestation;
  const e = p.escape;
  const status = p.unavailable
    ? statusLabel('critical', 'No proof served: the server failed closed')
    : !a ? statusLabel('warning', 'No attestation yet: claim with attestedBalance 0 and an empty proof')
    : p.included ? statusLabel('good', `Included in attestation #${a.seq}`) : statusLabel('neutral', 'No leaf: this account was owed 0 at the attested cut');
  const tx = a?.txHash && isTxHash(a.txHash) ? explorerUrl(chainId, 'tx', a.txHash) : null;
  const pairs: [string, Node | string][] = [['Account', h('span', { class: 'mono', text: p.account })]];
  if (a) {
    pairs.push(
      ['Attestation', `#${a.seq} · as of ${formatDateTime(a.asOfMs)} · from the ${a.source === 'vault' ? 'vault (on chain)' : 'journal (vault unreadable)'}`],
      ['Root', h('span', { class: 'mono', title: a.root, text: shortHash(a.root) })],
      ['Attested liabilities', formatWeiOpen(a.liabilitiesWei)],
    );
    if (a.txHash) pairs.push(['Attest transaction', tx ? h('a', { attrs: { href: tx, target: '_blank', rel: 'noopener noreferrer' }, text: shortHash(a.txHash) }) : h('span', { class: 'mono', text: shortHash(a.txHash) })]);
  }
  if (!p.unavailable) {
    pairs.push(['Leaf balance', h('strong', { class: 'tabular', text: formatWeiOpen(p.balanceWei) })]);
    if (p.currentOwedWei !== undefined) pairs.push(['Owed now (ledger)', formatWeiOpen(p.currentOwedWei)]);
    pairs.push(['Proof', p.proof.length ? `${p.proof.length} sibling hash${p.proof.length === 1 ? '' : 'es'}` : 'empty']);
  }
  if (e) {
    pairs.push(['Escape hatch', e.mode ? 'Active: claims open' : e.available ? 'Available to anyone now' : `Available in ${formatAge(Math.max(0, e.availableAtMs - nowMs))} (${formatDateTime(e.availableAtMs)})`]);
    if (e.entitlementWei !== undefined) pairs.push(['Escape entitlement', h('strong', { class: 'tabular', text: formatWeiOpen(e.entitlementWei) })]);
  }
  const proofList = p.proof.length ? h('details', { class: 'proof-list' },
    h('summary', { text: 'Show proof hashes' }),
    h('ol', { class: 'mono' }, ...p.proof.map(x => h('li', { title: x, text: x })))) : null;
  const claim = p.claim;
  const copyBtn = claim ? h('button', { class: 'btn small', attrs: { type: 'button' }, text: 'Copy claim arguments' }) : null;
  const copied = h('span', { class: 'muted', attrs: { 'aria-live': 'polite' } });
  copyBtn?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(JSON.stringify({ function: claim!.function, attestedBalance: claim!.attestedBalance, proof: claim!.proof })); setText(copied, 'Copied.'); }
    catch { setText(copied, 'The browser blocked clipboard access.'); }
  });
  return h('div', { class: 'stack' },
    status,
    p.unavailable ? errorNotice({ code: p.unavailable.code, message: p.unavailable.message, status: 503 }) : null,
    kv(pairs),
    proofList,
    claim ? h('div', { class: 'row' }, h('code', { text: `${claim.function.split('(')[0]}(${claim.attestedBalance}, [${claim.proof.length} hashes])` }), copyBtn, copied) : null,
    p.note ? h('p', { class: 'muted', text: p.note }) : null);
}

export interface ProofLookup {
  readonly el: HTMLElement;
  /** Look up an address now (also fills the input). */
  lookup(address: string): Promise<void>;
}

export function proofLookup(api: AdminApi, deps: { chainId: () => number; nowMs: () => number; compact?: boolean }): ProofLookup {
  const id = uid('proof'); const errId = uid('proof-err');
  const input = h('input', { class: 'input mono', id, attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '0x… player address', 'aria-describedby': errId } });
  const submit = h('button', { class: 'btn', attrs: { type: 'submit' }, text: 'Look up proof' });
  const error = h('span', { class: 'error', id: errId, attrs: { 'aria-live': 'polite' } });
  const result = h('div', { attrs: { 'aria-live': 'polite' } });
  const form = h('form', { class: 'field', attrs: { novalidate: true } },
    h('label', { attrs: { for: id }, text: 'On-chain player address' }),
    h('div', { class: 'row', style: { 'flex-wrap': 'nowrap' } }, input, submit),
    h('span', { class: 'help', text: 'Public data from GET /v1/account/:address/proof; the admin token is not sent.' }),
    error);
  let seq = 0;
  async function lookup(raw: string): Promise<void> {
    setText(error, ''); input.removeAttribute('aria-invalid');
    const address = proofAddress(raw);
    if (!address) { setText(error, 'Enter a 0x address (40 hex digits).'); input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
    input.value = address;
    const mine = ++seq;
    submit.disabled = true;
    replace(result, h('div', { class: 'empty', text: `Looking up ${shortAddress(address)}…` }));
    const r = await api.proof(address);
    if (mine !== seq) return;
    submit.disabled = false;
    replace(result, r.ok ? renderProof(r.data, deps.chainId(), deps.nowMs()) : errorNotice(r.error as ApiErrorBody));
  }
  form.addEventListener('submit', e => { e.preventDefault(); void lookup(input.value); });
  input.addEventListener('input', () => { setText(error, ''); input.removeAttribute('aria-invalid'); });
  const el = h('div', { class: 'stack' }, deps.compact ? null : form, result);
  return { el, lookup };
}
