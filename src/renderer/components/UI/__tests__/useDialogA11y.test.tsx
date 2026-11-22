/**
 * @jest-environment jsdom
 *
 * RTL is not installed in this project, so we unit-test the exported pure
 * helpers that hold the real logic of the dialog-a11y primitive. The hook
 * itself is thin glue over these helpers.
 */
import { isTypingTarget, getFocusable, matchMnemonic, recoverStrandedFocus } from '../useDialogA11y';
import { splitMnemonic } from '../Mnemonic';

describe('isTypingTarget', () => {
  const make = (html: string): HTMLElement => {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    return wrap.firstElementChild as HTMLElement;
  };

  it('is true for a text input', () => {
    expect(isTypingTarget(make('<input type="text" />'))).toBe(true);
  });

  it('is true for an input with no type (defaults to text)', () => {
    expect(isTypingTarget(make('<input />'))).toBe(true);
  });

  it('is true for textarea, select, and contenteditable', () => {
    expect(isTypingTarget(make('<textarea></textarea>'))).toBe(true);
    expect(isTypingTarget(make('<select><option>a</option></select>'))).toBe(true);
    expect(isTypingTarget(make('<div contenteditable="true">x</div>'))).toBe(true);
  });

  it('is FALSE for radio and checkbox (so shell radios do not suppress mnemonics)', () => {
    expect(isTypingTarget(make('<input type="radio" />'))).toBe(false);
    expect(isTypingTarget(make('<input type="checkbox" />'))).toBe(false);
  });

  it('is false for buttons, divs, and null', () => {
    expect(isTypingTarget(make('<button>x</button>'))).toBe(false);
    expect(isTypingTarget(make('<div>x</div>'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('getFocusable', () => {
  it('returns focusable children in document order, excluding disabled and tabindex=-1', () => {
    const c = document.createElement('div');
    c.innerHTML = `
      <button id="b1">one</button>
      <button id="b2" disabled>two</button>
      <a id="a1" href="#">link</a>
      <a id="a2">no href</a>
      <input id="i1" />
      <div id="d1" tabindex="0">focusable div</div>
      <div id="d2" tabindex="-1">not focusable</div>
    `;
    const ids = getFocusable(c).map((el) => el.id);
    expect(ids).toEqual(['b1', 'a1', 'i1', 'd1']);
  });

  it('returns [] for null container', () => {
    expect(getFocusable(null)).toEqual([]);
  });
});

describe('matchMnemonic', () => {
  const noop = () => undefined;
  const close = jest.fn();
  const cancel = jest.fn();
  const mnemonics = [
    { key: 'C', handler: close },
    { key: 'a', handler: cancel },
  ];

  it('matches case-insensitively and returns the handler', () => {
    expect(matchMnemonic('c', mnemonics)).toBe(close);
    expect(matchMnemonic('C', mnemonics)).toBe(close);
    expect(matchMnemonic('A', mnemonics)).toBe(cancel);
  });

  it('returns null for non-matching, multi-char, or empty keys', () => {
    expect(matchMnemonic('z', mnemonics)).toBeNull();
    expect(matchMnemonic('ca', mnemonics)).toBeNull();
    expect(matchMnemonic('', mnemonics)).toBeNull();
    expect(matchMnemonic('c', [])).toBeNull();
  });

  it('handlers are distinct (no accidental aliasing)', () => {
    expect(matchMnemonic('c', mnemonics)).not.toBe(matchMnemonic('a', mnemonics));
    expect(noop).toBe(noop);
  });
});



describe('splitMnemonic', () => {
  it('splits around the first occurrence', () => {
    expect(splitMnemonic('Close Tab', 'C')).toEqual({ before: '', match: 'C', after: 'lose Tab' });
  });

  it('matches case-insensitively (Cancel → c[a]ncel)', () => {
    expect(splitMnemonic('Cancel', 'a')).toEqual({ before: 'C', match: 'a', after: 'ncel' });
  });

  it('uses the first occurrence when the char repeats', () => {
    expect(splitMnemonic('Refresh', 'r')).toEqual({ before: '', match: 'R', after: 'efresh' });
  });

  it('returns null when not found or char is not a single character', () => {
    expect(splitMnemonic('Done', 'x')).toBeNull();
    expect(splitMnemonic('Done', 'do')).toBeNull();
    expect(splitMnemonic('Done', '')).toBeNull();
  });
});

// P068-1: a failed Apply in the SSH Permissions dialog disabled the focused field while pending.
// Focus fell to <body>, outside the container's key handlers, so Escape no longer closed the modal.
describe('recoverStrandedFocus', () => {
  const mount = (html: string, tabindex = true) => {
    const dialog = document.createElement('div');
    if (tabindex) dialog.setAttribute('tabindex', '-1');
    dialog.innerHTML = html;
    document.body.appendChild(dialog);
    return dialog;
  };
  afterEach(() => { document.body.innerHTML = ''; });

  it('moves focus from <body> back to the container after the focused field is disabled', () => {
    const dialog = mount('<input id="uid" /><button id="apply">Apply</button>');
    const uid = dialog.querySelector<HTMLInputElement>('#uid')!;
    uid.focus();
    expect(document.activeElement).toBe(uid);
    // A browser drops focus to <body> when `pending` disables the focused field; jsdom keeps it,
    // so model the browser: blur, then disable.
    uid.blur();
    uid.disabled = true;
    expect(document.activeElement).toBe(document.body);

    expect(recoverStrandedFocus(dialog)).toBe(dialog);
    expect(document.activeElement).toBe(dialog);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('falls back to the first focusable control when the container is not focusable', () => {
    const dialog = mount('<input id="a" disabled /><button id="b">ok</button>', false);
    expect(recoverStrandedFocus(dialog)?.id).toBe('b');
    expect(document.activeElement?.id).toBe('b');
  });

  it('never steals focus from an element that is focused, inside or outside the dialog', () => {
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    const dialog = mount('<button id="in">in</button>');
    outside.focus();
    expect(recoverStrandedFocus(dialog)).toBeNull();
    expect(document.activeElement).toBe(outside);
    dialog.querySelector<HTMLButtonElement>('#in')!.focus();
    expect(recoverStrandedFocus(dialog)).toBeNull();
    expect(document.activeElement?.id).toBe('in');
  });

  it('does nothing for a detached or missing container', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('tabindex', '-1');
    expect(recoverStrandedFocus(dialog)).toBeNull();
    expect(recoverStrandedFocus(null)).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
