import fs from 'fs';
import path from 'path';
import {
  shouldArmSpacePan, shouldDisarmSpacePan, fitShortcut, wheelAction, exceedsDragSlop,
  DRAG_SLOP, SpacePanKey, FitKey,
} from '../canvasGestures';

const key = (over: Partial<SpacePanKey> = {}): SpacePanKey =>
  ({ key: ' ', code: 'Space', repeat: false, target: null, ...over });

describe('shouldArmSpacePan', () => {
  it('arms on Space over the canvas', () => {
    expect(shouldArmSpacePan(key(), null)).toBe(true);
    // Either identifier alone is enough: `code` is layout-independent, `key` is what jsdom
    // and some remote-desktop stacks actually populate.
    expect(shouldArmSpacePan(key({ key: 'Unidentified' }), null)).toBe(true);
    expect(shouldArmSpacePan(key({ code: '' }), null)).toBe(true);
  });

  it('ignores every other key', () => {
    for (const k of ['a', 'Enter', 'Shift', 'ArrowLeft', '']) {
      expect(shouldArmSpacePan(key({ key: k, code: k }), null)).toBe(false);
    }
  });

  // The one that matters. A focused node has a live terminal taking keystrokes, where Space is
  // a space — arming here would swallow the keypress and pan instead, which from the user's
  // side is a shell that dropped a character.
  it('refuses while a node is focused, however the key is reported', () => {
    expect(shouldArmSpacePan(key(), 'tm-1')).toBe(false);
    expect(shouldArmSpacePan(key({ code: '' }), 'tm-1')).toBe(false);
  });

  it('refuses in an editable target, so a rename box keeps its spaces', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(shouldArmSpacePan(key({ target: { tagName } }), null)).toBe(false);
    }
    expect(shouldArmSpacePan(key({ target: { isContentEditable: true } }), null)).toBe(false);
    // ...but an ordinary element is not editable, or the gesture would never arm at all.
    expect(shouldArmSpacePan(key({ target: { tagName: 'DIV' } }), null)).toBe(true);
  });

  it('refuses auto-repeat', () => {
    expect(shouldArmSpacePan(key({ repeat: true }), null)).toBe(false);
  });
});

/**
 * Release is deliberately NOT the negation of arm.
 *
 * A keyup that arrives while a node happens to have taken focus, or one flagged as a repeat,
 * still means the user let go. Refusing to disarm strands the canvas in hand mode with no key
 * held — a far worse failure than one redundant disarm, and one the user cannot undo except by
 * pressing and releasing Space again.
 */
describe('shouldDisarmSpacePan', () => {
  it('releases on Space by either identifier', () => {
    expect(shouldDisarmSpacePan({ key: ' ', code: 'Space' })).toBe(true);
    expect(shouldDisarmSpacePan({ key: 'Unidentified', code: 'Space' })).toBe(true);
    expect(shouldDisarmSpacePan({ key: ' ', code: '' })).toBe(true);
  });

  it('releases in states where arming would have refused', () => {
    const e = { key: ' ', code: 'Space' };
    expect(shouldArmSpacePan(key({ repeat: true }), 'tm-1')).toBe(false);
    expect(shouldDisarmSpacePan(e)).toBe(true);
  });

  it('ignores other keys', () => {
    expect(shouldDisarmSpacePan({ key: 'a', code: 'KeyA' })).toBe(false);
  });
});

describe('fitShortcut', () => {
  const fit = (over: Partial<FitKey> = {}): FitKey => ({
    key: '!', code: 'Digit1', shiftKey: true,
    ctrlKey: false, altKey: false, metaKey: false, target: null, ...over,
  });

  it('reads Shift+1 as "fit everything" however the key is reported', () => {
    expect(fitShortcut(fit())).toBe('all');
    // US layout reports `!`; AZERTY reports `1` because the digit IS the shifted glyph.
    expect(fitShortcut(fit({ code: '', key: '!' }))).toBe('all');
    expect(fitShortcut(fit({ code: '', key: '1' }))).toBe('all');
    expect(fitShortcut(fit({ code: 'Digit1', key: 'Unidentified' }))).toBe('all');
  });

  it('reads Shift+2 as "fit this group"', () => {
    expect(fitShortcut(fit({ code: 'Digit2', key: '@' }))).toBe('group');
    expect(fitShortcut(fit({ code: '', key: '2' }))).toBe('group');
  });

  it('needs Shift, so a bare digit still reaches whatever wants it', () => {
    expect(fitShortcut(fit({ shiftKey: false, key: '1' }))).toBeNull();
    expect(fitShortcut(fit({ shiftKey: false, code: 'Digit2', key: '2' }))).toBeNull();
  });

  it('refuses any other modifier, so it cannot shadow a real shortcut', () => {
    for (const mod of ['ctrlKey', 'altKey', 'metaKey'] as const) {
      expect(fitShortcut(fit({ [mod]: true }))).toBeNull();
    }
  });

  it('refuses in an editable target, so typing "!" into the search box does not fly', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(fitShortcut(fit({ target: { tagName } }))).toBeNull();
    }
    expect(fitShortcut(fit({ target: { tagName: 'DIV', isContentEditable: true } }))).toBeNull();
  });

  it('ignores every other key', () => {
    for (const k of ['3', 'a', 'Enter', '#', '']) {
      expect(fitShortcut(fit({ key: k, code: k }))).toBeNull();
    }
  });
});

describe('wheelAction', () => {
  const wheel = (over: Partial<{ ctrlKey: boolean; metaKey: boolean }> = {}) =>
    ({ ctrlKey: false, metaKey: false, ...over });

  it('zooms the canvas on a plain wheel', () => {
    expect(wheelAction(wheel(), null)).toBe('zoom');
  });

  it('leaves Ctrl/Cmd+wheel alone, so font zoom keeps working', () => {
    expect(wheelAction(wheel({ ctrlKey: true }), null)).toBe('passthrough');
    expect(wheelAction(wheel({ metaKey: true }), null)).toBe('passthrough');
  });

  it('gives the wheel to an open overlay', () => {
    // The overlay is that terminal at 1:1 and the thing being read, so the wheel is a
    // scrollback scroll. Zooming as well moved the world behind it at the same time.
    expect(wheelAction(wheel(), 'tm-1')).toBe('passthrough');
    expect(wheelAction(wheel({ ctrlKey: true }), 'tm-1')).toBe('passthrough');
  });
});

describe('the canvas wheel does not reach the terminals underneath', () => {
  const SRC = fs.readFileSync(path.resolve(__dirname, '../CanvasViewport.tsx'), 'utf8');

  it('listens in the CAPTURE phase', () => {
    // The terminals are DESCENDANTS of `.canvas-viewport`, so capture is the only phase that
    // runs before them. Bubble-phase — what this shipped as — meant xterm had already
    // forwarded the wheel to the PTY as a mouse escape sequence before the canvas saw it.
    expect(SRC).toMatch(/addEventListener\('wheel',\s*onWheel,\s*\{[^}]*capture:\s*true/);
    // removeEventListener must match, or the listener leaks past unmount.
    expect(SRC).toMatch(/removeEventListener\('wheel',\s*onWheel,\s*\{\s*capture:\s*true/);
  });

  /** The wheel handler's own body. Scoped, because `CanvasViewport` calls `stopPropagation`
   *  in its space-pan pointerdown handler too — a file-wide `toContain` matches that one and
   *  passes with the wheel handler stripped bare. Sliced rather than matched with a regex:
   *  the delimiters here are newlines and braces, which is the worst case for escaping. */
  const wheelStart = SRC.indexOf('const onWheel');
  const wheelBody = SRC.slice(wheelStart, SRC.indexOf('};', wheelStart));

  it('found the wheel handler it is reading', () => {
    // Or every assertion below passes vacuously against an empty string.
    expect(wheelStart).toBeGreaterThan(-1);
    expect(wheelBody).toContain('wheelAction(');
  });

  it('stops the event once it has claimed it', () => {
    // preventDefault alone stops the PAGE scrolling; it does not stop the terminal seeing it,
    // which is the whole bug — a mouse-tracking TUI gets the wheel as a PTY escape sequence.
    expect(wheelBody).toContain('e.preventDefault();');
    expect(wheelBody).toContain('e.stopPropagation();');
  });
});

/**
 * Telling a port CLICK from a port DRAG — Tam's item 4.
 *
 * A press on a connection port means two different things now: drag to an existing node to
 * wire them, or click to create a new terminal already connected. Movement is the only thing
 * that separates them, and both mistakes are silent.
 */
describe('exceedsDragSlop', () => {
  it('treats a still pointer as a click', () => {
    expect(exceedsDragSlop(0, 0)).toBe(false);
  });

  /**
   * A pointer is never perfectly still, and a trackpad tap least of all — the finger rolls a
   * pixel or two on the way down. Without the tolerance every click would be a one-pixel drag
   * that lands on nothing, connects nothing, and swallows the gesture with no feedback at all.
   */
  it('tolerates the wobble in a real click', () => {
    expect(exceedsDragSlop(1, 0)).toBe(false);
    expect(exceedsDragSlop(0, -2)).toBe(false);
    expect(exceedsDragSlop(2, 2)).toBe(false);
  });

  it('calls a deliberate move a drag', () => {
    expect(exceedsDragSlop(0, 40)).toBe(true);
    expect(exceedsDragSlop(-120, 0)).toBe(true);
    expect(exceedsDragSlop(-30, 30)).toBe(true);
  });

  /**
   * RADIAL, not per-axis. A diagonal drag moves less along each axis than along its path, so
   * `|dx| > SLOP || |dy| > SLOP` would need ~1.4× the travel at 45° before it noticed — a
   * threshold that depends on the direction you happen to drag in.
   */
  it('measures distance, not the larger axis', () => {
    const d = DRAG_SLOP * 0.75;                 // under the threshold on either axis alone…
    expect(exceedsDragSlop(d, d)).toBe(true);   // …but past it as a distance
    expect(exceedsDragSlop(DRAG_SLOP, 0)).toBe(false);      // exactly at it is not past it
    expect(exceedsDragSlop(DRAG_SLOP + 0.5, 0)).toBe(true);
  });

  it('is symmetric in every direction', () => {
    for (const [dx, dy] of [[9, 5], [-9, 5], [9, -5], [-9, -5], [5, 9], [-5, -9]]) {
      expect(exceedsDragSlop(dx, dy)).toBe(true);
    }
  });
});
