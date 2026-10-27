/**
 * Hand-built SVG charts: grouped RTP bars with a target band, the diverging
 * calibration-drift bars, and a reliability plot. Marks follow the dataviz
 * spec: ≤ 24 px bars with 4 px rounded data-ends square at the baseline,
 * hairline solid grid, text in text tokens, per-mark hover + focus tooltips.
 */
import { formatInt, formatPct } from '../format.js';
import { svg, type StatusKind } from '../ui/dom.js';
import { token } from './theme.js';
import { hideTooltip, showTooltip, showTooltipFor, type TooltipRow } from './tooltip.js';

/** Vertical bar path with rounded top corners only. */
export function roundedTopBar(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0 || w <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** Horizontal bar from a center baseline; rounded at the data end only. */
export function roundedEndBarH(x0: number, x1: number, y: number, h: number, r = 4): string {
  const w = Math.abs(x1 - x0);
  if (w <= 0 || h <= 0) return '';
  const rr = Math.min(r, h / 2, w);
  if (x1 >= x0) return `M${x0},${y}H${x1 - rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 - rr},${y + h}H${x0}Z`;
  return `M${x0},${y}H${x1 + rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 + rr},${y + h}H${x0}Z`;
}

function bindTooltip(el: SVGElement, title: string, rows: () => readonly TooltipRow[]): void {
  el.addEventListener('pointermove', e => showTooltip(e.clientX, e.clientY, title, rows()));
  el.addEventListener('pointerleave', () => hideTooltip());
  el.addEventListener('focus', () => showTooltipFor(el, title, rows()));
  el.addEventListener('blur', () => hideTooltip());
}

function niceMax(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

export interface RtpBarDatum {
  readonly series: 0 | 1;
  readonly seriesName: string;
  readonly realized: number | null;
  /** null: no bets in this range/phase, so no target to draw. */
  readonly expected: number | null;
  readonly low: number | null;
  readonly high: number | null;
  readonly bets: number;
}

export interface RtpBarGroup {
  readonly key: string;
  readonly label: string;
  readonly bars: readonly RtpBarDatum[];
}

const SERIES_TOKENS = ['series-1', 'series-2'] as const;

export function rtpBarChart(groups: readonly RtpBarGroup[], width: number, height = 280): SVGSVGElement {
  const margin = { top: 22, right: 8, bottom: 30, left: 44 };
  const plotW = Math.max(100, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;
  let maxValue = 1.1;
  for (const g of groups) for (const b of g.bars) maxValue = Math.max(maxValue, b.realized ?? 0, b.high ?? 0);
  const yMax = niceMax(maxValue * 1.04, 0.25);
  const y = (v: number) => margin.top + plotH - (Math.max(0, v) / yMax) * plotH;
  const root = svg('svg', { class: 'viz', width, height, viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': 'Realized versus target RTP by multiplier range and phase' });
  for (let tick = 0; tick <= yMax + 1e-9; tick += 0.25) {
    const ty = y(tick);
    root.append(svg('line', { class: tick === 0 ? 'base-line' : 'grid-line', x1: margin.left, x2: margin.left + plotW, y1: ty, y2: ty }));
    root.append(svg('text', { x: margin.left - 6, y: ty + 4, 'text-anchor': 'end' }, `${Math.round(tick * 100)}%`));
  }
  const groupW = plotW / Math.max(1, groups.length);
  const seriesCount = Math.max(1, ...groups.map(g => g.bars.length));
  const gap = 10;
  const barW = Math.max(6, Math.min(24, (groupW - 28 - gap * (seriesCount - 1)) / seriesCount));
  const surface = token('surface');
  groups.forEach((group, gi) => {
    const clusterW = seriesCount * barW + (seriesCount - 1) * gap;
    const x0 = margin.left + gi * groupW + (groupW - clusterW) / 2;
    group.bars.forEach(bar => {
      const bx = x0 + bar.series * (barW + gap);
      const mark = svg('g', { class: 'mark', tabindex: 0, role: 'img', 'aria-label': bar.expected === null ? `${group.label}, ${bar.seriesName}: no bets yet, no target` : `${group.label}, ${bar.seriesName}: realized ${formatPct(bar.realized)}, target ${formatPct(bar.expected)}, ${formatInt(bar.bets)} bets` });
      if (bar.low !== null && bar.high !== null) {
        const top = y(bar.high); const bottom = y(Math.max(0, bar.low));
        mark.append(svg('rect', { x: bx - 4, y: top, width: barW + 8, height: Math.max(1, bottom - top), fill: token('ink'), 'fill-opacity': 0.09, rx: 2 }));
      }
      if (bar.realized !== null) {
        const top = y(bar.realized);
        mark.append(svg('path', { d: roundedTopBar(bx, top, barW, margin.top + plotH - top), fill: token(SERIES_TOKENS[bar.series]) }));
        const labelY = Math.min(top, bar.high !== null ? y(bar.high) : top) - 5;
        mark.append(svg('text', { class: 'value-label', x: bx + barW / 2, y: labelY, 'text-anchor': 'middle', style: `paint-order: stroke; stroke: ${surface}; stroke-width: 3px;` }, formatPct(bar.realized, 1)));
      }
      if (bar.expected !== null) {
        const ey = y(bar.expected);
        mark.append(svg('line', { x1: bx - 4, x2: bx + barW + 4, y1: ey, y2: ey, stroke: token('ink'), 'stroke-width': 2 }));
      } else {
        mark.append(svg('text', { x: bx + barW / 2, y: margin.top + plotH - 6, 'text-anchor': 'middle' }, 'no bets'));
      }
      mark.append(svg('rect', { class: 'mark-outline', x: bx - 5, y: margin.top, width: barW + 10, height: plotH, rx: 3 }));
      mark.append(svg('rect', { class: 'hit', x: bx - gap / 2, y: margin.top, width: barW + gap, height: plotH }));
      bindTooltip(mark, `${group.label} · ${bar.seriesName}`, () => [
        { value: formatPct(bar.realized), name: 'realized RTP', color: token(SERIES_TOKENS[bar.series]) },
        { value: bar.expected === null ? 'no bets' : formatPct(bar.expected), name: 'target (expected)' },
        { value: bar.low !== null && bar.high !== null ? `${formatPct(bar.low, 1)} – ${formatPct(bar.high, 1)}` : '—', name: 'target band' },
        { value: formatInt(bar.bets), name: 'bets' },
      ]);
      root.append(mark);
    });
    root.append(svg('text', { x: margin.left + gi * groupW + groupW / 2, y: height - 10, 'text-anchor': 'middle' }, group.label));
  });
  return root;
}

export interface DriftRow {
  readonly label: string;
  readonly z: number | null;
  readonly realized: number | null;
  readonly expected: number | null;
  readonly bets: number;
  readonly level: StatusKind;
}

export function driftChart(rows: readonly DriftRow[], width: number): SVGSVGElement {
  const rowH = 28;
  const margin = { top: 20, right: 130, bottom: 22, left: 150 };
  const height = margin.top + margin.bottom + rows.length * rowH;
  const plotW = Math.max(120, width - margin.left - margin.right);
  const zMax = Math.max(4, Math.ceil(Math.max(0, ...rows.map(r => Math.abs(r.z ?? 0)))));
  const clampZ = Math.min(zMax, 6);
  const x = (z: number) => margin.left + ((Math.max(-clampZ, Math.min(clampZ, z)) + clampZ) / (2 * clampZ)) * plotW;
  const root = svg('svg', { class: 'viz', width, height, viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': 'Calibration drift in standard errors by multiplier range and phase' });
  for (let z = -clampZ; z <= clampZ; z += 2) {
    root.append(svg('line', { class: z === 0 ? 'base-line' : 'grid-line', x1: x(z), x2: x(z), y1: margin.top - 4, y2: height - margin.bottom }));
    root.append(svg('text', { x: x(z), y: height - 6, 'text-anchor': 'middle' }, z === 0 ? '0' : `${z > 0 ? '+' : '−'}${Math.abs(z)} SE`));
  }
  root.append(svg('text', { x: x(-clampZ), y: 12, 'text-anchor': 'start' }, '← house favoured'));
  root.append(svg('text', { x: x(clampZ), y: 12, 'text-anchor': 'end' }, 'players favoured →'));
  rows.forEach((row, i) => {
    const top = margin.top + i * rowH;
    const mark = svg('g', { class: 'mark', tabindex: 0, role: 'img', 'aria-label': `${row.label}: drift ${row.z === null ? 'not enough data' : `${row.z.toFixed(1)} standard errors`}` });
    mark.append(svg('text', { x: margin.left - 8, y: top + rowH / 2 + 4, 'text-anchor': 'end' }, row.label));
    if (row.z !== null) {
      const d = roundedEndBarH(x(0), x(row.z), top + 6, rowH - 12);
      if (d) mark.append(svg('path', { d, fill: token(row.z >= 0 ? 'diverge-pos' : 'diverge-neg') }));
      mark.append(svg('text', { class: 'value-label', x: width - margin.right + 8, y: top + rowH / 2 + 4 }, `${row.z >= 0 ? '+' : '−'}${Math.abs(row.z).toFixed(1)} SE`));
      if (row.level === 'warning' || row.level === 'critical') {
        // Status is icon + word in a status ink, never color alone.
        mark.append(svg('text', { x: width - margin.right + 64, y: top + rowH / 2 + 4, style: `fill: ${token(row.level === 'critical' ? 'critical-ink' : 'warning-ink')}; font-weight: 600` }, row.level === 'critical' ? '■ drift' : '▲ watch'));
      }
    } else {
      mark.append(svg('text', { x: width - margin.right + 8, y: top + rowH / 2 + 4 }, 'n/a'));
    }
    mark.append(svg('rect', { class: 'mark-outline', x: margin.left - 2, y: top + 2, width: plotW + 4, height: rowH - 4, rx: 3 }));
    mark.append(svg('rect', { class: 'hit', x: 0, y: top, width, height: rowH }));
    bindTooltip(mark, row.label, () => [
      { value: row.z === null ? 'n/a' : `${row.z >= 0 ? '+' : '−'}${Math.abs(row.z).toFixed(2)} SE`, name: 'drift' },
      { value: formatPct(row.realized), name: 'realized' },
      { value: row.expected === null ? 'no bets' : formatPct(row.expected), name: 'expected' },
      { value: formatInt(row.bets), name: 'bets' },
    ]);
    root.append(mark);
  });
  return root;
}

export interface ReliabilityPoint { readonly predicted: number; readonly observed: number; readonly n: number }

export function reliabilityChart(points: readonly ReliabilityPoint[], width: number, height = 260): SVGSVGElement {
  const margin = { top: 12, right: 12, bottom: 32, left: 44 };
  const size = Math.min(width - margin.left - margin.right, height - margin.top - margin.bottom, 360);
  const plotW = size; const plotH = size;
  const maxP = Math.min(1, niceMax(Math.max(0.2, ...points.map(p => Math.max(p.predicted, p.observed))) * 1.05, 0.1));
  const x = (p: number) => margin.left + (p / maxP) * plotW;
  const y = (p: number) => margin.top + plotH - (p / maxP) * plotH;
  const root = svg('svg', { class: 'viz', width, height: plotH + margin.top + margin.bottom, viewBox: `0 0 ${width} ${plotH + margin.top + margin.bottom}`, role: 'group', 'aria-label': 'Predicted versus observed touch probability' });
  const step = maxP > 0.5 ? 0.2 : 0.1;
  for (let v = 0; v <= maxP + 1e-9; v += step) {
    root.append(svg('line', { class: v === 0 ? 'base-line' : 'grid-line', x1: margin.left, x2: margin.left + plotW, y1: y(v), y2: y(v) }));
    root.append(svg('line', { class: v === 0 ? 'base-line' : 'grid-line', x1: x(v), x2: x(v), y1: margin.top, y2: margin.top + plotH }));
    root.append(svg('text', { x: margin.left - 6, y: y(v) + 4, 'text-anchor': 'end' }, `${Math.round(v * 100)}%`));
    root.append(svg('text', { x: x(v), y: margin.top + plotH + 14, 'text-anchor': 'middle' }, `${Math.round(v * 100)}%`));
  }
  root.append(svg('line', { x1: x(0), y1: y(0), x2: x(maxP), y2: y(maxP), stroke: token('ink-3'), 'stroke-width': 1 }));
  root.append(svg('text', { x: margin.left + 6, y: margin.top + 10 }, 'observed'));
  root.append(svg('text', { x: margin.left + plotW / 2, y: margin.top + plotH + 28, 'text-anchor': 'middle' }, 'predicted probability'));
  const color = token('series-1'); const surface = token('surface');
  for (const p of points) {
    const mark = svg('g', { class: 'mark', tabindex: 0, role: 'img', 'aria-label': `Predicted ${formatPct(p.predicted, 1)}, observed ${formatPct(p.observed, 1)}, ${formatInt(p.n)} samples` });
    mark.append(svg('circle', { cx: x(p.predicted), cy: y(p.observed), r: 4.5, fill: color, stroke: surface, 'stroke-width': 2 }));
    mark.append(svg('circle', { class: 'mark-outline', cx: x(p.predicted), cy: y(p.observed), r: 7 }));
    mark.append(svg('circle', { class: 'hit', cx: x(p.predicted), cy: y(p.observed), r: 12 }));
    bindTooltip(mark, `Predicted ${formatPct(p.predicted, 1)}`, () => [
      { value: formatPct(p.observed, 1), name: 'observed', color },
      { value: formatInt(p.n), name: 'samples' },
    ]);
    root.append(mark);
  }
  return root;
}
