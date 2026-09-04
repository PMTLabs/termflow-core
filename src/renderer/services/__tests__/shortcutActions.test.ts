import {
  SHORTCUT_ACTIONS, GLOBAL_SHORTCUT_ACTIONS, CANVAS_SHORTCUT_ACTIONS, CANVAS_FIXED_SHORTCUTS,
  isGlobalAction,
  findConflict, canonicalizeCombo, comboKeyToken, eventCombo, matchesCombo,
  allowsModifierlessCombo,
} from '../shortcutActions';

describe('SHORTCUT_ACTIONS', () => {
  it('has 21 unique action ids with unique default combos', () => {
    expect(SHORTCUT_ACTIONS).toHaveLength(21);
    const ids = SHORTCUT_ACTIONS.map(a => a.id);
    const combos = SHORTCUT_ACTIONS.map(a => a.defaultCombo);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(combos).size).toBe(combos.length);
  });
});

/**
 * The scope split, which is the whole defence behind letting the canvas put BARE LETTERS in
 * this registry. `InputHandler` registers `GLOBAL_SHORTCUT_ACTIONS` on the window in the
 * capture phase; anything that leaked into that list would fire on every matching character
 * typed into any terminal in the app.
 */
describe('shortcut scopes', () => {
  it('splits the registry in two, losing nothing', () => {
    expect(GLOBAL_SHORTCUT_ACTIONS.length + CANVAS_SHORTCUT_ACTIONS.length)
      .toBe(SHORTCUT_ACTIONS.length);
    expect(CANVAS_SHORTCUT_ACTIONS.length).toBeGreaterThan(0);
  });

  it('treats a missing scope as global, so every pre-canvas action is unaffected', () => {
    expect(isGlobalAction({ id: 'x', label: 'x', defaultCombo: 'Ctrl+X' })).toBe(true);
    expect(GLOBAL_SHORTCUT_ACTIONS.map(a => a.id)).toContain('newTab');
  });

  /**
   * The assertion that matters, stated as a PROPERTY rather than a list of the four ids we
   * happen to have added: no action reachable by InputHandler may be bindable to a combo with
   * no modifier at all. A future canvas action added without `scope: 'canvas'` fails here on
   * the day it is written, which is the only moment the mistake is cheap.
   */
  it('leaves no modifier-less combo in the globally-registered set', () => {
    const bare = GLOBAL_SHORTCUT_ACTIONS
      .filter(a => !/^(control|alt|shift)\+/.test(canonicalizeCombo(a.defaultCombo)))
      // F11 and friends are function keys — a bare key that is nobody's typed character.
      .filter(a => !/^f\d{1,2}$/.test(canonicalizeCombo(a.defaultCombo)))
      .map(a => a.id);
    expect(bare).toEqual([]);
  });

  it('keeps the canvas letters out of the global set', () => {
    const globalIds = GLOBAL_SHORTCUT_ACTIONS.map(a => a.id);
    for (const id of ['canvasOpenNodeTab', 'canvasEnlargeNode', 'canvasOpenNodeTabFromOverlay',
      'canvasLeaveTerminal', 'canvasArrange', 'canvasToggleList']) {
      expect({ id, global: globalIds.includes(id) }).toEqual({ id, global: false });
    }
  });

  /** Tam's requirement, as a fact about the defaults: the canvas key is bare and the one that
   *  has to work from inside a live terminal is not. */
  it('gives the open-in-tab pair a bare key on the canvas and a Ctrl chord in the overlay', () => {
    const by = (id: string) => SHORTCUT_ACTIONS.find(a => a.id === id)!;
    expect(canonicalizeCombo(by('canvasOpenNodeTab').defaultCombo)).toBe('t');
    expect(canonicalizeCombo(by('canvasOpenNodeTabFromOverlay').defaultCombo)).toBe('control+t');
  });
});

/**
 * The fixed canvas keys — listed for the user, not yet assignable (`docs/backlog/008`).
 *
 * The table exists to serve two jobs at once, and the tests that matter are about them agreeing:
 * what Settings SHOWS and what `findConflict` PROTECTS. A row visible as "Next Node" that a
 * customizable action can still bind over is the worst outcome available here — it is silent, it
 * only breaks on the canvas, and the user has been told the key is spoken for.
 */
describe('CANVAS_FIXED_SHORTCUTS', () => {
  it('is a non-empty table with a label, a display and at least one reserved spelling', () => {
    expect(CANVAS_FIXED_SHORTCUTS.length).toBeGreaterThan(0);
    for (const s of CANVAS_FIXED_SHORTCUTS) {
      expect({ label: s.label, ok: !!s.label && !!s.display && s.reserve.length > 0 })
        .toEqual({ label: s.label, ok: true });
    }
  });

  /**
   * THE test. Every spelling in the table is actually blocked — derived from the table rather
   * than a list of the keys we happen to have added, so a row added later is covered the day it
   * becomes visible.
   */
  it('reserves every spelling it lists, against a customizable action', () => {
    for (const s of CANVAS_FIXED_SHORTCUTS) {
      for (const combo of s.reserve) {
        expect({ label: s.label, combo, got: findConflict('canvasOpenNodeTab', combo, {}) })
          .toEqual({ label: s.label, combo, got: { type: 'reserved' } });
      }
    }
  });

  /** ...and against a GLOBAL action too, since both listeners share one window. */
  it('reserves them against a global action as well', () => {
    for (const s of CANVAS_FIXED_SHORTCUTS) {
      expect({ label: s.label, got: findConflict('newTab', s.reserve[0], {}) })
        .toEqual({ label: s.label, got: { type: 'reserved' } });
    }
  });

  /**
   * A fixed key and an assignable one must not name the same combo.
   *
   * If they did, the screen would show one key twice with two different meanings, and the
   * assignable row's default would be permanently in conflict with a reserved combo — a row whose
   * own current value it could never re-record.
   */
  it('never collides with a customizable action\'s default', () => {
    const reserved = new Set(CANVAS_FIXED_SHORTCUTS.flatMap(s => s.reserve).map(canonicalizeCombo));
    const clashing = SHORTCUT_ACTIONS
      .filter(a => reserved.has(canonicalizeCombo(a.defaultCombo)))
      .map(a => a.id);
    expect(clashing).toEqual([]);
  });

  /** Two rows claiming the same key would be two answers to "what does this do?". */
  it('lists each spelling once across the whole table', () => {
    const all = CANVAS_FIXED_SHORTCUTS.flatMap(s => s.reserve).map(canonicalizeCombo);
    expect(new Set(all).size).toBe(all.length);
  });

  /**
   * `'+'` IS the combo delimiter, so `'Ctrl++'` canonicalizes to a trailing-empty `control+` and
   * would reserve nothing at all — silently. The word form is the only spelling that round-trips.
   */
  it('uses the word form for keys that cannot survive a combo string', () => {
    const all = CANVAS_FIXED_SHORTCUTS.flatMap(s => s.reserve);
    expect(all).toContain('Ctrl+Plus');
    for (const combo of all) {
      expect({ combo, empty: canonicalizeCombo(combo).endsWith('+') })
        .toEqual({ combo, empty: false });
    }
  });
});

/**
 * The Settings recorder demands a modifier or a function key. Two canvas actions SHIP with a
 * bare letter, so without an exemption their rows would show a value the user could never
 * re-record — visible, current, and unreachable.
 */
describe('allowsModifierlessCombo', () => {
  it('exempts every canvas-scoped action', () => {
    const refused = CANVAS_SHORTCUT_ACTIONS
      .filter(a => !allowsModifierlessCombo(a.id))
      .map(a => a.id);
    expect(refused).toEqual([]);
  });

  it('exempts no globally-registered action', () => {
    const exempt = GLOBAL_SHORTCUT_ACTIONS
      .filter(a => allowsModifierlessCombo(a.id))
      .map(a => a.id);
    expect(exempt).toEqual([]);
  });

  /**
   * The property that ties the exemption to the defaults: any action shipping a modifier-less
   * default MUST be exempt, or its own row cannot re-record its own current value. Derived from
   * the registry rather than listing the two we happen to have, so a future one is covered the
   * day it is added.
   */
  it('exempts every action whose own default has no modifier', () => {
    const stranded = SHORTCUT_ACTIONS
      .filter(a => !/^(control|alt|shift)\+/.test(canonicalizeCombo(a.defaultCombo)))
      .filter(a => !/^f\d{1,2}$/.test(canonicalizeCombo(a.defaultCombo)))
      .filter(a => !allowsModifierlessCombo(a.id))
      .map(a => a.id);
    expect(stranded).toEqual([]);
  });

  it('is false for an unknown action id', () => {
    expect(allowsModifierlessCombo('notARealAction')).toBe(false);
  });
});

/**
 * `eventCombo` was lifted out of `InputHandler.handleKeyEvent` so the canvas could ask the same
 * question of the same event. These pin the two properties that made that safe to share.
 */
describe('eventCombo / matchesCombo', () => {
  const key = (over: Partial<Parameters<typeof eventCombo>[0]> = {}) => ({
    key: 'a', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over,
  });

  it('agrees with the written form of the same combo', () => {
    expect(eventCombo(key({ key: 'T', ctrlKey: true }))).toBe(canonicalizeCombo('Ctrl+T'));
    expect(eventCombo(key({ key: 'e' }))).toBe(canonicalizeCombo('E'));
  });

  it('folds Cmd into Ctrl, so a Ctrl default answers Cmd on macOS', () => {
    expect(matchesCombo(key({ key: 't', metaKey: true }), 'Ctrl+T')).toBe(true);
  });

  /** CapsLock reports an uppercase `key` with no shiftKey. A real Shift press is a DIFFERENT
   *  combo and must not match — that separation is what keeps Shift+E free. */
  it('accepts CapsLock but not a real Shift', () => {
    expect(matchesCombo(key({ key: 'E' }), 'E')).toBe(true);
    expect(matchesCombo(key({ key: 'E', shiftKey: true }), 'E')).toBe(false);
  });

  /** An action left bound to '' by corrupt settings must match NOTHING. Matching everything
   *  would turn one bad value into a key that fires on every press. */
  it('matches nothing for an empty or absent combo', () => {
    expect(matchesCombo(key({ key: 't' }), '')).toBe(false);
    expect(matchesCombo(key({ key: 't' }), undefined)).toBe(false);
    expect(matchesCombo(key({ key: 't' }), null)).toBe(false);
  });

  it('does not throw on an event with no usable key', () => {
    expect(matchesCombo(key({ key: undefined as unknown as string }), 'T')).toBe(false);
  });
});

describe('canonicalizeCombo', () => {
  it('treats Cmd and Meta the same as Ctrl (matches handleKeyEvent unifying ctrlKey/metaKey)', () => {
    expect(canonicalizeCombo('Cmd+W')).toBe(canonicalizeCombo('Ctrl+W'));
    expect(canonicalizeCombo('Meta+W')).toBe(canonicalizeCombo('Ctrl+W'));
  });

  it('is order-independent for modifiers', () => {
    expect(canonicalizeCombo('Shift+Ctrl+Tab')).toBe(canonicalizeCombo('Ctrl+Shift+Tab'));
    expect(canonicalizeCombo('Alt+Ctrl+Shift+X')).toBe(canonicalizeCombo('Ctrl+Alt+Shift+X'));
  });

  it('strips a leading "arrow" from the main key, matching handleKeyEvent', () => {
    expect(canonicalizeCombo('Ctrl+ArrowLeft')).toBe(canonicalizeCombo('Ctrl+Left'));
  });

  it('is case- and whitespace-insensitive', () => {
    expect(canonicalizeCombo('ctrl+w')).toBe(canonicalizeCombo('Ctrl+W'));
    expect(canonicalizeCombo(' Ctrl + W ')).toBe(canonicalizeCombo('Ctrl+W'));
  });

  it('round-trips the literal Plus key cleanly when captured as the word "Plus" (not the raw "+" character, which is ambiguous with the delimiter)', () => {
    expect(canonicalizeCombo('Ctrl+Plus')).toBe('control+plus');
    expect(canonicalizeCombo('Ctrl+Shift+Plus')).toBe('control+shift+plus');
    // Distinct from — and does not collide with — the (unreachable in practice)
    // raw "+" character form, which loses the key entirely.
    expect(canonicalizeCombo('Ctrl+Plus')).not.toBe(canonicalizeCombo('Ctrl++'));
  });
});

describe('findConflict', () => {
  it('returns null when the combo is not used by any other action', () => {
    expect(findConflict('newTab', 'Ctrl+Alt+N', {})).toBeNull();
  });

  it('returns the conflicting action when the combo matches another action\'s default', () => {
    // closeTab's default is 'Ctrl+W'
    expect(findConflict('newTab', 'Ctrl+W', {})).toEqual({ type: 'action', actionId: 'closeTab', label: 'Close Tab' });
  });

  it('returns the conflicting action when the combo matches another action\'s override', () => {
    const overrides = { closeTab: 'Ctrl+Alt+X' };
    expect(findConflict('newTab', 'Ctrl+Alt+X', overrides)).toEqual({ type: 'action', actionId: 'closeTab', label: 'Close Tab' });
  });

  it('is case- and whitespace-insensitive when comparing combos', () => {
    expect(findConflict('newTab', 'ctrl+w', {})?.type).toBe('action');
    expect(findConflict('newTab', ' Ctrl + W ', {})?.type).toBe('action');
  });

  it('never reports a conflict against the action being edited itself', () => {
    // closeTab checked against its own current default combo
    expect(findConflict('closeTab', 'Ctrl+W', {})).toBeNull();
  });

  it('an override on the action being edited does not shadow the check', () => {
    // newTab has a custom override; re-recording newTab to closeTab's combo must
    // still report closeTab as the conflict, not compare against newTab's own override.
    const overrides = { newTab: 'Ctrl+Alt+N' };
    expect(findConflict('newTab', 'Ctrl+W', overrides)).toEqual({ type: 'action', actionId: 'closeTab', label: 'Close Tab' });
  });

  it('reports a reserved-combo conflict for the fixed Ctrl+1-9 tab-jump bindings', () => {
    expect(findConflict('newTab', 'Ctrl+1', {})).toEqual({ type: 'reserved' });
  });

  it('reports a reserved-combo conflict for the fixed Ctrl+Shift+V paste fallback', () => {
    expect(findConflict('paste', 'Ctrl+Shift+V', {})).toEqual({ type: 'reserved' });
  });

  it('does NOT reserve Alt+Arrow — those keys pass through to the terminal for word movement', () => {
    // The old pane-navigation stub swallowed Alt+Left/Right before xterm saw
    // them, breaking word-jump at the shell prompt. The stub and its
    // reservation were removed; Alt+Arrow is a free combo like any other.
    expect(findConflict('nextTab', 'Alt+ArrowLeft', {})).toBeNull();
    expect(findConflict('nextTab', 'Alt+ArrowRight', {})).toBeNull();
  });

  it('reports a reserved-combo conflict for the fixed Alt+Shift+Arrow pane-resize bindings', () => {
    expect(findConflict('nextTab', 'Alt+Shift+ArrowLeft', {})).toEqual({ type: 'reserved' });
    expect(findConflict('nextTab', 'Alt+Shift+ArrowRight', {})).toEqual({ type: 'reserved' });
    expect(findConflict('nextTab', 'Alt+Shift+ArrowUp', {})).toEqual({ type: 'reserved' });
    expect(findConflict('nextTab', 'Alt+Shift+ArrowDown', {})).toEqual({ type: 'reserved' });
  });

  it('normalizes arrow-key combos the same way InputHandler does, so an arrow override still detects conflicts', () => {
    const overrides = { prevTab: 'Ctrl+ArrowLeft' };
    expect(findConflict('nextTab', 'Ctrl+ArrowLeft', overrides)).toEqual({ type: 'action', actionId: 'prevTab', label: 'Previous Tab' });
  });

  it('reports a reserved-combo conflict for a macOS Cmd equivalent of a reserved combo', () => {
    // Cmd+1 must be caught the same as Ctrl+1 — this is the exact bug Dual Review #2 found.
    expect(findConflict('newTab', 'Cmd+1', {})).toEqual({ type: 'reserved' });
  });

  /**
   * The canvas's FIXED navigation is not in SHORTCUT_ACTIONS, so it cannot defend itself through
   * the per-action loop — it has to be reserved by hand or Settings will happily let a canvas
   * action shadow it, silently and only on that one surface.
   */
  it('reserves the canvas navigation keys that are not themselves rebindable', () => {
    for (const combo of ['Tab', 'Shift+Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
      'Delete', 'Backspace']) {
      expect({ combo, got: findConflict('canvasOpenNodeTab', combo, {}) })
        .toEqual({ combo, got: { type: 'reserved' } });
    }
  });

  /** Zoom is per-surface — each terminal pane, the canvas and Settings own their own level, and
   *  InputHandler deliberately binds none of it. One customizable action landing here would
   *  shadow all three at once. */
  it('reserves the per-surface zoom chords', () => {
    for (const combo of ['Ctrl+=', 'Ctrl+-', 'Ctrl+0', 'Ctrl+Plus']) {
      expect({ combo, got: findConflict('newTab', combo, {}) })
        .toEqual({ combo, got: { type: 'reserved' } });
    }
  });

  /** A canvas action and a global one share one window in the capture phase, so a shared combo
   *  would fire BOTH. Conflicts are deliberately global rather than per-scope. */
  it('conflicts across scopes in both directions', () => {
    expect(findConflict('canvasOpenNodeTab', 'Ctrl+W', {}))
      .toEqual({ type: 'action', actionId: 'closeTab', label: 'Close Tab' });
    expect(findConflict('newTab', 'T', {}))
      .toEqual({ type: 'action', actionId: 'canvasOpenNodeTab', label: 'Open Node in Its Tab' });
  });

  it('defaults customKeybindings to {} when omitted, without throwing', () => {
    expect(() => findConflict('newTab', 'Ctrl+Alt+N')).not.toThrow();
  });

  it('does not throw when customKeybindings is explicitly null', () => {
    expect(() => findConflict('newTab', 'Ctrl+Alt+N', null as any)).not.toThrow();
  });
});

describe('comboKeyToken', () => {
  // Both of these lose their identity SILENTLY in a '+'-delimited,
  // whitespace-trimmed combo string, so a shortcut using either registers
  // fine and then never fires. That is why the mapping exists at all.
  it('gives the delimiter-colliding and whitespace keys a word form', () => {
    expect(comboKeyToken('+')).toBe('Plus');
    expect(comboKeyToken(' ')).toBe('Space');
  });

  it('leaves every other key untouched', () => {
    for (const k of ['a', 'A', 'F5', 'Enter', 'Tab', 'ArrowLeft', ',']) {
      expect(comboKeyToken(k)).toBe(k);
    }
  });

  // The property that actually matters: what a keypress canonicalizes to via
  // this helper must equal what the written combo canonicalizes to. Assert it
  // rather than the intermediate strings.
  it('makes a live keypress canonicalize to the same string as its written combo', () => {
    const live = (mods: string[], key: string) =>
      canonicalizeCombo([...mods, comboKeyToken(key)].join('+'));

    expect(live(['Ctrl', 'Alt', 'Shift'], ' ')).toBe(canonicalizeCombo('Ctrl+Shift+Alt+Space'));
    expect(live(['Ctrl'], '+')).toBe(canonicalizeCombo('Ctrl+Plus'));
    expect(live(['Ctrl', 'Shift'], 'x')).toBe(canonicalizeCombo('Ctrl+Shift+X'));
  });

  // Without the mapping the space is trimmed to nothing and the combo
  // collapses to modifiers only — the failure this helper exists to prevent.
  it('is what stops a Space combo collapsing to bare modifiers', () => {
    expect(canonicalizeCombo('Ctrl+Alt+Shift+ ')).toBe('control+alt+shift+');
    expect(canonicalizeCombo('Ctrl+Shift+Alt+Space')).not.toBe('control+alt+shift+');
  });
});
