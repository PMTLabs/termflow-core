/** @jest-environment jsdom */
/**
 * The automation message snippet picker is mounted under a bare root, like the editor itself.
 * The store is still the app singleton; the Tauri event bridge is mocked only because this test
 * exercises the renderer menu in jsdom rather than a native window.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';

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

    it('opens as the picker-classed menu with a focused search field', async () => {
        await show();
        await act(async () => {
            container.querySelector<HTMLButtonElement>('button[aria-label="Insert a saved snippet"]')!.click();
        });

        const picker = document.querySelector('.context-menu.au-snippet-picker');
        expect(picker).not.toBeNull();
        expect(picker?.querySelector<HTMLInputElement>('.context-menu-flyout-search')).toBe(document.activeElement);
    });

    /**
     * jsdom does not paint, so "above the editor" is pinned where it is decided: the picker class's
     * `z-index` against the editor's, read from the two stylesheets. The class itself being applied
     * is the test above; the number order is what a regression would change.
     */
    it('is stacked above the editor by its z-index', () => {
        const css = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
        const zIndexOf = (source: string, selector: string): number => {
            const rule = new RegExp(`${selector.replace(/\./g, '\\.')}\\s*\\{[^}]*?z-index:\\s*(\\d+)`);
            const found = source.match(rule);
            if (!found) throw new Error(`no z-index rule for ${selector}`);
            return Number(found[1]);
        };
        const picker = zIndexOf(css('../Terminal/ContextMenu.css'), '.context-menu.au-snippet-picker');
        const editor = zIndexOf(css('AutomationEditor.css'), '.au-editor');
        expect(picker).toBeGreaterThan(editor);
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
        // Focus comes back to the button rather than parking on <body>, where the editor's own
        // Escape would then close nothing until the next click.
        expect(document.activeElement).toBe(
            container.querySelector('button[aria-label="Insert a saved snippet"]'),
        );
    });

    it('dismisses on a click outside without inserting', async () => {
        store.dispatch(addSnippet(SNIPPET));
        await show();
        await act(async () => {
            container.querySelector<HTMLButtonElement>('button[aria-label="Insert a saved snippet"]')!.click();
        });
        expect(document.querySelector('.context-menu.au-snippet-picker')).not.toBeNull();

        await act(async () => { fireEvent.mouseDown(document.body); });

        expect(document.querySelector('.context-menu.au-snippet-picker')).toBeNull();
        expect(onInsert).not.toHaveBeenCalled();
    });
});
