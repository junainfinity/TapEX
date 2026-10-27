/** One shared floating tooltip. Values lead, labels follow; rows keyed with a short line. */
import { h, replace } from '../ui/dom.js';

export interface TooltipRow {
  readonly value: string;
  readonly name: string;
  /** CSS color for the line key; omitted for plain rows. */
  readonly color?: string;
}

let el: HTMLDivElement | null = null;

function ensure(): HTMLDivElement {
  if (!el) {
    el = h('div', { class: 'chart-tooltip', attrs: { role: 'status', 'aria-live': 'off' }, hidden: true });
    document.body.append(el);
    // The tooltip is fixed-position: scrolling moves the mark away without a pointerleave, so hide it.
    document.addEventListener('scroll', () => hideTooltip(), { capture: true, passive: true });
  }
  return el;
}

export function showTooltip(clientX: number, clientY: number, title: string, rows: readonly TooltipRow[]): void {
  const tip = ensure();
  replace(tip,
    h('div', { class: 'tt-title', text: title }),
    ...rows.map(row => h('div', { class: 'tt-row' },
      row.color ? h('span', { class: 'tt-key', style: { background: row.color } }) : null,
      h('span', { class: 'tt-value', text: row.value }),
      h('span', { class: 'tt-name', text: row.name }))));
  tip.hidden = false;
  const pad = 14;
  const { width, height } = tip.getBoundingClientRect();
  let x = clientX + pad;
  let y = clientY + pad;
  if (x + width > window.innerWidth - 8) x = clientX - width - pad;
  if (y + height > window.innerHeight - 8) y = clientY - height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

/** Keyboard focus shows the same details as hover, anchored to the focused mark. */
export function showTooltipFor(target: Element, title: string, rows: readonly TooltipRow[]): void {
  const r = target.getBoundingClientRect();
  showTooltip(r.right, r.top, title, rows);
}

export function hideTooltip(): void {
  if (el) el.hidden = true;
}
