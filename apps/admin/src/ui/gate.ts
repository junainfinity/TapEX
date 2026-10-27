/** Token entry: paste once, validated against /overview, kept in sessionStorage only. */
import type { AdminApi } from '../api.js';
import type { TokenStore } from '../settings.js';
import { errorNotice } from './components.js';
import { h, replace } from './dom.js';

export function showTokenGate(root: HTMLElement, api: AdminApi, tokens: TokenStore, message: string | null, onReady: () => void): void {
  const input = h('input', { class: 'input', id: 'token-input', attrs: { type: 'password', autocomplete: 'off', spellcheck: 'false', required: true, 'aria-describedby': 'token-help' } });
  const errorHost = h('div', { attrs: { 'aria-live': 'assertive' } });
  const submit = h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: 'Unlock console' });
  const form = h('form', { class: 'stack', attrs: { novalidate: true } },
    h('div', { class: 'field' },
      h('label', { attrs: { for: 'token-input' }, text: 'Admin token' }), input,
      h('span', { class: 'help', id: 'token-help', text: 'Paste the bearer token from .secrets/admin-token on the house server. It is kept in this tab’s sessionStorage only and is forgotten when the tab closes.' })),
    errorHost, h('div', { class: 'row' }, submit, h('a', { attrs: { href: '?demo' }, text: 'Open the demo instead' })));
  replace(root, h('main', { class: 'gate' }, h('div', { class: 'card' },
    h('div', { class: 'stack', style: { gap: '4px' } }, h('h1', { text: 'Maya-Live house console' }), h('p', { class: 'secondary', text: '$OPEN operator administration — testnet.' })),
    message ? errorNotice({ code: 'TOKEN', message, status: 0 }) : null,
    form)));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const token = input.value.trim();
    if (!token) { replace(errorHost, errorNotice({ code: 'TOKEN_REQUIRED', message: 'Paste the admin token.', status: 0 })); input.focus(); return; }
    submit.disabled = true; submit.textContent = 'Checking…';
    tokens.set(token);
    const result = await api.overview();
    submit.disabled = false; submit.textContent = 'Unlock console';
    if (!result.ok && (result.error.status === 401 || result.error.status === 403)) {
      tokens.clear();
      replace(errorHost, errorNotice(result.error));
      input.select();
      return;
    }
    // Any other failure (server down, bad payload) still unlocks: the console shows the error live.
    onReady();
  });
  input.focus();
}
