/**
 * Canvas Mode's entry points, against a real tabs reducer.
 *
 * The single-instance rule is the one with teeth. Two canvas tabs would mount two
 * `CanvasMode`s, and each mounts a `NodeTerminal` per terminal — two registrants for the
 * same terminalId, which `surfaceHosts` explicitly forbids and which would relocate every
 * live terminal into whichever host registered last.
 *
 * The rest is about not stranding the user: toggling off has to land somewhere real even
 * when the tab it came from has been closed underneath it.
 */

import tabsReducer, { addTab, setActiveTab } from '../../store/slices/tabsSlice';
import { CANVAS_SHELL_TYPE } from '../tabKinds';

type TabsState = ReturnType<typeof tabsReducer>;
let state: TabsState = tabsReducer(undefined, { type: '@@init' });
const dispatch = jest.fn((action: { type: string; payload?: unknown }) => {
  state = tabsReducer(state, action as never);
  return action;
});

jest.mock('../../store', () => ({
  store: {
    getState: () => ({ tabs: state }),
    dispatch: (a: never) => dispatch(a),
  },
}));

// eslint-disable-next-line import/first
import {
  openCanvasTab, leaveCanvasTab, toggleCanvasTab, isCanvasTabActive,
  __resetCanvasReturnForTest,
} from '../openCanvas';

const shell = (id: string) => addTab({ id, title: id, shellType: 'bash' } as never);
const canvasTabs = () => state.tabs.filter((t) => t.shellType === CANVAS_SHELL_TYPE);
const activeId = () => state.activeTabId;

beforeEach(() => {
  state = tabsReducer(undefined, { type: '@@init' });
  dispatch.mockClear();
  __resetCanvasReturnForTest();
});

describe('openCanvasTab', () => {
  it('creates one canvas tab and activates it', () => {
    state = tabsReducer(state, shell('tb-1'));
    openCanvasTab();

    expect(canvasTabs()).toHaveLength(1);
    expect(canvasTabs()[0].shellType).toBe(CANVAS_SHELL_TYPE);
    expect(activeId()).toBe(canvasTabs()[0].id);
    expect(isCanvasTabActive()).toBe(true);
  });

  it('reuses the existing canvas tab instead of opening a second one', () => {
    state = tabsReducer(state, shell('tb-1'));
    openCanvasTab();
    const first = canvasTabs()[0].id;

    state = tabsReducer(state, setActiveTab('tb-1'));
    openCanvasTab();

    expect(canvasTabs()).toHaveLength(1);
    expect(activeId()).toBe(first);
  });

  it('is a no-op when the canvas is already on screen', () => {
    state = tabsReducer(state, shell('tb-1'));
    openCanvasTab();
    dispatch.mockClear();

    openCanvasTab();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('leaveCanvasTab', () => {
  it('returns to the tab the canvas was opened from, not just any tab', () => {
    state = tabsReducer(state, shell('tb-1'));
    state = tabsReducer(state, shell('tb-2'));
    state = tabsReducer(state, shell('tb-3'));
    state = tabsReducer(state, setActiveTab('tb-2'));

    openCanvasTab();
    leaveCanvasTab();

    // 'tb-1' is first in the strip and would be the answer to any "pick a tab" fallback.
    expect(activeId()).toBe('tb-2');
  });

  it('keeps the canvas tab open — leaving is a switch, not a close', () => {
    state = tabsReducer(state, shell('tb-1'));
    openCanvasTab();
    leaveCanvasTab();

    expect(canvasTabs()).toHaveLength(1);
  });

  // The remembered tab is ordinary state in an app where tabs close: an agent finishing,
  // the user closing it from the canvas, a process exiting under closeTabOnProcessExit.
  it('falls back to another tab when the remembered one was closed meanwhile', () => {
    state = tabsReducer(state, shell('tb-1'));
    state = tabsReducer(state, shell('tb-2'));
    state = tabsReducer(state, setActiveTab('tb-2'));
    openCanvasTab();

    state = { ...state, tabs: state.tabs.filter((t) => t.id !== 'tb-2') };
    leaveCanvasTab();

    expect(activeId()).toBe('tb-1');
    expect(isCanvasTabActive()).toBe(false);
  });

  it('stays put when the canvas is the only tab left', () => {
    openCanvasTab();
    dispatch.mockClear();

    leaveCanvasTab();

    // Nothing to go to. Dispatching `setActiveTab(null)` — or an id that no longer exists —
    // would blank the workspace rather than leave the canvas showing.
    expect(dispatch).not.toHaveBeenCalled();
    expect(isCanvasTabActive()).toBe(true);
  });

  it('does nothing when the canvas is not the active tab', () => {
    state = tabsReducer(state, shell('tb-1'));
    openCanvasTab();
    state = tabsReducer(state, setActiveTab('tb-1'));
    dispatch.mockClear();

    leaveCanvasTab();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('toggleCanvasTab', () => {
  it('goes there and comes back', () => {
    state = tabsReducer(state, shell('tb-1'));
    state = tabsReducer(state, shell('tb-2'));
    state = tabsReducer(state, setActiveTab('tb-2'));

    toggleCanvasTab();
    expect(isCanvasTabActive()).toBe(true);

    toggleCanvasTab();
    expect(activeId()).toBe('tb-2');

    // And again, on the tab that already exists — the round trip must be repeatable, not
    // a one-shot that loses its return target after the first pass.
    toggleCanvasTab();
    expect(isCanvasTabActive()).toBe(true);
    toggleCanvasTab();
    expect(activeId()).toBe('tb-2');
    expect(canvasTabs()).toHaveLength(1);
  });

  // Toggling from a DIFFERENT tab than last time must return to THAT tab.
  it('remembers where it was entered from each time', () => {
    state = tabsReducer(state, shell('tb-1'));
    state = tabsReducer(state, shell('tb-2'));

    state = tabsReducer(state, setActiveTab('tb-1'));
    toggleCanvasTab();
    toggleCanvasTab();
    expect(activeId()).toBe('tb-1');

    state = tabsReducer(state, setActiveTab('tb-2'));
    toggleCanvasTab();
    toggleCanvasTab();
    expect(activeId()).toBe('tb-2');
  });
});
