/** Stat-tile sparkline: de-emphasis line, accent end dot with a surface ring. Fixed box, no layout shift. */
import { svg } from '../ui/dom.js';

export function sparklinePath(values: readonly (number | null)[], width: number, height: number, pad = 4): { d: string; end: { x: number; y: number } | null } {
  const points = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => typeof p.v === 'number' && Number.isFinite(p.v));
  if (points.length < 2) return { d: '', end: null };
  let min = Infinity; let max = -Infinity;
  for (const p of points) { if (p.v < min) min = p.v; if (p.v > max) max = p.v; }
  const span = max - min || 1;
  const n = values.length - 1 || 1;
  const x = (i: number) => pad + (i / n) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);
  let d = '';
  let pen = false;
  let lastIndex = -2;
  for (const p of points) {
    d += `${pen && p.i === lastIndex + 1 ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`;
    pen = true;
    lastIndex = p.i;
  }
  const last = points[points.length - 1]!;
  return { d, end: { x: x(last.i), y: y(last.v) } };
}

export function sparkline(values: readonly (number | null)[], width = 88, height = 28, label = ''): SVGSVGElement {
  const { d, end } = sparklinePath(values, width, height);
  return svg('svg', { class: 'spark', width, height, viewBox: `0 0 ${width} ${height}`, role: label ? 'img' : null, 'aria-label': label || null, 'aria-hidden': label ? null : 'true' },
    d ? svg('path', { class: 'spark-line', d }) : null,
    end ? svg('circle', { class: 'spark-end', cx: end.x.toFixed(1), cy: end.y.toFixed(1), r: 3.5 }) : null);
}
