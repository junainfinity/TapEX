/**
 * Config forms shared by Controls and Defenses. Inputs start blank ("blank = unchanged") so a stale form
 * can never silently revert a change another admin made; every submission goes through the diff dialog
 * and nothing changes locally until the server acknowledges.
 */
import type { AppContext } from '../app.js';
import { displayField, rawField, type Draft, type FieldSpec, type PlanResult } from '../controls.js';
import { h, replace, setText, statusIcon, uid } from './dom.js';

export interface FieldControl {
  readonly wrap: HTMLElement;
  readonly control: HTMLInputElement | HTMLSelectElement;
  readonly current: HTMLElement;
  readonly error: HTMLElement;
}

export function fieldInput(spec: FieldSpec): FieldControl {
  const id = uid(`f-${spec.key.replace(/\./g, '-')}`); const helpId = uid('help'); const currentId = uid('cur'); const errorId = uid('err');
  const described = `${currentId} ${helpId} ${errorId}`;
  let control: HTMLInputElement | HTMLSelectElement;
  if (spec.kind === 'boolean' || spec.kind === 'enum') {
    const options = spec.kind === 'boolean' ? [['true', 'On'], ['false', 'Off']] : (spec.options ?? []).map(o => [o, o]);
    control = h('select', { class: 'input', id, attrs: { 'aria-describedby': described } }, h('option', { attrs: { value: '' }, text: '— unchanged —' }), ...options.map(([v, l]) => h('option', { attrs: { value: v ?? '' }, text: l ?? '' })));
  } else {
    control = h('input', { class: 'input tabular', id, attrs: { type: 'text', inputmode: spec.kind === 'integer' || spec.kind === 'minutes' ? 'numeric' : spec.signed ? 'text' : 'decimal', autocomplete: 'off', 'aria-describedby': described } });
  }
  const unit = spec.kind === 'percent' ? ' (%)' : spec.kind === 'open' ? ' (OPEN)' : spec.kind === 'minutes' ? ' (minutes)' : spec.kind === 'multiplier' ? ' (×)' : spec.unit ? ` (${spec.unit})` : '';
  const current = h('span', { class: 'current', id: currentId });
  const error = h('span', { class: 'error', id: errorId, attrs: { 'aria-live': 'polite' } });
  const wrap = h('div', { class: 'field' }, h('label', { attrs: { for: id }, text: `${spec.label}${unit}` }), control, current, h('span', { class: 'help', id: helpId, text: spec.help }), error);
  return { wrap, control, current, error };
}

export interface FormSection<S> {
  readonly el: HTMLElement;
  /** Re-read "current" values and placeholders from a new snapshot. */
  refresh(source: S): void;
  /** Cheap live refresh of the non-focusable summary block. */
  refreshExtra(source: S): void;
}

export interface FormSectionOptions<S> {
  readonly title: string;
  readonly sub: string;
  readonly fields: readonly FieldSpec[];
  readonly before: (source: S) => Readonly<Record<string, unknown>> | undefined;
  readonly plan: (source: S, draft: Draft) => PlanResult;
  readonly extra?: (source: S) => HTMLElement | null;
  readonly shortcuts?: (source: S, apply: (draft: Draft) => void) => HTMLElement | null;
  /** Shown when a submission happens before the first snapshot. */
  readonly notLoaded?: string;
  readonly headExtra?: HTMLElement;
}

export function formSection<S>(ctx: AppContext, opts: FormSectionOptions<S>): FormSection<S> {
  const titleId = uid('sec');
  const inputs = opts.fields.map(spec => ({ spec, ...fieldInput(spec) }));
  const formError = h('div', { class: 'form-error', attrs: { role: 'alert' } });
  const extraHost = h('div');
  const shortcutHost = h('div', { class: 'row' });
  const review = h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: 'Review change…' });
  const reset = h('button', { class: 'btn ghost', attrs: { type: 'button' }, text: 'Clear' });
  let latest: S | null = null;
  const form = h('form', { attrs: { novalidate: true, 'aria-labelledby': titleId } },
    extraHost,
    h('div', { class: 'form-grid' }, ...inputs.map(i => i.wrap)),
    h('div', { class: 'form-actions' }, review, reset, shortcutHost, h('span', { class: 'spacer' }), h('span', { class: 'muted', text: 'Blank fields stay unchanged.' })),
    formError);
  const el = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, h('h2', { id: titleId, text: opts.title }), h('span', { class: 'sub', text: opts.sub })), opts.headExtra ?? null), form);

  const clearErrors = () => { setText(formError, ''); for (const i of inputs) { setText(i.error, ''); i.control.removeAttribute('aria-invalid'); } };
  const draft = (): Draft => Object.fromEntries(inputs.map(i => [i.spec.key, i.control.value]));
  const submit = (d: Draft) => {
    clearErrors();
    if (latest === null) { replace(formError, statusIcon('critical'), h('span', { text: opts.notLoaded ?? 'No overview from the server yet; cannot show current values.' })); return; }
    const result = opts.plan(latest, d);
    if (!result.ok) {
      for (const [key, message] of Object.entries(result.errors)) {
        const input = inputs.find(i => i.spec.key === key);
        if (input) { setText(input.error, message); input.control.setAttribute('aria-invalid', 'true'); }
        else replace(formError, statusIcon('critical'), h('span', { text: message }));
      }
      inputs.find(i => i.control.getAttribute('aria-invalid') === 'true')?.control.focus();
      return;
    }
    void ctx.act(result.plan, () => { for (const i of inputs) i.control.value = ''; });
  };
  form.addEventListener('submit', e => { e.preventDefault(); submit(draft()); });
  reset.addEventListener('click', () => { for (const i of inputs) i.control.value = ''; clearErrors(); });
  for (const i of inputs) i.control.addEventListener('input', () => { setText(i.error, ''); i.control.removeAttribute('aria-invalid'); });

  return {
    el,
    refreshExtra(source) { latest = source; replace(extraHost, opts.extra?.(source) ?? null); },
    refresh(source) {
      latest = source;
      const before = opts.before(source);
      for (const i of inputs) {
        const value = before?.[i.spec.key];
        setText(i.current, `Current: ${displayField(i.spec, value)}`);
        if (i.control instanceof HTMLInputElement) i.control.placeholder = rawField(i.spec, value);
      }
      replace(extraHost, opts.extra?.(source) ?? null);
      replace(shortcutHost, opts.shortcuts?.(source, d => { for (const i of inputs) i.control.value = d[i.spec.key] ?? ''; submit(d); }) ?? null);
    },
  };
}
