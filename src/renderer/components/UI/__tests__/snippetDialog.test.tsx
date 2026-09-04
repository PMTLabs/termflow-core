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
        expect(draft.folder).toBeDefined();
        expect(draft.folder).not.toContain('/');
    });
});
