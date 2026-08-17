import {
  shouldArmSpacePan, shouldDisarmSpacePan, fitShortcut, SpacePanKey, FitKey,
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
