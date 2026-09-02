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
import { addTab, updateTabMeta } from '../../store/slices/tabsSlice';
import { addTabTree, splitPaneInTab, toggleMaximizePane } from '../../store/slices/panesSlice';
import { hydrateCanvas } from '../../store/slices/canvasSlice';
import { RootState } from '../../store';
import {
  captureWorkspaceSnapshot,
  workspaceIdentity,
  isWorkspaceEmpty,
  layoutShapeIdentity,
  matchesAnySavedWorkspace,
  WorkspaceSnapshot,
} from '../workspaceSnapshot';
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


/**
 * plan/025 §2.5 follow-up (GUI pass): the dirty gate must not warn about unsaved
 * work that is demonstrably saved. That needs a comparison between a live
 * workspace and a SAVED layout, and `workspaceIdentity` cannot make it.
 */
describe('layoutShapeIdentity / matchesAnySavedWorkspace', () => {
  beforeEach(() => {
    (window as any).__TAB_PANES__ = undefined;
    __resetCwdSnapshots();
  });

  /** Exactly what `StateManager.buildLayoutBody` writes for a WORKSPACE-scope
   *  save — no per-tab maps, no tabPanes, no canvas. Built from the same state
   *  the snapshot is captured from, so the two describe one workspace. */
  const savedLayoutBodyFrom = (state: RootState) => ({
    tabs: state.tabs.tabs,
    activeTabId: state.tabs.activeTabId,
    paneTree: state.panes.paneTree,
    activePaneId: state.panes.activePaneId,
    treesByTabId: { ...state.panes.treesByTabId },
  });

  const seed = () => {
    const store = makeStore();
    store.dispatch(addTab({ id: 'tb-a', title: 'A', shellType: 'default' } as any));
    store.dispatch(addTabTree({ tabId: 'tb-a', tree: { id: 'pn-a1', type: 'terminal', terminalId: 'tm-a1' } }));
    return store;
  };

  it('workspaceIdentity THROWS on a saved layout — which is why the narrower function exists', () => {
    // Not a curiosity: this is the whole reason the gate could not simply reuse
    // `workspaceIdentity`. A workspace-scope SavedLayout has no `tabPanes`, so
    // `sortedEntries` reaches `Object.entries(undefined)`. Pinned so nobody
    // "simplifies" `layoutShapeIdentity` away into a call to its neighbour.
    const store = seed();
    const body = savedLayoutBodyFrom(getState(store));
    expect(() => workspaceIdentity(body as any)).toThrow();
  });

  it('a live workspace and the layout saved FROM it have the same layout-shape identity', () => {
    const store = seed();
    const state = getState(store);
    const snapshot = captureWorkspaceSnapshot(state, 'live');
    expect(layoutShapeIdentity(snapshot)).toBe(layoutShapeIdentity(savedLayoutBodyFrom(state) as any));
  });

  it('matches a saved WORKSPACE layout, and reports the workspace as saved', () => {
    const store = seed();
    const state = getState(store);
    const saved = { id: 'l1', ...savedLayoutBodyFrom(state) };
    expect(matchesAnySavedWorkspace(captureWorkspaceSnapshot(state, 'live'), [saved as any])).toBe(true);
  });

  it('does NOT match a TAB-scoped layout, even when its fields are byte-identical', () => {
    // A one-tab layout can coincide with a one-tab workspace field for field.
    // "You have this tab saved" is not "you have this workspace saved", so the
    // gate must still fire. Same body as the passing case above — only `scope`
    // differs, so this cannot pass for any reason except the scope check.
    const store = seed();
    const state = getState(store);
    const saved = { id: 'l1', scope: 'tab' as const, scopedTabId: 'tb-a', ...savedLayoutBodyFrom(state) };
    expect(matchesAnySavedWorkspace(captureWorkspaceSnapshot(state, 'live'), [saved as any])).toBe(false);
  });

  it('does not match when only a tab TITLE differs — the `tabs` field is really compared', () => {
    // The negative that stops every assertion above from passing vacuously.
    //
    // Deliberately a RENAME rather than an added tab. Mutating
    // `layoutShapeIdentity` to ignore `tabs` entirely survived the added-tab
    // version of this test, because `addTab` also moves `activeTabId` — so that
    // test was pinning `activeTabId` while claiming to pin `tabs`. A title
    // change moves nothing else, so this fails if and only if `tabs` is compared.
    const store = seed();
    const saved = { id: 'l1', ...savedLayoutBodyFrom(getState(store)) };
    store.dispatch(updateTabMeta({ id: 'tb-a', patch: { title: 'A renamed' } }));

    const after = captureWorkspaceSnapshot(getState(store), 'live');
    expect(after.tabs.find(t => t.id === 'tb-a')?.title).toBe('A renamed');
    expect(after.activeTabId).toBe(saved.activeTabId);
    expect(matchesAnySavedWorkspace(after, [saved as any])).toBe(false);
  });

  it('does not match when only the PANE TREE differs — `treesByTabId` is really compared', () => {
    // The pane arrangement is the substance of a layout, and nothing pinned it:
    // mutating `layoutShapeIdentity` to ignore `treesByTabId` survived every
    // other test in this file. Without this, splitting a pane would read as
    // "matches the saved layout" and the gate would wave through losing it.
    //
    // The split targets a BACKGROUND tab on purpose. `splitPaneInTab` mirrors
    // into `paneTree`/`activePaneId` only when the tab is the one on screen, so
    // splitting tb-b leaves every other compared field untouched and this test
    // can only fail for the reason it names.
    const store = makeStore();
    store.dispatch(addTab({ id: 'tb-a', title: 'A', shellType: 'default' } as any));
    store.dispatch(addTab({ id: 'tb-b', title: 'B', shellType: 'default' } as any));
    store.dispatch(addTabTree({ tabId: 'tb-a', tree: { id: 'pn-a1', type: 'terminal', terminalId: 'tm-a1' } }));
    store.dispatch(addTabTree({ tabId: 'tb-b', tree: { id: 'pn-b1', type: 'terminal', terminalId: 'tm-b1' } }));

    const before = getState(store);
    const saved = { id: 'l1', ...savedLayoutBodyFrom(before) };

    store.dispatch(splitPaneInTab({ tabId: 'tb-b', paneId: 'pn-b1', direction: 'horizontal', terminalId: 'tm-b2' }));

    const after = captureWorkspaceSnapshot(getState(store), 'live');
    // The isolation this test depends on, asserted rather than assumed.
    expect(after.tabs.map(t => t.title)).toEqual(before.tabs.tabs.map(t => t.title));
    expect(after.activeTabId).toBe(before.tabs.activeTabId);
    expect(after.paneTree).toEqual(before.panes.paneTree);
    expect(after.activePaneId).toBe(before.panes.activePaneId);
    // ...and the tree really did change.
    expect((after.treesByTabId['tb-b'] as any).type).toBe('split');

    expect(matchesAnySavedWorkspace(after, [saved as any])).toBe(false);
  });

  it('does not match when a whole tab is added', () => {
    const store = seed();
    const saved = { id: 'l1', ...savedLayoutBodyFrom(getState(store)) };
    store.dispatch(addTab({ id: 'tb-b', title: 'B', shellType: 'default' } as any));
    expect(matchesAnySavedWorkspace(captureWorkspaceSnapshot(getState(store), 'live'), [saved as any])).toBe(false);
  });

  /**
   * The subject stated as a SET, rather than one field at a time.
   *
   * Written this way because the field-by-field tests above left holes: mutants
   * that dropped `activePaneId`, `activeTabId` or `paneTree` from the identity
   * survived the whole file. Answering that by adding one more single-field test
   * per survivor is the same mistake one coordinate over — the property is
   * "sensitive to every field a workspace layout persists", so that is what is
   * asserted, and a sixth field added to `layoutShapeIdentity` tomorrow gets a
   * row here rather than a new test.
   */
  it('is sensitive to EVERY field a workspace-scope layout persists', () => {
    const base = {
      tabs: [{ id: 'tb-a', title: 'A', shellType: 'default' }] as any,
      activeTabId: 'tb-a',
      paneTree: { id: 'pn-a1', type: 'terminal', terminalId: 'tm-a1' } as any,
      activePaneId: 'pn-a1',
      treesByTabId: { 'tb-a': { id: 'pn-a1', type: 'terminal', terminalId: 'tm-a1' } } as any,
    };
    const baseline = layoutShapeIdentity(base);

    const variants: Array<[string, typeof base]> = [
      ['tabs', { ...base, tabs: [{ id: 'tb-a', title: 'RENAMED', shellType: 'default' }] as any }],
      ['activeTabId', { ...base, activeTabId: 'tb-other' }],
      ['paneTree', { ...base, paneTree: { id: 'pn-z', type: 'terminal', terminalId: 'tm-z' } as any }],
      ['activePaneId', { ...base, activePaneId: 'pn-other' }],
      ['treesByTabId', { ...base, treesByTabId: { 'tb-a': { id: 'pn-z', type: 'terminal', terminalId: 'tm-z' } } as any }],
    ];

    for (const [field, variant] of variants) {
      // Keyed by field name so a failure says WHICH field stopped being compared.
      expect(`${field} => ${layoutShapeIdentity(variant)}`).not.toBe(`${field} => ${baseline}`);
    }
    expect(variants).toHaveLength(5);
  });

  it('is INSENSITIVE to the live-only fields a workspace layout cannot store', () => {
    // The other half of the set: these five exist on a WorkspaceSnapshot and on
    // no workspace-scope SavedLayout, so a difference in them is one that saving
    // could not have preserved. Asserted so the weakening stays deliberate — and
    // so nobody "fixes" it by widening the projection into fields that would
    // then make every comparison fail.
    const base = {
      tabs: [{ id: 'tb-a', title: 'A', shellType: 'default' }] as any,
      activeTabId: 'tb-a',
      paneTree: null,
      activePaneId: null,
      treesByTabId: {},
    };
    const baseline = layoutShapeIdentity(base);

    const liveOnly = {
      ...base,
      activePaneByTabId: { 'tb-a': 'pn-a1' },
      maximizedPaneByTabId: { 'tb-a': 'pn-a1' },
      tabPanes: { 'tb-a': { id: 'pn-a1', type: 'terminal', terminalId: 'tm-a1' } },
      terminalCwds: { 'tm-a1': '/somewhere' },
      canvas: { viewport: { x: 1, y: 2, z: 3 } },
      capturedAt: 12345,
      label: 'ignored',
    };
    expect(layoutShapeIdentity(liveOnly as any)).toBe(baseline);
  });

  it('IGNORES per-tab maximize — a difference the saved layout could not have stored anyway', () => {
    // The documented weakening, asserted rather than assumed. A workspace-scope
    // layout does not persist `maximizedPaneByTabId`, so offering to "save
    // before switching" would not preserve a maximize either. Gating on it
    // would hand the user a remedy that does nothing.
    const store = seed();
    const saved = { id: 'l1', ...savedLayoutBodyFrom(getState(store)) };
    store.dispatch(toggleMaximizePane({ tabId: 'tb-a', paneId: 'pn-a1' }));

    const after = captureWorkspaceSnapshot(getState(store), 'live');
    // The maximize really did land — otherwise this test asserts nothing.
    expect(after.maximizedPaneByTabId['tb-a']).toBe('pn-a1');
    expect(matchesAnySavedWorkspace(after, [saved as any])).toBe(true);
  });
});
