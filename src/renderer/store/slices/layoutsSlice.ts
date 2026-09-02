import { createSlice, PayloadAction, createAsyncThunk } from '@reduxjs/toolkit';
import { StateManager, SavedLayout } from '../../services/StateManager';
import { captureWorkspaceSnapshot, workspaceIdentity } from '../../services/workspaceSnapshot';
import { isWorkspaceDirty } from '../../services/layoutBaseline';

interface LayoutsState {
  savedLayouts: SavedLayout[];
  isLoading: boolean;
  error: string | null;
  showLayoutManager: boolean;
  // plan/025 §2.5. The saved layout the CURRENT workspace corresponds to, or
  // `null` when it does not correspond to any (never saved/loaded this
  // session, or the workspace has since been reverted to an ad-hoc state —
  // see `revertWorkspace.fulfilled` below). `isWorkspaceDirty` treats `null`
  // as "always dirty": there is nothing named to be clean AGAINST.
  activeLayoutId: string | null;
  // Recomputed on demand (`recomputeDirty`) — "when the Layout Manager opens",
  // per §2.5 — not on every store tick; `workspaceIdentity` can run into tens
  // of KB for a large workspace, so this is deliberately not a selector that
  // re-stringifies the world on every render.
  isDirty: boolean;
}

const initialState: LayoutsState = {
  savedLayouts: [],
  isLoading: false,
  error: null,
  showLayoutManager: false,
  activeLayoutId: null,
  isDirty: true,
};

// Thunk actions
export const saveCurrentLayout = createAsyncThunk(
  'layouts/saveCurrentLayout',
  async (
    { name, description, scope, tabId }:
      { name: string; description?: string; scope?: 'workspace' | 'tab'; tabId?: string },
  ) => {
    const layoutId = await StateManager.saveLayout(
      name,
      description,
      scope ? { scope, tabId } : undefined,
    );
    return { layoutId, name, description, scope: scope ?? 'workspace' as const };
  }
);

export const loadLayout = createAsyncThunk(
  'layouts/loadLayout',
  async (layoutId: string, { dispatch }) => {
    // `committed` distinguishes an ABANDONED load (a newer `loadLayout` won
    // the race — StateManager.ts's `loadGeneration` invariant) from a real
    // one: only a load that actually populated Redux may claim
    // `activeLayoutId`, or a superseded call's stale layoutId would overwrite
    // the winner's the moment its own promise resolves.
    const committed = await StateManager.loadLayout(layoutId, dispatch);
    return { layoutId, committed };
  }
);

// plan/025 §2.4. A tab-scoped load never touches the rest of the workspace,
// so — unlike `loadLayout` — it must NOT claim `activeLayoutId`: comparing the
// WHOLE workspace against a layout that only ever described one tab would
// read every other tab's ordinary state as "dirty" the moment it loaded.
export const loadTabScopedLayout = createAsyncThunk(
  'layouts/loadTabScopedLayout',
  async (layoutId: string, { dispatch }) => {
    const committed = await StateManager.loadTabScopedLayout(layoutId, dispatch);
    return { layoutId, committed };
  }
);

// plan/025 §2.2/§2.3. "Revert" — restore the workspace as it was immediately
// before the last load. See `StateManager.revertWorkspace` for the transaction
// shape and why it already records the new baseline itself.
export const revertWorkspace = createAsyncThunk(
  'layouts/revertWorkspace',
  async (_: void, { dispatch }) => {
    return StateManager.revertWorkspace(dispatch);
  }
);

export const deleteLayout = createAsyncThunk(
  'layouts/deleteLayout',
  async (layoutId: string) => {
    const success = StateManager.deleteLayout(layoutId);
    if (!success) {
      throw new Error('Failed to delete layout');
    }
    return layoutId;
  }
);

export const renameLayout = createAsyncThunk(
  'layouts/renameLayout',
  async ({ layoutId, name, description }: { layoutId: string; name: string; description?: string }) => {
    const success = StateManager.renameLayout(layoutId, name, description);
    if (!success) {
      throw new Error('Failed to rename layout');
    }
    return { layoutId, name, description };
  }
);

export const updateLayout = createAsyncThunk(
  'layouts/updateLayout',
  async (layoutId: string) => {
    const success = await StateManager.updateLayout(layoutId);
    if (!success) {
      throw new Error('Failed to update layout');
    }
    // The layout's own scope decides whether this re-capture makes the WORKSPACE
    // clean. A tab-scope update re-captured one tab, so the rest of the
    // workspace is exactly as dirty as it was — the same rule `saveLayout` and
    // `StateManager.updateLayout`'s baseline block already apply.
    const scope = StateManager.getSavedLayouts().find(l => l.id === layoutId)?.scope ?? 'workspace';
    return { layoutId, scope };
  }
);

/**
 * Recompute `isDirty` against the CURRENT live workspace (plan/025 §2.5).
 * Dispatched on demand — "when the Layout Manager opens" — not wired to every
 * store tick. Reads `getState()` directly (rather than accepting a snapshot
 * as an argument) so every call site — Layout Manager open, a manual re-check
 * — gets the same up-to-the-moment answer with no risk of a caller passing a
 * stale one.
 */
export const recomputeDirty = createAsyncThunk(
  'layouts/recomputeDirty',
  async (_: void, { getState }) => {
    const state = getState() as { layouts: LayoutsState; [key: string]: any };
    const identity = workspaceIdentity(captureWorkspaceSnapshot(state as any, 'dirty-check'));
    return isWorkspaceDirty(identity, state.layouts.activeLayoutId);
  }
);

const layoutsSlice = createSlice({
  name: 'layouts',
  initialState,
  reducers: {
    refreshLayouts: (state) => {
      state.savedLayouts = StateManager.getSavedLayouts();
    },

    setShowLayoutManager: (state, action: PayloadAction<boolean>) => {
      state.showLayoutManager = action.payload;
    },

    clearError: (state) => {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      // Save layout
      .addCase(saveCurrentLayout.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(saveCurrentLayout.fulfilled, (state, action) => {
        state.isLoading = false;
        // Refresh layouts list
        state.savedLayouts = StateManager.getSavedLayouts();
        // plan/025 §2.5: only a WORKSPACE-scope save claims the baseline — a
        // tab-scope save never captured the whole workspace, so the rest of
        // the tabs would read as "dirty" against it forever. `StateManager`
        // already recorded (or skipped) the identity baseline; this just
        // keeps `activeLayoutId` consistent with that same rule.
        if (action.payload.scope !== 'tab') {
          state.activeLayoutId = action.payload.layoutId;
          // The workspace now MATCHES what was just written, so it is clean.
          // Without this the panel keeps the pre-save `isDirty` and the very
          // next Load in the same session re-opens the dirty gate over a
          // workspace that has nothing unsaved in it — the gate crying wolf is
          // how a user learns to click through it.
          state.isDirty = false;
        }
      })
      .addCase(saveCurrentLayout.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to save layout';
      })

      // Load layout
      .addCase(loadLayout.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(loadLayout.fulfilled, (state, action) => {
        state.isLoading = false;
        // Refresh layouts list to update timestamps
        state.savedLayouts = StateManager.getSavedLayouts();
        if (action.payload.committed) {
          state.activeLayoutId = action.payload.layoutId;
        }
      })
      .addCase(loadLayout.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to load layout';
      })

      // Tab-scoped load (plan/025 §2.4) — deliberately does NOT touch
      // `activeLayoutId`; see the thunk's own comment above.
      .addCase(loadTabScopedLayout.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(loadTabScopedLayout.fulfilled, (state) => {
        state.isLoading = false;
        state.savedLayouts = StateManager.getSavedLayouts();
      })
      .addCase(loadTabScopedLayout.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to load tab layout';
      })

      // Revert workspace (plan/025 §2.2/§2.3)
      .addCase(revertWorkspace.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(revertWorkspace.fulfilled, (state, action) => {
        state.isLoading = false;
        if (action.payload) {
          // The reverted-to workspace does not correspond to any SAVED layout
          // anymore (plan/025 §2.5) — `StateManager.revertWorkspace` already
          // recorded its identity as the new baseline, but `activeLayoutId:
          // null` still means "always dirty" per `isWorkspaceDirty`, which is
          // the right default for an ad-hoc reverted state: nothing is
          // offered as "the" layout to compare against, so the dirty gate
          // stays armed until the user explicitly saves.
          state.activeLayoutId = null;
        }
      })
      .addCase(revertWorkspace.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to revert workspace';
      })

      // Dirty recompute (plan/025 §2.5) — no `isLoading`/`error` involvement;
      // this is a cheap on-demand read, not a user-visible operation.
      .addCase(recomputeDirty.fulfilled, (state, action) => {
        state.isDirty = action.payload;
      })

      // Delete layout
      .addCase(deleteLayout.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(deleteLayout.fulfilled, (state, action) => {
        state.isLoading = false;
        state.savedLayouts = state.savedLayouts.filter(l => l.id !== action.payload);
      })
      .addCase(deleteLayout.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to delete layout';
      })

      // Rename layout
      .addCase(renameLayout.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(renameLayout.fulfilled, (state, action) => {
        state.isLoading = false;
        const { layoutId, name, description } = action.payload;
        const layout = state.savedLayouts.find(l => l.id === layoutId);
        if (layout) {
          layout.name = name;
          if (description !== undefined) {
            layout.description = description;
          }
          layout.updatedAt = Date.now();
        }
      })
      .addCase(renameLayout.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to rename layout';
      })

      // Update layout
      .addCase(updateLayout.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(updateLayout.fulfilled, (state, action) => {
        state.isLoading = false;
        // Refresh layouts list to get updated timestamps
        state.savedLayouts = StateManager.getSavedLayouts();
        // plan/025 §2.5: updating a WORKSPACE-scope layout re-captures the
        // current workspace under it, so it becomes the active/clean reference
        // exactly like a fresh save (`StateManager.updateLayout` already
        // recorded the baseline itself). A TAB-scope update captured one tab
        // and says nothing about the workspace, so it claims neither.
        if (action.payload.scope !== 'tab') {
          state.activeLayoutId = action.payload.layoutId;
          state.isDirty = false;
        }
      })
      .addCase(updateLayout.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to update layout';
      });
  },
});

export const {
  refreshLayouts,
  setShowLayoutManager,
  clearError
} = layoutsSlice.actions;

export default layoutsSlice.reducer;
