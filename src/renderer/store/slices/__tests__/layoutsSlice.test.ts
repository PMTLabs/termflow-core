/**
 * @jest-environment jsdom
 *
 * `layoutsSlice.ts` imports `StateManager` (a value, not just a type), and
 * `StateManager.ts` itself is the top of a chain that runs all the way down
 * to `TerminalService`'s module-scope singleton (`window.electronAPI`) and
 * the Tauri bridge (`window.__TAURI_INTERNALS__`) — importing the REAL module
 * here throws before a single reducer runs. `StateManager` is mocked so this
 * file can drive `layoutsSlice`'s reducer in isolation, the way a slice test
 * should. `jsdom` is still required even with that mock: the slice's OTHER
 * (unmocked) imports — `workspaceSnapshot` -> `cwdSnapshot` -> `TerminalService`
 * — construct that same singleton at module load, which touches
 * `window`/`document` regardless of whether any test in this file uses them.
 */
jest.mock('../../../services/StateManager', () => ({
  StateManager: {
    getSavedLayouts: jest.fn(() => []),
  },
}));

import layoutsReducer, {
  refreshLayouts,
  setShowLayoutManager,
  clearError,
  saveCurrentLayout,
  loadLayout,
  loadTabScopedLayout,
  revertWorkspace,
  deleteLayout,
  renameLayout,
  updateLayout,
  recomputeDirty,
  resetLayoutTracking,
} from '../layoutsSlice';
import { StateManager } from '../../../services/StateManager';
import type { SavedLayout } from '../../../services/StateManager';

const getSavedLayoutsMock = StateManager.getSavedLayouts as jest.Mock;

const makeLayout = (overrides: Partial<SavedLayout> = {}): SavedLayout => ({
  id: 'layout-1',
  name: 'Layout 1',
  tabs: [],
  activeTabId: null,
  paneTree: null,
  activePaneId: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const initial = () => layoutsReducer(undefined, { type: '@@INIT' } as any);

beforeEach(() => {
  getSavedLayoutsMock.mockReset();
  getSavedLayoutsMock.mockReturnValue([]);
});

describe('layoutsSlice initial state', () => {
  it('starts with no active layout and dirty=true (nothing to compare against yet)', () => {
    const state = initial();
    expect(state.activeLayoutId).toBeNull();
    expect(state.isDirty).toBe(true);
    expect(state.savedLayouts).toEqual([]);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.showLayoutManager).toBe(false);
  });
});

describe('layoutsSlice loadLayout', () => {
  it('pending sets isLoading and clears any previous error', () => {
    const withError = { ...initial(), error: 'stale error' };
    const next = layoutsReducer(withError, loadLayout.pending('req-1', 'layout-x'));
    expect(next.isLoading).toBe(true);
    expect(next.error).toBeNull();
  });

  it('fulfilled with committed:true refreshes savedLayouts and claims activeLayoutId', () => {
    const layouts = [makeLayout({ id: 'layout-x' })];
    getSavedLayoutsMock.mockReturnValue(layouts);

    const next = layoutsReducer(
      initial(),
      loadLayout.fulfilled({ layoutId: 'layout-x', committed: true }, 'req-1', 'layout-x'),
    );

    expect(next.isLoading).toBe(false);
    expect(next.activeLayoutId).toBe('layout-x');
    expect(next.savedLayouts).toEqual(layouts);
    // The workspace IS the layout that was just loaded, so it is clean
    // (pre-review fix — this branch now also clears isDirty).
    expect(next.isDirty).toBe(false);
  });

  /**
   * Load-bearing negative case (plan/025): `StateManager.loadLayout` returns
   * `committed: false` when a NEWER load superseded this one — recording
   * `activeLayoutId` for an abandoned load would name a layout that never
   * actually made it onto the screen. Starting from a state that ALREADY has
   * a different active layout, so a reducer that unconditionally sets
   * `activeLayoutId` (ignoring `committed`) is caught, not just one that
   * defaults it to something falsy.
   */
  it('fulfilled with committed:false still refreshes the layout list but leaves activeLayoutId AND isDirty untouched', () => {
    const layouts = [makeLayout({ id: 'layout-y' })];
    getSavedLayoutsMock.mockReturnValue(layouts);
    const before = { ...initial(), activeLayoutId: 'layout-already-active' };

    const next = layoutsReducer(
      before,
      loadLayout.fulfilled({ layoutId: 'layout-superseded', committed: false }, 'req-2', 'layout-superseded'),
    );

    expect(next.isLoading).toBe(false);
    expect(next.activeLayoutId).toBe('layout-already-active');
    expect(next.savedLayouts).toEqual(layouts);
    // Pre-review fix: an abandoned load populated nothing, so it must claim
    // neither the active layout nor cleanliness — `before.isDirty` (from
    // `initial()`) is `true` and must stay that way.
    expect(next.isDirty).toBe(before.isDirty);
  });

  it('rejected sets isLoading false and records the error message', () => {
    const next = layoutsReducer(
      initial(),
      loadLayout.rejected(new Error('boom'), 'req-3', 'layout-x'),
    );
    expect(next.isLoading).toBe(false);
    expect(next.error).toBe('boom');
  });

  it('rejected with an empty error message falls back to a default message', () => {
    const next = layoutsReducer(
      initial(),
      loadLayout.rejected(new Error(''), 'req-4', 'layout-x'),
    );
    expect(next.error).toBe('Failed to load layout');
  });
});

describe('layoutsSlice saveCurrentLayout scope', () => {
  it('workspace scope (the default) claims activeLayoutId, matching a fresh whole-workspace save', () => {
    const layouts = [makeLayout({ id: 'layout-new' })];
    getSavedLayoutsMock.mockReturnValue(layouts);

    const next = layoutsReducer(
      initial(),
      saveCurrentLayout.fulfilled(
        { layoutId: 'layout-new', name: 'New', description: undefined, scope: 'workspace' },
        'req-1',
        { name: 'New' },
      ),
    );

    expect(next.activeLayoutId).toBe('layout-new');
    expect(next.savedLayouts).toEqual(layouts);
    expect(next.isLoading).toBe(false);
    // The workspace now matches what was just saved, so it is clean. Leaving
    // isDirty set made the very next Load in the same session re-open the dirty
    // gate over a workspace with nothing unsaved in it.
    expect(next.isDirty).toBe(false);
  });

  /**
   * A tab-scope save never captured the whole workspace, so it must not
   * become "the" reference the rest of the tabs are compared against —
   * that would read every OTHER tab's ordinary state as dirty forever.
   * Starting from a state that already has a DIFFERENT active layout so a
   * reducer that always overwrites it (ignoring scope) is caught.
   */
  it('tab scope does NOT claim activeLayoutId, and does not declare the workspace clean', () => {
    const before = { ...initial(), activeLayoutId: 'layout-workspace', isDirty: true };
    const layouts = [makeLayout({ id: 'layout-tab' })];
    getSavedLayoutsMock.mockReturnValue(layouts);

    const next = layoutsReducer(
      before,
      saveCurrentLayout.fulfilled(
        { layoutId: 'layout-tab', name: 'Just one tab', description: undefined, scope: 'tab' },
        'req-2',
        { name: 'Just one tab', scope: 'tab', tabId: 'tb-1' },
      ),
    );

    expect(next.activeLayoutId).toBe('layout-workspace');
    expect(next.savedLayouts).toEqual(layouts);
    // ...and for the same reason it must not declare the workspace clean:
    // every other tab's unsaved state was never written anywhere.
    expect(next.isDirty).toBe(true);
  });

  it('pending sets isLoading and clears error; rejected records the error message', () => {
    const pendingState = layoutsReducer(initial(), saveCurrentLayout.pending('req-3', { name: 'X' }));
    expect(pendingState.isLoading).toBe(true);
    expect(pendingState.error).toBeNull();

    const rejectedState = layoutsReducer(
      pendingState,
      saveCurrentLayout.rejected(new Error('disk full'), 'req-3', { name: 'X' }),
    );
    expect(rejectedState.isLoading).toBe(false);
    expect(rejectedState.error).toBe('disk full');
  });
});

describe('layoutsSlice loadTabScopedLayout', () => {
  it('pending sets isLoading and clears error', () => {
    const next = layoutsReducer(
      { ...initial(), error: 'stale' },
      loadTabScopedLayout.pending('req-1', 'layout-tab'),
    );
    expect(next.isLoading).toBe(true);
    expect(next.error).toBeNull();
  });

  /**
   * plan/025 §2.4: a tab-scoped load never touches the rest of the
   * workspace, so it must NOT claim `activeLayoutId` — unlike `loadLayout`.
   * Starting from a state with an EXISTING activeLayoutId so a reducer that
   * unconditionally sets it (or clears it) is caught either way.
   */
  it('fulfilled refreshes savedLayouts but leaves activeLayoutId untouched', () => {
    const before = { ...initial(), activeLayoutId: 'layout-workspace', isLoading: true };
    const layouts = [makeLayout({ id: 'layout-tab' })];
    getSavedLayoutsMock.mockReturnValue(layouts);

    const next = layoutsReducer(
      before,
      loadTabScopedLayout.fulfilled({ layoutId: 'layout-tab', committed: true }, 'req-2', 'layout-tab'),
    );

    expect(next.isLoading).toBe(false);
    expect(next.activeLayoutId).toBe('layout-workspace');
    expect(next.savedLayouts).toEqual(layouts);
  });

  it('rejected sets isLoading false and records the error message', () => {
    const next = layoutsReducer(
      initial(),
      loadTabScopedLayout.rejected(new Error('tab gone'), 'req-3', 'layout-tab'),
    );
    expect(next.isLoading).toBe(false);
    expect(next.error).toBe('tab gone');
  });
});

describe('layoutsSlice revertWorkspace', () => {
  it('pending sets isLoading and clears error', () => {
    const next = layoutsReducer(
      { ...initial(), error: 'stale' },
      revertWorkspace.pending('req-1', undefined),
    );
    expect(next.isLoading).toBe(true);
    expect(next.error).toBeNull();
  });

  it('fulfilled(true) clears activeLayoutId — the reverted workspace is ad-hoc, not any saved layout', () => {
    const before = { ...initial(), activeLayoutId: 'layout-x' };
    const next = layoutsReducer(before, revertWorkspace.fulfilled(true, 'req-2', undefined));
    expect(next.isLoading).toBe(false);
    expect(next.activeLayoutId).toBeNull();
  });

  it('fulfilled(false) — nothing to revert — leaves activeLayoutId untouched', () => {
    const before = { ...initial(), activeLayoutId: 'layout-x' };
    const next = layoutsReducer(before, revertWorkspace.fulfilled(false, 'req-3', undefined));
    expect(next.isLoading).toBe(false);
    expect(next.activeLayoutId).toBe('layout-x');
  });

  it('rejected sets isLoading false and records the error message', () => {
    const next = layoutsReducer(
      initial(),
      revertWorkspace.rejected(new Error('no undo slot'), 'req-4', undefined),
    );
    expect(next.error).toBe('no undo slot');
  });
});

describe('layoutsSlice updateLayout', () => {
  it('pending sets isLoading and clears error', () => {
    const next = layoutsReducer(
      { ...initial(), error: 'stale' },
      updateLayout.pending('req-1', 'layout-x'),
    );
    expect(next.isLoading).toBe(true);
    expect(next.error).toBeNull();
  });

  it('fulfilled refreshes savedLayouts, claims activeLayoutId, and marks the workspace clean', () => {
    const layouts = [makeLayout({ id: 'layout-x', name: 'Updated' })];
    getSavedLayoutsMock.mockReturnValue(layouts);

    const next = layoutsReducer(
      { ...initial(), activeLayoutId: null, isDirty: true },
      updateLayout.fulfilled({ layoutId: 'layout-x', scope: 'workspace' }, 'req-2', 'layout-x'),
    );

    expect(next.isLoading).toBe(false);
    expect(next.activeLayoutId).toBe('layout-x');
    expect(next.savedLayouts).toEqual(layouts);
    // The workspace now matches what was just written. Leaving isDirty set made
    // the very next Load re-open the dirty gate over a clean workspace.
    expect(next.isDirty).toBe(false);
  });

  /**
   * The payload gained a `scope` (it was a bare layout id) so this branch can
   * exist: updating a TAB-scoped layout re-captures one tab and says nothing
   * about the workspace, so it must claim neither the active-layout slot nor
   * "clean" — otherwise every other tab's genuinely unsaved state is silently
   * declared saved, and the gate that exists to protect it stops opening.
   */
  it('a TAB-scoped update claims neither activeLayoutId nor clean', () => {
    getSavedLayoutsMock.mockReturnValue([makeLayout({ id: 'layout-tab' })]);

    const next = layoutsReducer(
      { ...initial(), activeLayoutId: null, isDirty: true },
      updateLayout.fulfilled({ layoutId: 'layout-tab', scope: 'tab' }, 'req-2b', 'layout-tab'),
    );

    expect(next.isLoading).toBe(false);
    expect(next.activeLayoutId).toBeNull();
    expect(next.isDirty).toBe(true);
  });

  it('rejected sets isLoading false and records the error message', () => {
    const next = layoutsReducer(
      initial(),
      updateLayout.rejected(new Error('layout not found'), 'req-3', 'layout-missing'),
    );
    expect(next.isLoading).toBe(false);
    expect(next.error).toBe('layout not found');
  });
});

describe('layoutsSlice recomputeDirty', () => {
  it('fulfilled(true) marks the workspace dirty', () => {
    const next = layoutsReducer(
      { ...initial(), isDirty: false },
      recomputeDirty.fulfilled(true, 'req-1', undefined),
    );
    expect(next.isDirty).toBe(true);
  });

  it('fulfilled(false) marks the workspace clean', () => {
    const next = layoutsReducer(
      { ...initial(), isDirty: true },
      recomputeDirty.fulfilled(false, 'req-2', undefined),
    );
    expect(next.isDirty).toBe(false);
  });

  it('does not touch isLoading/error — this is a cheap on-demand read, not a user-visible operation', () => {
    const before = { ...initial(), isLoading: true, error: 'unrelated error' };
    const next = layoutsReducer(before, recomputeDirty.fulfilled(true, 'req-3', undefined));
    expect(next.isLoading).toBe(true);
    expect(next.error).toBe('unrelated error');
  });
});

describe('layoutsSlice pre-existing reducers', () => {
  it('refreshLayouts reads the current list from StateManager', () => {
    const layouts = [makeLayout({ id: 'layout-a' }), makeLayout({ id: 'layout-b' })];
    getSavedLayoutsMock.mockReturnValue(layouts);
    const next = layoutsReducer(initial(), refreshLayouts());
    expect(next.savedLayouts).toEqual(layouts);
  });

  it('setShowLayoutManager sets the flag to whatever payload is given', () => {
    const opened = layoutsReducer(initial(), setShowLayoutManager(true));
    expect(opened.showLayoutManager).toBe(true);
    const closed = layoutsReducer(opened, setShowLayoutManager(false));
    expect(closed.showLayoutManager).toBe(false);
  });

  it('clearError resets error to null without touching other fields', () => {
    const before = { ...initial(), error: 'oops', isLoading: true, activeLayoutId: 'layout-x' };
    const next = layoutsReducer(before, clearError());
    expect(next.error).toBeNull();
    expect(next.isLoading).toBe(true);
    expect(next.activeLayoutId).toBe('layout-x');
  });

  it('deleteLayout.fulfilled removes only the matching layout from savedLayouts', () => {
    const before = {
      ...initial(),
      savedLayouts: [makeLayout({ id: 'layout-a' }), makeLayout({ id: 'layout-b' })],
    };
    const next = layoutsReducer(before, deleteLayout.fulfilled('layout-a', 'req-1', 'layout-a'));
    expect(next.savedLayouts.map(l => l.id)).toEqual(['layout-b']);
  });

  /**
   * Deleting the layout the workspace came FROM dissolves the association —
   * left in place, `activeLayoutId` would name a layout that no longer
   * exists while the workspace kept comparing CLEAN against its baseline.
   */
  it('deleteLayout.fulfilled clears activeLayoutId and marks dirty when the deleted layout IS the active one', () => {
    const before = {
      ...initial(),
      savedLayouts: [makeLayout({ id: 'layout-a' }), makeLayout({ id: 'layout-b' })],
      activeLayoutId: 'layout-a',
      isDirty: false,
    };
    const next = layoutsReducer(before, deleteLayout.fulfilled('layout-a', 'req-2', 'layout-a'));
    expect(next.activeLayoutId).toBeNull();
    expect(next.isDirty).toBe(true);
  });

  /**
   * The paired negative: deleting a DIFFERENT (non-active) layout must leave
   * both `activeLayoutId` and `isDirty` alone.
   */
  it('deleteLayout.fulfilled leaves activeLayoutId and isDirty untouched when deleting a DIFFERENT layout', () => {
    const before = {
      ...initial(),
      savedLayouts: [makeLayout({ id: 'layout-a' }), makeLayout({ id: 'layout-b' })],
      activeLayoutId: 'layout-b',
      isDirty: false,
    };
    const next = layoutsReducer(before, deleteLayout.fulfilled('layout-a', 'req-3', 'layout-a'));
    expect(next.activeLayoutId).toBe('layout-b');
    expect(next.isDirty).toBe(false);
  });

  it('renameLayout.fulfilled patches name/description/updatedAt on the matching layout only', () => {
    const before = {
      ...initial(),
      savedLayouts: [
        makeLayout({ id: 'layout-a', name: 'Old name', updatedAt: 1 }),
        makeLayout({ id: 'layout-b', name: 'Untouched', updatedAt: 1 }),
      ],
    };
    const next = layoutsReducer(
      before,
      renameLayout.fulfilled(
        { layoutId: 'layout-a', name: 'New name', description: 'New description' },
        'req-2',
        { layoutId: 'layout-a', name: 'New name', description: 'New description' },
      ),
    );
    const renamed = next.savedLayouts.find(l => l.id === 'layout-a')!;
    expect(renamed.name).toBe('New name');
    expect(renamed.description).toBe('New description');
    expect(renamed.updatedAt).toBeGreaterThan(1);
    const other = next.savedLayouts.find(l => l.id === 'layout-b')!;
    expect(other.name).toBe('Untouched');
  });

  /**
   * The Redux half of `StateManager.resetToDefaultLayout` (which clears the
   * module half: the undo slot and the identity baseline). A reset throws the
   * workspace away rather than replacing it with something named, so it must
   * dissolve the active-layout association the same way deleting the active
   * layout does.
   */
  it('resetLayoutTracking clears activeLayoutId and marks the workspace dirty', () => {
    const before = { ...initial(), activeLayoutId: 'layout-x', isDirty: false };
    const next = layoutsReducer(before, resetLayoutTracking());
    expect(next.activeLayoutId).toBeNull();
    expect(next.isDirty).toBe(true);
  });
});
