/**
 * @jest-environment jsdom
 *
 * Settings → Snippets panel (plan/029 §7.2, T7). Full CRUD surface over
 * `state.settings.snippets`: grouped-by-folder rows, Edit/Delete (Delete confirms),
 * New Snippet, folder rename, and Import/Export.
 *
 * Repo convention: no React Testing Library (installed v13 predates React 19) —
 * driven via a real DOM render with `react-dom/client` + `React.act`, mirroring
 * `settingsNavGuardArming.test.tsx` / `PeersPanel.test.tsx`.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import settingsReducer, { Snippet } from '../../../store/slices/settingsSlice';

// Jest has no CSS transform.
jest.mock('../SnippetsPanel.css', () => ({}));
jest.mock('../../UI/SnippetDialog.css', () => ({}));
jest.mock('../../UI/ConfirmDialog.css', () => ({}));

// The import/export service is owned by a concurrent task (T8) — this suite only
// exercises the panel's wiring to it, not its own behaviour (covered by
// snippetPorting's own test file).
const exportSnippets = jest.fn();
const importSnippets = jest.fn();
jest.mock('../../../services/snippetPorting', () => ({
    exportSnippets: (...args: unknown[]) => exportSnippets(...args),
    importSnippets: (...args: unknown[]) => importSnippets(...args),
    describeImport: (r: { imported: number; skippedDuplicates: number; rejected: number }) =>
        `Imported ${r.imported}, skipped ${r.skippedDuplicates} duplicates, rejected ${r.rejected} malformed.`,
}));

// eslint-disable-next-line import/first
import { SnippetsPanel } from '../SnippetsPanel';

function makeStore(snippets: Snippet[] = []) {
    return configureStore({
        reducer: { settings: settingsReducer },
        preloadedState: { settings: { ...settingsReducer(undefined, { type: '@@init' }), snippets } },
    });
}

const snip = (over: Partial<Snippet> = {}): Snippet => ({
    id: over.id ?? `sn-${Math.random().toString(36).slice(2, 8)}`,
    text: over.text ?? 'echo hello',
    createdAt: over.createdAt ?? 1000,
    ...over,
});

describe('SnippetsPanel', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeAll(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
            true;
    });

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        exportSnippets.mockReset();
        importSnippets.mockReset();
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    });

    async function mount(store: ReturnType<typeof makeStore>) {
        root = createRoot(container);
        await act(async () => {
            root.render(
                <Provider store={store}>
                    <SnippetsPanel />
                </Provider>,
            );
        });
    }

    async function flush() {
        await act(async () => {
            await Promise.resolve();
        });
    }

    const rows = () => Array.from(container.querySelectorAll('.snippets-row'));
    const groupLabels = () =>
        Array.from(container.querySelectorAll('.snippets-group-label')).map((el) => el.textContent);
    const click = async (el: Element | null) => {
        expect(el).not.toBeNull();
        await act(async () => {
            (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };

    it('renders the empty state and stays usable', async () => {
        await mount(makeStore([]));
        expect(container.textContent).toContain('A snippet is a saved piece of terminal input');
        expect(container.querySelector('.snippets-group')).toBeNull();
        expect(container.querySelector('button')).not.toBeNull(); // "New Snippet" still reachable
    });

    it('groups rows by folder, unfiled last', async () => {
        const store = makeStore([
            snip({ id: 'a', text: 'a', folder: 'git', createdAt: 1 }),
            snip({ id: 'b', text: 'b', createdAt: 2 }), // unfiled
            snip({ id: 'c', text: 'c', folder: 'docker', createdAt: 3 }),
        ]);
        await mount(store);

        expect(groupLabels()).toEqual(['docker', 'git', 'Unfiled']);
        expect(rows()).toHaveLength(3);
    });

    it('Edit opens the dialog pre-filled with that snippet', async () => {
        const target = snip({ id: 'a', text: 'echo target', label: 'My Label', folder: 'git', tags: ['x', 'y'] });
        await mount(makeStore([target]));

        const editBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Edit');
        await click(editBtn ?? null);

        const textarea = document.querySelector('.snippet-dialog-textarea') as HTMLTextAreaElement;
        const labelInput = document.querySelector('input[data-field="label"]') as HTMLInputElement;
        const folderInput = document.querySelector('input[data-field="folder"]') as HTMLInputElement;
        const tagsInput = document.querySelector('input[data-field="tags"]') as HTMLInputElement;

        expect(textarea.value).toBe('echo target');
        expect(labelInput.value).toBe('My Label');
        expect(folderInput.value).toBe('git');
        expect(tagsInput.value).toBe('x, y');
    });

    it('saving from create mode dispatches addSnippet', async () => {
        const store = makeStore([]);
        await mount(store);

        const newBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'New Snippet');
        await click(newBtn ?? null);

        const textarea = document.querySelector('.snippet-dialog-textarea') as HTMLTextAreaElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
            setter.call(textarea, 'a brand new snippet');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });

        const saveBtn = document.querySelector('[data-dialog-confirm]');
        await click(saveBtn);

        expect(store.getState().settings.snippets).toHaveLength(1);
        expect(store.getState().settings.snippets[0].text).toBe('a brand new snippet');
        // The dialog must have closed.
        expect(document.querySelector('.snippet-dialog')).toBeNull();
    });

    it('saving from edit mode dispatches updateSnippet, not addSnippet', async () => {
        const target = snip({ id: 'edit-me', text: 'old text' });
        const store = makeStore([target]);
        await mount(store);

        const editBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Edit');
        await click(editBtn ?? null);

        const textarea = document.querySelector('.snippet-dialog-textarea') as HTMLTextAreaElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
            setter.call(textarea, 'new text');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });

        const saveBtn = document.querySelector('[data-dialog-confirm]');
        await click(saveBtn);

        const state = store.getState().settings.snippets;
        expect(state).toHaveLength(1); // no new record — same id, in place
        expect(state[0].id).toBe('edit-me');
        expect(state[0].text).toBe('new text');
    });

    it('Delete asks for confirmation and only dispatches removeSnippet after confirming', async () => {
        const target = snip({ id: 'doomed', text: 'delete me' });
        const store = makeStore([target]);
        await mount(store);

        const deleteBtn = container.querySelector('.agent-schema-remove');
        await click(deleteBtn);

        expect(document.querySelector('.confirm-dialog')).not.toBeNull();
        expect(store.getState().settings.snippets).toHaveLength(1); // not removed yet

        // Cancel first: must NOT dispatch removeSnippet.
        const cancelBtn = document.querySelector('[data-dialog-cancel]');
        await click(cancelBtn);
        expect(store.getState().settings.snippets).toHaveLength(1);
        expect(document.querySelector('.confirm-dialog')).toBeNull();

        // Reopen and actually confirm.
        const deleteBtn2 = container.querySelector('.agent-schema-remove');
        await click(deleteBtn2);
        const confirmBtn = document.querySelector('[data-dialog-confirm]');
        await click(confirmBtn);

        expect(store.getState().settings.snippets).toHaveLength(0);
    });

    it('a successful import dispatches exactly one setSnippets with existing + added', async () => {
        const existing = snip({ id: 'keep', text: 'kept' });
        const store = makeStore([existing]);
        const added = [snip({ id: 'new-1', text: 'imported one' })];
        importSnippets.mockResolvedValue({ ok: true, added, imported: 1, skippedDuplicates: 0, rejected: 0 });

        await mount(store);
        const importBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Import…');
        await click(importBtn ?? null);
        await flush();

        expect(importSnippets).toHaveBeenCalledTimes(1);
        const finalIds = store.getState().settings.snippets.map((s) => s.id).sort();
        expect(finalIds).toEqual(['keep', 'new-1']);
        expect(container.textContent).toContain('Imported 1, skipped 0 duplicates, rejected 0 malformed.');
    });

    it('a cancelled import renders no summary and dispatches nothing', async () => {
        const store = makeStore([snip({ id: 'keep', text: 'kept' })]);
        importSnippets.mockResolvedValue({ ok: 'cancelled' });

        await mount(store);
        const importBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Import…');
        await click(importBtn ?? null);
        await flush();

        expect(store.getState().settings.snippets).toHaveLength(1);
        expect(container.querySelector('.snippets-result-line')).toBeNull();
    });

    it('a cancelled export renders no summary and dispatches nothing', async () => {
        const store = makeStore([snip({ id: 'keep', text: 'kept' })]);
        exportSnippets.mockResolvedValue({ ok: 'cancelled' });

        await mount(store);
        const exportBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Export…');
        await click(exportBtn ?? null);
        await flush();

        expect(exportSnippets).toHaveBeenCalledTimes(1);
        expect(container.querySelector('.snippets-result-line')).toBeNull();
        expect(store.getState().settings.snippets).toHaveLength(1);
    });

    // A-01: `renameSnippetFolder` treats `to === ''` as "unfile these snippets"
    // (settingsSlice.ts), but the pre-fix `commitRename` guarded on
    // `if (to && to !== renamingFolder)`, so clearing the rename box — the obvious way
    // to unfile a whole folder from this UI — silently dispatched nothing.
    it('clearing the folder name during rename unfiles every snippet in that folder', async () => {
        const store = makeStore([
            snip({ id: 'a', text: 'a', folder: 'git' }),
            snip({ id: 'b', text: 'b', folder: 'git' }),
            snip({ id: 'c', text: 'c' }), // already unfiled — must stay unaffected
        ]);
        await mount(store);

        const renameBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Rename');
        await click(renameBtn ?? null);

        const renameInput = container.querySelector('.snippets-folder-rename-input') as HTMLInputElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            setter.call(renameInput, '');
            renameInput.dispatchEvent(new Event('input', { bubbles: true }));
        });

        const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save');
        await click(saveBtn ?? null);

        // A wrong implementation guarding `if (to && ...)` never dispatches when
        // `to === ''`, so both 'git' snippets would still carry `folder: 'git'` here.
        const state = store.getState().settings.snippets;
        expect(state.find((s) => s.id === 'a')!.folder).toBeUndefined();
        expect(state.find((s) => s.id === 'b')!.folder).toBeUndefined();
        expect(state.find((s) => s.id === 'c')!.folder).toBeUndefined();
        // The rename UI itself must close (no longer treated as a no-op / stuck open).
        expect(container.querySelector('.snippets-folder-rename-input')).toBeNull();
    });

    // Link 9 mutation guard: replacing `useSelector((s) => s.settings.snippets)` with
    // a hard-coded literal array is a legal argument to the same call site — `tsc`
    // cannot see it — so this must be caught by behavior instead. A store seeded with
    // a snippet the component did not itself add must show up; a literal binding
    // would either show nothing or show a fixed fake list instead of this exact one.
    it('reads snippets from the store, not a hard-coded literal', async () => {
        const distinctiveText = `store-bound-marker-${Math.random().toString(36).slice(2)}`;
        const store = makeStore([snip({ id: 'marker', text: distinctiveText })]);
        await mount(store);
        expect(container.textContent).toContain(distinctiveText);

        // Mutating the store after mount must also be reflected — a literal could
        // never do this regardless of its initial content.
        await act(async () => {
            store.dispatch({
                type: 'settings/addSnippet',
                payload: snip({ id: 'marker-2', text: 'added-after-mount' }),
            });
        });
        expect(container.textContent).toContain('added-after-mount');
    });
});
