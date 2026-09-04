/**
 * @jest-environment jsdom
 *
 * SnippetDialog (plan/029 §7.3) — shared create/edit modal for T6 (context menu's
 * "Add New Snippet") and T7 (Settings panel). Presentational only: no Redux, no
 * knowledge of its caller. It hands a draft back through `onSave`; the caller
 * decides between `addSnippet`/`updateSnippet`.
 *
 * Repo convention: no React Testing Library (installed v13 predates React 19) —
 * drive a real DOM render via react-dom/client + React.act (see
 * settingsNavGuardArming.test.tsx).
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

// Jest has no CSS transform (moduleNameMapper also stubs this, but mock explicitly
// per repo convention so the test doesn't depend on that mapping).
jest.mock('../SnippetDialog.css', () => ({}));

// eslint-disable-next-line import/first
import { SnippetDialog } from '../SnippetDialog';
// eslint-disable-next-line import/first
import type { Snippet } from '../../../store/slices/settingsSlice';

describe('SnippetDialog', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
            true;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        jest.restoreAllMocks();
    });

    async function render(props: {
        snippet?: Snippet | null;
        snippets?: Snippet[];
        onSave: (s: Snippet) => void;
        onCancel: () => void;
    }) {
        await act(async () => {
            root.render(
                <SnippetDialog
                    isOpen
                    snippet={props.snippet ?? null}
                    snippets={props.snippets ?? []}
                    onSave={props.onSave}
                    onCancel={props.onCancel}
                />,
            );
        });
    }

    function textarea(): HTMLTextAreaElement {
        return document.querySelector('.snippet-dialog textarea') as HTMLTextAreaElement;
    }
    function labelInput(): HTMLInputElement {
        return document.querySelector('.snippet-dialog input[data-field="label"]') as HTMLInputElement;
    }
    function folderInput(): HTMLInputElement {
        return document.querySelector('.snippet-dialog input[data-field="folder"]') as HTMLInputElement;
    }
    function tagsInput(): HTMLInputElement {
        return document.querySelector('.snippet-dialog input[data-field="tags"]') as HTMLInputElement;
    }
    function saveBtn(): HTMLButtonElement {
        return document.querySelector('.snippet-dialog [data-dialog-confirm]') as HTMLButtonElement;
    }
    function cancelBtn(): HTMLButtonElement {
        return document.querySelector('.snippet-dialog [data-dialog-cancel]') as HTMLButtonElement;
    }

    function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
        const setter = Object.getOwnPropertyDescriptor(
            el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
            'value',
        )!.set!;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    it('disables Save when text is empty and enables it once text is entered', async () => {
        const onSave = jest.fn();
        const onCancel = jest.fn();
        await render({ onSave, onCancel });

        expect(saveBtn().disabled).toBe(true);

        await act(async () => setValue(textarea(), 'kubectl get pods'));
        expect(saveBtn().disabled).toBe(false);
    });

    it('keeps Save disabled for whitespace-only text', async () => {
        const onSave = jest.fn();
        const onCancel = jest.fn();
        await render({ onSave, onCancel });

        await act(async () => setValue(textarea(), '   \n  \t '));
        expect(saveBtn().disabled).toBe(true);
    });

    it('passes the parsed draft to onSave with de-duplicated, trimmed tags', async () => {
        const onSave = jest.fn();
        const onCancel = jest.fn();
        await render({ onSave, onCancel });

        await act(async () => {
            setValue(textarea(), 'docker compose up -d');
            setValue(labelInput(), 'Compose up');
            setValue(folderInput(), 'Docker');
            setValue(tagsInput(), ' docker, compose ,docker , , compose');
        });
        await act(async () => saveBtn().click());

        expect(onSave).toHaveBeenCalledTimes(1);
        const draft = onSave.mock.calls[0][0] as Snippet;
        expect(draft.text).toBe('docker compose up -d');
        expect(draft.label).toBe('Compose up');
        expect(draft.folder).toBe('Docker');
        expect(draft.tags).toEqual(['docker', 'compose']);
        expect(onCancel).not.toHaveBeenCalled();
    });

    it('preserves multi-line text verbatim, including newlines', async () => {
        const onSave = jest.fn();
        const onCancel = jest.fn();
        await render({ onSave, onCancel });

        const multiline = 'line one\nline two\n\nline four';
        await act(async () => setValue(textarea(), multiline));
        await act(async () => saveBtn().click());

        expect(onSave).toHaveBeenCalledTimes(1);
        const draft = onSave.mock.calls[0][0] as Snippet;
        expect(draft.text).toBe(multiline);
    });

    it('trims only leading/trailing whitespace off the saved text', async () => {
        const onSave = jest.fn();
        const onCancel = jest.fn();
        await render({ onSave, onCancel });

        await act(async () => setValue(textarea(), '  \n hello\n  world \n  '));
        await act(async () => saveBtn().click());

        const draft = onSave.mock.calls[0][0] as Snippet;
        expect(draft.text).toBe('hello\n  world');
    });

    it('returns a blank label as absent rather than a whitespace string', async () => {
        const onSave = jest.fn();
        const onCancel = jest.fn();
        await render({ onSave, onCancel });

        await act(async () => {
            setValue(textarea(), 'some text');
            setValue(labelInput(), '   ');
        });
        await act(async () => saveBtn().click());

        const draft = onSave.mock.calls[0][0] as Snippet;
        expect(draft.label).toBeFalsy();
    });

    it('a click on the OVERLAY does not throw the form away', async () => {
        // ConfirmDialog dismisses this way and should: it holds a question. This holds a
        // form, and a click landing a few pixels outside the panel — reaching for the
        // Folder field, or a datalist suggestion — is easy to make and has no undo.
        const onSave = jest.fn();
        const onCancel = jest.fn();
        await render({ onSave, onCancel });

        await act(async () => setValue(textarea(), 'half-written'));
        await act(async () => {
            document
                .querySelector('.snippet-dialog-overlay')!
                .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(onCancel).not.toHaveBeenCalled();
        expect(onSave).not.toHaveBeenCalled();
        // Still open, and still holding what was typed.
        expect(textarea().value).toBe('half-written');
    });

    it('Escape calls onCancel and never onSave', async () => {
        const onSave = jest.fn();
        const onCancel = jest.fn();
        await render({ onSave, onCancel });

        await act(async () => setValue(textarea(), 'something'));
        await act(async () => {
            document
                .querySelector('.snippet-dialog')!
                .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });

        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onSave).toHaveBeenCalledTimes(0);
    });

    it('Cancel calls onCancel and never onSave', async () => {
        const onSave = jest.fn();
        const onCancel = jest.fn();
        await render({ onSave, onCancel });

        await act(async () => setValue(textarea(), 'something'));
        await act(async () => cancelBtn().click());

        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onSave).toHaveBeenCalledTimes(0);
    });

    it('edit mode preserves id and createdAt; create mode mints a fresh id', async () => {
        const existing: Snippet = {
            id: 'snip-existing',
            label: 'Old label',
            text: 'old text',
            folder: 'Git',
            tags: ['a'],
            createdAt: 12345,
        };
        const onSave = jest.fn();
        const onCancel = jest.fn();

        // Edit mode.
        await render({ snippet: existing, onSave, onCancel });
        await act(async () => setValue(textarea(), 'new text'));
        await act(async () => saveBtn().click());
        const editedDraft = onSave.mock.calls[0][0] as Snippet;
        expect(editedDraft.id).toBe('snip-existing');
        expect(editedDraft.createdAt).toBe(12345);
        expect(editedDraft.text).toBe('new text');

        onSave.mockClear();

        // Create mode, fresh mount.
        await act(async () => root.unmount());
        container.remove();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await render({ snippet: null, onSave, onCancel });
        await act(async () => setValue(textarea(), 'brand new snippet'));
        await act(async () => saveBtn().click());
        const createdDraft = onSave.mock.calls[0][0] as Snippet;
        expect(createdDraft.id).toBeTruthy();
        expect(createdDraft.id).not.toBe('snip-existing');
        expect(typeof createdDraft.createdAt).toBe('number');
    });

    it('flattens a folder value containing a slash instead of creating nested hierarchy', async () => {
        const onSave = jest.fn();
        const onCancel = jest.fn();
        await render({ onSave, onCancel });

        await act(async () => {
            setValue(textarea(), 'text');
            setValue(folderInput(), 'Git/Sub');
        });
        await act(async () => saveBtn().click());

        const draft = onSave.mock.calls[0][0] as Snippet;
        // B-05: exact expected string, not just "no slash". `'GitSub'` (strip) and
        // `'Git'` (truncate at slash) both satisfy `not.toContain('/')` but are not
        // what `flattenFolder` (replace '/' with ' ', collapse whitespace) produces.
        expect(draft.folder).toBe('Git Sub');
    });

    /**
     * D-04 (blocker): `buildDraft()` used to omit a cleared field entirely
     * (`...(trimmedLabel ? { label: trimmedLabel } : {})`), and `updateSnippet` merges
     * the returned patch into the stored snippet — an OMITTED key is left alone, so
     * clearing a label/folder/tags in the dialog silently did nothing. The fix must
     * return the key explicitly with value `undefined`, which the slice's patch merge
     * treats as "delete this field". Absence and explicit-undefined are different
     * things here, so the oracle below checks for the KEY, not just the value.
     */
    it('clearing an edited snippet\'s label, folder and tags produces explicit undefined keys, not omitted ones', async () => {
        const existing: Snippet = {
            id: 'snip-clear',
            label: 'Old label',
            text: 'text',
            folder: 'Git',
            tags: ['a', 'b'],
            createdAt: 111,
        };
        const onSave = jest.fn();
        const onCancel = jest.fn();
        await render({ snippet: existing, onSave, onCancel });

        await act(async () => {
            setValue(labelInput(), '');
            setValue(folderInput(), '');
            setValue(tagsInput(), '');
        });
        await act(async () => saveBtn().click());

        const draft = onSave.mock.calls[0][0] as Snippet;
        // A wrong implementation that omits cleared keys (the pre-fix `buildDraft`)
        // produces a draft object with NO `label`/`folder`/`tags` property at all —
        // `'label' in draft` is `false` — even though `draft.label` reads as
        // `undefined` either way via property access. `in` is what distinguishes them.
        expect('label' in draft).toBe(true);
        expect(draft.label).toBeUndefined();
        expect('folder' in draft).toBe(true);
        expect(draft.folder).toBeUndefined();
        expect('tags' in draft).toBe(true);
        expect(draft.tags).toBeUndefined();
    });

    it('preserves label, folder and tags when editing a snippet without clearing them', async () => {
        const existing: Snippet = {
            id: 'snip-keep',
            label: 'Keep label',
            text: 'text',
            folder: 'Ops',
            tags: ['x'],
            createdAt: 222,
        };
        const onSave = jest.fn();
        const onCancel = jest.fn();
        await render({ snippet: existing, onSave, onCancel });

        await act(async () => setValue(textarea(), 'text edited'));
        await act(async () => saveBtn().click());

        const draft = onSave.mock.calls[0][0] as Snippet;
        expect(draft.label).toBe('Keep label');
        expect(draft.folder).toBe('Ops');
        expect(draft.tags).toEqual(['x']);
    });

    /**
     * Regression, found by the Settings panel during integration.
     *
     * Callers render this dialog UNCONDITIONALLY — `isOpen` only chooses between `null`
     * and the portal — so it never remounts on its own and the `useState` initializers
     * run exactly once. Without a re-seed on open, the second open reuses the first
     * open's state: "Edit snippet" over blank fields, or a create form still holding the
     * snippet you were just editing.
     *
     * Pinned HERE rather than at a call site on purpose. There are two callers (the
     * Settings panel and the terminal context menu) and a remount `key` in one of them
     * leaves the other to rediscover the same bug.
     */
    describe('re-seeds its fields on every open', () => {
        async function renderWith(isOpen: boolean, snippet: Snippet | null) {
            await act(async () => {
                root.render(
                    <SnippetDialog
                        isOpen={isOpen}
                        snippet={snippet}
                        snippets={[]}
                        onSave={jest.fn()}
                        onCancel={jest.fn()}
                    />,
                );
            });
        }

        const existing: Snippet = {
            id: 'snip-a',
            label: 'Deploy',
            text: 'kubectl apply -f .',
            folder: 'Ops',
            tags: ['k8s'],
            createdAt: 1,
        };

        it('populates the fields when opened for edit after having been open for create', async () => {
            await renderWith(true, null);
            expect(textarea().value).toBe('');

            await renderWith(false, null);
            await renderWith(true, existing);

            expect(textarea().value).toBe('kubectl apply -f .');
            expect(labelInput().value).toBe('Deploy');
            expect(folderInput().value).toBe('Ops');
        });

        it('clears the fields when opened for create after having been open for edit', async () => {
            await renderWith(true, existing);
            expect(textarea().value).toBe('kubectl apply -f .');

            await renderWith(false, existing);
            await renderWith(true, null);

            expect(textarea().value).toBe('');
            expect(labelInput().value).toBe('');
            expect(folderInput().value).toBe('');
        });

        it('does not discard in-progress typing when the parent re-renders the same snippet', async () => {
            await renderWith(true, existing);
            await act(async () => setValue(textarea(), 'edited by the user'));

            // A new object for the SAME snippet — exactly what a parent re-render produces.
            await renderWith(true, { ...existing });

            expect(textarea().value).toBe('edited by the user');
        });
    });
});
