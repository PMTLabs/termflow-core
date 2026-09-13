/** @jest-environment jsdom */
/**
 * The automation message snippet picker is mounted under a bare root, like the editor itself.
 * The store is still the app singleton; the Tauri event bridge is mocked only because this test
 * exercises the renderer menu in jsdom rather than a native window.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';

jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn(() => Promise.resolve(undefined)) }));
jest.mock('@tauri-apps/api/event', () => ({ listen: jest.fn(async () => jest.fn()) }));
jest.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: jest.fn(() => ({ label: 'main' })) }));
jest.mock('@tauri-apps/plugin-dialog', () => ({ open: jest.fn(), save: jest.fn() }));

import { SnippetPickerButton } from '../panels/SnippetPickerButton';
import { store } from '../../../store';
import { addSnippet, setSnippets } from '../../../store/slices/settingsSlice';

const SNIPPET = {
    id: 'picker-snippet',
    text: 'first line\n$1 $$ ${terminal.id}\nlast line',
    createdAt: 1,
};

describe('SnippetPickerButton', () => {
    let container: HTMLDivElement;
    let root: Root;
    let onInsert: jest.Mock;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        onInsert = jest.fn();
        store.dispatch(setSnippets([]));
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    async function show() {
        await act(async () => {
            root.render(<SnippetPickerButton onInsert={onInsert} />);
        });
    }

    it('opens above the editor with a focused search field', async () => {
        await show();
        await act(async () => {
            container.querySelector<HTMLButtonElement>('button[aria-label="Insert a saved snippet"]')!.click();
        });

        const picker = document.querySelector('.context-menu.au-snippet-picker');
        expect(picker).not.toBeNull();
        expect(picker?.querySelector<HTMLInputElement>('.context-menu-flyout-search')).toBe(document.activeElement);
    });

    it('inserts exact multiline text and records a use', async () => {
        store.dispatch(addSnippet(SNIPPET));
        await show();
        await act(async () => {
            container.querySelector<HTMLButtonElement>('button[aria-label="Insert a saved snippet"]')!.click();
        });

        await act(async () => {
            document.querySelector<HTMLButtonElement>('[data-row-id="snippet-picker-snippet"]')!.click();
        });

        expect(onInsert).toHaveBeenCalledWith(SNIPPET.text);
        expect(store.getState().settings.snippets.find((s) => s.id === SNIPPET.id)?.usageCount).toBe(1);
    });

    it('dismisses on Escape without inserting', async () => {
        store.dispatch(addSnippet(SNIPPET));
        await show();
        await act(async () => {
            container.querySelector<HTMLButtonElement>('button[aria-label="Insert a saved snippet"]')!.click();
        });
        const search = document.querySelector<HTMLInputElement>('.context-menu-flyout-search')!;

        await act(async () => fireEvent.keyDown(search, { key: 'Escape' }));

        expect(document.querySelector('.context-menu.au-snippet-picker')).toBeNull();
        expect(onInsert).not.toHaveBeenCalled();
    });
});
