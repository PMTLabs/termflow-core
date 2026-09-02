/**
 * @jest-environment jsdom
 *
 * `TerminalSearchBar` — the first component-level test this component has ever had, and it only
 * became possible when `plan/027` §1.3 made it presentational: while it owned its own state,
 * every case here would have been a test of `useState` wired to a fake engine.
 *
 * What the cases below are really pinning is that the bar is a PURE VIEW. It must draw whatever
 * state it is handed and call back for every change, because two of them are now rendered at
 * once — one in the pane, one on the Canvas overlay — over a single owner. A bar that kept any
 * state of its own would put the two out of step the moment the terminal was overlaid.
 *
 * `react-dom/client` + `React.act`; there is no testing-library in this repo
 * (`nodeTerminal.test.tsx` is the precedent).
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { TerminalSearchBar } from '../TerminalSearchBar';
import type { SearchViewState } from '../useTerminalSearch';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

/**
 * The bar asks `navigator.platform` at RENDER time, so this has to be set before `render`.
 * jsdom reports `''`, which is the Windows/Linux answer, and every case that does not call this
 * is therefore a Windows/Linux case.
 */
const setPlatform = (platform: string) => {
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setPlatform('');
});

const view = (over: Partial<SearchViewState> = {}): SearchViewState => ({
  open: true,
  query: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  result: { resultIndex: -1, resultCount: 0 },
  focusToken: 0,
  setQuery: jest.fn(),
  toggleCaseSensitive: jest.fn(),
  toggleWholeWord: jest.fn(),
  toggleRegex: jest.fn(),
  next: jest.fn(),
  previous: jest.fn(),
  close: jest.fn(),
  ...over,
});

const render = (search: SearchViewState) =>
  act(() => { root.render(<TerminalSearchBar search={search} />); });

const input = () => container.querySelector<HTMLInputElement>('.tsb-input')!;
const toggle = (title: string) =>
  container.querySelector<HTMLButtonElement>(`.tsb-toggle[title="${title}"]`)!;
const nav = (title: string) =>
  container.querySelector<HTMLButtonElement>(`.tsb-nav[title^="${title}"]`)!;
const click = (el: Element) =>
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
/**
 * Type into the controlled input.
 *
 * The value has to go through the NATIVE setter: React tracks the last value it wrote on the DOM
 * node and skips its synthetic `change` when the node's own value assignment matches, so
 * `el.value = 'ne'` followed by an `input` event fires nothing at all. This is the standard
 * RTL-free way in, and there is no testing-library here to hide it.
 */
const type = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const press = (el: Element, init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => { el.dispatchEvent(e); });
  return e;
};

describe('drawing the handed-in state', () => {
  it('shows the query it is given, not one of its own', () => {
    render(view({ query: 'needle' }));
    expect(input().value).toBe('needle');
  });

  it('shows the live N-of-M', () => {
    render(view({ result: { resultIndex: 2, resultCount: 7 } }));
    expect(container.querySelector('.tsb-count')!.textContent).toBe('3 of 7');
  });

  it('reflects each option in its toggle', () => {
    render(view({ caseSensitive: true, wholeWord: false, regex: true }));
    expect(toggle('Match Case').getAttribute('aria-pressed')).toBe('true');
    expect(toggle('Match Whole Word').getAttribute('aria-pressed')).toBe('false');
    expect(toggle('Use Regular Expression').getAttribute('aria-pressed')).toBe('true');
  });

  // The one thing the bar still computes for itself, because it is presentation only: an
  // unparseable pattern is flagged rather than silently searched for.
  it('flags an unparseable regex', () => {
    render(view({ query: '([unclosed', regex: true }));
    expect(input().className).toContain('tsb-input-invalid');
    render(view({ query: '([unclosed', regex: false }));
    expect(input().className).not.toContain('tsb-input-invalid');
  });
});

describe('calling back for every change', () => {
  it('reports typing rather than keeping it', () => {
    const search = view();
    render(search);
    type(input(), 'ne');
    expect(search.setQuery).toHaveBeenCalledWith('ne');
    // ...and it did NOT change the field on its own: the value it draws is still the prop.
    expect(input().value).toBe('');
  });

  /**
   * EVERY toggle, not one of them. The earlier version clicked only Match Case, and the wrong
   * implementation it could not see is the likeliest one there is: `onClick={toggleCaseSensitive}`
   * copy-pasted onto all three buttons. That leaves `toggleWholeWord` and `toggleRegex` dead and
   * unreachable while the assertions — one positive, two negatives — all still hold, because the
   * two negatives are about callbacks nothing has clicked yet.
   *
   * A table over the three, so a fourth toggle added later has one obvious place to go.
   */
  it.each([
    ['Match Case', 'toggleCaseSensitive'],
    ['Match Whole Word', 'toggleWholeWord'],
    ['Use Regular Expression', 'toggleRegex'],
  ] as const)('routes the %s toggle to its own callback and no other', (title, own) => {
    const search = view();
    render(search);
    click(toggle(title));
    const others = (['toggleCaseSensitive', 'toggleWholeWord', 'toggleRegex'] as const)
      .filter((k) => k !== own);
    expect(search[own]).toHaveBeenCalledTimes(1);
    for (const other of others) expect(search[other]).not.toHaveBeenCalled();
  });

  it('routes the nav buttons and the close button', () => {
    const search = view({ query: 'needle' });
    render(search);
    click(nav('Next Match'));
    click(nav('Previous Match'));
    click(container.querySelector('.tsb-close')!);
    expect(search.next).toHaveBeenCalledTimes(1);
    expect(search.previous).toHaveBeenCalledTimes(1);
    expect(search.close).toHaveBeenCalledTimes(1);
  });
});

describe('keyboard', () => {
  it('navigates with Enter and Shift+Enter', () => {
    const search = view({ query: 'needle' });
    render(search);
    press(input(), { key: 'Enter' });
    expect(search.next).toHaveBeenCalledTimes(1);
    expect(search.previous).not.toHaveBeenCalled();
    press(input(), { key: 'Enter', shiftKey: true });
    expect(search.previous).toHaveBeenCalledTimes(1);
    expect(search.next).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const search = view({ query: 'needle' });
    render(search);
    const e = press(input(), { key: 'Escape' });
    expect(search.close).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  /**
   * Ctrl+F WHILE FOCUSED INSIDE THE BAR is swallowed here, and that is not redundant with the
   * engine's own intercept or the overlay's: both are bound on the terminal container, which is
   * this bar's SIBLING, so the event never reaches either of them and the WebView's native find
   * dialog would open instead.
   */
  it('swallows Ctrl+F rather than letting the WebView open its own find', () => {
    const search = view({ query: 'needle' });
    render(search);
    const e = press(input(), { key: 'f', ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(search.next).not.toHaveBeenCalled();
    expect(search.close).not.toHaveBeenCalled();
  });

  /**
   * ...and it asks the SHARED predicate what "the find shortcut" is, per platform.
   *
   * A hand-written `(e.ctrlKey || e.metaKey)` here agreed with `isFindShortcut` on
   * Windows/Linux and disagreed with it on macOS, where plain Ctrl+F is deliberately not find.
   * The overlay's `useSearchHotkey` therefore ignores macOS Ctrl+F and it arrives here — where
   * the old test swallowed it, preventDefaulting the system's forward-char binding and
   * select-all-ing the query the user was in the middle of editing.
   *
   * A TABLE over both platforms and both modifiers, because the defect was exactly one cell of
   * it: pinning only the platform the developer is on is what let the two homes disagree.
   */
  it.each([
    // platform,      modifier,             swallowed
    ['',              { ctrlKey: true },    true],
    ['',              { metaKey: true },    false],
    ['MacIntel',      { metaKey: true },    true],
    ['MacIntel',      { ctrlKey: true },    false],
  ] as const)('platform %s + %o: swallowed=%s', (platform, modifier, swallowed) => {
    setPlatform(platform);
    const search = view({ query: 'needle' });
    render(search);
    // The caret parked mid-word, as it is while the user edits the query. A swallowed press
    // re-selects the whole query; an ignored one must leave the caret exactly where it was.
    input().setSelectionRange(3, 3);

    const e = press(input(), { key: 'f', ...modifier });

    expect(e.defaultPrevented).toBe(swallowed);
    expect([input().selectionStart, input().selectionEnd])
      .toEqual(swallowed ? [0, 'needle'.length] : [3, 3]);
  });
});

/**
 * The bar is a TOOLBAR, not an input with decorations: five of its six focusable controls are
 * buttons, and a keyboard user reaches them with Tab.
 *
 * `onKeyDown` is bound on the bar, so every key pressed on any of them arrives here. Which of
 * the arms may act on it depends on where it came from, and that distinction is the fix these
 * cases pin.
 */
describe('keys pressed on the bar\'s BUTTONS, not its input', () => {
  it('leaves Enter to the button it was pressed on', () => {
    const search = view({ query: 'needle' });
    render(search);
    const e = press(toggle('Match Case'), { key: 'Enter' });
    // Not consumed: jsdom does not synthesise a button's activation click from a keydown, so
    // what is asserted is the thing that actually broke it — the bar preventDefault()ing the
    // key, which in a browser is what stops the click and leaves the toggle unflipped.
    expect(e.defaultPrevented).toBe(false);
    // ...and the search did NOT advance instead, which is what the user saw happen.
    expect(search.next).not.toHaveBeenCalled();
    expect(search.previous).not.toHaveBeenCalled();
  });

  it('leaves Shift+Enter on the close button alone too', () => {
    const search = view({ query: 'needle' });
    render(search);
    const e = press(container.querySelector('.tsb-close')!, { key: 'Enter', shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(search.previous).not.toHaveBeenCalled();
  });

  // Escape is the one binding the whole bar shares — it is nobody's activation key, so it costs
  // no button anything, and a user who tabbed to a toggle must still be able to dismiss the bar.
  it('still closes on Escape from a button', () => {
    const search = view({ query: 'needle' });
    render(search);
    const e = press(toggle('Use Regular Expression'), { key: 'Escape' });
    expect(search.close).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  /**
   * And Ctrl+F is DELIBERATELY not gated to the input, unlike Enter. Nothing between this bar
   * and the WebView will swallow the combo — the engine's intercept is on the terminal
   * container, a sibling — so gating it here would open the browser's native find dialog for
   * five of the bar's six controls. Unlike Enter it suppresses no button activation.
   */
  it('still swallows Ctrl+F from a button', () => {
    const search = view({ query: 'needle' });
    render(search);
    const e = press(toggle('Match Case'), { key: 'f', ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input());
  });
});

/**
 * The focus effect, which is the whole reason `focusToken` is a NUMBER rather than a boolean.
 *
 * Re-focusing only on `open` would leave a second Ctrl+F doing nothing when the bar is already
 * up and focus has gone back into the terminal — the exact case the token was added for.
 */
describe('focus', () => {
  it('takes focus on mount and again on every token bump', () => {
    render(view({ focusToken: 1 }));
    expect(document.activeElement).toBe(input());

    // Focus deliberately moved away, as it is when the user clicks back into the terminal.
    act(() => { input().blur(); });
    expect(document.activeElement).not.toBe(input());

    render(view({ focusToken: 2 }));
    expect(document.activeElement).toBe(input());
  });

  // Paired negative: an unchanged token must not yank focus back on an unrelated re-render —
  // the bar re-renders on every keystroke of the query it does not own.
  it('does not steal focus back on a re-render with the same token', () => {
    render(view({ focusToken: 1 }));
    act(() => { input().blur(); });
    render(view({ focusToken: 1, query: 'ne' }));
    expect(document.activeElement).not.toBe(input());
  });
});
