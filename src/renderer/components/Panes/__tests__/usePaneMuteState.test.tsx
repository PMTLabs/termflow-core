/**
 * @jest-environment jsdom
 *
 * `usePaneMuteState` — the pane/tab mute selector pair shared by TerminalPane's
 * header bell, PaneContextMenu, and TerminalDisplay's context menu item (plan/025
 * §2.7). Extracted from two verbatim copies (`TerminalPane.tsx`, `PaneContextMenu.tsx`)
 * so a third, added for TerminalDisplay, could not silently diverge from either.
 *
 * Exercised against a real (trimmed) Redux store rather than mocked selectors: the
 * behaviour this hook exists to preserve — pane flag vs. tab flag vs. their OR, and
 * `toggle` only ever touching the pane's OWN flag — is a property of the STORE SHAPE
 * (two separate slices), not of the hook's internals, so a hand-built fake state
 * would prove nothing a mock couldn't already assert trivially. Mirrors the RTL-free
 * react-dom/client + act pattern used by useRestartHotkey.test.tsx /
 * TerminalContainer.test.tsx.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import tabsReducer, { addTab, setTabMuted } from '../../../store/slices/tabsSlice';
import panesReducer, { addTabTree, type PaneNode } from '../../../store/slices/panesSlice';
import { usePaneMuteState } from '../usePaneMuteState';

function makeStore() {
  return configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } });
}

const leaf = (id: string, terminalId: string): PaneNode => ({ id, type: 'terminal', terminalId });

let container: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof makeStore>;
let lastResult: ReturnType<typeof usePaneMuteState> | null;

const Host: React.FC<{ paneId?: string; terminalId?: string }> = ({ paneId, terminalId }) => {
  lastResult = usePaneMuteState(paneId, terminalId);
  return null;
};

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  store = makeStore();
  lastResult = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (paneId?: string, terminalId?: string) =>
  act(() => {
    root.render(
      <Provider store={store}>
        <Host paneId={paneId} terminalId={terminalId} />
      </Provider>,
    );
  });

describe('usePaneMuteState', () => {
  it('reads the pane leaf\'s own flag, unmuted by default (absence, not a literal false)', () => {
    store.dispatch(addTab({ id: 'tb-1', title: 'Tab', shellType: 'default' }));
    store.dispatch(addTabTree({ tabId: 'tb-1', tree: leaf('pane-1', 'tm-1') }));
    render('pane-1', 'tm-1');
    expect(lastResult).toMatchObject({ paneMuted: false, tabMuted: false, effectiveMuted: false });
  });

  it('toggle flips the PANE flag only, and effectiveMuted follows it', () => {
    store.dispatch(addTab({ id: 'tb-1', title: 'Tab', shellType: 'default' }));
    store.dispatch(addTabTree({ tabId: 'tb-1', tree: leaf('pane-1', 'tm-1') }));
    render('pane-1', 'tm-1');

    act(() => { lastResult!.toggle(); });
    expect(lastResult).toMatchObject({ paneMuted: true, effectiveMuted: true });

    act(() => { lastResult!.toggle(); });
    expect(lastResult).toMatchObject({ paneMuted: false, effectiveMuted: false });
  });

  /**
   * The override direction: a tab mute makes the pane read as effectively muted
   * without ever touching the pane's own flag, and `toggle` — unmute the tab from
   * here is not offered anywhere; that lives on the tab context menu — still only
   * ever flips the pane's flag, leaving the tab flag exactly as it was.
   */
  it('tabMuted overrides into effectiveMuted; toggle never touches the tab flag', () => {
    store.dispatch(addTab({ id: 'tb-1', title: 'Tab', shellType: 'default' }));
    store.dispatch(setTabMuted({ id: 'tb-1', muted: true }));
    store.dispatch(addTabTree({ tabId: 'tb-1', tree: leaf('pane-1', 'tm-1') }));
    render('pane-1', 'tm-1');
    expect(lastResult).toMatchObject({ paneMuted: false, tabMuted: true, effectiveMuted: true });

    act(() => { lastResult!.toggle(); });
    expect(lastResult).toMatchObject({ paneMuted: true, tabMuted: true, effectiveMuted: true });
  });

  // tabMuted is resolved via terminalId -> owning tab, so it stays false with no
  // terminalId even when the tab is muted -- matching the pre-extraction selector.
  it('tabMuted reads as false with no terminalId to resolve the owning tab from', () => {
    store.dispatch(addTab({ id: 'tb-1', title: 'Tab', shellType: 'default' }));
    store.dispatch(setTabMuted({ id: 'tb-1', muted: true }));
    store.dispatch(addTabTree({ tabId: 'tb-1', tree: leaf('pane-1', 'tm-1') }));
    render('pane-1', undefined);
    expect(lastResult).toMatchObject({ paneMuted: false, tabMuted: false, effectiveMuted: false });
  });

  /**
   * `TerminalDisplay`'s own `paneId` prop is optional (a relocated surface can be
   * hosted with none), and the Rules of Hooks forbid calling this conditionally --
   * so with no paneId it must degrade to "unmuted, toggle does nothing" rather than
   * throw or read some other pane's flag. `tabMuted` still resolves off terminalId
   * alone, independent of paneId, since the tab-level flag is not pane-scoped.
   */
  it('with no paneId, the pane flag reads false and toggle is a no-op', () => {
    store.dispatch(addTab({ id: 'tb-1', title: 'Tab', shellType: 'default' }));
    store.dispatch(setTabMuted({ id: 'tb-1', muted: true }));
    store.dispatch(addTabTree({ tabId: 'tb-1', tree: leaf('pane-1', 'tm-1') }));
    render(undefined, 'tm-1');
    expect(lastResult).toMatchObject({ paneMuted: false, tabMuted: true, effectiveMuted: true });

    const panesStateBefore = store.getState().panes;
    act(() => { lastResult!.toggle(); });
    // No dispatch happened at all -- same state reference, not just equal value.
    expect(store.getState().panes).toBe(panesStateBefore);
  });

  // Self-contained lookup: the pane flag is found by walking every tab's tree for
  // the matching leaf id, not by trusting a caller-supplied owning tab.
  it('finds the pane leaf regardless of which tab currently owns it', () => {
    store.dispatch(addTab({ id: 'tb-1', title: 'Tab one', shellType: 'default' }));
    store.dispatch(addTab({ id: 'tb-2', title: 'Tab two', shellType: 'default' }));
    store.dispatch(addTabTree({ tabId: 'tb-1', tree: null }));
    store.dispatch(addTabTree({ tabId: 'tb-2', tree: leaf('pane-9', 'tm-9') }));
    render('pane-9', 'tm-9');
    expect(lastResult).toMatchObject({ paneMuted: false, tabMuted: false });

    act(() => { lastResult!.toggle(); });
    expect(lastResult!.paneMuted).toBe(true);
  });
});
