/**
 * @jest-environment jsdom
 *
 * The pane-title menu's **Find…** item — `plan/027` R2.
 *
 * `PaneContextMenu` reaches nothing per-terminal on its own: every other action in it is Redux,
 * a store + tree walk, a service function or a poller singleton. Find is the first, and it goes
 * through `surfaceChrome` — the registry that already carries `openContextMenu` across the same
 * boundary.
 *
 * The case that matters most is the one a "did it call something?" assertion would miss: the
 * item must open search for the terminal whose title was right-clicked and for NO OTHER. The
 * registry is keyed by terminalId and a menu is opened over one pane at a time, so a lookup that
 * used the wrong id — or none — would still call *an* `openSearch` and still look correct.
 *
 * Rendered for real (`react-dom/client` + `React.act`) against a trimmed store, the pattern
 * `usePaneMuteState.test.tsx` established; there is no testing-library in this repo.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import tabsReducer from '../../../store/slices/tabsSlice';
import panesReducer from '../../../store/slices/panesSlice';
import settingsReducer from '../../../store/slices/settingsSlice';
import { PaneContextMenu } from '../PaneContextMenu';
import {
  setSurfaceChrome, clearSurfaceChrome, __resetSurfaceChromeForTest,
} from '../../../services/surfaceChrome';

/**
 * `tauri-bridge` registers its event listeners AT MODULE LOAD and dies outside a Tauri WebView
 * (`window.__TAURI_INTERNALS__` is undefined), taking the whole worker with it. It is nowhere
 * near this menu, but it is reachable from the store's import graph, so it has to be stubbed
 * before anything pulls it in.
 */
jest.mock('../../../api/tauri-bridge', () => ({ __esModule: true, default: {} }));

// The tracker polls the backend for the pane's coding agent; irrelevant here and its refresh
// would leave a floating promise rejecting after the test ends.
jest.mock('../../../services/AgentSchemeTracker', () => ({
  agentSchemeTracker: {
    getDetectedAgentForTerminal: () => null,
    refreshNow: () => Promise.resolve(),
    subscribe: () => () => {},
  },
}));

function makeStore() {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer, settings: settingsReducer },
  });
}

const chromeFor = (openSearch: jest.Mock) => ({
  atBottom: true,
  suggest: { open: false, items: [], selectedIndex: 0, focused: false, anchor: null },
  search: {
    open: false,
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
  },
  scrollToBottom: jest.fn(),
  pickSuggestion: jest.fn(),
  openContextMenu: jest.fn(),
  restartSession: jest.fn(),
  dismissSessionClosed: jest.fn(),
  openSearch,
});

let container: HTMLDivElement;
let root: Root;
let onClose: jest.Mock;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  __resetSurfaceChromeForTest();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onClose = jest.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetSurfaceChromeForTest();
});

const render = (terminalId?: string) =>
  act(() => {
    root.render(
      <Provider store={makeStore()}>
        <PaneContextMenu
          x={10}
          y={20}
          paneId="pn-1"
          paneName="Pane 1"
          terminalId={terminalId}
          onClose={onClose}
        />
      </Provider>,
    );
  });

// The menu portals to <body>, so it is never inside `container`.
const findItem = () =>
  [...document.querySelectorAll<HTMLButtonElement>('.pane-context-menu .context-menu-item')]
    .find((b) => b.textContent?.includes('Find'))!;

describe('PaneContextMenu — Find…', () => {
  it('opens search for its OWN terminal and no other', () => {
    const mine = jest.fn();
    const other = jest.fn();
    setSurfaceChrome('tm-mine', {}, chromeFor(mine));
    setSurfaceChrome('tm-other', {}, chromeFor(other));

    render('tm-mine');
    act(() => { findItem().dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(mine).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  // Every other item in this menu closes on activation; an item that left it open would sit over
  // the terminal it just asked to focus.
  it('closes the menu after acting', () => {
    setSurfaceChrome('tm-mine', {}, chromeFor(jest.fn()));
    render('tm-mine');
    act(() => { findItem().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * `terminalId` is optional on this component and genuinely absent for a pane with no terminal.
   * Disabled rather than hidden, matching the "Color scheme for agent" fallback beside it: an
   * item that looks live and calls nothing is worse than one that is visibly unavailable.
   */
  it('is disabled, and inert, with no terminal', () => {
    render(undefined);
    const item = findItem();
    expect(item.disabled).toBe(true);
    act(() => { item.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * ...and equally when a terminal exists but nothing is PUBLISHING its chrome — the window
   * between a `TerminalDisplay` unmounting and the next one registering. There is nothing to
   * call in that state, so the item must not pretend otherwise.
   */
  it('is disabled when nothing is publishing chrome for the terminal', () => {
    render('tm-unpublished');
    expect(findItem().disabled).toBe(true);
  });

  // The paired positive for the two negatives above: with a publisher, it is live.
  it('is enabled once a publisher appears', () => {
    setSurfaceChrome('tm-mine', {}, chromeFor(jest.fn()));
    render('tm-mine');
    expect(findItem().disabled).toBe(false);
  });

  /**
   * Each disabled reason explains ITSELF.
   *
   * The tooltip used to be keyed on `terminalId` alone, so the case that most needs explaining —
   * a terminal exists but nothing is publishing chrome for it yet — showed a greyed item with no
   * tooltip at all, beside a disabled “Color scheme for agent” that always carries one. A greyed
   * control with no reason reads as a bug in the app rather than a state of the pane.
   */
  it('gives each disabled reason its own tooltip, and the live item none', () => {
    render(undefined);
    expect(findItem().title).toBe('This pane has no terminal to search');

    render('tm-unpublished');
    const starting = findItem().title;
    expect(starting).not.toBe('');
    expect(starting).not.toBe('This pane has no terminal to search');

    setSurfaceChrome('tm-mine', {}, chromeFor(jest.fn()));
    render('tm-mine');
    expect(findItem().title).toBe('');
  });

  /**
   * ...and the item TRACKS availability while the menu stays open.
   *
   * The disabled check used to read the registry at render and never subscribe, so the answer
   * froze the moment the menu opened. Both directions are driven because they fail differently:
   * a stale-greyed item is merely useless, while a stale-enabled one looks live and then does
   * nothing at all when clicked, because the click re-reads the registry and finds nothing.
   */
  it('becomes enabled when a publisher appears under the open menu', () => {
    render('tm-late');
    expect(findItem().disabled).toBe(true);
    act(() => { setSurfaceChrome('tm-late', {}, chromeFor(jest.fn())); });
    expect(findItem().disabled).toBe(false);
  });

  it('becomes disabled when the publisher goes away under the open menu', () => {
    const owner = {};
    setSurfaceChrome('tm-mine', owner, chromeFor(jest.fn()));
    render('tm-mine');
    expect(findItem().disabled).toBe(false);
    act(() => { clearSurfaceChrome('tm-mine', owner); });
    expect(findItem().disabled).toBe(true);
  });
});
