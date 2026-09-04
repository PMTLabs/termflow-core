import React, { useMemo, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../../store';
import {
    Snippet,
    addSnippet,
    updateSnippet,
    removeSnippet,
    renameSnippetFolder,
    setSnippets,
} from '../../store/slices/settingsSlice';
import { snippetDisplayLabel } from '../../services/snippetSearch';
import { exportSnippets, importSnippets, describeImport } from '../../services/snippetPorting';
import { SnippetDialog } from '../UI/SnippetDialog';
import { ConfirmDialog } from '../UI/ConfirmDialog';
import './SnippetsPanel.css';

/** The unfiled bucket's internal group key. Never a real folder name (flattenFolder
 * in SnippetDialog strips '/' and trims, so it can never produce this token). */
const UNFILED = '__unfiled__';

interface FolderGroup {
    /** '' for the unfiled group; otherwise the folder name. */
    folder: string;
    snippets: Snippet[];
}

/** Group snippets by folder, sorted alphabetically, unfiled last (plan/029 §7.2). */
function groupByFolder(snippets: Snippet[]): FolderGroup[] {
    const byFolder = new Map<string, Snippet[]>();
    for (const s of snippets) {
        const key = s.folder?.trim() || '';
        const bucket = byFolder.get(key);
        if (bucket) bucket.push(s);
        else byFolder.set(key, [s]);
    }
    const folders = [...byFolder.keys()].filter((k) => k !== '').sort((a, b) => a.localeCompare(b));
    const groups: FolderGroup[] = folders.map((f) => ({ folder: f, snippets: byFolder.get(f)! }));
    const unfiled = byFolder.get('');
    if (unfiled) groups.push({ folder: '', snippets: unfiled });
    return groups;
}

/**
 * Settings → Snippets panel (plan/029 §7.2), the `PeersPanel` extraction precedent.
 * Renders the full CRUD surface for `state.settings.snippets` (link 9 of the nine
 * links, §3.2): grouped-by-folder rows with Edit/Delete, folder rename, New Snippet,
 * and Import/Export. Every mutation applies live via the settingsSlice reducers —
 * there is no Save button and no local draft state for the list itself.
 */
export const SnippetsPanel: React.FC = () => {
    const dispatch = useDispatch<AppDispatch>();
    const snippets = useSelector((s: RootState) => s.settings.snippets);

    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<Snippet | null>(null);
    const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [portBusy, setPortBusy] = useState(false);
    const [resultLine, setResultLine] = useState<string | null>(null);

    const groups = useMemo(() => groupByFolder(snippets), [snippets]);

    const openCreate = () => {
        setEditingSnippet(null);
        setDialogOpen(true);
    };
    const openEdit = (s: Snippet) => {
        setEditingSnippet(s);
        setDialogOpen(true);
    };

    // The dialog hands back a finished draft (create mint's its own id, edit keeps
    // the original) — this is the only place that picks addSnippet vs updateSnippet.
    const saveSnippet = (saved: Snippet) => {
        if (editingSnippet) {
            dispatch(updateSnippet({ id: saved.id, patch: saved }));
        } else {
            dispatch(addSnippet(saved));
        }
        setDialogOpen(false);
        setEditingSnippet(null);
    };

    const confirmDelete = () => {
        if (deleteTarget) dispatch(removeSnippet(deleteTarget.id));
        setDeleteTarget(null);
    };

    const startRename = (folder: string) => {
        setRenamingFolder(folder);
        setRenameValue(folder);
    };
    const commitRename = () => {
        if (renamingFolder === null) return;
        const to = renameValue.trim();
        // No truthiness guard on `to` (A-01): the reducer treats `to === ''` as
        // "unfile these snippets" (settingsSlice.ts), and clearing the rename box is
        // the obvious way to do that from this UI. Only a true no-op rename is skipped.
        if (to !== renamingFolder) dispatch(renameSnippetFolder({ from: renamingFolder, to }));
        setRenamingFolder(null);
    };
    const cancelRename = () => setRenamingFolder(null);

    const runExport = async () => {
        setResultLine(null);
        setPortBusy(true);
        try {
            const r = await exportSnippets(snippets);
            // A dismissed dialog is a normal outcome (§8.4) — render nothing for it,
            // not an error line.
            if (r.ok === 'cancelled') return;
            setResultLine(r.ok ? `Exported to ${r.path}` : r.reason);
        } finally {
            setPortBusy(false);
        }
    };

    const runImport = async () => {
        setResultLine(null);
        setPortBusy(true);
        try {
            const r = await importSnippets(snippets);
            if (r.ok === 'cancelled') return;
            if (r.ok) {
                // Single persist: append everything accepted in one setSnippets (§8.4 step 7).
                dispatch(setSnippets([...snippets, ...r.added]));
                setResultLine(describeImport(r));
            } else {
                setResultLine(r.reason);
            }
        } finally {
            setPortBusy(false);
        }
    };

    return (
        <div className="settings-section">
            <h2>Snippets</h2>
            <p className="section-description">
                Reusable pieces of terminal input — commands, prompts, anything you paste often.
                Available from the terminal's right-click Snippets menu.
            </p>

            <div className="snippets-toolbar">
                <button type="button" className="link-btn" onClick={openCreate}>
                    New Snippet
                </button>
                <button
                    type="button"
                    className="link-btn"
                    onClick={() => { void runImport(); }}
                    disabled={portBusy}
                    // The format is detected, never chosen (plan/030 §4.1), so the only place
                    // a user can learn that a foreign export is accepted at all is here —
                    // otherwise the feature is invisible until they guess.
                    title="Import a TermFlow snippets export, an InkSpoke Command Mappings export, or a Rephlo commands export. The format is detected automatically."
                >
                    Import…
                </button>
                <button type="button" className="link-btn" onClick={() => { void runExport(); }} disabled={portBusy}>
                    Export…
                </button>
            </div>

            {resultLine && <p className="snippets-result-line">{resultLine}</p>}

            {snippets.length === 0 ? (
                <p className="help-text">
                    A snippet is a saved piece of terminal input you insert with one click from the
                    terminal's right-click Snippets menu. Click "New Snippet" above to add your first
                    one.
                </p>
            ) : (
                groups.map((g) => (
                    <div className="snippets-group" key={g.folder || UNFILED}>
                        <div className="snippets-group-header">
                            {renamingFolder === g.folder && g.folder !== '' ? (
                                <>
                                    <input
                                        className="snippets-folder-rename-input"
                                        value={renameValue}
                                        autoFocus
                                        onChange={(e) => setRenameValue(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') commitRename();
                                            else if (e.key === 'Escape') cancelRename();
                                        }}
                                        aria-label={`Rename folder ${g.folder}`}
                                    />
                                    <button type="button" className="link-btn" onClick={commitRename}>
                                        Save
                                    </button>
                                    <button type="button" className="link-btn" onClick={cancelRename}>
                                        Cancel
                                    </button>
                                </>
                            ) : (
                                <>
                                    <span className="snippets-group-label">{g.folder || 'Unfiled'}</span>
                                    {g.folder !== '' && (
                                        <button
                                            type="button"
                                            className="link-btn"
                                            onClick={() => startRename(g.folder)}
                                            aria-label={`Rename folder ${g.folder}`}
                                        >
                                            Rename
                                        </button>
                                    )}
                                </>
                            )}
                        </div>

                        <div className="agent-schema-list snippets-list">
                            {g.snippets.map((s) => (
                                <div className="agent-schema-row snippets-row" key={s.id}>
                                    <span className="agent-schema-name snippets-name">
                                        {snippetDisplayLabel(s)}
                                    </span>
                                    <span className="snippets-folder-chip">{s.folder?.trim() || 'Unfiled'}</span>
                                    {s.tags && s.tags.length > 0 && (
                                        <span className="snippets-tags">{s.tags.join(', ')}</span>
                                    )}
                                    <button type="button" className="link-btn" onClick={() => openEdit(s)}>
                                        Edit
                                    </button>
                                    <button
                                        type="button"
                                        className="agent-schema-remove"
                                        title={`Delete ${snippetDisplayLabel(s)}`}
                                        aria-label={`Delete ${snippetDisplayLabel(s)}`}
                                        onClick={() => setDeleteTarget(s)}
                                    >
                                        ×
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                ))
            )}

            <SnippetDialog
                isOpen={dialogOpen}
                snippet={editingSnippet}
                snippets={snippets}
                onSave={saveSnippet}
                onCancel={() => { setDialogOpen(false); setEditingSnippet(null); }}
            />

            <ConfirmDialog
                isOpen={deleteTarget !== null}
                title="Delete snippet"
                message={
                    deleteTarget
                        ? `Delete "${snippetDisplayLabel(deleteTarget)}"? This cannot be undone.`
                        : ''
                }
                onConfirm={confirmDelete}
                onCancel={() => setDeleteTarget(null)}
                confirmText="Delete"
                destructive
            />
        </div>
    );
};
