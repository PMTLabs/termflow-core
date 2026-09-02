import React, { useEffect, useId, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../store';
import { useDialogA11y } from './UI/useDialogA11y';
import { UnsavedChangesDialog } from './UI/UnsavedChangesDialog';
import { ConfirmDialog } from './UI/ConfirmDialog';
import {
  saveCurrentLayout,
  loadLayout,
  loadTabScopedLayout,
  revertWorkspace,
  recomputeDirty,
  deleteLayout,
  renameLayout,
  updateLayout,
  refreshLayouts,
  setShowLayoutManager,
  clearError
} from '../store/slices/layoutsSlice';
import { addToast, removeToast } from '../store/slices/uiSlice';
import { registerToastAction, unregisterToastAction, makeToastActionId } from '../services/toastActions';
import { peekUndo, subscribeUndo } from '../services/layoutUndo';
import { WorkspaceSnapshot } from '../services/workspaceSnapshot';
import { StateManager } from '../services/StateManager';
import './LayoutManager.css';

export const LayoutManager: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { savedLayouts, isLoading, error, showLayoutManager, isDirty } = useSelector(
    (state: RootState) => state.layouts,
  );
  // For the save dialog's scope radio (plan/025 §2.6 Task B5) — the tab-scope option
  // shows the ACTIVE tab's real title, and is disabled when there is none to save.
  const tabs = useSelector((state: RootState) => state.tabs.tabs);
  const activeTabId = useSelector((state: RootState) => state.tabs.activeTabId);
  const activeTab = tabs.find(t => t.id === activeTabId);

  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [selectedLayoutId, setSelectedLayoutId] = useState<string | null>(null);
  const [layoutName, setLayoutName] = useState('');
  const [layoutDescription, setLayoutDescription] = useState('');
  const [showImportExport, setShowImportExport] = useState(false);
  // Task B5 — defaults to Workspace per plan/025 §2.6 step 4.
  const [saveScope, setSaveScope] = useState<'workspace' | 'tab'>('workspace');
  // Task B4 — the layout a Load was requested for while the workspace is dirty; the
  // dirty gate is showing for it until the user picks Save/Discard/Cancel.
  const [dirtyGateLayoutId, setDirtyGateLayoutId] = useState<string | null>(null);
  // Set only via the dirty gate's "Save current layout..." choice: the load to resume
  // once THAT save (opened below) completes.
  const [pendingLoadAfterSave, setPendingLoadAfterSave] = useState<string | null>(null);
  // Task B6 — window.confirm replacements. Each holds the id (or, for Reset, just a
  // boolean) the pending confirmation applies to; null/false means no dialog showing.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingUpdateId, setPendingUpdateId] = useState<string | null>(null);
  const [pendingReset, setPendingReset] = useState(false);
  // Task B4 — mirrors `layoutUndo.ts`'s module-scope slot so the header Revert
  // button re-renders on every push/take/clear, not just when THIS component causes one.
  const [undoSnapshot, setUndoSnapshot] = useState<WorkspaceSnapshot | null>(() => peekUndo());
  // The ONE outstanding Undo toast, or null. There is exactly one undo slot
  // (`layoutUndo` is one-deep), so there must be at most one live Undo
  // affordance: after A -> B -> C, a surviving 'Switched to "B" ... Undo' toast
  // would still call `revertWorkspace()`, which restores the snapshot taken
  // before C — it would return the user to B while promising the workspace
  // from before B. A stale affordance that lies is worse than none.
  const undoToastRef = useRef<{ toastId: string; actionId: string } | null>(null);

  const mainRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const saveTitleId = useId();
  const renameTitleId = useId();

  useEffect(() => {
    if (showLayoutManager) {
      dispatch(refreshLayouts());
      // plan/025 §2.5: recomputed "when the Layout Manager opens" — not on every
      // store tick — so the dirty gate below always judges the LATEST workspace.
      dispatch(recomputeDirty());
    }
  }, [showLayoutManager, dispatch]);

  useEffect(() => {
    const update = () => {
      const next = peekUndo();
      setUndoSnapshot(next);
      // The slot emptied (a revert ran, from the header button, the toast, or
      // anywhere else) — so the Undo affordance no longer has anything to
      // restore and must go, along with its registry entry. Consuming the slot
      // is the one signal that covers every path, including ones this
      // component never initiated.
      if (!next) retireUndoToast();
    };
    update(); // catch anything pushed between the initial state calc above and mount
    return subscribeUndo(update);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveLayout = async () => {
    if (!layoutName.trim()) return;

    try {
      await dispatch(saveCurrentLayout({
        name: layoutName.trim(),
        description: layoutDescription.trim() || undefined,
        scope: saveScope,
        tabId: saveScope === 'tab' ? (activeTabId ?? undefined) : undefined,
      })).unwrap();

      setShowSaveDialog(false);
      setLayoutName('');
      setLayoutDescription('');
      setSaveScope('workspace');

      // plan/025 §2.6 step 2: the dirty gate's "Save current layout..." choice opens
      // THIS dialog rather than saving immediately (see `handleDirtyGateSave` below);
      // once the save has landed, resume the load the user originally asked for.
      if (pendingLoadAfterSave) {
        const id = pendingLoadAfterSave;
        setPendingLoadAfterSave(null);
        await performLoad(id);
      }
    } catch (error) {
      console.error('Failed to save layout:', error);
    }
  };

  // plan/025 §2.6 step 3: fired on every successful switch (workspace- or tab-scoped
  // alike — both push an undo snapshot, see StateManager.loadLayout/loadTabScopedLayout).
  // Sticky and with an inline Undo action, because the Layout Manager closes on load
  // (below) and the header Revert button is therefore not reachable feedback for a
  // switch the user just made from a now-closed panel.
  //
  // Retiring the previous one is not tidiness — see `undoToastRef`. It also
  // closes the handler leak: a toast dismissed WITHOUT clicking Undo would
  // otherwise leave its entry in the registry for the life of the renderer,
  // one per switch, since only the click path unregisters.
  const retireUndoToast = () => {
    const outstanding = undoToastRef.current;
    if (!outstanding) return;
    undoToastRef.current = null;
    unregisterToastAction(outstanding.actionId);
    dispatch(removeToast(outstanding.toastId));
  };

  const fireUndoToast = (label: string) => {
    retireUndoToast();
    const actionId = makeToastActionId('layout-undo');
    // An EXPLICIT toast id (uiSlice's `addToast` generates one only when the
    // caller omits it), so this component can retire exactly this toast later
    // without having to guess the value the reducer would have minted.
    const toastId = makeToastActionId('layout-undo-toast');
    registerToastAction(actionId, () => {
      retireUndoToast();
      dispatch(revertWorkspace());
    });
    undoToastRef.current = { toastId, actionId };
    dispatch(addToast({
      id: toastId,
      message: `Switched to "${label}". Your previous workspace is still running in the background.`,
      type: 'info',
      sticky: true,
      action: { label: 'Undo', actionId },
    }));
  };

  // The actual load, once the dirty gate (if any) is satisfied. Routes on the TARGET
  // layout's own scope — a tab-scoped layout must go through `loadTabScopedLayout`
  // (patches one tab in place); routing it through `loadLayout` instead would replace
  // the WHOLE workspace with its one-tab `tabs` array (plan/025 §2.4).
  const performLoad = async (layoutId: string) => {
    const layout = savedLayouts.find(l => l.id === layoutId);
    try {
      if (layout?.scope === 'tab') {
        await dispatch(loadTabScopedLayout(layoutId)).unwrap();
      } else {
        await dispatch(loadLayout(layoutId)).unwrap();
      }
      dispatch(setShowLayoutManager(false));
      fireUndoToast(layout?.name ?? 'layout');
    } catch (error) {
      console.error('Failed to load layout:', error);
    }
  };

  // plan/025 §2.6 step 2 — the dirty gate. `isDirty` is a WORKSPACE-level flag
  // (§2.5), so it only ever gates a workspace-scope load: a tab-scoped load never
  // touches the rest of the workspace (§2.4) and has nothing for the gate to protect.
  const handleLoadLayout = (layoutId: string) => {
    const layout = savedLayouts.find(l => l.id === layoutId);
    if (layout?.scope !== 'tab' && isDirty) {
      setDirtyGateLayoutId(layoutId);
      return;
    }
    performLoad(layoutId);
  };

  const handleDirtyGateSave = () => {
    const id = dirtyGateLayoutId;
    setDirtyGateLayoutId(null);
    setPendingLoadAfterSave(id);
    setSaveScope('workspace');
    setShowSaveDialog(true);
  };

  const handleDirtyGateDiscard = () => {
    const id = dirtyGateLayoutId;
    setDirtyGateLayoutId(null);
    if (id) performLoad(id);
  };

  // Cancel dispatches nothing — the pending load is simply forgotten.
  const handleDirtyGateCancel = () => {
    setDirtyGateLayoutId(null);
  };

  const handleRevert = async () => {
    try {
      const restored = await dispatch(revertWorkspace()).unwrap();
      if (restored) dispatch(setShowLayoutManager(false));
    } catch (error) {
      console.error('Failed to revert workspace:', error);
    }
  };

  const confirmDelete = async () => {
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    if (!id) return;
    try {
      await dispatch(deleteLayout(id)).unwrap();
    } catch (error) {
      console.error('Failed to delete layout:', error);
    }
  };

  const handleRenameLayout = async () => {
    if (!selectedLayoutId || !layoutName.trim()) return;

    try {
      await dispatch(renameLayout({
        layoutId: selectedLayoutId,
        name: layoutName.trim(),
        description: layoutDescription.trim() || undefined
      })).unwrap();

      setShowRenameDialog(false);
      setSelectedLayoutId(null);
      setLayoutName('');
      setLayoutDescription('');
    } catch (error) {
      console.error('Failed to rename layout:', error);
    }
  };

  const startRename = (layoutId: string, currentName: string, currentDescription?: string) => {
    setSelectedLayoutId(layoutId);
    setLayoutName(currentName);
    setLayoutDescription(currentDescription || '');
    setShowRenameDialog(true);
  };

  const closeSaveDialog = () => {
    setShowSaveDialog(false);
    setLayoutName('');
    setLayoutDescription('');
    setSaveScope('workspace');
    // Abandon any load that was only pending because we opened this dialog FOR it
    // (plan/025 §2.6's dirty gate) — Cancel here must resume nothing.
    setPendingLoadAfterSave(null);
  };

  const closeRenameDialog = () => {
    setShowRenameDialog(false);
    setSelectedLayoutId(null);
    setLayoutName('');
    setLayoutDescription('');
  };

  const handleExportLayouts = () => {
    try {
      const exportData = StateManager.exportLayouts();
      const blob = new Blob([exportData], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `auto-terminal-layouts-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export layouts:', error);
    }
  };

  const handleImportLayouts = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const importedCount = StateManager.importLayouts(content);
        dispatch(refreshLayouts());
        dispatch(addToast({
          message: `Successfully imported ${importedCount} layouts!`,
          type: 'success'
        }));
      } catch (error) {
        console.error('Failed to import layouts:', error);
        dispatch(addToast({
          message: 'Failed to import layouts. Please check the file format.',
          type: 'error'
        }));
      }
    };
    reader.readAsText(file);

    // Reset input
    event.target.value = '';
  };

  const confirmUpdate = async () => {
    const id = pendingUpdateId;
    setPendingUpdateId(null);
    if (!id) return;
    try {
      await dispatch(updateLayout(id)).unwrap();
    } catch (error) {
      console.error('Failed to update layout:', error);
    }
  };

  const confirmReset = () => {
    setPendingReset(false);
    StateManager.resetToDefaultLayout(dispatch);
    dispatch(setShowLayoutManager(false));
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  // Exactly one surface owns the focus trap at a time: a sub-dialog when open,
  // otherwise the main panel. This keeps the two traps from fighting over Tab and
  // stops a single Esc from closing both levels at once. `dirtyGateLayoutId` joins
  // `showSaveDialog`/`showRenameDialog` here for the same reason: the dirty-gate
  // dialog below is nested inside THIS container (not portalled), so its Tab-trap
  // would otherwise fight this one over the very same DOM subtree. The three
  // `ConfirmDialog`s further down do NOT need to join this list — `ConfirmDialog`
  // portals to `document.body` (see its own header comment), so its focus trap lives
  // in a disjoint DOM subtree this container's listener never sees.
  useDialogA11y(mainRef, {
    isOpen: showLayoutManager && !showSaveDialog && !showRenameDialog && !dirtyGateLayoutId,
    onCancel: () => dispatch(setShowLayoutManager(false)),
    initialFocus: 'first',
  });
  useDialogA11y(saveRef, {
    isOpen: showSaveDialog,
    onCancel: closeSaveDialog,
    initialFocus: 'first',
  });
  useDialogA11y(renameRef, {
    isOpen: showRenameDialog,
    onCancel: closeRenameDialog,
    initialFocus: 'first',
  });

  if (!showLayoutManager) return null;

  return (
    <div className="layout-manager-overlay">
      <div
        className="layout-manager"
        ref={mainRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="layout-manager-header">
          <h2 id={titleId}>Layout Manager</h2>
          <div className="layout-manager-actions">
            <button
              className="btn btn-primary"
              onClick={() => setShowSaveDialog(true)}
              disabled={isLoading}
            >
              Save Current Layout
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setShowImportExport(!showImportExport)}
            >
              Import/Export
            </button>
            {/* Task B4 — enabled only while there is something to revert to; the
                snapshot's own label (set when it was captured, e.g. "Workspace
                before loading X") doubles as the hover tooltip. */}
            <button
              className="btn btn-secondary"
              onClick={handleRevert}
              disabled={!undoSnapshot || isLoading}
              title={undoSnapshot?.label}
            >
              Revert
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setPendingReset(true)}
              disabled={isLoading}
            >
              Reset Layout
            </button>
            <button
              className="btn btn-close"
              onClick={() => dispatch(setShowLayoutManager(false))}
            >
              ×
            </button>
          </div>
        </div>

        {/* Task B3 (P1a) — a PERMANENT row, unlike the conditional error banner just
            below: process continuity is true on every visit to this panel, not only
            when something has gone wrong. Copy is quoted verbatim from plan/025 §2.6. */}
        <div className="continuity-banner">
          <span>
            <strong>Your processes keep running.</strong> Loading or switching layouts only
            changes what is on screen — shells, agent CLIs and long-running commands in the
            current layout keep running in the background, and nothing is terminated.
          </span>
        </div>

        {error && (
          <div className="error-message">
            {error}
            <button onClick={() => dispatch(clearError())}>×</button>
          </div>
        )}

        {showImportExport && (
          <div className="import-export-panel">
            <div className="import-export-actions">
              <button className="btn btn-secondary" onClick={handleExportLayouts}>
                Export All Layouts
              </button>
              <label className="btn btn-secondary file-input-label">
                Import Layouts
                <input
                  type="file"
                  accept=".json"
                  onChange={handleImportLayouts}
                  style={{ display: 'none' }}
                />
              </label>
            </div>
          </div>
        )}

        <div className="layouts-list">
          {savedLayouts.length === 0 ? (
            <div className="empty-state">
              <p>No saved layouts yet. Save your current layout to get started!</p>
            </div>
          ) : (
            savedLayouts.map(layout => (
              <div key={layout.id} className="layout-item">
                <div className="layout-info">
                  <h3>{layout.name}</h3>
                  {layout.description && <p>{layout.description}</p>}
                  <div className="layout-meta">
                    {/* Task B5 — scope badge. Replaces the old bare tab-count span:
                        for a tab-scoped layout that count is always 1 and names
                        nothing, where the badge names the actual saved tab. */}
                    <span className="layout-scope-badge">
                      {layout.scope === 'tab'
                        ? `Tab / "${layout.tabs?.[0]?.title ?? 'unknown'}"`
                        : `Workspace / ${layout.tabs.length} tab${layout.tabs.length !== 1 ? 's' : ''}`}
                    </span>
                    <span>Created: {formatDate(layout.createdAt)}</span>
                    {layout.updatedAt !== layout.createdAt && (
                      <span>Updated: {formatDate(layout.updatedAt)}</span>
                    )}
                  </div>
                </div>
                <div className="layout-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => handleLoadLayout(layout.id)}
                    disabled={isLoading}
                  >
                    Load
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setPendingUpdateId(layout.id)}
                    disabled={isLoading}
                  >
                    Update
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => startRename(layout.id, layout.name, layout.description)}
                    disabled={isLoading}
                  >
                    Rename
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => setPendingDeleteId(layout.id)}
                    disabled={isLoading}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Save Dialog */}
        {showSaveDialog && (
          <div className="dialog-overlay">
            <div
              className="dialog"
              ref={saveRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={saveTitleId}
              tabIndex={-1}
            >
              <h3 id={saveTitleId}>Save Current Layout</h3>
              <div className="form-group">
                <label>Layout Name:</label>
                <input
                  type="text"
                  value={layoutName}
                  onChange={(e) => setLayoutName(e.target.value)}
                  placeholder="Enter layout name..."
                  maxLength={50}
                />
              </div>
              <div className="form-group">
                <label>Description (optional):</label>
                <textarea
                  value={layoutDescription}
                  onChange={(e) => setLayoutDescription(e.target.value)}
                  placeholder="Enter description..."
                  maxLength={200}
                />
              </div>
              {/* Task B5 — `<label>`-wrapped radios, ShellSelector.tsx's pattern:
                  `useDialogA11y`'s `isTypingTarget` deliberately returns false for
                  radios, so this dialog's Esc/mnemonics stay live with one focused. */}
              <div className="form-group">
                <label>Save:</label>
                <div className="scope-options">
                  <label className="scope-option">
                    <input
                      type="radio"
                      name="save-scope"
                      value="workspace"
                      checked={saveScope === 'workspace'}
                      onChange={() => setSaveScope('workspace')}
                    />
                    <span>Whole workspace ({tabs.length} tab{tabs.length !== 1 ? 's' : ''})</span>
                  </label>
                  <label className="scope-option">
                    <input
                      type="radio"
                      name="save-scope"
                      value="tab"
                      checked={saveScope === 'tab'}
                      onChange={() => setSaveScope('tab')}
                      disabled={!activeTab}
                    />
                    <span>Only this tab ("{activeTab?.title ?? ''}")</span>
                  </label>
                </div>
              </div>
              <div className="dialog-actions">
                <button
                  className="btn btn-primary"
                  onClick={handleSaveLayout}
                  disabled={!layoutName.trim() || isLoading}
                >
                  Save
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={closeSaveDialog}
                  disabled={isLoading}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Rename Dialog */}
        {showRenameDialog && (
          <div className="dialog-overlay">
            <div
              className="dialog"
              ref={renameRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={renameTitleId}
              tabIndex={-1}
            >
              <h3 id={renameTitleId}>Rename Layout</h3>
              <div className="form-group">
                <label>Layout Name:</label>
                <input
                  type="text"
                  value={layoutName}
                  onChange={(e) => setLayoutName(e.target.value)}
                  placeholder="Enter layout name..."
                  maxLength={50}
                />
              </div>
              <div className="form-group">
                <label>Description (optional):</label>
                <textarea
                  value={layoutDescription}
                  onChange={(e) => setLayoutDescription(e.target.value)}
                  placeholder="Enter description..."
                  maxLength={200}
                />
              </div>
              <div className="dialog-actions">
                <button
                  className="btn btn-primary"
                  onClick={handleRenameLayout}
                  disabled={!layoutName.trim() || isLoading}
                >
                  Save
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={closeRenameDialog}
                  disabled={isLoading}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Task B4 — the dirty-switch gate (plan/025 §2.6 step 2). Save opens the
            Save dialog above (see `handleDirtyGateSave`) rather than saving directly,
            so the user still names/scopes the save; Switch anyway discards and
            proceeds; Cancel dispatches nothing. */}
        <UnsavedChangesDialog
          isOpen={dirtyGateLayoutId !== null}
          title="Unsaved changes"
          body={
            <p>
              The current workspace has changes that are not saved to any layout. Save it,
              switch anyway, or cancel?
            </p>
          }
          saveLabel="Save current layout..."
          saveMnemonic="S"
          discardLabel="Switch anyway"
          discardMnemonic="w"
          onSave={handleDirtyGateSave}
          onDiscard={handleDirtyGateDiscard}
          onCancel={handleDirtyGateCancel}
        />

        {isLoading && (
          <div className="loading-overlay">
            <div className="loading-spinner">Loading...</div>
          </div>
        )}
      </div>

      {/* Task B6 — window.confirm replacements. Portalled (see ConfirmDialog's own
          header comment), so none of these need joining the `useDialogA11y(mainRef,
          ...)` exclusion list above — their focus trap lives in a disjoint DOM
          subtree under document.body that `mainRef`'s listener never sees. */}
      <ConfirmDialog
        isOpen={pendingDeleteId !== null}
        destructive
        title="Delete Layout"
        message="Are you sure you want to delete this layout?"
        confirmText="Delete"
        confirmMnemonic="D"
        cancelText="Cancel"
        cancelMnemonic="A"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDeleteId(null)}
      />
      <ConfirmDialog
        isOpen={pendingUpdateId !== null}
        title="Update Layout"
        message="Are you sure you want to update this layout with the current state?"
        confirmText="Update"
        confirmMnemonic="U"
        cancelText="Cancel"
        cancelMnemonic="A"
        onConfirm={confirmUpdate}
        onCancel={() => setPendingUpdateId(null)}
      />
      <ConfirmDialog
        isOpen={pendingReset}
        destructive
        title="Reset Layout"
        message="Are you sure you want to reset to default layout? This will close all current tabs and create a single terminal."
        confirmText="Reset"
        confirmMnemonic="R"
        cancelText="Cancel"
        cancelMnemonic="A"
        onConfirm={confirmReset}
        onCancel={() => setPendingReset(false)}
      />
    </div>
  );
};
