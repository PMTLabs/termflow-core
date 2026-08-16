import { SHORTCUT_ACTIONS, findConflict, canonicalizeCombo, comboKeyToken } from '../shortcutActions';

describe('SHORTCUT_ACTIONS', () => {
  it('has 14 unique action ids with unique default combos', () => {
    expect(SHORTCUT_ACTIONS).toHaveLength(14);
    const ids = SHORTCUT_ACTIONS.map(a => a.id);
    const combos = SHORTCUT_ACTIONS.map(a => a.defaultCombo);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(combos).size).toBe(combos.length);
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
