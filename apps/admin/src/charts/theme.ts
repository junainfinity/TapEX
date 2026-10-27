/** Chart colors come from the CSS tokens so light/dark stay in one place. */

export function token(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  return value || '#888888';
}

/** "#rrggbb" + alpha → rgba() string (used for the 10 % area wash). */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  return `rgba(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)}, ${alpha})`;
}

/** Relative luminance, to choose ink or white for labels set inside a colored fill. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return 1;
  const channel = (h: string) => { const c = parseInt(h, 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(m[1]!) + 0.7152 * channel(m[2]!) + 0.0722 * channel(m[3]!);
}

export function inkOn(fillHex: string): string {
  return luminance(fillHex) > 0.33 ? '#0b0b0b' : '#ffffff';
}

type Listener = () => void;
const listeners = new Set<Listener>();

/** Charts that bake colors into canvas/SVG re-render when the theme flips. */
export function onThemeChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyThemeChange(): void {
  for (const l of listeners) l();
}

if (typeof matchMedia === 'function') {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => notifyThemeChange());
}
