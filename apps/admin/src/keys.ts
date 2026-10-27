/** Page registry and the keyboard shortcut state machine (pure, unit-tested). */

export type PageId = 'overview' | 'odds' | 'exposure' | 'players' | 'controls' | 'defenses' | 'treasury' | 'audit';

export interface PageMeta {
  readonly id: PageId;
  readonly title: string;
  /** Second key of the `g <key>` chord. */
  readonly key: string;
  readonly hasSearch: boolean;
}

export const PAGES: readonly PageMeta[] = Object.freeze([
  { id: 'overview', title: 'Overview', key: 'o', hasSearch: false },
  { id: 'odds', title: 'Odds & RTP', key: 'r', hasSearch: false },
  { id: 'exposure', title: 'Exposure', key: 'e', hasSearch: false },
  { id: 'players', title: 'Players', key: 'p', hasSearch: true },
  { id: 'controls', title: 'Controls', key: 'c', hasSearch: false },
  { id: 'defenses', title: 'Defenses', key: 'd', hasSearch: false },
  { id: 'treasury', title: 'Treasury & chain', key: 't', hasSearch: false },
  { id: 'audit', title: 'Audit log', key: 'a', hasSearch: true },
]);

export function isPageId(value: string): value is PageId {
  return PAGES.some(p => p.id === value);
}

export type ShortcutAction =
  | { readonly type: 'navigate'; readonly page: PageId }
  | { readonly type: 'focus-search' }
  | { readonly type: 'help' };

export interface KeyInput {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  /** true when focus is in an input, textarea, select or contenteditable. */
  readonly editable: boolean;
}

export interface ShortcutHandler {
  handle(input: KeyInput): ShortcutAction | null;
  /** true while waiting for the second key of a `g` chord (shown as a hint). */
  readonly pending: boolean;
}

export const CHORD_TIMEOUT_MS = 1_500;

export function createShortcutHandler(now: () => number = () => Date.now(), chordMs = CHORD_TIMEOUT_MS): ShortcutHandler {
  let chordAt: number | null = null;
  return {
    get pending() { return chordAt !== null && now() - chordAt <= chordMs; },
    handle(input) {
      if (input.ctrlKey || input.metaKey || input.altKey || input.editable) { chordAt = null; return null; }
      const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
      if (chordAt !== null) {
        const fresh = now() - chordAt <= chordMs;
        chordAt = null;
        if (fresh) {
          const page = PAGES.find(p => p.key === key);
          if (page) return { type: 'navigate', page: page.id };
          if (key !== 'g') return null;
        }
      }
      if (key === 'g') { chordAt = now(); return null; }
      if (input.key === '/') return { type: 'focus-search' };
      if (input.key === '?') return { type: 'help' };
      return null;
    },
  };
}
