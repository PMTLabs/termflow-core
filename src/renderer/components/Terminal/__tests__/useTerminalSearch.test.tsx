/**
 * @jest-environment jsdom
 *
 * `useTerminalSearch` — the find bar's state, lifted out of `TerminalSearchBar` (`plan/027` §1.3).
 *
 * This is where the feature's real behaviour now lives, and none of it is reachable from
 * `TerminalDisplay`, which cannot be mounted under the root Jest config. So the hook is driven
 * directly against a fake engine, with `react-dom/client` + `React.act` — the RTL-free pattern
 * `useRestartHotkey.test.tsx` and `nodeTerminal.test.tsx` already use.
 *
 * Two properties carry more weight than the rest:
 *  - CALLBACK IDENTITY. Every callback here is published through `surfaceChrome`, whose `same()`
 *    compares them by reference to decide whether a write is observable. One rebuilt per render
 *    would make every publish a change and re-render every node on the canvas on every keystroke.
 *  - WHEN THE RESULT SUBSCRIPTION IS MADE. The engine is constructed by an effect declared BELOW
 *    this hook's call site, so at mount `engineRef.current` is still null; a `[]`-keyed
 *    subscription would silently never attach and the N-of-M counter would sit at "0 of 0".
 */
import React, { act, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import type { TerminalEngine, TerminalSearchResult } from '@termflow/terminal-core';
import { useTerminalSearch, type TerminalSearchApi } from '../useTerminalSearch';

let container: HTMLDivElement;
let root: Root;
let api: TerminalSearchApi;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

/** Only the five engine methods this hook touches; everything else would be noise. */
const makeEngine = () => {
  const listeners: ((r: TerminalSearchResult) => void)[] = [];
  const dispose = jest.fn();
  return {
    searchNext: jest.fn(),
    searchPrevious: jest.fn(),
    clearSearch: jest.fn(),
    focus: jest.fn(),
    onSearchResults: jest.fn((cb: (r: TerminalSearchResult) => void) => {
      listeners.push(cb);
      return { dispose };
    }),
    /** Test handle: push an N-of-M update the way the SearchAddon would. */
    emit: (r: TerminalSearchResult) => listeners.forEach((l) => l(r)),
    dispose,
  };
};

type FakeEngine = ReturnType<typeof makeEngine>;
let engine: FakeEngine;

/**
 * Mirrors `TerminalDisplay`: the engine arrives through a REF, and is null on the first render.
 *
 * The terminalId is a PROP rather than a constant for the same reason it is a parameter of the
 * hook — `TerminalDisplay` is rendered without a key and `TerminalPane`'s reuse path changes it
 * on the same component instance, which is exactly what the last describe here drives.
 */
const Host: React.FC<{ engine: FakeEngine | null; terminalId: string }> = ({ engine: e, terminalId }) => {
  const ref = useRef<TerminalEngine | null>(null);
  ref.current = e as unknown as TerminalEngine | null;
  api = useTerminalSearch(ref, terminalId);
  return null;
};

const render = (e: FakeEngine | null, terminalId = 'tm-a') =>
  act(() => { root.render(<Host engine={e} terminalId={terminalId} />); });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  engine = makeEngine();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('opening', () => {
  it('starts closed and does nothing to the engine', () => {
    render(engine);
    expect(api.open).toBe(false);
    expect(engine.clearSearch).not.toHaveBeenCalled();
    expect(engine.searchNext).not.toHaveBeenCalled();
  });

  it('opens and bumps the focus token', () => {
    render(engine);
    const before = api.focusToken;
    act(() => { api.openSearch(); });
    expect(api.open).toBe(true);
    expect(api.focusToken).toBe(before + 1);
  });

  /**
   * The reason a token exists at all rather than the bar focusing on mount: a SECOND Ctrl+F while
   * the bar is already open must pull focus back out of the terminal, and `setOpen(true)` alone
   * is a no-op then, so nothing would re-run the bar's focus effect.
   */
  it('bumps the token again on a repeat request while already open', () => {
    render(engine);
    act(() => { api.openSearch(); });
    const after = api.focusToken;
    act(() => { api.openSearch(); });
    expect(api.open).toBe(true);
    expect(api.focusToken).toBe(after + 1);
  });
});

describe('as-you-type', () => {
  it('runs the query INCREMENTALLY on every keystroke', () => {
    render(engine);
    act(() => { api.openSearch(); });
    act(() => { api.setQuery('needle'); });
    expect(engine.searchNext).toHaveBeenCalledWith(
      'needle',
      { caseSensitive: false, wholeWord: false, regex: false },
      true,
    );
  });

  // The options travel with the query, or a toggle would silently keep searching the old way.
  it('re-runs with the new options when a toggle flips', () => {
    render(engine);
    act(() => { api.openSearch(); });
    act(() => { api.setQuery('needle'); });
    act(() => { api.toggleCaseSensitive(); });
    expect(engine.searchNext).toHaveBeenLastCalledWith(
      'needle',
      { caseSensitive: true, wholeWord: false, regex: false },
      true,
    );
  });

  // The paired negative: an EMPTY query clears rather than searching, or the addon highlights
  // every cell in the buffer.
  it('clears instead of searching when the query is emptied', () => {
    render(engine);
    act(() => { api.openSearch(); });
    act(() => { api.setQuery('needle'); });
    // A LIVE count first, exactly as the `close()` case does. Asserting the zero result without
    // having moved off it is vacuous: `setResult(NO_RESULT)` could be deleted from this arm and
    // the assertion would still pass, leaving the bar reading "3 of 7" over no highlights.
    act(() => { engine.emit({ resultIndex: 2, resultCount: 7 }); });
    expect(api.result).toEqual({ resultIndex: 2, resultCount: 7 });
    engine.clearSearch.mockClear();
    engine.searchNext.mockClear();
    act(() => { api.setQuery(''); });
    expect(engine.clearSearch).toHaveBeenCalledTimes(1);
    expect(engine.searchNext).not.toHaveBeenCalled();
    expect(api.result).toEqual({ resultIndex: -1, resultCount: 0 });
  });

  // An unparseable pattern in regex mode would make the addon throw.
  it('clears instead of searching on an invalid regex', () => {
    render(engine);
    act(() => { api.openSearch(); });
    act(() => { api.toggleRegex(); });
    engine.searchNext.mockClear();
    act(() => { api.setQuery('([unclosed'); });
    expect(engine.searchNext).not.toHaveBeenCalled();
    expect(engine.clearSearch).toHaveBeenCalled();
  });

  /**
   * Nothing runs while the bar is CLOSED. This is the case that pins the whole reason the state
   * was lifted: with the effect ungated it fires at mount with an empty query and calls
   * `clearSearch()` — which is precisely how a second `TerminalSearchBar` used to wipe the
   * first one's live search.
   */
  it('does not touch the engine while closed', () => {
    render(engine);
    act(() => { api.setQuery('needle'); });
    expect(engine.searchNext).not.toHaveBeenCalled();
    expect(engine.clearSearch).not.toHaveBeenCalled();
  });
});

describe('next / previous', () => {
  it('runs the live query forward, NON-incrementally', () => {
    render(engine);
    act(() => { api.openSearch(); });
    act(() => { api.setQuery('needle'); });
    engine.searchNext.mockClear();
    act(() => { api.next(); });
    expect(engine.searchNext).toHaveBeenCalledWith(
      'needle',
      { caseSensitive: false, wholeWord: false, regex: false },
      false,
    );
  });

  it('runs it backward', () => {
    render(engine);
    act(() => { api.openSearch(); });
    act(() => { api.setQuery('needle'); });
    act(() => { api.previous(); });
    expect(engine.searchPrevious).toHaveBeenCalledWith(
      'needle',
      { caseSensitive: false, wholeWord: false, regex: false },
    );
  });

  it('does nothing with an empty query', () => {
    render(engine);
    act(() => { api.openSearch(); });
    engine.searchNext.mockClear();
    act(() => { api.next(); });
    act(() => { api.previous(); });
    expect(engine.searchNext).not.toHaveBeenCalled();
    expect(engine.searchPrevious).not.toHaveBeenCalled();
  });
});

describe('the result subscription', () => {
  /**
   * Not at mount, because the engine does not exist yet — the hook is declared above the effect
   * that builds it. Rendering with a null engine first is what makes that ordering real here.
   */
  it('subscribes only once the bar opens', () => {
    render(null);
    expect(engine.onSearchResults).not.toHaveBeenCalled();
    render(engine);
    expect(engine.onSearchResults).not.toHaveBeenCalled();
    act(() => { api.openSearch(); });
    expect(engine.onSearchResults).toHaveBeenCalledTimes(1);
  });

  it('surfaces the N-of-M the addon reports', () => {
    render(engine);
    act(() => { api.openSearch(); });
    act(() => { engine.emit({ resultIndex: 2, resultCount: 7 }); });
    expect(api.result).toEqual({ resultIndex: 2, resultCount: 7 });
  });

  it('disposes the subscription when the bar closes', () => {
    render(engine);
    act(() => { api.openSearch(); });
    act(() => { api.close(); });
    expect(engine.dispose).toHaveBeenCalled();
  });
});

describe('close', () => {
  it('clears the highlights and hands the keyboard back to the shell', () => {
    render(engine);
    act(() => { api.openSearch(); });
    act(() => { api.setQuery('needle'); });
    engine.clearSearch.mockClear();
    act(() => { api.close(); });
    expect(api.open).toBe(false);
    expect(engine.clearSearch).toHaveBeenCalled();
    expect(engine.focus).toHaveBeenCalledTimes(1);
  });

  /**
   * And RESETS every field the bar drew, which is what the old bar got free by unmounting.
   * Lifting the state out of the component removed that reset, so it has to be performed
   * deliberately or closing quietly becomes "hide".
   */
  it('resets the query and the counter', () => {
    render(engine);
    act(() => { api.openSearch(); });
    act(() => { api.setQuery('needle'); });
    act(() => { engine.emit({ resultIndex: 0, resultCount: 4 }); });
    act(() => { api.close(); });
    expect(api.query).toBe('');
    expect(api.result).toEqual({ resultIndex: -1, resultCount: 0 });
  });

  /**
   * The three toggles reset TOO, and they get their own case because the query's reset does not
   * imply theirs — they are separate `useState` slots, and a `close()` that reset only the query
   * passed the case above while leaving Match Case / Whole Word / Regex latched on from a search
   * the user finished minutes ago. Resetting one and keeping the others matches neither the old
   * behaviour nor a deliberate new one, which is the whole reason to pin it.
   */
  it('resets the option toggles as well as the query', () => {
    render(engine);
    act(() => { api.openSearch(); });
    act(() => { api.toggleCaseSensitive(); });
    act(() => { api.toggleWholeWord(); });
    act(() => { api.toggleRegex(); });
    expect([api.caseSensitive, api.wholeWord, api.regex]).toEqual([true, true, true]);
    act(() => { api.close(); });
    expect([api.caseSensitive, api.wholeWord, api.regex]).toEqual([false, false, false]);
  });
});

/**
 * THE terminal swap — `TerminalPane`'s reuse path changing `terminalId` on this same component
 * instance (`useSurfaceRelocation.ts`, review 098 A1).
 *
 * Nothing here unmounts when that happens, so every field survives a change of the thing it
 * describes unless something resets it deliberately. The two halves are driven separately below
 * because they fail separately: the VIEW keeping A's query is visible, while the result
 * subscription staying attached to A's SearchAddon is not — B's bar would simply count A's
 * matches, and nothing else in the app would notice.
 */
describe('a terminalId change', () => {
  const swap = (e: FakeEngine) => render(e, 'tm-b');

  it('closes the bar and clears the query and the toggles', () => {
    render(engine);
    act(() => { api.openSearch(); });
    act(() => { api.setQuery('needle'); });
    act(() => { api.toggleCaseSensitive(); });
    act(() => { api.toggleWholeWord(); });
    act(() => { api.toggleRegex(); });
    act(() => { engine.emit({ resultIndex: 2, resultCount: 7 }); });

    swap(makeEngine());

    expect(api.open).toBe(false);
    expect(api.query).toBe('');
    expect([api.caseSensitive, api.wholeWord, api.regex]).toEqual([false, false, false]);
    expect(api.result).toEqual({ resultIndex: -1, resultCount: 0 });
  });

  /**
   * ...and the subscription follows the terminal. Closing is the mechanism: `open` going false
   * disposes the subscription against A, and the next open attaches to whatever the ref then
   * holds. Without the reset neither happens — `[open, engineRef]` sees no change at all, so the
   * bar goes on being fed by A's addon over B's buffer.
   */
  it('drops the subscription to the old engine and re-establishes it against the new one', () => {
    const next = makeEngine();
    render(engine);
    act(() => { api.openSearch(); });
    expect(engine.onSearchResults).toHaveBeenCalledTimes(1);

    swap(next);
    expect(engine.dispose).toHaveBeenCalled();
    expect(next.onSearchResults).not.toHaveBeenCalled();

    act(() => { api.openSearch(); });
    expect(next.onSearchResults).toHaveBeenCalledTimes(1);
    // And the old one is never subscribed again, so a swap cannot leave two live feeds.
    expect(engine.onSearchResults).toHaveBeenCalledTimes(1);
    act(() => { next.emit({ resultIndex: 0, resultCount: 3 }); });
    expect(api.result).toEqual({ resultIndex: 0, resultCount: 3 });
  });

  // The paired negative: a re-render with the SAME terminal must not throw the user's search
  // away. The reset is keyed on the identity, not on rendering.
  it('leaves the search alone when the terminal is unchanged', () => {
    render(engine);
    act(() => { api.openSearch(); });
    act(() => { api.setQuery('needle'); });
    render(engine);
    expect(api.open).toBe(true);
    expect(api.query).toBe('needle');
  });
});

/**
 * THE property `surfaceChrome`'s no-op rule rests on.
 *
 * `same()` compares every published callback by identity, so one rebuilt per render makes every
 * publish an observable change — and every canvas node re-renders on every notification. The
 * dangerous pair is `next`/`previous`, which need the live query and options: closing over them
 * is the obvious way to write them and is exactly what would break this.
 */
describe('callback identity', () => {
  it('keeps every callback stable across a state change', () => {
    render(engine);
    const before = {
      setQuery: api.setQuery,
      toggleCaseSensitive: api.toggleCaseSensitive,
      toggleWholeWord: api.toggleWholeWord,
      toggleRegex: api.toggleRegex,
      next: api.next,
      previous: api.previous,
      close: api.close,
      openSearch: api.openSearch,
    };
    act(() => { api.openSearch(); });
    act(() => { api.setQuery('needle'); });
    act(() => { api.toggleCaseSensitive(); });
    expect(api.setQuery).toBe(before.setQuery);
    expect(api.toggleCaseSensitive).toBe(before.toggleCaseSensitive);
    expect(api.toggleWholeWord).toBe(before.toggleWholeWord);
    expect(api.toggleRegex).toBe(before.toggleRegex);
    expect(api.next).toBe(before.next);
    expect(api.previous).toBe(before.previous);
    expect(api.close).toBe(before.close);
    expect(api.openSearch).toBe(before.openSearch);
  });

  // The paired positive: stable identity must not mean a stale VALUE. `next` reads the query
  // through a ref precisely so it can be both.
  it('still sees the latest query through the stable next()', () => {
    render(engine);
    act(() => { api.openSearch(); });
    const next = api.next;
    act(() => { api.setQuery('first'); });
    act(() => { api.setQuery('second'); });
    act(() => { next(); });
    expect(engine.searchNext).toHaveBeenLastCalledWith(
      'second',
      { caseSensitive: false, wholeWord: false, regex: false },
      false,
    );
  });
});
