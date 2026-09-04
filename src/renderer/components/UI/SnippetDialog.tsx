import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './SnippetDialog.css';
import { useDialogA11y } from './useDialogA11y';
import type { Snippet } from '../../store/slices/settingsSlice';
import { snippetDisplayLabel, snippetFolders } from '../../services/snippetSearch';

export interface SnippetDialogProps {
    isOpen: boolean;
    /**
     * The snippet being edited, or `null`/`undefined` for create mode. Edit mode
     * preserves `id` and `createdAt`; create mode mints both.
     */
    snippet?: Snippet | null;
    /** Full snippet list — used only to derive the folder `<datalist>` vocabulary. */
    snippets: Snippet[];
    /**
     * Called with the finished draft when the user saves. This component never
     * dispatches to Redux and never knows which caller opened it — the caller
     * chooses `addSnippet` (create mode) vs `updateSnippet` (edit mode).
     */
    onSave: (snippet: Snippet) => void;
    /** Escape, the Cancel button, and the overlay/✕ all route here. Never followed by onSave. */
    onCancel: () => void;
}

/**
 * plan/029 §7.3 — the shared create/edit modal for a Snippet, used by the Settings
 * panel (T7) and the terminal context menu's "Add New Snippet" (T6). Presentational
 * only, built on the shared `useDialogA11y` focus-trap primitive (AddPeerModal /
 * ConfirmDialog precedent).
 */

/** Mint a fresh id for a new snippet. `generateId()` in utils/id.ts is scoped to the
 * tab/pane/terminal id spaces (see the "four id spaces" note) and does not have a
 * snippet prefix, so this follows the repo's other config-item-id precedent
 * (`StateManager.ts`'s `layout-${Date.now()}-${Math.random()...}`) instead of
 * widening that union for an unrelated domain. */
function mintSnippetId(): string {
    return `snip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * One folder level only (D7). A `/` typed into the field is flattened rather than
 * rejected: rejecting would block Save entirely over a stray keystroke, while
 * flattening (dropping the slash) keeps the single-level model truthful — no fake
 * nested hierarchy is ever created — without adding friction to the fast save path.
 */
function flattenFolder(raw: string): string {
    return raw.replace(/\//g, ' ').replace(/\s+/g, ' ').trim();
}

function parseTags(raw: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of raw.split(',')) {
        const tag = part.trim();
        if (tag && !seen.has(tag)) {
            seen.add(tag);
            out.push(tag);
        }
    }
    return out;
}

export const SnippetDialog: React.FC<SnippetDialogProps> = ({
    isOpen,
    snippet,
    snippets,
    onSave,
    onCancel,
}) => {
    const isEdit = !!snippet;
    const [text, setText] = useState(snippet?.text ?? '');
    const [label, setLabel] = useState(snippet?.label ?? '');
    const [folder, setFolder] = useState(snippet?.folder ?? '');
    const [tagsRaw, setTagsRaw] = useState((snippet?.tags ?? []).join(', '));

    /**
     * Re-seed the fields whenever the dialog opens, or the snippet being edited changes
     * while it is already open.
     *
     * The initializers above run ONCE. Callers render this component unconditionally —
     * `isOpen` only chooses between `null` and the portal — so it never remounts on its
     * own, and opening it for Edit after a create reused the previous, stale state:
     * the title read "Edit snippet" over blank fields.
     *
     * This belongs here, not at the call sites. A remount `key` in one caller fixes that
     * caller and leaves every other one to rediscover the same bug — and there are already
     * two (the Settings panel and the terminal context menu).
     *
     * Keyed on `snippet?.id` rather than `snippet` so a parent re-render that produces a
     * new object for the same snippet cannot wipe out what the user is typing.
     */
    useEffect(() => {
        if (!isOpen) return;
        setText(snippet?.text ?? '');
        setLabel(snippet?.label ?? '');
        setFolder(snippet?.folder ?? '');
        setTagsRaw((snippet?.tags ?? []).join(', '));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, snippet?.id]);

    const containerRef = useRef<HTMLDivElement>(null);
    const textRef = useRef<HTMLTextAreaElement>(null);
    const titleId = useId();
    const folderListId = useId();

    const folders = useMemo(() => snippetFolders(snippets), [snippets]);
    const placeholderLabel = useMemo(
        () => snippetDisplayLabel({ id: '', text: text || ' ', createdAt: 0 }),
        [text],
    );

    const canSave = text.trim().length > 0;

    const buildDraft = (): Snippet => {
        const trimmedLabel = label.trim();
        const trimmedFolder = flattenFolder(folder);
        const tags = parseTags(tagsRaw);
        return {
            id: snippet?.id ?? mintSnippetId(),
            text: text.trim(),
            // Explicit keys, not omitted ones (D-04): `updateSnippet` merges this patch
            // into the stored snippet, so an omitted key here would leave a stale value
            // in place. `undefined` is a real instruction to clear the field, and the
            // slice's patch merge (settingsSlice.ts) deletes a key whose patch value is
            // `undefined` rather than ignoring it.
            label: trimmedLabel || undefined,
            folder: trimmedFolder || undefined,
            tags: tags.length > 0 ? tags : undefined,
            createdAt: snippet?.createdAt ?? Date.now(),
        };
    };

    const save = () => {
        if (!canSave) return;
        onSave(buildDraft());
    };

    useDialogA11y(containerRef, {
        isOpen,
        onCancel,
        initialFocus: textRef as React.RefObject<HTMLElement>,
    });

    if (!isOpen) return null;

    return createPortal(
        <div className="snippet-dialog-overlay" onClick={onCancel}>
            <div
                className="snippet-dialog"
                ref={containerRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="snippet-dialog-header">
                    <h3 id={titleId}>{isEdit ? 'Edit snippet' : 'New snippet'}</h3>
                    <button className="snippet-dialog-close" onClick={onCancel} aria-label="Close">✕</button>
                </div>

                <form
                    className="snippet-dialog-body"
                    onSubmit={(e) => { e.preventDefault(); save(); }}
                >
                    <label className="snippet-dialog-label" htmlFor={`${titleId}-text`}>Text</label>
                    <textarea
                        id={`${titleId}-text`}
                        ref={textRef}
                        className="snippet-dialog-textarea"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        rows={8}
                        placeholder="Snippet text — multi-line supported, inserted verbatim"
                        spellCheck={false}
                    />

                    <label className="snippet-dialog-label" htmlFor={`${titleId}-label`}>Label</label>
                    <input
                        id={`${titleId}-label`}
                        data-field="label"
                        className="snippet-dialog-input"
                        type="text"
                        value={label}
                        onChange={(e) => setLabel(e.target.value)}
                        placeholder={placeholderLabel}
                        autoComplete="off"
                        spellCheck={false}
                    />

                    <label className="snippet-dialog-label" htmlFor={`${titleId}-folder`}>Folder</label>
                    <input
                        id={`${titleId}-folder`}
                        data-field="folder"
                        className="snippet-dialog-input"
                        type="text"
                        value={folder}
                        onChange={(e) => setFolder(e.target.value)}
                        placeholder="Unfiled"
                        list={folderListId}
                        autoComplete="off"
                        spellCheck={false}
                    />
                    <datalist id={folderListId}>
                        {folders.map((f) => <option key={f} value={f} />)}
                    </datalist>

                    <label className="snippet-dialog-label" htmlFor={`${titleId}-tags`}>Tags</label>
                    <input
                        id={`${titleId}-tags`}
                        data-field="tags"
                        className="snippet-dialog-input"
                        type="text"
                        value={tagsRaw}
                        onChange={(e) => setTagsRaw(e.target.value)}
                        placeholder="comma, separated, tags"
                        autoComplete="off"
                        spellCheck={false}
                    />

                    <div className="snippet-dialog-footer">
                        <button
                            type="button"
                            className="snippet-dialog-btn snippet-dialog-btn--cancel"
                            data-dialog-cancel
                            onClick={onCancel}
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            className="snippet-dialog-btn snippet-dialog-btn--save"
                            data-dialog-confirm
                            disabled={!canSave}
                        >
                            {isEdit ? 'Save' : 'Add snippet'}
                        </button>
                    </div>
                </form>
            </div>
        </div>,
        document.body,
    );
};
