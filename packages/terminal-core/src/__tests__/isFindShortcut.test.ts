import { isFindShortcut } from '../TerminalEngine';
import { isFindShortcut as fromPackageEntry } from '../index';

/**
 * The find shortcut, at the level of the predicate itself (plan 027 §1.6).
 *
 * `engine.search.test.ts:242-266` already pins the same three cases THROUGH a mounted engine, and
 * that is not a duplicate: those tests prove the engine's container listener still calls this,
 * these prove what it answers. The extraction exists because the canvas overlay is chromeless —
 * the engine wires no listener there — so the overlay binds its own hotkey and must ask the same
 * question. Two copies would be fixed apart, and the macOS branch is the half that rots, because
 * nobody developing on Windows can see it (`two-implementations-one-fix`).
 */
describe('isFindShortcut', () => {
  const ev = (over: Partial<KeyboardEvent> = {}) => ({
    key: 'f', code: 'KeyF', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
    ...over,
  });

  it('fires on Ctrl+F off macOS', () => {
    expect(isFindShortcut(ev({ ctrlKey: true }), false)).toBe(true);
  });

  it('fires on Cmd+F on macOS', () => {
    expect(isFindShortcut(ev({ metaKey: true }), true)).toBe(true);
  });

  /** Ctrl+F on macOS is `forward-char` in every readline-style program; claiming it there would
   *  break cursor movement in the shell for a shortcut macOS spells with Cmd. */
  it('does NOT fire on Ctrl+F on macOS', () => {
    expect(isFindShortcut(ev({ ctrlKey: true }), true)).toBe(false);
  });

  /** ...and the mirror of it: Cmd is not the find modifier off macOS. Without this pair the
   *  `isMac ? metaKey : ctrlKey` choice could be a bare `metaKey || ctrlKey` and still pass. */
  it('does NOT fire on Cmd+F off macOS', () => {
    expect(isFindShortcut(ev({ metaKey: true }), false)).toBe(false);
  });

  it('needs a modifier at all', () => {
    expect(isFindShortcut(ev(), false)).toBe(false);
  });

  /** Shift and Alt are excluded so Ctrl+Shift+F and friends reach the PTY untouched. */
  it('does not fire with Shift or Alt held', () => {
    expect(isFindShortcut(ev({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isFindShortcut(ev({ ctrlKey: true, altKey: true }), false)).toBe(false);
  });

  it('accepts a capital F (Caps Lock, not Shift)', () => {
    expect(isFindShortcut(ev({ key: 'F', ctrlKey: true }), false)).toBe(true);
  });

  /** A non-Latin layout reports some other `key` for the physical F key, so `code` has to be
   *  enough on its own — otherwise search is unreachable on a Cyrillic or Greek keyboard. */
  it('accepts the physical F key when the layout names it something else', () => {
    expect(isFindShortcut(ev({ key: 'а', code: 'KeyF', ctrlKey: true }), false)).toBe(true);
  });

  it('ignores another key entirely', () => {
    expect(isFindShortcut(ev({ key: 'g', code: 'KeyG', ctrlKey: true }), false)).toBe(false);
  });

  /** The renderer imports it from the package entry, not from `TerminalEngine` — an export that
   *  is not re-exported is a second copy waiting to be written. */
  it('is reachable from the package entry point', () => {
    expect(fromPackageEntry).toBe(isFindShortcut);
  });
});
