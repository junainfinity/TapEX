/**
 * Minimal DOM builders. Strings always become text nodes, so server-provided
 * labels (accounts, reasons, market ids) can never inject markup.
 */

export type Child = Node | string | number | null | undefined | false;

export interface Props {
  readonly class?: string;
  readonly id?: string;
  readonly text?: string;
  readonly title?: string;
  readonly hidden?: boolean;
  readonly attrs?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  readonly dataset?: Readonly<Record<string, string>>;
  readonly style?: Readonly<Record<string, string>>;
  readonly on?: { readonly [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };
}

function applyAttrs(el: Element, attrs: Props['attrs']): void {
  if (!attrs) return;
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    el.setAttribute(name, value === true ? '' : String(value));
  }
}

function append(el: Element, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.id) el.id = props.id;
  if (props.title) el.title = props.title;
  if (props.hidden) el.hidden = true;
  if (props.text !== undefined) el.textContent = props.text;
  applyAttrs(el, props.attrs);
  if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) el.dataset[k] = v;
  if (props.style) for (const [k, v] of Object.entries(props.style)) el.style.setProperty(k, v);
  if (props.on) for (const [type, handler] of Object.entries(props.on)) el.addEventListener(type, handler as EventListener);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Readonly<Record<string, string | number | null | undefined>> = {}, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) if (value !== null && value !== undefined) el.setAttribute(name, String(value));
  append(el, children);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replace(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

/** Update text only when it changed, so live updates cause no needless reflow. */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

let idCounter = 0;
export function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
}

export type StatusKind = 'good' | 'warning' | 'serious' | 'critical' | 'info' | 'neutral';

const ICON_PATHS: Record<StatusKind, string> = {
  good: 'M3.5 8.5l3 3 6-7',
  warning: 'M8 2.5l6 11H2z M8 6.5v3.5 M8 12v.01',
  serious: 'M8 2.5l6 11H2z M8 6.5v3.5 M8 12v.01',
  critical: 'M5.5 2h5L14 5.5v5L10.5 14h-5L2 10.5v-5z M8 5v4 M8 11.2v.01',
  info: 'M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8z M8 7.2v4 M8 4.8v.01',
  neutral: 'M8 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
};

/** Status never relies on color alone: every icon ships beside a text label. */
export function statusIcon(kind: StatusKind): SVGSVGElement {
  return svg('svg', { class: `icon icon-${kind}`, viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false' },
    svg('path', { d: ICON_PATHS[kind], fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
}

export function statusLabel(kind: StatusKind, label: string, extraClass = ''): HTMLSpanElement {
  return h('span', { class: `status status-${kind} ${extraClass}`.trim() }, statusIcon(kind), h('span', { text: label }));
}
