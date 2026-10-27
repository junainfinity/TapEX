/** Small pure display decisions behind page widgets (kept out of the DOM code so they are unit-tested). */
import { formatOpen } from './money.js';
import type { Centi, PlayerFlag } from './types.js';

/** Actor the server uses for automatic toxicity flags (house-server engine TOXICITY_ACTOR). */
export const TOXICITY_ACTOR = 'toxicity-monitor';

/**
 * House equity tile: the exact figure to the cent. A compact "99.9M" hid a 198 OPEN loss behind a
 * 100,000 OPEN step and flipped between "100M" and "99.9M" on ±1 OPEN; the unit sits in the tile label.
 */
export function equityTileValue(equityCenti: Centi): { readonly value: string; readonly title: string } {
  return { value: formatOpen(equityCenti, { unit: false }), title: formatOpen(equityCenti) };
}

/** Who set the current flag, from the latest `flag` entry of the player's flag history. */
export function flagLabel(flagged: boolean, flags: readonly PlayerFlag[]): string | null {
  if (!flagged) return null;
  const last = [...flags].reverse().find(f => f.action === 'flag');
  if (!last) return 'Flagged';
  return last.actor === TOXICITY_ACTOR ? 'Flagged by toxicity monitor' : `Flagged by ${last.actor}`;
}
