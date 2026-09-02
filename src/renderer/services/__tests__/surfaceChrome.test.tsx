/**
 * @jest-environment jsdom
 *
 * `surfaceChrome` (`plan/020` §5) — the registry that lets the Canvas overlay draw a terminal's
 * floating chrome while `TerminalDisplay`, which owns the state, stays in the pane.
 *
 * Two properties carry real weight and neither is visible from a component test:
 *  - the NO-OP rule. Every canvas node subscribes, so a write that notifies for an unchanged
 *    value re-renders the whole workspace — and `atBottom` is recomputed on every scroll event
 *    of every terminal.
 *  - the OWNER check. The published state changes on nearly every keystroke, so it carries no
 *    identity of its own; without an owner token a remount's cleanup wipes the registration the
 *    new instance has already made. That is the `surfaceHosts` spike-004 Q5 failure exactly.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import {
  setSurfaceChrome, clearSurfaceChrome, subscribeSurfaceChrome, useSurfaceChrome,
  useSurfaceChromeAvailable,
  __getSurfaceChromeForTest, __resetSurfaceChromeForTest, SurfaceChromeState,
} from '../surfaceChrome';

const noop = () => {};
const pick = () => {};
const openMenu = () => {};
const restart = () => {};
const dismiss = () => {};
const openSearch = () => {};

/**
 * The search view state, as one shared object (`plan/027` §1.4).
 *
 * Held at module scope with the other stable callbacks so a plain `state()` twice really is
 * unchanged. Rebuilding it per call would hand `same()` a fresh identity for each of its seven
 * callbacks and make the no-op cases below pass for the wrong reason — which is exactly the
 * failure the real publisher's `useCallback`s exist to avoid.
 */
const SEARCH = {
  open: false,
  query: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  result: { resultIndex: -1, resultCount: 0 },
  focusToken: 0,
  setQuery: () => {},
  toggleCaseSensitive: () => {},
  toggleWholeWord: () => {},
  toggleRegex: () => {},
  next: () => {},
  previous: () => {},
  close: () => {},
};

const state = (over: Partial<SurfaceChromeState> = {}): SurfaceChromeState => ({
  atBottom: true,
  suggest: { open: false, items: [], selectedIndex: 0, focused: false, anchor: null },
  search: SEARCH,
  scrollToBottom: noop,
  pickSuggestion: pick,
  openContextMenu: openMenu,
  restartSession: restart,
  dismissSessionClosed: dismiss,
  openSearch,
  ...over,
});

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => __resetSurfaceChromeForTest());

describe('surfaceChrome registry', () => {
  it('publishes and reads back under the terminal id', () => {
    const owner = {};
    const s = state();
    setSurfaceChrome('tm-1', owner, s);
    expect(__getSurfaceChromeForTest('tm-1')).toBe(s);
    expect(__getSurfaceChromeForTest('tm-2')).toBeNull();
  });

  it('notifies only when something observable changed', () => {
    const owner = {};
    let notifications = 0;
    const unsubscribe = subscribeSurfaceChrome(() => { notifications += 1; });

    setSurfaceChrome('tm-1', owner, state());
    expect(notifications).toBe(1);

    // A fresh object with identical field values — what a re-render of the pane produces,
    // because `useCommandSuggest` returns a spread.
    setSurfaceChrome('tm-1', owner, state());
    expect(notifications).toBe(1);

    setSurfaceChrome('tm-1', owner, state({ atBottom: false }));
    expect(notifications).toBe(2);

    unsubscribe();
    setSurfaceChrome('tm-1', owner, state({ atBottom: true }));
    expect(notifications).toBe(2);
  });

  // The fields the no-op rule has to look INSIDE `suggest` for. Listed one at a time so a
  // comparison that quietly drops one is caught by name rather than by a vague total.
  it.each([
    ['open', { open: true }],
    ['items', { items: ['git status'] }],
    ['selectedIndex', { selectedIndex: 2 }],
    ['focused', { focused: true }],
    ['anchor', { anchor: { x: 1, y: 2, cellHeight: 3 } }],
  ])('treats a changed suggest.%s as a change', (_name, over) => {
    const owner = {};
    let notifications = 0;
    subscribeSurfaceChrome(() => { notifications += 1; });
    setSurfaceChrome('tm-1', owner, state());
    setSurfaceChrome('tm-1', owner, state({ suggest: { ...state().suggest, ...(over as object) } }));
    expect(notifications).toBe(2);
  });

  it.each([
    ['scrollToBottom', { scrollToBottom: () => {} }],
    ['pickSuggestion', { pickSuggestion: () => {} }],
    // Added with the context-menu trigger (`plan/021` R2). Every published callback needs its
    // own case: one left out of `same()` is a stale closure the overlay keeps calling, and
    // nothing else would notice.
    ['openContextMenu', { openContextMenu: () => {} }],
    // ...and the session-closed actions (`plan/024` Req 4). Same hazard, one step worse: a stale
    // `restartSession` would respawn against the profile and cwd of a pane that has since been
    // closed or re-homed.
    ['restartSession', { restartSession: () => {} }],
    ['dismissSessionClosed', { dismissSessionClosed: () => {} }],
    // ...and the search TRIGGER (`plan/027` §1.4). It is published beside `search` rather than
    // inside it because nothing that calls it renders anything — the overlay's Ctrl+F binding,
    // and both context menus' Find item.
    ['openSearch', { openSearch: () => {} }],
  ])('treats a changed %s identity as a change', (_name, over) => {
    const owner = {};
    let notifications = 0;
    subscribeSurfaceChrome(() => { notifications += 1; });
    setSurfaceChrome('tm-1', owner, state());
    setSurfaceChrome('tm-1', owner, state(over as Partial<SurfaceChromeState>));
    expect(notifications).toBe(2);
  });

  /**
   * The `search` sub-fields (`plan/027` §1.4), one row each for the same reason the `suggest`
   * table above has one row each — a comparison that quietly drops one is named, not lost in a
   * total. This wrapper is rebuilt on every render of the pane, so it is compared field by
   * field; its CALLBACKS are in the same table because they live inside the wrapper and so
   * cannot appear in the top-level identity table above.
   *
   * A callback missing from `same()` is worse than a missed re-render: the overlay goes on
   * calling a STALE closure, and nothing else in the app notices.
   */
  it.each([
    ['open', { open: true }],
    ['query', { query: 'needle' }],
    ['caseSensitive', { caseSensitive: true }],
    ['wholeWord', { wholeWord: true }],
    ['regex', { regex: true }],
    ['focusToken', { focusToken: 1 }],
    ['result.resultIndex', { result: { resultIndex: 0, resultCount: 0 } }],
    ['result.resultCount', { result: { resultIndex: -1, resultCount: 3 } }],
    ['setQuery', { setQuery: () => {} }],
    ['toggleCaseSensitive', { toggleCaseSensitive: () => {} }],
    ['toggleWholeWord', { toggleWholeWord: () => {} }],
    ['toggleRegex', { toggleRegex: () => {} }],
    ['next', { next: () => {} }],
    ['previous', { previous: () => {} }],
    ['close', { close: () => {} }],
  ])('treats a changed search.%s as a change', (_name, over) => {
    const owner = {};
    let notifications = 0;
    subscribeSurfaceChrome(() => { notifications += 1; });
    setSurfaceChrome('tm-1', owner, state());
    setSurfaceChrome('tm-1', owner, state({ search: { ...SEARCH, ...(over as object) } }));
    expect(notifications).toBe(2);
  });

  // The paired negative for the table above: a FRESH wrapper carrying the same values must not
  // notify. `useTerminalSearch` returns a new object on every render, so comparing `search` by
  // identity would wake every canvas node on every keystroke anywhere in the app.
  it('no-ops for a fresh search wrapper with identical values', () => {
    const owner = {};
    let notifications = 0;
    subscribeSurfaceChrome(() => { notifications += 1; });
    setSurfaceChrome('tm-1', owner, state());
    setSurfaceChrome('tm-1', owner, state({ search: { ...SEARCH } }));
    expect(notifications).toBe(1);
  });

  it('still no-ops when every field, callbacks included, is unchanged', () => {
    // The paired negative for the case above: with a fresh arrow per publish this would notify
    // on every keystroke, and every canvas node re-renders on every notification.
    const owner = {};
    let notifications = 0;
    subscribeSurfaceChrome(() => { notifications += 1; });
    setSurfaceChrome('tm-1', owner, state());
    setSurfaceChrome('tm-1', owner, state());
    expect(notifications).toBe(1);
  });

  it('lets a new owner take the slot, and ignores the old one clearing it', () => {
    const first = {};
    const second = {};
    setSurfaceChrome('tm-1', first, state({ atBottom: false }));
    // A remount publishes before the outgoing instance's cleanup runs.
    const live = state({ atBottom: true });
    setSurfaceChrome('tm-1', second, live);
    clearSurfaceChrome('tm-1', first);          // the stale cleanup
    expect(__getSurfaceChromeForTest('tm-1')).toBe(live);

    clearSurfaceChrome('tm-1', second);
    expect(__getSurfaceChromeForTest('tm-1')).toBeNull();
  });

  it('re-publishes for a new owner even when the value is identical', () => {
    // The no-op rule is keyed on owner AND value: same value, different owner must still take
    // the slot, or the outgoing instance's cleanup would then clear a live registration.
    const first = {};
    const second = {};
    setSurfaceChrome('tm-1', first, state());
    setSurfaceChrome('tm-1', second, state());
    clearSurfaceChrome('tm-1', first);
    expect(__getSurfaceChromeForTest('tm-1')).not.toBeNull();
  });
});

describe('useSurfaceChrome', () => {
  let container: HTMLDivElement;
  let root: Root;
  let renders = 0;

  const Probe: React.FC<{ id: string | null }> = ({ id }) => {
    const chrome = useSurfaceChrome(id);
    renders += 1;
    return <span>{chrome ? String(chrome.atBottom) : 'none'}</span>;
  };

  beforeEach(() => {
    renders = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('delivers updates for its own terminal', () => {
    const owner = {};
    act(() => { root.render(<Probe id="tm-1" />); });
    expect(container.textContent).toBe('none');

    act(() => { setSurfaceChrome('tm-1', owner, state({ atBottom: false })); });
    expect(container.textContent).toBe('false');

    act(() => { clearSurfaceChrome('tm-1', owner); });
    expect(container.textContent).toBe('none');
  });

  /**
   * The reason the hook takes `string | null`. Every canvas node calls it and only the overlaid
   * one passes an id; an opted-out node must not re-render when an unrelated terminal scrolls.
   */
  it('never re-renders a consumer that opted out', () => {
    act(() => { root.render(<Probe id={null} />); });
    const before = renders;
    act(() => { setSurfaceChrome('tm-1', {}, state({ atBottom: false })); });
    expect(renders).toBe(before);
    expect(container.textContent).toBe('none');
  });

  // Paired with the negative above: a subscriber for a DIFFERENT terminal is equally unaffected,
  // which is what makes one busy terminal cheap on a canvas full of them.
  it('never re-renders a consumer watching another terminal', () => {
    act(() => { root.render(<Probe id="tm-other" />); });
    const before = renders;
    act(() => { setSurfaceChrome('tm-1', {}, state({ atBottom: false })); });
    expect(renders).toBe(before);
  });
});

/**
 * `useSurfaceChromeAvailable` — PRESENCE, subscribed to (`plan/027` R2).
 *
 * `PaneContextMenu` needs an answer that stays right while its menu is open, and cannot afford
 * `useSurfaceChrome`'s answer, which changes on nearly every keystroke. The boolean snapshot is
 * what reconciles the two, and the second case is the one that proves it: without it this hook
 * would be `useSurfaceChrome` with a `!!` on the end, and the menu would re-render for every
 * character typed into the terminal it is sitting over.
 */
describe('useSurfaceChromeAvailable', () => {
  let container: HTMLDivElement;
  let root: Root;
  let renders = 0;

  const Probe: React.FC<{ id: string | null }> = ({ id }) => {
    const available = useSurfaceChromeAvailable(id);
    renders += 1;
    return <span>{String(available)}</span>;
  };

  beforeEach(() => {
    renders = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('flips in BOTH directions while the consumer stays mounted', () => {
    const owner = {};
    act(() => { root.render(<Probe id="tm-1" />); });
    expect(container.textContent).toBe('false');

    // A pane's terminal finishing its start-up: the Find item must stop being greyed out.
    act(() => { setSurfaceChrome('tm-1', owner, state()); });
    expect(container.textContent).toBe('true');

    // ...and an MCP client closing that terminal under an open menu: it must stop being live,
    // or the click silently does nothing.
    act(() => { clearSurfaceChrome('tm-1', owner); });
    expect(container.textContent).toBe('false');
  });

  it('does NOT re-render when a published value changes', () => {
    act(() => { root.render(<Probe id="tm-1" />); });
    act(() => { setSurfaceChrome('tm-1', {}, state()); });
    const before = renders;
    // A scroll, or a keystroke in the find bar — a write that changes the state but not whether
    // there IS one. `useSyncExternalStore` compares snapshots with `Object.is`, so an unchanged
    // boolean ends here.
    act(() => { setSurfaceChrome('tm-1', {}, state({ atBottom: false })); });
    expect(renders).toBe(before);
    expect(container.textContent).toBe('true');
  });

  // Same opt-out as `useSurfaceChrome`, for the same reason: a pane with no terminal has no id
  // to ask about, and a hook cannot be called conditionally.
  it('reads false for a null id and never wakes for anyone else', () => {
    act(() => { root.render(<Probe id={null} />); });
    const before = renders;
    act(() => { setSurfaceChrome('tm-1', {}, state()); });
    expect(renders).toBe(before);
    expect(container.textContent).toBe('false');
  });
});
