/**
 * @jest-environment jsdom
 *
 * plan/025 §2.1. `captureWorkspaceSnapshot` reads `window.__TAB_PANES__`
 * (via `tabPanesStore.ts`) and `workspaceIdentity`/`isWorkspaceEmpty` are pure,
 * but the round-trip test below also exercises `localStorage`-shaped JSON —
 * hence jsdom for the whole file, per the project's test setup pattern.
 */
import { configureStore } from '@reduxjs/toolkit';
import tabsReducer from '../../store/slices/tabsSlice';
import panesReducer from '../../store/slices/panesSlice';
import canvasReducer from '../../store/slices/canvasSlice';
import { addTab } from '../../store/slices/tabsSlice';
import { addTabTree, splitPaneInTab, toggleMaximizePane } from '../../store/slices/panesSlice';
import { hydrateCanvas } from '../../store/slices/canvasSlice';
import { RootState } from '../../store';
import { captureWorkspaceSnapshot, workspaceIdentity, isWorkspaceEmpty, WorkspaceSnapshot } from '../workspaceSnapshot';
import { setCwdSnapshot, __resetCwdSnapshots } from '../cwdSnapshot';

function makeStore() {
  return configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer, canvas: canvasReducer } });
}

/** Only the three slices `captureWorkspaceSnapshot` actually reads are wired
 *  up (same trade-off `StateManager.loadLayout.test.ts` makes with tabs+panes
 *  alone) — cast rather than pull in every RootState slice for a module with
 *  no dependency on the rest of them. */
function getState(store: ReturnType<typeof makeStore>): RootState {
  return store.getState() as unknown as RootState;
}

describe('workspaceSnapshot', () => {
  beforeEach(() => {
    (window as any).__TAB_PANES__ = undefined;
    (window as any).tabPanes = undefined;
    __resetCwdSnapshots();
  });

  it('captures a JSON-round-trippable snapshot preserving the absent/null/populated tree distinction', () => {
    const store = makeStore();

    // tb-a: a real tree. tb-b: open and EMPTY (explicit null). tb-c: never mentioned at all.
    store.dispatch(addTab({ id: 'tb-a', title: 'A', shellType: 'default' } as any));
    store.dispatch(addTab({ id: 'tb-b', title: 'B', shellType: 'default' } as any));
    store.dispatch(addTabTree({ tabId: 'tb-a', tree: { id: 'pn-a1', type: 'terminal', terminalId: 'tm-a1' } }));
    store.dispatch(addTabTree({ tabId: 'tb-b', tree: null }));
    store.dispatch(splitPaneInTab({ tabId: 'tb-a', paneId: 'pn-a1', direction: 'horizontal', terminalId: 'tm-a2' }));
    store.dispatch(toggleMaximizePane({ tabId: 'tb-a', paneId: 'pn-a1' }));
    store.dispatch(hydrateCanvas({ viewport: { x: 10, y: 20, z: 1.5 }, sidebarOpen: false }));

    setCwdSnapshot('tm-a1', '/home/a1');

    (window as any).__TAB_PANES__ = { 'tb-a': { id: 'pn-a1', type: 'terminal', terminalId: 'tm-a1' } };

    const snap = captureWorkspaceSnapshot(getState(store), 'test capture');
    // Round-trip through JSON, exactly as `layoutUndo.ts` mirrors it to localStorage.
    const rehydrated: WorkspaceSnapshot = JSON.parse(JSON.stringify(snap));

    expect(rehydrated.tabs.map(t => t.id).sort()).toEqual(['tb-a', 'tb-b']);
    // Absent vs. null vs. populated — all three survive.
    expect('tb-a' in rehydrated.treesByTabId).toBe(true);
    expect(rehydrated.treesByTabId['tb-a']).not.toBeNull();
    expect('tb-b' in rehydrated.treesByTabId).toBe(true);
    expect(rehydrated.treesByTabId['tb-b']).toBeNull();
    expect('tb-c' in rehydrated.treesByTabId).toBe(false);

    expect(rehydrated.maximizedPaneByTabId['tb-a']).toBe('pn-a1');
    expect(rehydrated.terminalCwds['tm-a1']).toBe('/home/a1');
    expect(rehydrated.tabPanes['tb-a']).toEqual({ id: 'pn-a1', type: 'terminal', terminalId: 'tm-a1' });
    expect(rehydrated.canvas?.viewport).toEqual({ x: 10, y: 20, z: 1.5 });
    expect(rehydrated.canvas?.sidebarOpen).toBe(false);
    expect(rehydrated.label).toBe('test capture');
    expect(typeof rehydrated.capturedAt).toBe('number');
  });

  it('copies window.__TAB_PANES__ BY VALUE — mutating the live global afterward must not affect an already-captured snapshot', () => {
    const store = makeStore();
    store.dispatch(addTab({ id: 'tb-a', title: 'A', shellType: 'default' } as any));
    const liveTabPanes = { 'tb-a': { id: 'pn-a1', type: 'terminal' as const, terminalId: 'tm-a1' } };
    (window as any).__TAB_PANES__ = liveTabPanes;

    const snap = captureWorkspaceSnapshot(getState(store), 'label');

    // Simulate `clearTabPanesInPlace()`: the live global is emptied IN PLACE
    // (same object reference), which is exactly what a later `loadLayout` does.
    for (const k of Object.keys(liveTabPanes)) delete (liveTabPanes as any)[k];

    expect(Object.keys(liveTabPanes)).toEqual([]);
    // The snapshot must be unaffected — it held a structural copy, not the reference.
    expect(snap.tabPanes['tb-a']).toEqual({ id: 'pn-a1', type: 'terminal', terminalId: 'tm-a1' });
  });

  describe('workspaceIdentity', () => {
    function baseSnapshot(): WorkspaceSnapshot {
      const store = makeStore();
      store.dispatch(addTab({ id: 'tb-a', title: 'A', shellType: 'default' } as any));
      return captureWorkspaceSnapshot(getState(store), 'label-1');
    }

    it('is unchanged by any of the six transient Tab fields', () => {
      const a = baseSnapshot();
      const b: WorkspaceSnapshot = {
        ...a,
        tabs: a.tabs.map(t => ({
          ...t,
          processId: 4242,
          exited: true,
          isRunning: true,
          hasBackgroundActivity: true,
          activityTick: 7,
          hasUnseenOutput: true,
        })),
      };
      expect(workspaceIdentity(a)).toBe(workspaceIdentity(b));
    });

    it('changes when a durable Tab field changes', () => {
      const a = baseSnapshot();
      const b: WorkspaceSnapshot = { ...a, tabs: a.tabs.map(t => ({ ...t, title: 'Renamed' })) };
      expect(workspaceIdentity(a)).not.toBe(workspaceIdentity(b));
    });

    it('ignores capturedAt and label — two captures of the same unchanged workspace must compare equal', () => {
      const a = baseSnapshot();
      const b: WorkspaceSnapshot = { ...a, capturedAt: a.capturedAt + 999999, label: 'a completely different label' };
      expect(workspaceIdentity(a)).toBe(workspaceIdentity(b));
    });

    it('is independent of Record key insertion order', () => {
      const a = baseSnapshot();
      const reordered: WorkspaceSnapshot = {
        ...a,
        terminalCwds: { z: '/z', a: '/a' },
      };
      const same: WorkspaceSnapshot = {
        ...a,
        terminalCwds: { a: '/a', z: '/z' },
      };
      expect(workspaceIdentity(reordered)).toBe(workspaceIdentity(same));
    });
  });

  describe('isWorkspaceEmpty', () => {
    it('is true with zero tabs and false with at least one', () => {
      const store = makeStore();
      expect(isWorkspaceEmpty(captureWorkspaceSnapshot(getState(store), 'l'))).toBe(true);

      store.dispatch(addTab({ id: 'tb-a', title: 'A', shellType: 'default' } as any));
      expect(isWorkspaceEmpty(captureWorkspaceSnapshot(getState(store), 'l'))).toBe(false);
    });
  });
});
