/**
 * uPlot time-series card body: one series per chart (small multiples share a
 * cursor sync key instead of a second y-axis), 2 px line + 10 % wash,
 * hairline grid, UTC time axis, crosshair tooltip whose values come from the
 * exact source strings (never from the float projection used for plotting).
 */
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { formatDateTime, formatTime } from '../format.js';
import { onThemeChange, token, withAlpha } from './theme.js';
import { hideTooltip, showTooltip } from './tooltip.js';

export interface TimeSeriesData {
  readonly t: readonly number[];
  /** Plot coordinates (display projection only). */
  readonly values: readonly (number | null)[];
  /** Exact label for the point at an index (e.g. formatOpen of the Centi string). */
  readonly label: (index: number) => string;
}

export interface TimeChartOptions {
  readonly name: string;
  readonly height: number;
  readonly syncKey?: string;
  readonly colorToken?: string;
  readonly yFormat: (value: number) => string;
  /** Include zero in the y range (magnitudes); off for levels like equity. */
  readonly zeroBased?: boolean;
}

const UTC = (ts: number) => uPlot.tzDate(new Date(ts), 'Etc/UTC');

export class TimeChart {
  private plot: uPlot | null = null;
  private data: TimeSeriesData = { t: [], values: [], label: () => '' };
  private readonly resizeObserver: ResizeObserver;
  private readonly offTheme: () => void;
  private width = 0;

  constructor(private readonly host: HTMLElement, private readonly options: TimeChartOptions) {
    this.resizeObserver = new ResizeObserver(() => {
      const width = Math.floor(this.host.clientWidth);
      if (width > 0 && width !== this.width) { this.width = width; this.plot ? this.plot.setSize({ width, height: this.options.height }) : this.build(); }
    });
    this.resizeObserver.observe(host);
    this.offTheme = onThemeChange(() => this.build());
    host.style.minHeight = `${options.height}px`;
  }

  setData(data: TimeSeriesData): void {
    this.data = data;
    if (!this.plot) { this.build(); return; }
    this.plot.setData([data.t as number[], data.values as (number | null)[]]);
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.offTheme();
    this.plot?.destroy();
    this.plot = null;
  }

  private build(): void {
    const width = Math.floor(this.host.clientWidth);
    if (width <= 0) return;
    this.width = width;
    this.plot?.destroy();
    const color = token(this.options.colorToken ?? 'series-1');
    const ink3 = token('ink-3');
    const grid = token('grid');
    const surface = token('surface');
    const font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    const yFormat = this.options.yFormat;
    const opts: uPlot.Options = {
      width, height: this.options.height, ms: 1, tzDate: UTC, pxAlign: true,
      padding: [8, 22, 0, 0],
      legend: { show: false },
      scales: { x: { time: true }, y: { range: (_u, min, max) => this.range(min, max) } },
      axes: [
        { stroke: ink3, font, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1, size: 4 }, space: 70, values: (u, splits) => { const span = (u.scales['x']?.max ?? 0) - (u.scales['x']?.min ?? 0); return splits.map(ts => { const d = new Date(ts); if (span < 900_000) return formatTime(ts); return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 ? `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` : formatTime(ts).slice(0, 5); }); } },
        { stroke: ink3, font, grid: { stroke: grid, width: 1 }, ticks: { show: false }, size: 64, space: 32, values: (_u, splits) => splits.map(v => yFormat(v)) },
      ],
      series: [
        {},
        { label: this.options.name, stroke: color, width: 2, fill: withAlpha(color, 0.1), points: { show: false }, spanGaps: false },
      ],
      cursor: {
        ...(this.options.syncKey ? { sync: { key: this.options.syncKey } } : {}),
        drag: { x: false, y: false, setScale: false },
        points: { size: 8, width: 2, stroke: surface, fill: color },
        y: false,
      },
      hooks: {
        setCursor: [u => this.tooltip(u)],
      },
    };
    this.plot = new uPlot(opts, [this.data.t as number[], this.data.values as (number | null)[]], this.host);
    this.plot.over.addEventListener('mouseleave', () => hideTooltip());
  }

  private range(min: number | null, max: number | null): [number, number] {
    let lo = min ?? 0; let hi = max ?? 1;
    if (this.options.zeroBased) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
    if (lo === hi) { const pad = Math.abs(lo) * 0.05 || 1; return [lo - pad, hi + pad]; }
    const pad = (hi - lo) * 0.08;
    return [this.options.zeroBased && lo === 0 ? 0 : lo - pad, hi + pad];
  }

  private tooltip(u: uPlot): void {
    const idx = u.cursor.idx;
    const over = u.over.getBoundingClientRect();
    // Synced charts move their cursor too; only the chart under the pointer shows a tooltip.
    if (idx === null || idx === undefined || u.cursor.left === undefined || u.cursor.left < 0 || !this.host.matches(':hover')) { if (!document.querySelector('.uplot:hover')) hideTooltip(); return; }
    const t = this.data.t[idx];
    if (t === undefined) { hideTooltip(); return; }
    showTooltip(over.left + (u.cursor.left ?? 0), over.top + (u.cursor.top ?? 0), formatDateTime(t), [
      { value: this.data.label(idx), name: this.options.name, color: token(this.options.colorToken ?? 'series-1') },
    ]);
  }
}
