import path from 'path';
import {
  shouldArmSpacePan, shouldDisarmSpacePan, fitShortcut, wheelAction, exceedsDragSlop,
  openOverlayShortcut, leaveTerminalShortcut, openTabShortcut, openTabFromOverlayShortcut,
  panShortcut, PAN_STEP_PX,
  stepShortcut, zoomShortcut, deleteShortcut, canvasKeyAction, terminalKeyAction,
  wheelPanDelta, WHEEL_LINE_PX, WHEEL_PAGE_PX,
  DRAG_SLOP, SpacePanKey, CanvasKey, CanvasCombos, WheelContext, WheelScroll,
} from '../canvasGestures';
import { SHORTCUT_ACTIONS, CANVAS_FIXED_SHORTCUTS } from '../../../services/shortcutActions';
import { readSource } from '../../../utils/readSource';

const key = (over: Partial<SpacePanKey> = {}): SpacePanKey =>
  ({ key: ' ', code: 'Space', repeat: false, target: null, ...over });

/**
 * The combos the resolvers are exercised with — taken from the REGISTRY's own defaults, not
 * retyped here.
 *
 * Retyping them would let this suite go on passing against `E`/`T` after somebody changed the
 * shipped defaults, which is the one thing these tests are least able to notice: every assertion
 * below would still be internally consistent and every one of them would be about a key the app
 * no longer uses.
 */
const defaultCombo = (id: string): string => {
  const action = SHORTCUT_ACTIONS.find(a => a.id === id);
  if (!action) throw new Error(`canvasGestures.test: no such shortcut action "${id}"`);
  return action.defaultCombo;
};

const COMBOS: CanvasCombos = {
  enlarge: defaultCombo('canvasEnlargeNode'),
  openTab: defaultCombo('canvasOpenNodeTab'),
  leaveTerminal: defaultCombo('canvasLeaveTerminal'),
  openTabFromOverlay: defaultCombo('canvasOpenNodeTabFromOverlay'),
};

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

  it('fires on its configured bare key', () => {
    expect(openOverlayShortcut(e(), 'E')).toBe(true);
    // CapsLock reports the capital with no Shift held. Refusing it would make the shortcut
    // silently stop working for anyone typing in caps.
    expect(openOverlayShortcut(e({ key: 'E' }), 'E')).toBe(true);
  });

  /**
   * The rule reads `key`, and `code` is now IGNORED — a deliberate reversal of what this rule
   * used to do, not an oversight.
   *
   * The old rule accepted `code === 'KeyE'` as a layout-independent fallback. That fallback
   * became wrong the day the key turned into a setting: the Settings recorder builds its combo
   * from `event.key`, so honouring `code` would fire for a physical key POSITION the user never
   * recorded — on a Dvorak layout, the key that types `.`.
   */
  it('ignores event.code, so a rebind means the key the user actually pressed', () => {
    expect(openOverlayShortcut(canvasKey({ key: 'Unidentified', code: 'KeyE' }), 'E')).toBe(false);
    expect(openOverlayShortcut(canvasKey({ key: 'e', code: '' }), 'E')).toBe(true);
  });

  it('follows a rebind, and stops answering the old key', () => {
    const q = canvasKey({ key: 'q', code: 'KeyQ' });
    expect(openOverlayShortcut(q, 'Q')).toBe(true);
    expect(openOverlayShortcut(e(), 'Q')).toBe(false);
  });

  it('refuses every modifier, one at a time', () => {
    for (const mod of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey'] as const) {
      expect({ mod, fires: openOverlayShortcut(e({ [mod]: true }), 'E') })
        .toEqual({ mod, fires: false });
    }
  });

  it('refuses in an editable target, so typing "e" into the search box does not enlarge a node', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(openOverlayShortcut(e({ target: { tagName } }), 'E')).toBe(false);
    }
    expect(openOverlayShortcut(e({ target: { tagName: 'DIV', isContentEditable: true } }), 'E')).toBe(false);
    // ...but an ordinary element is not editable, or the shortcut would never fire at all.
    expect(openOverlayShortcut(e({ target: { tagName: 'DIV' } }), 'E')).toBe(true);
  });

  it('ignores every other key', () => {
    for (const k of ['a', 'r', 'Enter', 'Escape', '3', '']) {
      expect(openOverlayShortcut(canvasKey({ key: k, code: k }), 'E')).toBe(false);
    }
  });
});

/**
 * `T` leaves the canvas for the selected node's own tab — Tam, 2026-08-21.
 *
 * The same bargain as `E`: a bare letter, affordable only because the caller gates it on the
 * canvas holding the keyboard. The editable refusal carries the extra weight here, because this
 * one navigates AWAY.
 */
describe('openTabShortcut', () => {
  const e = (over: Partial<CanvasKey> = {}) => canvasKey({ key: 't', code: 'KeyT', ...over });

  it('fires on its configured bare key, CapsLock included', () => {
    expect(openTabShortcut(e(), 'T')).toBe(true);
    expect(openTabShortcut(e({ key: 'T' }), 'T')).toBe(true);
  });

  it('refuses every modifier, one at a time', () => {
    for (const mod of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey'] as const) {
      expect({ mod, fires: openTabShortcut(e({ [mod]: true }), 'T') })
        .toEqual({ mod, fires: false });
    }
  });

  /** Typing `t` into the sidebar search must not throw the user into another tab. */
  it('refuses in an editable target', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(openTabShortcut(e({ target: { tagName } }), 'T')).toBe(false);
    }
    expect(openTabShortcut(e({ target: { tagName: 'DIV', isContentEditable: true } }), 'T')).toBe(false);
    expect(openTabShortcut(e({ target: { tagName: 'DIV' } }), 'T')).toBe(true);
  });

  it('follows a rebind', () => {
    expect(openTabShortcut(canvasKey({ key: 'g', code: 'KeyG' }), 'G')).toBe(true);
    expect(openTabShortcut(e(), 'G')).toBe(false);
  });

  it('ignores every other key', () => {
    for (const k of ['a', 'e', 'Enter', 'Escape', '']) {
      expect(openTabShortcut(canvasKey({ key: k, code: k }), 'T')).toBe(false);
    }
  });
});

/**
 * Ctrl+T leaves for the node's own tab from INSIDE the enlarged terminal — Tam, 2026-08-21.
 *
 * Tam's requirement has two halves and this rule is where the second one lives: the chord acts,
 * and a bare `t` must not. The bare-key half is asserted on `terminalKeyAction` below, which is
 * what actually decides that a lone letter is a passthrough.
 */
describe('openTabFromOverlayShortcut', () => {
  const e = (over: Partial<CanvasKey> = {}) =>
    canvasKey({ key: 't', code: 'KeyT', ctrlKey: true, ...over });

  it('fires on Ctrl+T and on Cmd+T', () => {
    expect(openTabFromOverlayShortcut(e(), 'Ctrl+T')).toBe(true);
    expect(openTabFromOverlayShortcut(e({ ctrlKey: false, metaKey: true }), 'Ctrl+T')).toBe(true);
  });

  /** THE test for this rule, and the same one `leaveTerminalShortcut` has: xterm's keyboard sink
   *  is a real `<textarea>`, so an editable guard here would refuse the chord in exactly the
   *  state it exists for. */
  it('fires inside a terminal, where the target is xterm\'s own textarea', () => {
    expect(openTabFromOverlayShortcut(e({ target: { tagName: 'TEXTAREA' } }), 'Ctrl+T')).toBe(true);
    expect(openTabFromOverlayShortcut(e({ target: { tagName: 'DIV', isContentEditable: true } }), 'Ctrl+T')).toBe(true);
  });

  it('needs the Ctrl — a bare t is a letter the shell is owed', () => {
    expect(openTabFromOverlayShortcut(e({ ctrlKey: false }), 'Ctrl+T')).toBe(false);
  });

  it('refuses extra modifiers that would make it a different chord', () => {
    expect(openTabFromOverlayShortcut(e({ shiftKey: true }), 'Ctrl+T')).toBe(false);
    expect(openTabFromOverlayShortcut(e({ altKey: true }), 'Ctrl+T')).toBe(false);
  });

  it('ignores every other key', () => {
    for (const k of ['a', 'e', 'w', '']) {
      expect(openTabFromOverlayShortcut(e({ key: k, code: k }), 'Ctrl+T')).toBe(false);
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
    expect(leaveTerminalShortcut(e(), 'Ctrl+Shift+E')).toBe(true);
    expect(leaveTerminalShortcut(e({ ctrlKey: false, metaKey: true }), 'Ctrl+Shift+E')).toBe(true);
    // Both accepted on every platform, so no `navigator.platform` sniffing leaks into a rule
    // that is otherwise pure. Win+Shift+E never reaches the page and Ctrl+Shift+E is unbound on
    // macOS, so the union costs nothing.
    expect(leaveTerminalShortcut(e({ metaKey: true }), 'Ctrl+Shift+E')).toBe(true);
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
    expect(leaveTerminalShortcut(e({ target: { tagName: 'TEXTAREA' } }), 'Ctrl+Shift+E')).toBe(true);
    expect(leaveTerminalShortcut(e({ target: { tagName: 'DIV', isContentEditable: true } }), 'Ctrl+Shift+E')).toBe(true);
  });

  it('leaves Ctrl+E alone, because that is readline\'s end-of-line', () => {
    expect(leaveTerminalShortcut(e({ shiftKey: false }), 'Ctrl+Shift+E')).toBe(false);
  });

  it('needs a Ctrl or Cmd, so a plain Shift+E still types a capital', () => {
    expect(leaveTerminalShortcut(e({ ctrlKey: false }), 'Ctrl+Shift+E')).toBe(false);
    expect(leaveTerminalShortcut(e({ ctrlKey: false, shiftKey: false }), 'Ctrl+Shift+E')).toBe(false);
  });

  it('refuses when Alt is also held, so it cannot swallow a different chord', () => {
    expect(leaveTerminalShortcut(e({ altKey: true }), 'Ctrl+Shift+E')).toBe(false);
  });

  it('ignores every other key', () => {
    for (const k of ['a', 'w', 'Enter', '']) {
      expect(leaveTerminalShortcut(e({ key: k, code: k }), 'Ctrl+Shift+E')).toBe(false);
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
describe('the four canvas shortcuts are pairwise disjoint', () => {
  // The SHIPPED combos, so this is a claim about the defaults users actually get.
  const DEFAULTS = COMBOS;

  /** Which of the four answer this press, by name. */
  const firing = (k: CanvasKey): string[] => [
    openOverlayShortcut(k, DEFAULTS.enlarge) && 'enlarge',
    openTabShortcut(k, DEFAULTS.openTab) && 'openTab',
    leaveTerminalShortcut(k, DEFAULTS.leaveTerminal) && 'leaveTerminal',
    openTabFromOverlayShortcut(k, DEFAULTS.openTabFromOverlay) && 'openTabFromOverlay',
  ].filter(Boolean) as string[];

  it('never both fire, over every letter and modifier combination', () => {
    for (const key of ['e', 't']) {
      for (const shiftKey of [false, true]) {
        for (const ctrlKey of [false, true]) {
          for (const altKey of [false, true]) {
            for (const metaKey of [false, true]) {
              const k = canvasKey({ key, code: `Key${key.toUpperCase()}`, shiftKey, ctrlKey, altKey, metaKey });
              // At most ONE rule may answer any single press. Reported with the offending names
              // attached, so a failure says which two collided rather than just "2 !== 1".
              const fired = firing(k);
              expect({ key, shiftKey, ctrlKey, altKey, metaKey, tooMany: fired.length > 1 ? fired : false })
                .toEqual({ key, shiftKey, ctrlKey, altKey, metaKey, tooMany: false });
            }
          }
        }
      }
    }
  });

  it('found the combinations it is checking — each of the four fires somewhere in that matrix', () => {
    // Or the sweep above passes because no rule ever fires.
    expect(firing(canvasKey({ key: 'e', code: 'KeyE' }))).toEqual(['enlarge']);
    expect(firing(canvasKey({ key: 't', code: 'KeyT' }))).toEqual(['openTab']);
    expect(firing(canvasKey({ key: 'e', code: 'KeyE', ctrlKey: true, shiftKey: true })))
      .toEqual(['leaveTerminal']);
    expect(firing(canvasKey({ key: 't', code: 'KeyT', ctrlKey: true })))
      .toEqual(['openTabFromOverlay']);
  });
});

/**
 * Everything Settings lists as a fixed canvas key must ACTUALLY be one.
 *
 * `shortcutActions.test.ts` proves the table is reserved and rendered; neither says the keys do
 * anything. A row naming a key the canvas does not handle is the exact failure Tam reported,
 * inverted — he could not find View All because nothing listed it, and a wrong listing is worse
 * than none because it looks authoritative.
 *
 * Driven off `reserve` rather than `display`: `display` is prose for humans ("↑ ↓ ← →", "Hold
 * Space + drag") while `reserve` carries the canonical spellings, which parse.
 */
describe('the fixed canvas keys Settings lists are real', () => {
  // Both flags set, so the rows gated on a selection (fit-group, delete-connection) resolve.
  const ANY_SELECTION = { node: true, edge: true };

  /** A CanvasKey for one canonical combo string. */
  const pressOf = (combo: string): CanvasKey => {
    const parts = combo.split('+').map(p => p.trim()).filter(Boolean);
    const mods = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    let k = '';
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === 'ctrl' || lower === 'control') mods.ctrlKey = true;
      else if (lower === 'alt') mods.altKey = true;
      else if (lower === 'shift') mods.shiftKey = true;
      else k = part;
    }
    if (k === 'Plus') k = '+';
    if (k === 'Space') k = ' ';
    return canvasKey({ key: k, code: k, ...mods });
  };

  it('found the table it is checking', () => {
    expect(CANVAS_FIXED_SHORTCUTS.length).toBeGreaterThan(0);
  });

  /**
   * Every listed spelling resolves to something the canvas does — either a `CanvasAction`, or the
   * hand tool, which is a hold-to-arm gesture rather than a resolved action and so has to be
   * asked separately.
   */
  it('every listed spelling resolves to a real canvas gesture', () => {
    for (const s of CANVAS_FIXED_SHORTCUTS) {
      for (const combo of s.reserve) {
        const press = pressOf(combo);
        const acts = canvasKeyAction(press, ANY_SELECTION, COMBOS) !== null
          || shouldArmSpacePan(
            { key: press.key, code: press.code, repeat: false, target: null },
            null,
          );
        expect({ label: s.label, combo, acts }).toEqual({ label: s.label, combo, acts: true });
      }
    }
  });

  /** And the labels are not lying about WHICH gesture. Spot-checked on the rows whose meaning a
   *  reader would most reasonably assume — including View All, the one Tam went looking for. */
  it('routes the named rows to the action their label claims', () => {
    const at = (label: string) => CANVAS_FIXED_SHORTCUTS.find(s => s.label === label)!;
    const resolve = (combo: string) => canvasKeyAction(pressOf(combo), ANY_SELECTION, COMBOS);

    expect(resolve(at('View All').reserve[0])).toEqual({ do: 'fit', target: 'all' });
    expect(resolve(at('Fit Current Group').reserve[0])).toEqual({ do: 'fit', target: 'group' });
    expect(resolve(at('Reset Zoom').reserve[0])).toEqual({ do: 'zoom', intent: 'reset' });
    expect(resolve(at('Remove Selected Connection').reserve[0])).toEqual({ do: 'delete-edge' });
    expect(resolve(at('Next / Previous Node').reserve[0])).toEqual({ do: 'step', dir: 1 });
    // Both spellings of the Shift+digit row, since neither alone covers every layout.
    for (const combo of at('View All').reserve) {
      expect({ combo, action: resolve(combo) })
        .toEqual({ combo, action: { do: 'fit', target: 'all' } });
    }
  });

  /** The zoom row names two directions; a table that reserved only one would leave the other
   *  bindable while the screen claimed both. */
  it('covers both zoom directions', () => {
    const zoom = CANVAS_FIXED_SHORTCUTS.find(s => s.label === 'Zoom In / Out')!;
    const intents = zoom.reserve.map(c => canvasKeyAction(pressOf(c), ANY_SELECTION, COMBOS));
    expect(intents).toContainEqual({ do: 'zoom', intent: 'in' });
    expect(intents).toContainEqual({ do: 'zoom', intent: 'out' });
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
 * Tab / Shift+Tab walk the terminals — Tam's sixth round.
 *
 * Tab is only available because the caller gates it on the canvas holding the keyboard: inside a
 * terminal, Tab is shell completion and must stay that way.
 */
describe('stepShortcut', () => {
  const tab = (over: Partial<CanvasKey> = {}) => canvasKey({ key: 'Tab', code: 'Tab', ...over });

  it('steps forward on Tab and back on Shift+Tab', () => {
    expect(stepShortcut(tab())).toBe(1);
    expect(stepShortcut(tab({ shiftKey: true }))).toBe(-1);
  });

  it('reads either identifier', () => {
    expect(stepShortcut(tab({ code: '' }))).toBe(1);
    expect(stepShortcut(tab({ key: 'Unidentified' }))).toBe(1);
  });

  /** Ctrl+Tab and Ctrl+Shift+Tab switch APP TABS (`shortcutActions`). Claiming them here would
   *  make one chord mean two things on this surface — and the canvas is itself a tab, so the
   *  gesture the user loses is the one that leaves it. */
  it('refuses Ctrl+Tab, so switching app tabs still works from the canvas', () => {
    expect(stepShortcut(tab({ ctrlKey: true }))).toBeNull();
    expect(stepShortcut(tab({ ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(stepShortcut(tab({ metaKey: true }))).toBeNull();
    expect(stepShortcut(tab({ altKey: true }))).toBeNull();
  });

  it('refuses in an editable target, so Tab still leaves the search box', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(stepShortcut(tab({ target: { tagName } }))).toBeNull();
    }
    expect(stepShortcut(tab({ target: { tagName: 'DIV' } }))).toBe(1);
  });

  it('ignores every other key', () => {
    for (const k of ['a', 'Enter', 'ArrowRight', '']) {
      expect(stepShortcut(canvasKey({ key: k, code: k }))).toBeNull();
    }
  });
});

/**
 * Ctrl/Cmd + `+`/`−`/`0` zoom the canvas — Tam's sixth round.
 *
 * There is no conflict with the terminal's font zoom: the engine binds the same set through
 * xterm's `attachCustomKeyEventHandler`, which only runs while xterm holds DOM focus. The caller
 * gates this on the canvas holding the keyboard, so the two never see the same press.
 */
describe('zoomShortcut', () => {
  const z = (over: Partial<CanvasKey> = {}) =>
    canvasKey({ key: '=', code: 'Equal', ctrlKey: true, ...over });

  it('reads zoom in however the layout and keypad report it', () => {
    expect(zoomShortcut(z())).toBe('in');
    expect(zoomShortcut(z({ key: '+', code: '' }))).toBe('in');
    expect(zoomShortcut(z({ key: 'Unidentified', code: 'NumpadAdd' }))).toBe('in');
    // Ctrl+Shift+= IS Ctrl++ on a US keyboard, which is why Shift is not tested for.
    expect(zoomShortcut(z({ shiftKey: true }))).toBe('in');
  });

  it('reads zoom out and reset', () => {
    expect(zoomShortcut(z({ key: '-', code: 'Minus' }))).toBe('out');
    expect(zoomShortcut(z({ key: '_', code: '' }))).toBe('out');
    expect(zoomShortcut(z({ key: 'Unidentified', code: 'NumpadSubtract' }))).toBe('out');
    expect(zoomShortcut(z({ key: '0', code: 'Digit0' }))).toBe('reset');
    expect(zoomShortcut(z({ key: 'Unidentified', code: 'Numpad0' }))).toBe('reset');
  });

  it('accepts Ctrl or Cmd and needs one of them', () => {
    expect(zoomShortcut(z({ ctrlKey: false, metaKey: true }))).toBe('in');
    // Bare `=` is a character. Taking it would make the canvas eat a key it has no claim on.
    expect(zoomShortcut(z({ ctrlKey: false }))).toBeNull();
  });

  it('refuses when Alt is held, so it cannot swallow a different chord', () => {
    expect(zoomShortcut(z({ altKey: true }))).toBeNull();
  });

  it('refuses in an editable target', () => {
    expect(zoomShortcut(z({ target: { tagName: 'INPUT' } }))).toBeNull();
    expect(zoomShortcut(z({ target: { tagName: 'DIV' } }))).toBe('in');
  });

  it('ignores every other key', () => {
    for (const k of ['a', '1', 'ArrowUp', 'Enter', '']) {
      expect(zoomShortcut(canvasKey({ key: k, code: k, ctrlKey: true }))).toBeNull();
    }
  });

  /**
   * The engine's own handler is the reference, and the two lists must not drift. Read out of
   * the shipped terminal-core bundle rather than restated here — a copy of the list in this
   * file would agree with itself forever.
   */
  it('answers every key the terminal engine answers', () => {
    const engine = readSource(path.resolve(__dirname, '../../../../../node_modules/@termflow/terminal-core/dist/index.js'));
    const handler = engine.slice(
      engine.indexOf('if (event.ctrlKey && event.type === "keydown")'),
    ).slice(0, 1200);
    expect(handler).toContain('handleZoom("in")');          // found the handler it is reading
    for (const [code, want] of [
      ['NumpadAdd', 'in'], ['NumpadSubtract', 'out'], ['Numpad0', 'reset'],
      ['Equal', 'in'], ['Minus', 'out'], ['Digit0', 'reset'],
    ] as const) {
      if (!handler.includes(code)) continue;               // the engine does not bind it either
      expect({ code, got: zoomShortcut(canvasKey({ key: 'Unidentified', code, ctrlKey: true })) })
        .toEqual({ code, got: want });
    }
  });
});

/**
 * What a key the canvas owns actually DOES.
 *
 * The rules above say "is this that key?"; this says "so what happens?" — the question that used
 * to be answered by an if-chain inside an effect, where nothing could reach it.
 */
/**
 * <kbd>Delete</kbd> / <kbd>Backspace</kbd>, the rule on its own.
 *
 * Whether it applies is `canvasKeyAction`'s business; this is only "is this that key?".
 */
describe('deleteShortcut', () => {
  it('accepts both keys, however the layout reports them', () => {
    expect(deleteShortcut(canvasKey({ key: 'Delete', code: 'Delete' }))).toBe(true);
    expect(deleteShortcut(canvasKey({ key: 'Backspace', code: 'Backspace' }))).toBe(true);
    // `code` alone, for stacks that leave `key` unidentified.
    expect(deleteShortcut(canvasKey({ key: 'Unidentified', code: 'Delete' }))).toBe(true);
    // `key` alone, which is what jsdom populates.
    expect(deleteShortcut(canvasKey({ key: 'Backspace', code: '' }))).toBe(true);
  });

  it('refuses every modifier', () => {
    for (const mod of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey'] as const) {
      expect({ mod, got: deleteShortcut(canvasKey({ key: 'Delete', code: 'Delete', [mod]: true })) })
        .toEqual({ mod, got: false });
    }
  });

  /** The sidebar search and the connection-label box both live on this surface. Backspace there
   *  is someone correcting a typo, not deleting their wire. */
  it('leaves an editable target its own key', () => {
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { isContentEditable: true }]) {
      expect(deleteShortcut(canvasKey({ key: 'Backspace', code: 'Backspace', target }))).toBe(false);
    }
  });

  it('is not some other key', () => {
    for (const k of ['d', 'Escape', 'Enter', 'Del', 'ArrowLeft']) {
      expect({ k, got: deleteShortcut(canvasKey({ key: k, code: k })) }).toEqual({ k, got: false });
    }
  });
});

describe('canvasKeyAction', () => {
  const SELECTED = { node: true, edge: false };
  const NOTHING_SELECTED = { node: false, edge: false };
  const EDGE_SELECTED = { node: false, edge: true };

  it('routes each key to its own action', () => {
    expect(canvasKeyAction(canvasKey({ key: '!', code: 'Digit1', shiftKey: true }), SELECTED, COMBOS))
      .toEqual({ do: 'fit', target: 'all' });
    expect(canvasKeyAction(canvasKey({ key: '@', code: 'Digit2', shiftKey: true }), SELECTED, COMBOS))
      .toEqual({ do: 'fit', target: 'group' });
    expect(canvasKeyAction(canvasKey({ key: 'e', code: 'KeyE' }), SELECTED, COMBOS))
      .toEqual({ do: 'overlay' });
    expect(canvasKeyAction(canvasKey({ key: 'Tab', code: 'Tab' }), SELECTED, COMBOS))
      .toEqual({ do: 'step', dir: 1 });
    expect(canvasKeyAction(canvasKey({ key: 'Tab', code: 'Tab', shiftKey: true }), SELECTED, COMBOS))
      .toEqual({ do: 'step', dir: -1 });
    expect(canvasKeyAction(canvasKey({ key: '=', code: 'Equal', ctrlKey: true }), SELECTED, COMBOS))
      .toEqual({ do: 'zoom', intent: 'in' });
    expect(canvasKeyAction(canvasKey({ key: '-', code: 'Minus', ctrlKey: true }), SELECTED, COMBOS))
      .toEqual({ do: 'zoom', intent: 'out' });
  });

  /** Unlike `E`, stepping with nothing selected is meaningful — it enters the list at one end.
   *  Declining it would make Tab do nothing on a canvas you have not clicked yet, which is
   *  exactly when you most want the keyboard. */
  it('steps with nothing selected', () => {
    expect(canvasKeyAction(canvasKey({ key: 'Tab', code: 'Tab' }), NOTHING_SELECTED, COMBOS))
      .toEqual({ do: 'step', dir: 1 });
  });

  /**
   * The step is applied HERE, once. If it leaked out to the caller instead, the two things that
   * pan — this and the minimap — would each own a multiplication, and a step applied twice is a
   * canvas that lurches.
   */
  it('returns a pan already measured in screen pixels', () => {
    expect(canvasKeyAction(canvasKey({ key: 'ArrowRight', code: 'ArrowRight' }), SELECTED, COMBOS))
      .toEqual({ do: 'pan', dx: PAN_STEP_PX, dy: 0 });
    expect(canvasKeyAction(canvasKey({ key: 'ArrowUp', code: 'ArrowUp' }), SELECTED, COMBOS))
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
    expect(canvasKeyAction(canvasKey({ key: 'e', code: 'KeyE' }), NOTHING_SELECTED, COMBOS)).toBeNull();
    expect(canvasKeyAction(canvasKey({ key: '!', code: 'Digit1', shiftKey: true }), NOTHING_SELECTED, COMBOS))
      .toEqual({ do: 'fit', target: 'all' });
    expect(canvasKeyAction(canvasKey({ key: 'ArrowLeft', code: 'ArrowLeft' }), NOTHING_SELECTED, COMBOS))
      .toEqual({ do: 'pan', dx: -PAN_STEP_PX, dy: 0 });
  });

  it('says nothing about keys it does not own', () => {
    for (const k of ['a', 'Escape', 'Enter', ' ', '']) {
      expect({ k, action: canvasKeyAction(canvasKey({ key: k, code: k }), SELECTED, COMBOS) })
        .toEqual({ k, action: null });
    }
  });

  /**
   * Delete removes the selected CONNECTION, and only when there is one.
   *
   * The two halves are one rule: Backspace is a key the rest of the app and the browser both
   * have opinions about, so resolving it to an action with nothing selected would swallow it
   * for a canvas that had nothing to do with it.
   */
  it('removes the selected connection on Delete and on Backspace', () => {
    for (const [key, code] of [['Delete', 'Delete'], ['Backspace', 'Backspace']]) {
      expect({ key, action: canvasKeyAction(canvasKey({ key, code }), EDGE_SELECTED, COMBOS) })
        .toEqual({ key, action: { do: 'delete-edge' } });
    }
  });

  it('leaves Delete alone when no connection is selected', () => {
    for (const sel of [NOTHING_SELECTED, SELECTED]) {
      expect(canvasKeyAction(canvasKey({ key: 'Delete', code: 'Delete' }), sel, COMBOS)).toBeNull();
      expect(canvasKeyAction(canvasKey({ key: 'Backspace', code: 'Backspace' }), sel, COMBOS)).toBeNull();
    }
  });

  /**
   * A selected NODE never resolves to a delete, and a selected WIRE never resolves to an
   * overlay. The two flags are read for different keys — swapping them at a call site is the
   * failure `CanvasSelection` is an object to prevent, and this is what would catch it.
   */
  it('reads the node flag for E and the edge flag for Delete, not the other way round', () => {
    expect(canvasKeyAction(canvasKey({ key: 'e', code: 'KeyE' }), EDGE_SELECTED, COMBOS)).toBeNull();
    expect(canvasKeyAction(canvasKey({ key: 'e', code: 'KeyE' }), SELECTED, COMBOS))
      .toEqual({ do: 'overlay' });
    expect(canvasKeyAction(canvasKey({ key: 'Delete', code: 'Delete' }), SELECTED, COMBOS)).toBeNull();
    expect(canvasKeyAction(canvasKey({ key: 'Delete', code: 'Delete' }), EDGE_SELECTED, COMBOS))
      .toEqual({ do: 'delete-edge' });
  });

  /** Ctrl+Tab switches app tabs and Ctrl+E is readline's end-of-line. Neither may resolve to a
   *  canvas action, or the canvas would shadow a binding the rest of the app owns. */
  it('leaves the app\'s own chords alone', () => {
    for (const k of [
      canvasKey({ key: 'Tab', code: 'Tab', ctrlKey: true }),
      canvasKey({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }),
      canvasKey({ key: 'e', code: 'KeyE', ctrlKey: true }),
    ]) {
      expect(canvasKeyAction(k, SELECTED, COMBOS)).toBeNull();
    }
  });

  /** Ctrl+Shift+E belongs to the OTHER resolver. Answering it here as well would make the same
   *  chord both open and leave, depending only on which listener happened to see it first. */
  it('leaves the exit chord to the other resolver', () => {
    expect(canvasKeyAction(
      canvasKey({ key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true }), SELECTED, COMBOS,
    )).toBeNull();
  });

  /* ---- Open the selected node in its own tab (Tam, 2026-08-21) ---- */

  it('resolves the bare open-tab key to its own action', () => {
    expect(canvasKeyAction(canvasKey({ key: 't', code: 'KeyT' }), SELECTED, COMBOS))
      .toEqual({ do: 'open-tab' });
  });

  /**
   * With nothing selected it resolves to NOTHING, the same shape `E` has and for the sharper
   * version of the same reason: the caller `preventDefault`s whatever comes back, so an
   * `{ do: 'open-tab' }` with no target would swallow the `t` — and if the caller ever stopped
   * checking, would throw the user into a tab they never chose.
   */
  it('declines the open-tab key with nothing selected', () => {
    expect(canvasKeyAction(canvasKey({ key: 't', code: 'KeyT' }), NOTHING_SELECTED, COMBOS)).toBeNull();
    // ...and reads the NODE flag, not the edge flag — the `CanvasSelection` transposition again.
    expect(canvasKeyAction(canvasKey({ key: 't', code: 'KeyT' }), EDGE_SELECTED, COMBOS)).toBeNull();
  });

  /** The overlay chord belongs to the OTHER resolver, exactly as Ctrl+Shift+E does. Answering it
   *  here too would make one chord mean the same thing twice, from whichever listener won. */
  it('leaves the overlay open-tab chord to the other resolver', () => {
    expect(canvasKeyAction(canvasKey({ key: 't', code: 'KeyT', ctrlKey: true }), SELECTED, COMBOS))
      .toBeNull();
  });

  /** A rebind reaches the resolver, not just the rule. */
  it('follows a rebound open-tab key', () => {
    const rebound = { ...COMBOS, openTab: 'G' };
    expect(canvasKeyAction(canvasKey({ key: 'g', code: 'KeyG' }), SELECTED, rebound))
      .toEqual({ do: 'open-tab' });
    expect(canvasKeyAction(canvasKey({ key: 't', code: 'KeyT' }), SELECTED, rebound)).toBeNull();
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
    expect(terminalKeyAction(esc(), OVERLAY_OPEN, COMBOS)).toBe('passthrough');
  });

  /** ...without losing Esc's other job. Closing an overlay deliberately does not blur, so a node
   *  can still be holding the keyboard with nothing enlarged, and there Esc hands it back. */
  it('still releases the keyboard on Escape when nothing is enlarged', () => {
    expect(terminalKeyAction(esc(), NO_OVERLAY, COMBOS)).toBe('release-focus');
  });

  it('leaves on the exit chord, whether or not an overlay is open', () => {
    expect(terminalKeyAction(chord(), OVERLAY_OPEN, COMBOS)).toBe('leave');
    expect(terminalKeyAction(chord(), NO_OVERLAY, COMBOS)).toBe('leave');
  });

  /** From inside xterm's own textarea, which is where it will always be pressed. */
  it('leaves from inside the terminal\'s textarea', () => {
    expect(terminalKeyAction(
      canvasKey({ key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true, target: { tagName: 'TEXTAREA' } }),
      OVERLAY_OPEN, COMBOS,
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
      // The two the sixth round added, and the two that matter most here: inside a terminal Tab
      // is shell completion and Ctrl+= is the FONT zoom, which the engine handles itself.
      canvasKey({ key: 'Tab', code: 'Tab' }),
      canvasKey({ key: 'Tab', code: 'Tab', shiftKey: true }),
      canvasKey({ key: '=', code: 'Equal', ctrlKey: true }),
      canvasKey({ key: '-', code: 'Minus', ctrlKey: true }),
    ]) {
      expect({ key: k.key, action: terminalKeyAction(k, OVERLAY_OPEN, COMBOS) })
        .toEqual({ key: k.key, action: 'passthrough' });
      expect({ key: k.key, action: terminalKeyAction(k, NO_OVERLAY, COMBOS) })
        .toEqual({ key: k.key, action: 'passthrough' });
    }
  });

  /* ---- Open this node's own tab from inside the overlay (Tam, 2026-08-21) ---- */

  it('opens the tab on the overlay chord, whether or not an overlay is open', () => {
    const k = canvasKey({ key: 't', code: 'KeyT', ctrlKey: true });
    expect(terminalKeyAction(k, OVERLAY_OPEN, COMBOS)).toBe('open-tab');
    expect(terminalKeyAction(k, NO_OVERLAY, COMBOS)).toBe('open-tab');
  });

  /** Where it will always be pressed: inside xterm's own textarea. */
  it('opens the tab from inside the terminal\'s textarea', () => {
    expect(terminalKeyAction(
      canvasKey({ key: 't', code: 'KeyT', ctrlKey: true, target: { tagName: 'TEXTAREA' } }),
      OVERLAY_OPEN, COMBOS,
    )).toBe('open-tab');
  });

  /**
   * THE requirement Tam stated, from the inside: *"single key will go to terminal"*.
   *
   * The bare key is the canvas's only while the canvas holds the keyboard. Once a node is being
   * edited it is a letter the shell is owed, and this resolver is what owes it — asserted for
   * both cases and both letters, since `E` has exactly the same contract.
   */
  it('passes the bare open-tab and enlarge keys through to the PTY', () => {
    for (const key of ['t', 'T', 'e', 'E']) {
      const k = canvasKey({ key, code: `Key${key.toUpperCase()}` });
      expect({ key, action: terminalKeyAction(k, OVERLAY_OPEN, COMBOS) })
        .toEqual({ key, action: 'passthrough' });
      expect({ key, action: terminalKeyAction(k, NO_OVERLAY, COMBOS) })
        .toEqual({ key, action: 'passthrough' });
    }
  });

  it('follows a rebound overlay chord', () => {
    const rebound = { ...COMBOS, openTabFromOverlay: 'Ctrl+Shift+G' };
    expect(terminalKeyAction(
      canvasKey({ key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true }), OVERLAY_OPEN, rebound,
    )).toBe('open-tab');
    expect(terminalKeyAction(
      canvasKey({ key: 't', code: 'KeyT', ctrlKey: true }), OVERLAY_OPEN, rebound,
    )).toBe('passthrough');
  });
});

describe('wheelAction', () => {
  const wheel = (over: Partial<{ ctrlKey: boolean; metaKey: boolean }> = {}) =>
    ({ ctrlKey: false, metaKey: false, ...over });
  /** The default mode, with nothing focused and no overlay — what the canvas ships as. */
  const ctx = (over: Partial<WheelContext> = {}): WheelContext =>
    ({ overlayId: null, mode: 'zoom', onFocusedTerminal: false, ...over });

  describe("mode 'zoom' — the default", () => {
    it('zooms the canvas on a plain wheel', () => {
      expect(wheelAction(wheel(), ctx())).toBe('zoom');
    });

    it('leaves Ctrl/Cmd+wheel alone, so font zoom keeps working', () => {
      expect(wheelAction(wheel({ ctrlKey: true }), ctx())).toBe('passthrough');
      expect(wheelAction(wheel({ metaKey: true }), ctx())).toBe('passthrough');
    });

    /**
     * The chord follows the POINTER in this mode, not the keyboard. Every node's engine binds
     * its own wheel-zoom listener to its container, so Ctrl+wheel over an unfocused terminal
     * zooms that terminal — which is the behaviour a pane has, and the reason this mode passes
     * the event through without asking who is focused.
     */
    it('passes the chord through whether or not that terminal is focused', () => {
      expect(wheelAction(wheel({ ctrlKey: true }), ctx({ onFocusedTerminal: true }))).toBe('passthrough');
      expect(wheelAction(wheel({ ctrlKey: true }), ctx({ onFocusedTerminal: false }))).toBe('passthrough');
    });
  });

  /**
   * Tam, 2026-08-17: *"allow ctrl+wheel on canvas do zoom in/out, and let the wheel as the
   * scroll the canvas"* — with the preceding sentence keeping font zoom in the terminal he is
   * editing. Both halves are asserted, because implementing only the first is a mode that
   * works and quietly takes a gesture away.
   */
  describe("mode 'scroll' — the setting", () => {
    const scroll = (over: Partial<WheelContext> = {}) => ctx({ mode: 'scroll', ...over });

    it('scrolls the canvas on a plain wheel', () => {
      expect(wheelAction(wheel(), scroll())).toBe('pan');
    });

    it('zooms the canvas on Ctrl/Cmd+wheel', () => {
      expect(wheelAction(wheel({ ctrlKey: true }), scroll())).toBe('zoom');
      expect(wheelAction(wheel({ metaKey: true }), scroll())).toBe('zoom');
    });

    it('still gives the chord to the terminal that holds the keyboard', () => {
      // The half of his message that is easy to drop: the canvas taking Ctrl+wheel everywhere
      // would leave the terminal you are typing in with no wheel font zoom at all.
      expect(wheelAction(wheel({ ctrlKey: true }), scroll({ onFocusedTerminal: true }))).toBe('passthrough');
      expect(wheelAction(wheel({ metaKey: true }), scroll({ onFocusedTerminal: true }))).toBe('passthrough');
    });

    it('still SCROLLS a plain wheel over that same focused terminal', () => {
      // Only the chord is handed over. A plain wheel is the canvas's in both modes — a terminal
      // in mouse-tracking mode would otherwise forward it to the PTY, which is the bug the
      // `stopPropagation` on the accept path exists for.
      expect(wheelAction(wheel(), scroll({ onFocusedTerminal: true }))).toBe('pan');
    });
  });

  it('gives the wheel to an open overlay, in either mode', () => {
    // The overlay is that terminal at 1:1 and the thing being read, so the wheel is a
    // scrollback scroll. Zooming as well moved the world behind it at the same time.
    for (const mode of ['zoom', 'scroll'] as const) {
      expect(wheelAction(wheel(), ctx({ mode, overlayId: 'tm-1' }))).toBe('passthrough');
      expect(wheelAction(wheel({ ctrlKey: true }), ctx({ mode, overlayId: 'tm-1' }))).toBe('passthrough');
    }
  });
});

/**
 * How far a wheel scrolls the canvas.
 *
 * Every assertion here is a sign or a unit, which is exactly the kind of mistake that survives
 * review: a scroll that pans the wrong way looks like a working control someone got backwards,
 * and a `deltaMode` left unconverted looks like a control that barely moves.
 */
describe('wheelPanDelta', () => {
  const w = (over: Partial<WheelScroll> = {}): WheelScroll =>
    ({ deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ...over });

  it('passes pixel deltas straight through, sign included', () => {
    // A wheel DOWN (positive deltaY) shows what was BELOW — the view moves down, which is a
    // positive `dy` in the direction `panBy` documents. `panBy` owns the inversion into world
    // space; a second negation here would cancel it and scroll backwards.
    expect(wheelPanDelta(w({ deltaY: 120 }))).toEqual({ dx: 0, dy: 120 });
    expect(wheelPanDelta(w({ deltaY: -120 }))).toEqual({ dx: 0, dy: -120 });
    expect(wheelPanDelta(w({ deltaX: 40 }))).toEqual({ dx: 40, dy: 0 });
    expect(wheelPanDelta(w({ deltaX: -40, deltaY: 30 }))).toEqual({ dx: -40, dy: 30 });
  });

  it('converts LINE and PAGE deltas to pixels', () => {
    // Firefox reports a mouse notch as 3 LINES. Used raw, that is a three-pixel pan — a control
    // that looks broken rather than one that looks wrong.
    expect(wheelPanDelta(w({ deltaY: 3, deltaMode: 1 }))).toEqual({ dx: 0, dy: 3 * WHEEL_LINE_PX });
    expect(wheelPanDelta(w({ deltaX: -2, deltaMode: 1 }))).toEqual({ dx: -2 * WHEEL_LINE_PX, dy: 0 });
    expect(wheelPanDelta(w({ deltaY: 1, deltaMode: 2 }))).toEqual({ dx: 0, dy: WHEEL_PAGE_PX });
    // …and a page is a bigger step than a line, or the two constants have been swapped.
    expect(WHEEL_PAGE_PX).toBeGreaterThan(WHEEL_LINE_PX);
  });

  it('sends Shift+wheel sideways', () => {
    expect(wheelPanDelta(w({ deltaY: 120, shiftKey: true }))).toEqual({ dx: 120, dy: 0 });
    expect(wheelPanDelta(w({ deltaY: 3, deltaMode: 1, shiftKey: true })))
      .toEqual({ dx: 3 * WHEEL_LINE_PX, dy: 0 });
  });

  /**
   * The carve-out that keeps a trackpad usable. A two-finger swipe reports BOTH axes; folding
   * its `deltaY` onto x because Shift happened to be held would turn a diagonal swipe into a
   * horizontal one and throw the vertical component on the floor.
   */
  it('leaves a device that reports its own horizontal delta alone', () => {
    expect(wheelPanDelta(w({ deltaX: 10, deltaY: 40, shiftKey: true }))).toEqual({ dx: 10, dy: 40 });
  });
});

describe('the canvas wheel does not reach the terminals underneath', () => {
  const SRC = readSource(path.resolve(__dirname, '../CanvasViewport.tsx'));

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

  /**
   * The three inputs of the decision, each read from somewhere LIVE.
   *
   * Any one of them frozen is a mode that half works: a hard-coded `mode` ignores the setting, a
   * hard-coded `onFocusedTerminal: false` takes font zoom away from the terminal being edited,
   * and reading either from a stale closure is worse than both — it works until the value
   * changes, which is after the user has decided the setting does nothing.
   */
  it('feeds the rule the live mode and the focused terminal', () => {
    expect(wheelBody).toContain('mode: wheelModeRef.current');
    expect(wheelBody).toContain('overlayId: overlayIdRef.current');
    expect(wheelBody).toMatch(/onFocusedTerminal:\s*!!focused && terminalIdAt\(e\.target\) === focused/);
    // …and the two refs are actually assigned from the store on every render, rather than
    // initialised once — the failure mode a ref makes easy.
    expect(SRC).toMatch(/wheelModeRef\.current = useSelector\(/);
    expect(SRC).toMatch(/focusedIdRef\.current = focusedId/);
    expect(SRC).toMatch(/const focusedId = useSelector\(/);
  });

  it('pans through the same relative action the arrow keys use', () => {
    // `panViewport` and not `setViewport`: the handler is registered once and never re-reads
    // the viewport, so an absolute pan computed here would be built on `vpRef` and is one more
    // place the sign inversion could be got wrong. `panBy` owns that inversion for both.
    expect(wheelBody).toMatch(/if \(action === 'pan'\)/);
    expect(wheelBody).toContain('wheelPanDelta(e)');
    expect(wheelBody).toContain('dispatch(panViewport({ dx, dy }))');
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
