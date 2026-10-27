import { describe, expect, it } from 'vitest';
import { createShortcutHandler, PAGES, type KeyInput } from './keys.js';

const key = (k: string, extra: Partial<KeyInput> = {}): KeyInput => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, editable: false, ...extra });

describe('shortcut handler', () => {
  it('maps g + o/r/e/p/c/d/t/a to every page', () => {
    let t = 0;
    const handler = createShortcutHandler(() => t);
    for (const page of PAGES) {
      expect(handler.handle(key('g'))).toBeNull();
      expect(handler.pending).toBe(true);
      t += 200;
      expect(handler.handle(key(page.key))).toEqual({ type: 'navigate', page: page.id });
      expect(handler.pending).toBe(false);
    }
    expect(PAGES.map(p => p.key).join('')).toBe('orepcdta');
  });

  it('expires the chord after the timeout', () => {
    let t = 0;
    const handler = createShortcutHandler(() => t, 1500);
    handler.handle(key('g'));
    t = 1501;
    expect(handler.pending).toBe(false);
    expect(handler.handle(key('o'))).toBeNull();
  });

  it('handles / and ? and ignores keys while typing or with modifiers', () => {
    const handler = createShortcutHandler(() => 0);
    expect(handler.handle(key('/'))).toEqual({ type: 'focus-search' });
    expect(handler.handle(key('?'))).toEqual({ type: 'help' });
    expect(handler.handle(key('/', { editable: true }))).toBeNull();
    expect(handler.handle(key('g', { editable: true }))).toBeNull();
    expect(handler.handle(key('o'))).toBeNull();
    handler.handle(key('g'));
    expect(handler.handle(key('o', { ctrlKey: true }))).toBeNull();
    expect(handler.handle(key('o'))).toBeNull();
  });

  it('accepts upper-case second keys, restarts on g g, and drops unknown keys', () => {
    const handler = createShortcutHandler(() => 0);
    handler.handle(key('g'));
    expect(handler.handle(key('P'))).toEqual({ type: 'navigate', page: 'players' });
    handler.handle(key('g'));
    handler.handle(key('g'));
    expect(handler.handle(key('a'))).toEqual({ type: 'navigate', page: 'audit' });
    handler.handle(key('g'));
    expect(handler.handle(key('x'))).toBeNull();
    expect(handler.handle(key('o'))).toBeNull();
  });
});
