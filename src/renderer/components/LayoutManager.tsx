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
  clearError,
  resetLayoutTracking
} from '../store/slices/layoutsSlice';
import { addToast, removeToast } from '../store/slices/uiSlice';
import { registerToastAction, unregisterToastAction, makeToastActionId } from '../services/toastActions';
import { useHiddenAgentTerminals } from '../hooks/useHiddenAgentTerminals';
import { refreshHiddenAgentTerminals } from '../services/hiddenAgentTerminals';
import { restoreHiddenAgentTerminals } from '../services/restoreHiddenAgentTerminals';
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
  // The scope the pending Update will re-capture in. Seeded from the layout's
  // OWN scope when the dialog opens, so accepting the default is always the
  // same operation Update performed before it could be chosen.
  const [updateScope, setUpdateScope] = useState<'workspace' | 'tab'>('workspace');
  const [pendingReset, setPendingReset] = useState(false);
  // Subscribing here is also what keeps the poll alive while this panel is
  // open — the tracker runs only while something is listening.
  const hiddenAgents = useHiddenAgentTerminals();
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
      // The hidden set is polled on a 10s interval, and opening this panel is
      // exactly when a stale count would be seen. Re-poll rather than show it.
      void refreshHiddenAgentTerminals();
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
      //
      // Only a WORKSPACE-scope save satisfies the gate. The gate's promise is
      // "your unsaved workspace is preserved before I replace it", and a
      // tab-scope save preserves exactly one tab — resuming on it would replace
      // every other tab having saved none of them, which is the loss the gate
      // was standing in front of. The scope radio stays available (a user may
      // genuinely decide to save just this tab), so the pending load is simply
      // NOT resumed and the gate is re-shown for the decision it still needs.
      if (pendingLoadAfterSave) {
        const id = pendingLoadAfterSave;
        setPendingLoadAfterSave(null);
        if (saveScope === 'workspace') {
          await performLoad(id);
        } else {
          setDirtyGateLayoutId(id);
        }
      }
    } catch (error) {
      console.error('Failed to save layout:', error);
    }
  };

  // One helper, both revert entry points (the header button and the toast's
  // Undo action). A revert declines rather than throwing when the undo slot is
  // empty or its snapshot went stale, and each caller was swallowing that
  // differently — the button by doing nothing visible, the toast by not
  // looking at all.
  // Deliberately says nothing about WHY, because `false` covers two cases that
  // differ in exactly that respect: the undo slot was empty or its snapshot was
  // structurally invalid (gone), or the revert was superseded by a newer
  // replacement at a generation check — which uses `peekUndo` and never spends
  // the slot, so the snapshot is still there to retry. An earlier version of
  // this message said the workspace "is no longer available", which is false on
  // the second path. The retryability is already on screen without being
  // claimed here: `Revert` is enabled exactly while `peekUndo()` is non-null.
  const fireRevertFailedToast = () => {
    dispatch(addToast({
      message: 'Could not restore the previous workspace.',
      type: 'warning',
    }));
  };

  // plan/025 §2.6 step 3: fired on every COMMITTED switch (workspace- or tab-scoped
  // alike — both push an undo snapshot, see StateManager.loadLayout/loadTabScopedLayout).
  // "Committed", not merely "resolved": both thunks report `{ committed }` and a
  // resolved-but-uncommitted load did nothing, so `performLoad` gates on it. The
  // earlier wording here said "every successful switch" while the call site fired
  // unconditionally — the sentence described the intent, not the code.
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
      // Reads the result, like `handleRevert` — `revertWorkspace` resolves
      // `false` when the snapshot is gone or its generation went stale, and a
      // revert that silently does nothing leaves the user believing their
      // previous workspace came back. Same class as `performLoad` above: an
      // operation allowed to decline has to be HEARD declining.
      void dispatch(revertWorkspace()).unwrap()
        .then(restored => { if (!restored) fireRevertFailedToast(); })
        .catch(error => console.error('Failed to revert workspace:', error));
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
      // `committed`, not "did not throw". Both thunks RESOLVE on a load that
      // deliberately did nothing — a tab-scoped load refused because a
      // replacement owns the workspace, or a workspace load superseded by a
      // newer one — so `unwrap()` succeeding says only that no error was
      // raised. Acting on that closed the panel and posted 'Switched to "X" ·
      // Undo' for a switch that never happened, and the Undo was armed against
      // whatever snapshot was in the one-deep slot: usually the IN-FLIGHT
      // replacement's, so pressing it reverted a workspace the toast had never
      // named. `undoToastRef`'s own comment already spells out why: "a stale
      // affordance that lies is worse than none."
      const { committed } = layout?.scope === 'tab'
        ? await dispatch(loadTabScopedLayout(layoutId)).unwrap()
        : await dispatch(loadLayout(layoutId)).unwrap();
      if (!committed) {
        dispatch(addToast({
          message: 'That layout was not loaded — the workspace is mid-switch. Try again.',
          type: 'warning',
        }));
        return;
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
  const handleLoadLayout = async (layoutId: string) => {
    const layout = savedLayouts.find(l => l.id === layoutId);
    if (layout?.scope === 'tab') {
      // A tab load never touches the rest of the workspace (§2.4), so the
      // workspace-level gate has nothing to protect here. Its own tab is
      // covered by the undo snapshot `loadTabScopedLayout` pushes.
      await performLoad(layoutId);
      return;
    }
    // Recomputed HERE, not read from the panel-open snapshot. `recomputeDirty`
    // has exactly one other dispatch site (the open effect above) and nothing
    // recomputes on store changes, so the Redux `isDirty` goes stale the moment
    // the workspace changes while the panel stays open — which an API/MCP tab
    // creation, a pane-split shortcut, or a terminal exiting all do without
    // going anywhere near this component. Judging a switch on that stale value
    // is precisely the case the gate exists for, waved through.
    let dirtyNow = isDirty;
    try {
      dirtyNow = await dispatch(recomputeDirty()).unwrap();
    } catch (e) {
      // Capturing a snapshot failed. Fall back to the last known value — and
      // note the fallback errs toward SHOWING the gate when that value is
      // dirty, never toward silently switching.
      console.warn('LayoutManager: dirty re-check failed, using last known value', e);
    }
    if (dirtyNow) {
      setDirtyGateLayoutId(layoutId);
      return;
    }
    await performLoad(layoutId);
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
      if (restored) {
        dispatch(setShowLayoutManager(false));
      } else {
        fireRevertFailedToast();
      }
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

  // Opening the Update dialog seeds its scope from the layout being updated.
  // A tab-scoped layout defaults to tab, a workspace one to workspace — so the
  // default answer is always "re-capture what this layout already is".
  // True only when confirming would actually move the layout to a different tab
  // from the one it describes today — a workspace-scope update, or a tab update
  // whose target is unchanged, re-points nothing.
  const pendingUpdateLayout = savedLayouts.find(l => l.id === pendingUpdateId);
  const updateRetargets =
    updateScope === 'tab' &&
    pendingUpdateLayout?.scope === 'tab' &&
    (pendingUpdateLayout.scopedTabId ?? pendingUpdateLayout.tabs?.[0]?.id) !== activeTabId;

  const startUpdate = (layoutId: string) => {
    const layout = savedLayouts.find(l => l.id === layoutId);
    setUpdateScope(layout?.scope === 'tab' ? 'tab' : 'workspace');
    setPendingUpdateId(layoutId);
  };

  const confirmUpdate = async () => {
    const id = pendingUpdateId;
    setPendingUpdateId(null);
    if (!id) return;
    try {
      await dispatch(updateLayout({
        layoutId: id,
        scope: updateScope,
        // The tab option means the tab the user is looking at, which is what
        // its label names. Sent explicitly so `StateManager.updateLayout`
        // treats it as a deliberate re-target rather than re-capturing
        // whatever tab the layout originally described.
        tabId: updateScope === 'tab' ? (activeTabId ?? undefined) : undefined,
      })).unwrap();
    } catch (error) {
      console.error('Failed to update layout:', error);
    }
  };

  // No confirmation step. The button that calls this already carries the count
  // in its own label and lists the terminals in its tooltip, so a dialog would
  // only re-read what the user just clicked. The title-bar badge keeps its
  // confirm: that is a glanceable icon, and the dialog is where its list of
  // terminals is shown for the first time.
  //
  // Safe to act immediately regardless: this only ADDS tabs, every terminal it
  // attaches to is already running, and nothing is restarted or closed.
  const handleRestoreRunning = () => {
    if (hiddenAgents.length === 0) return;
    const { restored, skipped } = restoreHiddenAgentTerminals(hiddenAgents, dispatch);
    // Reported rather than silent. `skipped` is not an error — `hiddenAgents`
    // is captured when this component renders, so something can put one of them
    // back on screen before the click is processed — but a button that says it
    // will restore five and restores three has to say so.
    if (restored.length > 0) {
      dispatch(setShowLayoutManager(false));
      dispatch(addToast({
        message: skipped.length === 0
          ? `Restored ${restored.length} running ${restored.length === 1 ? 'CLI' : 'CLIs'}.`
          : `Restored ${restored.length}; ${skipped.length} ${skipped.length === 1 ? 'was' : 'were'} already open.`,
        type: 'info',
      }));
    } else {
      dispatch(addToast({
        message: 'Nothing to restore — those terminals are already open in this layout.',
        type: 'warning',
      }));
    }
  };

  const confirmReset = () => {
    setPendingReset(false);
    // Gated on the RESULT: a reset declines while a replacement owns the
    // workspace. Dispatching the Redux half regardless is how the two halves
    // come apart — the module half (undo slot, identity baseline) untouched
    // because StateManager returned early, the Redux half torn up anyway, for
    // a workspace that was never reset.
    if (!StateManager.resetToDefaultLayout(dispatch)) {
      dispatch(addToast({
        message: 'Reset skipped — the workspace is mid-switch. Try again.',
        type: 'warning',
      }));
      return;
    }
    // A reset throws the workspace away rather than replacing it with something
    // named, so the workspace no longer corresponds to any saved layout.
    // `resetToDefaultLayout` clears the module half (the undo slot and the
    // identity baseline); this clears the Redux half, so the dirty gate stops
    // measuring a single default terminal against a layout it has nothing in
    // common with.
    dispatch(resetLayoutTracking());
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
        {/* Two rows: the title (with close) above, the actions below. The single
            `space-between` row this replaces gave the buttons no slack — every
            action added competed with the title for width. */}
        <div className="layout-manager-header">
          <div className="layout-manager-titlerow">
            <h2 id={titleId}>Layout Manager</h2>
            <button
              className="btn btn-close"
              onClick={() => dispatch(setShowLayoutManager(false))}
            >
              ×
            </button>
          </div>
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
                before loading X") doubles as the hover tooltip.
                `btn-warning` (amber), not `btn-secondary`: this is the one header
                action that replaces the whole workspace, and it was previously
                indistinguishable from Import/Export and Reset Layout. */}
            <button
              className="btn btn-warning"
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
            {/* Agent CLIs still running that no pane here is showing — usually
                stranded by a layout switch. Rendered ALWAYS, unlike the title-bar
                badge which appears only when there is something to report: this
                panel is where a user comes looking for the capability, and a
                control that exists only once it is already needed cannot be
                discovered before then. Disabled, with the reason in the tooltip,
                is the honest resting state. */}
            <button
              className="btn btn-warning"
              onClick={handleRestoreRunning}
              disabled={hiddenAgents.length === 0 || isLoading}
              title={hiddenAgents.length === 0
                ? 'Every running agent CLI is already open in this layout.'
                : hiddenAgents.map(h => `${h.name} (${h.agent})`).join(', ')}
            >
              {hiddenAgents.length === 0
                ? 'Restore Running CLIs'
                : `Restore Running CLIs (${hiddenAgents.length})`}
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
                    onClick={() => startUpdate(layout.id)}
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
      {/* Update asks for a SCOPE, not just a yes/no. Before this it silently
          re-captured in whatever scope the layout already had, so a
          workspace layout could never be narrowed to one tab and a tab layout
          could never be widened — and neither the question nor the answer was
          ever on screen. Same radio pattern as the save dialog, and
          `useDialogA11y.isTypingTarget` returns false for radios, so the
          dialog's Esc and mnemonics stay live with one focused. */}
      <ConfirmDialog
        isOpen={pendingUpdateId !== null}
        title="Update Layout"
        message={
          <>
            <p>Re-capture the current state into this layout. What should it save?</p>
            <div className="scope-options">
              <label className="scope-option">
                <input
                  type="radio"
                  name="update-scope"
                  value="workspace"
                  checked={updateScope === 'workspace'}
                  onChange={() => setUpdateScope('workspace')}
                />
                <span>Whole workspace ({tabs.length} tab{tabs.length !== 1 ? 's' : ''})</span>
              </label>
              <label className="scope-option">
                <input
                  type="radio"
                  name="update-scope"
                  value="tab"
                  checked={updateScope === 'tab'}
                  onChange={() => setUpdateScope('tab')}
                  disabled={!activeTab}
                />
                <span>Only this tab ("{activeTab?.title ?? ''}")</span>
              </label>
            </div>
            {updateRetargets && (
              /* Naming the tab in the option label is what keeps a re-target
                 from being silent, but a user who saved "build" and is now
                 sitting on "editor" is one blind Enter away from re-pointing
                 the layout. Say so outright when it would actually happen. */
              <p className="scope-retarget-note">
                This layout currently saves a different tab. Updating will re-point it at
                "{activeTab?.title ?? ''}".
              </p>
            )}
          </>
        }
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
