/** Exact OPEN amounts: Centi (0.01 OPEN) in the game, wei (1e-18) on chain. Never floats. */
export const CENTI_WEI = 10n ** 16n;

/** Parse a player-typed OPEN amount ("12", "12.5", "1,000.25") into Centi; at most 2 decimals so no dust is left. */
export function parseOpenAmount(text: string): { ok: true; centi: string } | { ok: false; error: string } {
  const clean = text.trim().replace(/,/g, '');
  if (!clean) return { ok: false, error: 'Enter an amount.' };
  const m = /^(\d{1,15})(?:\.(\d{0,2}))?$/.exec(clean);
  if (!m) return { ok: false, error: /^\d*\.\d{3,}$/.test(clean) ? 'Use at most two decimals (0.01 OPEN).' : 'Enter a positive number of OPEN, e.g. 25 or 12.50.' };
  const centi = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  if (centi <= 0n) return { ok: false, error: 'The amount must be above zero.' };
  return { ok: true, centi: centi.toString() };
}

export const centiToWei = (centi: string | bigint): bigint => BigInt(centi) * CENTI_WEI;
/** Wei → whole Centi (floor); the remainder is dust the vault keeps accounted. */
export const weiToCentiFloor = (wei: bigint): string => (wei / CENTI_WEI).toString();
