import fs from 'fs';
import path from 'path';
import {
  shouldArmSpacePan, shouldDisarmSpacePan, fitShortcut, wheelAction, exceedsDragSlop,
  openOverlayShortcut, leaveTerminalShortcut, panShortcut, PAN_STEP_PX,
  canvasKeyAction, terminalKeyAction,
  DRAG_SLOP, SpacePanKey, CanvasKey,
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

/** A neutral, unmodified keypress. Every rule below starts from this and adds only what it
 *  is actually about, so a test cannot pass because of a modifier it never mentioned. */
const canvasKey = (over: Partial<CanvasKey> = {}): CanvasKey => ({
  key: '', code: '', shiftKey: false,
  ctrlKey: false, altKey: false, metaKey: false, target: null, ...over,
});

describe('fitShortcut', () => {
  const fit = (over: Partial<CanvasKey> = {}): CanvasKey => ({
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

/**
 * `E` enlarges the selected node into the overlay — Tam's item 2.
 *
 * It can only afford to be a bare letter because the caller gates it on the canvas holding the
 * keyboard. Every assertion here is about the other half of that bargain: the moment any
 * modifier is involved, the press belongs to something else.
 */
describe('openOverlayShortcut', () => {
  const e = (over: Partial<CanvasKey> = {}) => canvasKey({ key: 'e', code: 'KeyE', ...over });

  it('fires on a bare E, however the layout reports it', () => {
    expect(openOverlayShortcut(e())).toBe(true);
    expect(openOverlayShortcut(e({ key: 'Unidentified' }))).toBe(true);   // `code` alone
    expect(openOverlayShortcut(e({ code: '' }))).toBe(true);              // `key` alone
    // CapsLock reports the capital with no Shift held. Refusing it would make the shortcut
    // silently stop working for anyone typing in caps.
    expect(openOverlayShortcut(e({ code: '', key: 'E' }))).toBe(true);
  });

  it('refuses every modifier, one at a time', () => {
    for (const mod of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey'] as const) {
      expect({ mod, fires: openOverlayShortcut(e({ [mod]: true })) }).toEqual({ mod, fires: false });
    }
  });

  it('refuses in an editable target, so typing "e" into the search box does not enlarge a node', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(openOverlayShortcut(e({ target: { tagName } }))).toBe(false);
    }
    expect(openOverlayShortcut(e({ target: { tagName: 'DIV', isContentEditable: true } }))).toBe(false);
    // ...but an ordinary element is not editable, or the shortcut would never fire at all.
    expect(openOverlayShortcut(e({ target: { tagName: 'DIV' } }))).toBe(true);
  });

  it('ignores every other key', () => {
    for (const k of ['a', 'r', 'Enter', 'Escape', '3', '']) {
      expect(openOverlayShortcut(canvasKey({ key: k, code: k }))).toBe(false);
    }
  });
});

/**
 * Ctrl/Cmd+Shift+E gives the keyboard back — Tam's items 1 and 2.
 *
 * This is the rule that replaced Esc, so the tests that matter are the two Esc got wrong: it has
 * to fire from INSIDE a terminal, and it must not shadow a key a terminal already owns.
 */
describe('leaveTerminalShortcut', () => {
  const e = (over: Partial<CanvasKey> = {}) =>
    canvasKey({ key: 'E', code: 'KeyE', shiftKey: true, ctrlKey: true, ...over });

  it('fires on Ctrl+Shift+E and on Cmd+Shift+E', () => {
    expect(leaveTerminalShortcut(e())).toBe(true);
    expect(leaveTerminalShortcut(e({ ctrlKey: false, metaKey: true }))).toBe(true);
    // Both accepted on every platform, so no `navigator.platform` sniffing leaks into a rule
    // that is otherwise pure. Win+Shift+E never reaches the page and Ctrl+Shift+E is unbound on
    // macOS, so the union costs nothing.
    expect(leaveTerminalShortcut(e({ metaKey: true }))).toBe(true);
  });

  /**
   * THE test for this rule.
   *
   * xterm's keyboard sink is a real `<textarea>`, so while a terminal holds the keyboard
   * `event.target` IS an editable element — the guard every other rule in this file needs would
   * refuse this shortcut in precisely the state it exists for, and the overlay would have no way
   * out at all now that Esc is handed through.
   */
  it('fires inside a terminal, where the target is xterm\'s own textarea', () => {
    expect(leaveTerminalShortcut(e({ target: { tagName: 'TEXTAREA' } }))).toBe(true);
    expect(leaveTerminalShortcut(e({ target: { tagName: 'DIV', isContentEditable: true } }))).toBe(true);
  });

  it('leaves Ctrl+E alone, because that is readline\'s end-of-line', () => {
    expect(leaveTerminalShortcut(e({ shiftKey: false }))).toBe(false);
  });

  it('needs a Ctrl or Cmd, so a plain Shift+E still types a capital', () => {
    expect(leaveTerminalShortcut(e({ ctrlKey: false }))).toBe(false);
    expect(leaveTerminalShortcut(e({ ctrlKey: false, shiftKey: false }))).toBe(false);
  });

  it('refuses when Alt is also held, so it cannot swallow a different chord', () => {
    expect(leaveTerminalShortcut(e({ altKey: true }))).toBe(false);
  });

  it('ignores every other key', () => {
    for (const k of ['a', 'w', 'Enter', '']) {
      expect(leaveTerminalShortcut(e({ key: k, code: k }))).toBe(false);
    }
  });
});

/**
 * The two E rules must never both answer for one press.
 *
 * They are read by different listeners under opposite gates, so nothing structural stops a
 * modifier being added to one and forgotten in the other — and the symptom would be `E` that
 * opens the overlay and immediately leaves it.
 */
describe('the two E shortcuts are disjoint', () => {
  it('never both fire, over every modifier combination', () => {
    for (const shiftKey of [false, true]) {
      for (const ctrlKey of [false, true]) {
        for (const altKey of [false, true]) {
          for (const metaKey of [false, true]) {
            const k = canvasKey({ key: 'e', code: 'KeyE', shiftKey, ctrlKey, altKey, metaKey });
            const both = openOverlayShortcut(k) && leaveTerminalShortcut(k);
            expect({ shiftKey, ctrlKey, altKey, metaKey, both }).toEqual(
              { shiftKey, ctrlKey, altKey, metaKey, both: false },
            );
          }
        }
      }
    }
  });

  it('found the combinations it is checking — each fires somewhere in that matrix', () => {
    // Or the sweep above passes because neither rule ever fires.
    expect(openOverlayShortcut(canvasKey({ key: 'e', code: 'KeyE' }))).toBe(true);
    expect(leaveTerminalShortcut(canvasKey({ key: 'e', code: 'KeyE', ctrlKey: true, shiftKey: true }))).toBe(true);
  });
});

/** Arrow keys pan the canvas — Tam's item 3. */
describe('panShortcut', () => {
  const arrow = (name: string, over: Partial<CanvasKey> = {}) =>
    canvasKey({ key: name, code: name, ...over });

  /**
   * The direction is the half of this that can be silently wrong: pressing → has to reveal what
   * was off the RIGHT edge, which means the world moves the other way. The rule returns the
   * direction the VIEW moves and `panBy` owns the inversion.
   */
  it('names the direction the view moves', () => {
    expect(panShortcut(arrow('ArrowRight'))).toEqual({ dx: 1, dy: 0 });
    expect(panShortcut(arrow('ArrowLeft'))).toEqual({ dx: -1, dy: 0 });
    expect(panShortcut(arrow('ArrowDown'))).toEqual({ dx: 0, dy: 1 });
    expect(panShortcut(arrow('ArrowUp'))).toEqual({ dx: 0, dy: -1 });
  });

  it('reads either identifier', () => {
    expect(panShortcut(arrow('ArrowUp', { code: '' }))).toEqual({ dx: 0, dy: -1 });
    expect(panShortcut(arrow('ArrowUp', { key: 'Unidentified' }))).toEqual({ dx: 0, dy: -1 });
  });

  /** A UNIT step, so the distance lives entirely in the caller's constant. Folding the step in
   *  here would be applied twice — once by this rule and once by the caller that multiplies. */
  it('returns a unit step along one axis, never a distance', () => {
    for (const name of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      const d = panShortcut(arrow(name))!;
      expect({ name, len: Math.abs(d.dx) + Math.abs(d.dy) }).toEqual({ name, len: 1 });
      expect({ name, diagonal: d.dx !== 0 && d.dy !== 0 }).toEqual({ name, diagonal: false });
    }
    // And the step the caller multiplies by is a real screen distance, not zero.
    expect(PAN_STEP_PX).toBeGreaterThan(0);
  });

  /**
   * Alt+Shift+Arrow is pane resize and plain Alt+Arrow is word movement in the shell — both
   * listed as permanently reserved in `shortcutActions`. Taking a modified arrow here would
   * shadow a binding the rest of the app already owns.
   */
  it('refuses every modifier, one at a time', () => {
    for (const mod of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey'] as const) {
      expect({ mod, dir: panShortcut(arrow('ArrowLeft', { [mod]: true })) })
        .toEqual({ mod, dir: null });
    }
  });

  it('refuses in an editable target, so the caret still moves in the search box', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(panShortcut(arrow('ArrowLeft', { target: { tagName } }))).toBeNull();
    }
    expect(panShortcut(arrow('ArrowLeft', { target: { tagName: 'DIV' } }))).toEqual({ dx: -1, dy: 0 });
  });

  it('ignores every other key', () => {
    for (const k of ['a', 'Enter', 'Home', 'PageDown', '']) {
      expect(panShortcut(canvasKey({ key: k, code: k }))).toBeNull();
    }
  });
});

/**
 * What a key the canvas owns actually DOES.
 *
 * The rules above say "is this that key?"; this says "so what happens?" — the question that used
 * to be answered by an if-chain inside an effect, where nothing could reach it.
 */
describe('canvasKeyAction', () => {
  const SELECTED = true;
  const NOTHING_SELECTED = false;

  it('routes each key to its own action', () => {
    expect(canvasKeyAction(canvasKey({ key: '!', code: 'Digit1', shiftKey: true }), SELECTED))
      .toEqual({ do: 'fit', target: 'all' });
    expect(canvasKeyAction(canvasKey({ key: '@', code: 'Digit2', shiftKey: true }), SELECTED))
      .toEqual({ do: 'fit', target: 'group' });
    expect(canvasKeyAction(canvasKey({ key: 'e', code: 'KeyE' }), SELECTED))
      .toEqual({ do: 'overlay' });
  });

  /**
   * The step is applied HERE, once. If it leaked out to the caller instead, the two things that
   * pan — this and the minimap — would each own a multiplication, and a step applied twice is a
   * canvas that lurches.
   */
  it('returns a pan already measured in screen pixels', () => {
    expect(canvasKeyAction(canvasKey({ key: 'ArrowRight', code: 'ArrowRight' }), SELECTED))
      .toEqual({ do: 'pan', dx: PAN_STEP_PX, dy: 0 });
    expect(canvasKeyAction(canvasKey({ key: 'ArrowUp', code: 'ArrowUp' }), SELECTED))
      .toEqual({ do: 'pan', dx: 0, dy: -PAN_STEP_PX });
  });

  /**
   * `E` with nothing selected resolves to NOTHING, not to an action the caller then declines.
   *
   * The difference is the whole keypress: the caller `preventDefault`s whatever this returns, so
   * an `{ do: 'overlay' }` handed back with no target would swallow the `e` and do nothing with
   * it. Everything else still resolves in that state, or the empty canvas would go dead.
   */
  it('declines E with nothing selected, and only E', () => {
    expect(canvasKeyAction(canvasKey({ key: 'e', code: 'KeyE' }), NOTHING_SELECTED)).toBeNull();
    expect(canvasKeyAction(canvasKey({ key: '!', code: 'Digit1', shiftKey: true }), NOTHING_SELECTED))
      .toEqual({ do: 'fit', target: 'all' });
    expect(canvasKeyAction(canvasKey({ key: 'ArrowLeft', code: 'ArrowLeft' }), NOTHING_SELECTED))
      .toEqual({ do: 'pan', dx: -PAN_STEP_PX, dy: 0 });
  });

  it('says nothing about keys it does not own', () => {
    for (const k of ['a', 'Escape', 'Enter', 'Tab', ' ', '']) {
      expect({ k, action: canvasKeyAction(canvasKey({ key: k, code: k }), SELECTED) })
        .toEqual({ k, action: null });
    }
  });

  /** Ctrl+Shift+E belongs to the OTHER resolver. Answering it here as well would make the same
   *  chord both open and leave, depending only on which listener happened to see it first. */
  it('leaves the exit chord to the other resolver', () => {
    expect(canvasKeyAction(
      canvasKey({ key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true }), SELECTED,
    )).toBeNull();
  });
});

/**
 * What a key pressed inside a focused terminal means — Tam's item 1.
 *
 * Esc used to close the overlay, which quietly made the key unusable in the one place a terminal
 * is shown at full size. vim, less, fzf and every menu in codex want it.
 */
describe('terminalKeyAction', () => {
  const OVERLAY_OPEN = true;
  const NO_OVERLAY = false;
  const esc = () => canvasKey({ key: 'Escape', code: 'Escape' });
  const chord = () => canvasKey({ key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true });

  /** THE regression this round exists to fix. */
  it('hands Escape to the terminal while an overlay is open', () => {
    expect(terminalKeyAction(esc(), OVERLAY_OPEN)).toBe('passthrough');
  });

  /** ...without losing Esc's other job. Closing an overlay deliberately does not blur, so a node
   *  can still be holding the keyboard with nothing enlarged, and there Esc hands it back. */
  it('still releases the keyboard on Escape when nothing is enlarged', () => {
    expect(terminalKeyAction(esc(), NO_OVERLAY)).toBe('release-focus');
  });

  it('leaves on the exit chord, whether or not an overlay is open', () => {
    expect(terminalKeyAction(chord(), OVERLAY_OPEN)).toBe('leave');
    expect(terminalKeyAction(chord(), NO_OVERLAY)).toBe('leave');
  });

  /** From inside xterm's own textarea, which is where it will always be pressed. */
  it('leaves from inside the terminal\'s textarea', () => {
    expect(terminalKeyAction(
      canvasKey({ key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true, target: { tagName: 'TEXTAREA' } }),
      OVERLAY_OPEN,
    )).toBe('leave');
  });

  /**
   * Everything else is a passthrough, and that has to include the keys the canvas owns when it
   * has the keyboard: while a terminal is focused, `e`, an arrow and `!` are all just input.
   */
  it('passes every other key through, including the ones the canvas owns elsewhere', () => {
    for (const k of [
      canvasKey({ key: 'e', code: 'KeyE' }),
      canvasKey({ key: 'ArrowLeft', code: 'ArrowLeft' }),
      canvasKey({ key: '!', code: 'Digit1', shiftKey: true }),
      canvasKey({ key: ' ', code: 'Space' }),
      canvasKey({ key: 'Enter', code: 'Enter' }),
    ]) {
      expect({ key: k.key, action: terminalKeyAction(k, OVERLAY_OPEN) })
        .toEqual({ key: k.key, action: 'passthrough' });
      expect({ key: k.key, action: terminalKeyAction(k, NO_OVERLAY) })
        .toEqual({ key: k.key, action: 'passthrough' });
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
