/**
 * Viewer settings. The admin token lives in sessionStorage only (SPEC §8):
 * it survives reloads of this tab and disappears when the tab closes.
 * Theme and the USD reference price are per-viewer conveniences in localStorage.
 */
import { DEFAULT_REF_PRICE_TEXT, parseRefPrice, type RefPrice } from './money.js';

const TOKEN_KEY = 'maya-admin.token';
const THEME_KEY = 'maya-admin.theme';
const REF_PRICE_KEY = 'maya-admin.refPriceUsd';

function read(storage: () => Storage, key: string): string | null {
  try { return storage().getItem(key); } catch { return null; }
}
function write(storage: () => Storage, key: string, value: string | null): void {
  try { if (value === null) storage().removeItem(key); else storage().setItem(key, value); } catch { /* storage blocked: keep in memory only */ }
}

export interface TokenStore {
  get(): string | null;
  set(token: string): void;
  clear(): void;
}

export function createTokenStore(fixed?: string): TokenStore {
  let memory: string | null = fixed ?? read(() => sessionStorage, TOKEN_KEY);
  return {
    get: () => memory,
    set: token => { memory = token; if (fixed === undefined) write(() => sessionStorage, TOKEN_KEY, token); },
    clear: () => { memory = null; if (fixed === undefined) write(() => sessionStorage, TOKEN_KEY, null); },
  };
}

export type ThemeChoice = 'system' | 'light' | 'dark';

type Listener = () => void;

export class Settings {
  private themeChoice: ThemeChoice;
  private refPriceValue: RefPrice;
  private showUsdValue: boolean;
  private readonly listeners = new Set<Listener>();

  constructor() {
    const theme = read(() => localStorage, THEME_KEY);
    this.themeChoice = theme === 'light' || theme === 'dark' ? theme : 'system';
    const stored = read(() => localStorage, REF_PRICE_KEY);
    this.refPriceValue = (stored && parseRefPrice(stored)) || parseRefPrice(DEFAULT_REF_PRICE_TEXT)!;
    this.showUsdValue = read(() => localStorage, 'maya-admin.showUsd') !== 'false';
  }

  get theme(): ThemeChoice { return this.themeChoice; }
  get refPrice(): RefPrice { return this.refPriceValue; }
  get showUsd(): boolean { return this.showUsdValue; }

  /** Resolved light/dark, following the OS when the choice is "system". */
  get resolvedTheme(): 'light' | 'dark' {
    if (this.themeChoice !== 'system') return this.themeChoice;
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  setTheme(choice: ThemeChoice): void {
    this.themeChoice = choice;
    write(() => localStorage, THEME_KEY, choice === 'system' ? null : choice);
    this.applyTheme();
    this.emit();
  }

  applyTheme(): void {
    const root = document.documentElement;
    if (this.themeChoice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', this.themeChoice);
  }

  /** Returns false (and keeps the old price) when the text is not a valid positive price. */
  setRefPrice(text: string): boolean {
    const parsed = parseRefPrice(text);
    if (!parsed) return false;
    this.refPriceValue = parsed;
    write(() => localStorage, REF_PRICE_KEY, parsed.text);
    this.emit();
    return true;
  }

  setShowUsd(show: boolean): void {
    this.showUsdValue = show;
    write(() => localStorage, 'maya-admin.showUsd', show ? 'true' : 'false');
    this.emit();
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(): void { for (const l of this.listeners) l(); }
}
