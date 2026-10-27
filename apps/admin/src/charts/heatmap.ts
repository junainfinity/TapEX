/**
 * Exposure heatmap: windows × price bands, colored by open liability as a
 * share of the cell limit on a one-hue sequential scale (six bins + empty),
 * 2 px surface gaps between cells, labels inked by fill luminance, a
 * near-limit icon (never color alone), roving-tabindex keyboard navigation.
 */
import { formatInt, formatPct, formatPrice, formatTime } from '../format.js';
import { centiRatio, formatOpen, formatX100, sumCenti } from '../money.js';
import type { Exposure } from '../types.js';
import { svg } from '../ui/dom.js';
import { inkOn, token } from './theme.js';
import { hideTooltip, showTooltip, showTooltipFor } from './tooltip.js';

export const HEAT_THRESHOLDS: readonly number[] = [0.1, 0.25, 0.5, 0.75, 0.9];
export const NEAR_LIMIT = 0.9;

/** 0 = no liability; 1..6 = sequential bins by share of the cell limit. */
export function heatBin(share: number | null): number {
  if (share === null || !(share > 0)) return 0;
  let bin = 1;
  for (const threshold of HEAT_THRESHOLDS) if (share > threshold) bin++;
  return bin;
}

export interface HeatCellModel {
  readonly key: string;
  readonly start: number;
  readonly bandIndex: number;
  readonly share: number | null;
  readonly bin: number;
  readonly x100: number | null;
  readonly liabilityCenti: string;
  readonly limitCenti: string;
  readonly legs: number;
}

export interface HeatColumnModel {
  readonly start: number;
  readonly liabilityCenti: string;
  readonly legs: number;
  readonly share: number | null;
}

export interface HeatModel {
  readonly windows: readonly number[];
  /** Highest band first (top row). */
  readonly bands: readonly { readonly index: number; readonly label: string }[];
  readonly cells: ReadonlyMap<string, HeatCellModel>;
  readonly columns: readonly HeatColumnModel[];
  readonly maxShare: number;
  readonly totalLiabilityCenti: string;
}

export const cellKey = (start: number, bandIndex: number) => `${start}:${bandIndex}`;

function bandLabel(band: { index: number; lower?: string; upper?: string }): string {
  if (band.lower !== undefined && band.upper !== undefined) return `${formatPrice(band.lower)} – ${formatPrice(band.upper)}`;
  return band.index === 0 ? 'spot band' : `band ${band.index > 0 ? '+' : '−'}${Math.abs(band.index)}`;
}

export function buildHeatModel(exposure: Exposure): HeatModel {
  const cells = new Map<string, HeatCellModel>();
  let maxShare = 0;
  for (const c of exposure.cells) {
    const share = centiRatio(c.liabilityCenti, c.limitCenti);
    if (share !== null && share > maxShare) maxShare = share;
    const key = cellKey(c.start, c.bandIndex);
    cells.set(key, { key, start: c.start, bandIndex: c.bandIndex, share, bin: heatBin(c.liabilityCenti === '0' ? 0 : share), x100: c.x100, liabilityCenti: c.liabilityCenti, limitCenti: c.limitCenti, legs: c.legs });
  }
  const bandIndexes = exposure.bands.length > 0 ? exposure.bands : [...new Set(exposure.cells.map(c => c.bandIndex))].map(index => ({ index }));
  const bands = [...bandIndexes].sort((a, b) => b.index - a.index).map(b => ({ index: b.index, label: bandLabel(b) }));
  const windows = exposure.windows.length > 0 ? [...exposure.windows] : [...new Set(exposure.cells.map(c => c.start))].sort((a, b) => a - b);
  const columns = windows.map(start => {
    const inColumn = exposure.cells.filter(c => c.start === start);
    const liability = sumCenti(inColumn.map(c => c.liabilityCenti));
    return { start, liabilityCenti: liability.toString(), legs: inColumn.reduce((n, c) => n + c.legs, 0), share: exposure.columnLimitCenti ? centiRatio(liability, exposure.columnLimitCenti) : null };
  });
  return { windows, bands, cells, columns, maxShare, totalLiabilityCenti: sumCenti(exposure.cells.map(c => c.liabilityCenti)).toString() };
}

export interface HeatmapHandlers {
  readonly onSelect: (key: string) => void;
}

function nearLimitIcon(x: number, y: number, color: string): SVGGElement {
  return svg('g', { transform: `translate(${x},${y})`, 'aria-hidden': 'true' },
    svg('path', { d: 'M6 0.8l5.4 9.6H0.6z', fill: token('warning'), stroke: color, 'stroke-width': 1 }),
    svg('path', { d: 'M6 4v3 M6 8.6v.01', stroke: '#0b0b0b', 'stroke-width': 1.4, 'stroke-linecap': 'round' }));
}

/** A share label that never reads "0%" for a cell that does carry liability. */
export function shareLabel(share: number | null): string {
  if (share === null) return '—';
  if (share > 0 && share < 0.005) return '<1%';
  return formatPct(share, 0);
}

const LABEL_W = 128; const HEAD_H = 34; const CELL_H = 44; const GAP = 2; const TOTALS_H = 50;

/**
 * Live heatmap view. Updates within the same window grid patch each cell in
 * place, so hover, focus and a click in progress survive the 1–2 s refresh;
 * only a structural change (windows rolled, bands moved, resize) rebuilds.
 */
export class HeatmapView {
  readonly el: HTMLDivElement;
  private svgEl: SVGSVGElement | null = null;
  private structure = '';
  private model: HeatModel | null = null;
  private selectedKey: string | null = null;
  private focusKey: string | null = null;
  private width = 0;
  private cellW = 0;
  private order: string[] = [];

  constructor(private readonly handlers: HeatmapHandlers) {
    this.el = document.createElement('div');
    this.el.className = 'heat-wrap';
  }

  update(model: HeatModel, width: number, selectedKey: string | null): void {
    this.model = model;
    this.selectedKey = selectedKey;
    const structure = `${width}|${model.windows.join(',')}|${model.bands.map(b => `${b.index}:${b.label}`).join(',')}`;
    if (structure !== this.structure || !this.svgEl) {
      const hadFocus = this.svgEl?.contains(document.activeElement) ?? false;
      this.structure = structure;
      this.width = width;
      this.build(hadFocus);
      return;
    }
    for (const g of this.svgEl.querySelectorAll<SVGGElement>('g[data-key]')) this.drawCell(g);
    this.drawTotals();
  }

  private cellGeometry(key: string): { x: number; y: number } | null {
    const m = this.model;
    if (!m) return null;
    const [startText, bandText] = key.split(':');
    const ci = m.windows.indexOf(Number(startText));
    const ri = m.bands.findIndex(b => b.index === Number(bandText));
    if (ci < 0 || ri < 0) return null;
    return { x: LABEL_W + ci * (this.cellW + GAP), y: HEAD_H + ri * (CELL_H + GAP) };
  }

  private title(key: string): string {
    const m = this.model!;
    const [startText, bandText] = key.split(':');
    const band = m.bands.find(b => b.index === Number(bandText));
    return `${formatTime(Number(startText))} · ${band?.label ?? bandText}`;
  }

  private tipRows(key: string) {
    const cell = this.model?.cells.get(key);
    if (!cell) return [{ value: '—', name: 'no data' }];
    const offered = cell.x100 !== null;
    return [
      { value: cell.share === null ? '—' : formatPct(cell.share, 1), name: cell.share !== null && cell.share > NEAR_LIMIT ? 'of cell limit · near limit' : 'of cell limit' },
      { value: formatOpen(cell.liabilityCenti), name: 'open liability' },
      { value: formatOpen(cell.limitCenti), name: 'cell limit' },
      { value: formatInt(cell.legs), name: 'open legs' },
      { value: offered ? formatX100(cell.x100) : 'not offered', name: 'current quote' },
    ];
  }

  private drawCell(g: SVGGElement): void {
    const key = g.getAttribute('data-key') ?? '';
    const geo = this.cellGeometry(key);
    if (!geo) return;
    const { x, y } = geo;
    const cellW = this.cellW;
    const cell = this.model?.cells.get(key);
    const fill = cell && cell.bin > 0 ? token(`seq-${cell.bin}`) : token('surface-2');
    const ink = cell && cell.bin > 0 ? inkOn(fill) : token('ink-3');
    const offered = cell !== undefined && cell.x100 !== null;
    const title = this.title(key);
    g.setAttribute('aria-label', cell ? `${title}: ${cell.share === null ? 'no limit' : `${shareLabel(cell.share)} of cell limit`}${cell.share !== null && cell.share > NEAR_LIMIT ? ' (near limit)' : ''}, ${formatOpen(cell.liabilityCenti)} liability, ${formatInt(cell.legs)} legs, ${offered ? formatX100(cell.x100) : 'not offered'}` : `${title}: no data`);
    g.setAttribute('aria-pressed', this.selectedKey === key ? 'true' : 'false');
    const parts: SVGElement[] = [svg('rect', { x, y, width: cellW, height: CELL_H, rx: 4, fill })];
    if (cell && cell.bin > 0) {
      parts.push(svg('text', { class: 'cell-label', x: x + cellW / 2, y: y + (cellW >= 64 ? 19 : CELL_H / 2 + 4), 'text-anchor': 'middle', style: `fill:${ink}` }, shareLabel(cell.share)));
      if (cellW >= 64) parts.push(svg('text', { x: x + cellW / 2, y: y + 34, 'text-anchor': 'middle', style: `fill:${ink}` }, offered ? formatX100(cell.x100) : 'not offered'));
      if (cell.share !== null && cell.share > NEAR_LIMIT) parts.push(nearLimitIcon(x + cellW - 16, y + 4, token('surface')));
    } else {
      parts.push(svg('text', { x: x + cellW / 2, y: y + CELL_H / 2 + 4, 'text-anchor': 'middle', style: `fill:${ink}` }, offered ? formatX100(cell?.x100) : '—'));
    }
    parts.push(svg('rect', { class: 'mark-outline', x: x + 1, y: y + 1, width: cellW - 2, height: CELL_H - 2, rx: 4 }));
    g.replaceChildren(...parts);
    if (g.matches(':hover') || document.activeElement === g) showTooltipFor(g, title, this.tipRows(key));
  }

  private build(restoreFocus: boolean): void {
    const m = this.model!;
    hideTooltip();
    const width = this.width;
    const cols = Math.max(1, m.windows.length);
    this.cellW = Math.max(48, (width - LABEL_W - GAP * (cols - 1)) / cols);
    const gridH = m.bands.length * (CELL_H + GAP) - GAP;
    const height = HEAD_H + gridH + 10 + TOTALS_H;
    const root = svg('svg', { class: 'viz heatmap', width, height, viewBox: `0 0 ${width} ${height}`, role: 'grid', 'aria-label': 'Open liability by window and price band, as a share of each cell limit' });
    const firstStart = m.windows[0];
    m.windows.forEach((start, ci) => {
      const x = LABEL_W + ci * (this.cellW + GAP);
      root.append(svg('text', { x: x + this.cellW / 2, y: 14, 'text-anchor': 'middle' }, formatTime(start)));
      root.append(svg('text', { x: x + this.cellW / 2, y: 28, 'text-anchor': 'middle' }, firstStart === undefined ? '' : `+${Math.round((start - firstStart) / 1000)} s`));
    });
    this.order = [];
    if (!this.focusKey || !m.cells.has(this.focusKey)) this.focusKey = this.selectedKey && m.cells.has(this.selectedKey) ? this.selectedKey : (m.windows[0] !== undefined && m.bands[0] ? cellKey(m.windows[0], m.bands[0].index) : null);
    m.bands.forEach((band, ri) => {
      const rowY = HEAD_H + ri * (CELL_H + GAP);
      const row = svg('g', { role: 'row' });
      row.append(svg('text', { x: LABEL_W - 10, y: rowY + CELL_H / 2 + 4, 'text-anchor': 'end', role: 'rowheader' }, band.label));
      for (const start of m.windows) {
        const key = cellKey(start, band.index);
        this.order.push(key);
        const g = svg('g', { class: 'mark', role: 'gridcell', tabindex: this.focusKey === key ? 0 : -1, 'data-key': key });
        g.addEventListener('click', () => this.handlers.onSelect(key));
        g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.handlers.onSelect(key); } });
        g.addEventListener('pointermove', e => showTooltip(e.clientX, e.clientY, this.title(key), this.tipRows(key)));
        g.addEventListener('pointerleave', () => hideTooltip());
        g.addEventListener('focus', () => { this.focusKey = key; showTooltipFor(g, this.title(key), this.tipRows(key)); });
        g.addEventListener('blur', () => hideTooltip());
        row.append(g);
        this.svgEl = root;
        this.drawCell(g);
      }
      root.append(row);
    });
    // Arrow keys move focus across the grid (one tab stop for the whole heatmap).
    root.addEventListener('keydown', e => {
      const active = (e.target as Element).closest?.('[data-key]');
      if (!active) return;
      const index = this.order.indexOf(active.getAttribute('data-key') ?? '');
      if (index === -1) return;
      const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? cols : e.key === 'ArrowUp' ? -cols : 0;
      if (!delta) return;
      const next = this.order[index + delta];
      if (next === undefined) return;
      e.preventDefault();
      const target = root.querySelector<SVGGElement>(`[data-key="${next}"]`);
      if (target) { root.querySelectorAll('[data-key]').forEach(n => n.setAttribute('tabindex', '-1')); target.setAttribute('tabindex', '0'); target.focus(); }
    });
    root.append(svg('g', { class: 'totals' }));
    this.svgEl = root;
    this.drawTotals();
    this.el.replaceChildren(root);
    if (restoreFocus && this.focusKey) root.querySelector<SVGGElement>(`[data-key="${this.focusKey}"]`)?.focus({ preventScroll: true });
  }

  /** Column totals: liability per window against the column limit. */
  private drawTotals(): void {
    const m = this.model; const root = this.svgEl;
    if (!m || !root) return;
    const host = root.querySelector('g.totals');
    if (!host) return;
    const gridH = m.bands.length * (CELL_H + GAP) - GAP;
    const totalsY = HEAD_H + gridH + 10;
    const parts: SVGElement[] = [svg('text', { x: LABEL_W - 10, y: totalsY + 14, 'text-anchor': 'end' }, 'column total')];
    m.columns.forEach((col, ci) => {
      const x = LABEL_W + ci * (this.cellW + GAP);
      const g = svg('g', { role: 'img', 'aria-label': `Column ${formatTime(col.start)}: ${formatOpen(col.liabilityCenti)}${col.share === null ? '' : `, ${formatPct(col.share, 0)} of column limit`}, ${formatInt(col.legs)} legs` });
      g.append(svg('text', { class: 'value-label', x: x + this.cellW / 2, y: totalsY + 14, 'text-anchor': 'middle' }, col.share === null ? formatOpen(col.liabilityCenti, { unit: false }) : shareLabel(col.share)));
      const trackY = totalsY + 24;
      g.append(svg('rect', { x: x + 6, y: trackY, width: this.cellW - 12, height: 6, rx: 3, fill: token('track') }));
      const share = Math.min(1, col.share ?? 0);
      if (share > 0) g.append(svg('rect', { x: x + 6, y: trackY, width: Math.max(3, (this.cellW - 12) * share), height: 6, rx: 3, fill: token(share > NEAR_LIMIT ? 'critical' : share > 0.75 ? 'warning' : 'accent') }));
      g.append(svg('text', { x: x + this.cellW / 2, y: trackY + 20, 'text-anchor': 'middle' }, `${formatInt(col.legs)} legs`));
      parts.push(g);
    });
    host.replaceChildren(...parts);
  }
}
