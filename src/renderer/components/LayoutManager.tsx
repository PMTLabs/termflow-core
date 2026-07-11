import React, { useEffect, useId, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../store';
import { useDialogA11y } from './UI/useDialogA11y';
import {
  saveCurrentLayout,
  loadLayout,
  deleteLayout,
  renameLayout,
  updateLayout,
  refreshLayouts,
  setShowLayoutManager,
  clearError
} from '../store/slices/layoutsSlice';
import { addToast } from '../store/slices/uiSlice';
import { StateManager } from '../services/StateManager';
import './LayoutManager.css';

export const LayoutManager: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { savedLayouts, isLoading, error, showLayoutManager } = useSelector((state: RootState) => state.layouts);

  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [selectedLayoutId, setSelectedLayoutId] = useState<string | null>(null);
  const [layoutName, setLayoutName] = useState('');
  const [layoutDescription, setLayoutDescription] = useState('');
  const [showImportExport, setShowImportExport] = useState(false);

  const mainRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const saveTitleId = useId();
  const renameTitleId = useId();

  useEffect(() => {
    if (showLayoutManager) {
      dispatch(refreshLayouts());
    }
  }, [showLayoutManager, dispatch]);

  const handleSaveLayout = async () => {
    if (!layoutName.trim()) return;

    try {
      await dispatch(saveCurrentLayout({
        name: layoutName.trim(),
        description: layoutDescription.trim() || undefined
      })).unwrap();

      setShowSaveDialog(false);
      setLayoutName('');
      setLayoutDescription('');
    } catch (error) {
      console.error('Failed to save layout:', error);
    }
  };

  const handleLoadLayout = async (layoutId: string) => {
    try {
      await dispatch(loadLayout(layoutId)).unwrap();
      dispatch(setShowLayoutManager(false));
    } catch (error) {
      console.error('Failed to load layout:', error);
    }
  };

  const handleDeleteLayout = async (layoutId: string) => {
    if (window.confirm('Are you sure you want to delete this layout?')) {
      try {
        await dispatch(deleteLayout(layoutId)).unwrap();
      } catch (error) {
        console.error('Failed to delete layout:', error);
      }
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

  const handleUpdateLayout = async (layoutId: string) => {
    if (window.confirm('Are you sure you want to update this layout with the current state?')) {
      try {
        await dispatch(updateLayout(layoutId)).unwrap();
      } catch (error) {
        console.error('Failed to update layout:', error);
      }
    }
  };

  const handleResetLayout = () => {
    if (window.confirm('Are you sure you want to reset to default layout? This will close all current tabs and create a single terminal.')) {
      StateManager.resetToDefaultLayout(dispatch);
      dispatch(setShowLayoutManager(false));
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  // Exactly one surface owns the focus trap at a time: a sub-dialog when open,
  // otherwise the main panel. This keeps the two traps from fighting over Tab and
  // stops a single Esc from closing both levels at once.
  useDialogA11y(mainRef, {
    isOpen: showLayoutManager && !showSaveDialog && !showRenameDialog,
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
            <button
              className="btn btn-secondary"
              onClick={handleResetLayout}
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
                    <span>{layout.tabs.length} tab{layout.tabs.length !== 1 ? 's' : ''}</span>
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
                    onClick={() => handleUpdateLayout(layout.id)}
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
                    onClick={() => handleDeleteLayout(layout.id)}
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

        {isLoading && (
          <div className="loading-overlay">
            <div className="loading-spinner">Loading...</div>
          </div>
        )}
      </div>
    </div>
  );
};