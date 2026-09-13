import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../../store';
import {
    Snippet,
    addSnippet,
    updateSnippet,
    removeSnippet,
    renameSnippetFolder,
    setSnippets,
    setSnippetsSortMode,
} from '../../store/slices/settingsSlice';
import { filterSnippets, SNIPPET_SORT_LABELS, SNIPPET_SORT_MODES, snippetDisplayLabel, sortSnippets } from '../../services/snippetSearch';
import { writeClipboardText } from '../../utils/clipboard';
import { exportSnippets, importSnippets, describeImport } from '../../services/snippetPorting';
import { SnippetDialog } from '../UI/SnippetDialog';
import { ConfirmDialog } from '../UI/ConfirmDialog';
import './SnippetsPanel.css';

/** The unfiled bucket's internal group key. Never a real folder name (flattenFolder
 * in SnippetDialog strips '/' and trims, so it can never produce this token). */
const UNFILED = '__unfiled__';
// Large enough that ordinary libraries stay one uninterrupted list, while preventing a bulk import
// from turning Settings into a needlessly long scroll before the browser can paint the controls.
const SNIPPETS_PAGE_SIZE = 500;

interface FolderGroup {
    /** '' for the unfiled group; otherwise the folder name. */
    folder: string;
    snippets: Snippet[];
}

interface SnippetsPanelProps {
    focusSearchSignal?: number;
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
export const SnippetsPanel: React.FC<SnippetsPanelProps> = ({ focusSearchSignal }) => {
    const dispatch = useDispatch<AppDispatch>();
    const snippets = useSelector((s: RootState) => s.settings.snippets);
    const snippetsSortMode = useSelector((s: RootState) => s.settings.snippetsSortMode);
    const searchRef = useRef<HTMLInputElement>(null);

    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<Snippet | null>(null);
    const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [portBusy, setPortBusy] = useState(false);
    const [resultLine, setResultLine] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(1);

    // Re-focus on tab reactivation, same-category deep links, and dirty-guard completion as well as
    // mount; a passive effect wins over useDialogA11y's passive cleanup that restores sidebar focus.
    //
    // Not while one of this panel's own dialogs is open: the panel stays mounted (and its dialog
    // stays open) while the Settings tab is hidden, so a reactivation would otherwise pull focus out
    // of the modal into the search behind it and leave its focus trap deaf. Read through a ref, not
    // the deps, so CLOSING a dialog does not re-run this and steal the focus useDialogA11y restores.
    const modalOpenRef = useRef(false);
    modalOpenRef.current = dialogOpen || deleteTarget !== null;
    useEffect(() => {
        if (modalOpenRef.current) return;
        searchRef.current?.focus();
    }, [focusSearchSignal]);

    const filteredSnippets = useMemo(() => search.trim() ? filterSnippets(snippets, search) : snippets, [snippets, search]);
    const sortedGroups = useMemo(
        () => groupByFolder(filteredSnippets).map((group) => ({ ...group, snippets: sortSnippets(group.snippets, snippetsSortMode) })),
        [filteredSnippets, snippetsSortMode],
    );
    // Flatten only to count and cut rows. Re-grouping the resulting window intentionally repeats a
    // folder header when its rows span pages, making each page understandable on its own.
    const sortedSnippets = useMemo(() => sortedGroups.flatMap((group) => group.snippets), [sortedGroups]);
    const totalPages = Math.max(1, Math.ceil(sortedSnippets.length / SNIPPETS_PAGE_SIZE));
    const pageStart = (page - 1) * SNIPPETS_PAGE_SIZE;
    const pageSnippets = sortedSnippets.slice(pageStart, pageStart + SNIPPETS_PAGE_SIZE);
    const groups = useMemo(() => groupByFolder(pageSnippets), [pageSnippets]);

    // A new filter or ordering defines a different result set, so retaining an old page number
    // would commonly present a misleading empty panel instead of the first matching rows.
    useEffect(() => setPage(1), [search, snippetsSortMode]);
    // Deletes/import changes can shrink a result set without changing either control above.
    useEffect(() => {
        if (page > totalPages) setPage(totalPages);
    }, [page, totalPages]);

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

    const copySnippet = async (s: Snippet) => {
        try {
            await writeClipboardText(s.text);
            setResultLine(`Copied “${snippetDisplayLabel(s)}” to the clipboard.`);
        } catch {
            setResultLine('Could not copy snippet to the clipboard.');
        }
    };

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
                <button type="button" className="snippets-toolbar-btn" onClick={openCreate}>
                    New Snippet
                </button>
                <button
                    type="button"
                    className="snippets-toolbar-btn"
                    onClick={() => { void runImport(); }}
                    disabled={portBusy}
                    // The format is detected, never chosen (plan/030 §4.1), so the only place
                    // a user can learn that a foreign export is accepted at all is here —
                    // otherwise the feature is invisible until they guess.
                    title="Import a TermFlow snippets export, an InkSpoke Command Mappings export, or a Rephlo commands export. The format is detected automatically."
                >
                    Import…
                </button>
                <button type="button" className="snippets-toolbar-btn" onClick={() => { void runExport(); }} disabled={portBusy}>
                    Export…
                </button>
                <input ref={searchRef} className="snippets-search" value={search} onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search name, text, tag, or initials…" aria-label="Search snippets" />
                <select className="snippets-sort" aria-label="Sort snippets by" value={snippetsSortMode}
                    onChange={(e) => dispatch(setSnippetsSortMode(e.target.value as typeof snippetsSortMode))}>
                    {SNIPPET_SORT_MODES.map((mode) => <option key={mode} value={mode}>{SNIPPET_SORT_LABELS[mode]}</option>)}
                </select>
            </div>

            {resultLine && <p className="snippets-result-line">{resultLine}</p>}

            {snippets.length === 0 ? (
                <p className="help-text">
                    A snippet is a saved piece of terminal input you insert with one click from the
                    terminal's right-click Snippets menu. Click "New Snippet" above to add your first
                    one.
                </p>
            ) : groups.length === 0 ? (
                <p className="help-text">No snippets match “{search.trim()}”</p>
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
                                            className="snippets-icon-btn"
                                            onClick={() => startRename(g.folder)}
                                            title={`Rename folder ${g.folder}`}
                                            aria-label={`Rename folder ${g.folder}`}
                                        >
                                            ✎
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
                                    {s.tags && s.tags.length > 0 && (
                                        <span className="snippets-tags">{s.tags.join(', ')}</span>
                                    )}
                                    {Number.isFinite(s.createdAt) && (
                                        <span className="snippets-created" title={new Date(s.createdAt).toLocaleString()}>{new Date(s.createdAt).toLocaleDateString()}</span>
                                    )}
                                    <span className="snippets-uses" title={s.lastUsedAt ? `Last used: ${new Date(s.lastUsedAt).toLocaleString()}` : 'Never used'}>
                                        {(s.usageCount ?? 0) === 1 ? '1 use' : `${s.usageCount ?? 0} uses`}
                                    </span>
                                    <button type="button" className="snippets-icon-btn" title={`Copy ${snippetDisplayLabel(s)}`} aria-label={`Copy ${snippetDisplayLabel(s)}`} onClick={() => { void copySnippet(s); }}>📋</button>
                                    <button type="button" className="snippets-icon-btn" title={`Edit ${snippetDisplayLabel(s)}`} aria-label={`Edit ${snippetDisplayLabel(s)}`} onClick={() => openEdit(s)}>✏️</button>
                                    <button
                                        type="button"
                                        className="snippets-icon-btn"
                                        title={`Delete ${snippetDisplayLabel(s)}`}
                                        aria-label={`Delete ${snippetDisplayLabel(s)}`}
                                        onClick={() => setDeleteTarget(s)}
                                    >
                                        🗑️
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                ))
            )}

            {sortedSnippets.length > SNIPPETS_PAGE_SIZE && (
                <div className="snippets-pager" aria-label="Snippet pagination">
                    <button type="button" className="snippets-toolbar-btn" disabled={page === 1} onClick={() => setPage((current) => current - 1)}>Prev</button>
                    <span>Page {page} of {totalPages} · rows {pageStart + 1}–{Math.min(pageStart + SNIPPETS_PAGE_SIZE, sortedSnippets.length)} of {sortedSnippets.length}</span>
                    <button type="button" className="snippets-toolbar-btn" disabled={page === totalPages} onClick={() => setPage((current) => current + 1)}>Next</button>
                </div>
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
