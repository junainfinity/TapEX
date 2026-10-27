/** Non-money display formatting: counts, ratios, times, addresses. */
import { formatEth, formatOpen, formatWeiOpen, groupThousands, isCenti } from './money.js';

const MINUS = '−';

export function formatInt(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const whole = Math.trunc(value);
  return `${whole < 0 ? MINUS : ''}${groupThousands(String(Math.abs(whole)))}`;
}

/** 0.9712 -> "97.12%". Ratios are not money, so float display is fine here. */
export function formatPct(fraction: number | null | undefined, digits = 2, signed = false): string {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return '—';
  const pct = fraction * 100;
  const rounded = Math.abs(pct).toFixed(digits);
  const isZero = Number(rounded) === 0;
  const sign = pct < 0 && !isZero ? MINUS : signed && pct > 0 && !isZero ? '+' : '';
  return `${sign}${rounded}%`;
}

/** Difference of two fractions in percentage points: 0.05 -> "+5.00 pts". */
export function formatPts(deltaFraction: number | null | undefined, digits = 2): string {
  if (typeof deltaFraction !== 'number' || !Number.isFinite(deltaFraction)) return '—';
  const pts = deltaFraction * 100;
  const rounded = Math.abs(pts).toFixed(digits);
  const isZero = Number(rounded) === 0;
  return `${pts < 0 && !isZero ? MINUS : isZero ? '' : '+'}${rounded} pts`;
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }

/** Server times are rendered in UTC; replay clocks are historical, so local time would mislead. */
export function formatTime(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

export function formatDateTime(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${formatTime(ms)} UTC`;
}

/** Compact age: 850 -> "0.9 s", 75_000 -> "1 m 15 s", 7_200_000 -> "2 h 0 m". */
export function formatAge(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const value = Math.max(0, ms);
  if (value < 10_000) return `${(value / 1000).toFixed(1)} s`;
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${seconds % 60} s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} m`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** "0x1234…abcd"; non-address accounts (e.g. "sim:4821") pass through. */
export function shortAddress(address: string): string {
  const bare = address.startsWith('player:') ? address.slice('player:'.length) : address;
  return /^0x[0-9a-fA-F]{40}$/.test(bare) ? `${bare.slice(0, 6)}…${bare.slice(-4)}` : bare;
}

export function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function isTxHash(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** Explorer links exist only for Base Sepolia (SPEC §8); local anvil has none. */
export function explorerUrl(chainId: number, kind: 'address' | 'tx', value: string): string | null {
  if (chainId !== 84532) return null;
  if (kind === 'address' ? !isEvmAddress(value) : !isTxHash(value)) return null;
  return `https://sepolia.basescan.org/${kind}/${value}`;
}

export function networkLabel(network: string, chainId: number): string {
  if (chainId === 84532) return 'Base Sepolia';
  if (chainId === 31337) return 'Local anvil';
  if (network === 'offline') return 'Offline vault';
  return network || `Chain ${chainId}`;
}

/** Market id ('btc-usd' from the server, 'BTC/USD' accepted) → 'BTC/USD'. */
export function marketLabel(id: string): string {
  const m = /^([a-z0-9]+)[-/]([a-z0-9]+)$/i.exec(id);
  return m ? `${m[1]!.toUpperCase()}/${m[2]!.toUpperCase()}` : id;
}

/** Market id → base asset ('btc-usd' → 'BTC'). */
export function marketShort(id: string): string {
  return marketLabel(id).split('/')[0] ?? id;
}

/** Group the integer part of a decimal price string: "64010.5" -> "64,010.5". */
export function formatPrice(value: string | undefined): string {
  if (value === undefined || !/^-?\d+(\.\d+)?$/.test(value)) return value ?? '—';
  const [whole, fraction] = value.split('.');
  const neg = whole!.startsWith('-');
  const digits = groupThousands(neg ? whole!.slice(1) : whole!);
  return `${neg ? MINUS : ''}${digits}${fraction === undefined ? '' : `.${fraction}`}`;
}

/** Short label for a leg's square: band floor and window (relative to placement when given). */
export function squareLabel(start: number, bandIndex: number, lower?: string, placedMs?: number): string {
  const band = lower !== undefined ? formatPrice(lower.replace(/\.0+$/, '')) : `band #${bandIndex}`;
  const when = placedMs === undefined ? formatTime(start) : `+${Math.max(0, Math.round((start - placedMs) / 1000))} s`;
  return `${band} · ${when}`;
}

/** Stable JSON-ish rendering for audit before/after cells. */
export function formatValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** "Base Sepolia · chain 84532": the network an on-chain action will hit, named in full. */
export function networkLine(network: string, chainId: number): string {
  return `${networkLabel(network, chainId)} · chain ${chainId}`;
}

/** Money-aware label for an object key: "houseEquityCenti" → "houseEquity". */
function moneyKey(key: string): string {
  return key.replace(/(Centi|Wei)$/, '') || key;
}

/**
 * Operator-facing rendering of an audit before/after value or a write ack: keys ending in `Centi` read as
 * exact OPEN, `…Wei` as exact OPEN from wei (ETH for gas balances), so a Centi figure is never mistaken for
 * an OPEN one (100× off). Everything else renders as `formatValue` does; callers keep the raw JSON nearby.
 */
export function formatDisplayValue(value: unknown, key?: string): string {
  if (key !== undefined && typeof value === 'string') {
    if (/Centi$/.test(key) && isCenti(value)) return formatOpen(value);
    if (/Wei$/.test(key) && /^\d{1,78}$/.test(value)) return /eth/i.test(key) ? formatEth(value) : formatWeiOpen(value);
  }
  if (Array.isArray(value)) return `[${value.map(v => formatDisplayValue(v, key)).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return entries.map(([k, v]) => `${moneyKey(k)}: ${v !== null && typeof v === 'object' ? `{ ${formatDisplayValue(v)} }` : formatDisplayValue(v, k)}`).join(' · ');
  }
  return formatValue(value);
}
