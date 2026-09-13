/**
 * @jest-environment jsdom
 *
 * Regression: Snippets search must focus on every Settings entry edge, not just when the panel
 * happens to mount. SettingsPage stays mounted while its tab is hidden, so tab reactivation and a
 * same-category deep link reach an already-mounted panel; the dirty-navigation path mounts the
 * panel in the same commit that closes the unsaved dialog, whose focus-restoring cleanup must lose.
 * And the reverse: an entry edge must NOT pull focus out of a dialog the panel itself has open.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

// Jest has no CSS transform. Mock unrelated heavy leaves, but keep the real unsaved dialog so its
// passive focus-restoration cleanup is part of the dirty-navigation assertion below.
jest.mock('../SettingsPage.css', () => ({}));
jest.mock('../SnippetsPanel.css', () => ({}));
jest.mock('../../UI/SnippetDialog.css', () => ({}));
jest.mock('../../UI/ConfirmDialog.css', () => ({}));
jest.mock('../PeersPanel', () => ({ PeersPanel: () => null }));
jest.mock('../Automations/AutomationsPanel', () => ({ AutomationsPanel: () => null }));
jest.mock('../AboutLegalPanel', () => ({ AboutLegalPanel: () => null }));
jest.mock('../McpConnectModal', () => ({ McpConnectModal: () => null }));
jest.mock('../../UI/SplitButton', () => ({ SplitButton: () => null }));
jest.mock('../../../hooks/useSurfaceZoom', () => ({
    useSurfaceZoom: () => ({ zoom: 1, zoomIn: () => {}, zoomOut: () => {}, reset: () => {} }),
    useZoomGestures: () => {},
}));
jest.mock('../../../utils/clipboard', () => ({
    writeClipboardText: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../../services/snippetPorting', () => ({
    exportSnippets: jest.fn(),
    importSnippets: jest.fn(),
    describeImport: jest.fn(),
}));
jest.mock('../../../services/openSettings', () => ({
    consumePendingSettingsCategory: jest.fn(() => null),
}));

// eslint-disable-next-line import/first
import settingsReducer, { addSnippet, setFontSize } from '../../../store/slices/settingsSlice';
// eslint-disable-next-line import/first
import { consumePendingSettingsCategory } from '../../../services/openSettings';
// eslint-disable-next-line import/first
import { SettingsPage } from '../SettingsPage';

const pendingCategory = consumePendingSettingsCategory as jest.MockedFunction<typeof consumePendingSettingsCategory>;
const makeStore = () => configureStore({ reducer: { settings: settingsReducer } });

describe('Snippets search focus entry edges', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        global.fetch = jest.fn(() => Promise.reject(new Error('no server in test'))) as never;
        pendingCategory.mockReset();
        pendingCategory.mockReturnValue(null);
        container = document.createElement('div');
        document.body.appendChild(container);
        document.body.tabIndex = -1;
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        document.body.removeAttribute('tabindex');
        delete (window as unknown as { electronAPI?: unknown }).electronAPI;
        jest.restoreAllMocks();
    });

    async function renderPage(isActive: boolean, store: ReturnType<typeof makeStore>) {
        await act(async () => {
            root.render(
                <Provider store={store}>
                    <SettingsPage isActive={isActive} />
                </Provider>,
            );
        });
    }

    const search = () => container.querySelector('[aria-label="Search snippets"]') as HTMLInputElement | null;
    const sidebar = (label: string) => Array.from(container.querySelectorAll('button')).find(
        (button) => button.querySelector('.settings-nav-label')?.textContent === label,
    ) as HTMLButtonElement | undefined;
    const click = async (element: Element | undefined) => {
        expect(element).toBeDefined();
        await act(async () => {
            element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };
    const focusBody = () => {
        document.body.focus();
        expect(document.activeElement).toBe(document.body);
    };

    it('focuses on a category switch into Snippets', async () => {
        const store = makeStore();
        await renderPage(true, store);
        focusBody();
        await click(sidebar('Snippets'));
        expect(document.activeElement).toBe(search());
    });

    it('focuses when returning from another Settings category', async () => {
        const store = makeStore();
        await renderPage(true, store);
        focusBody();
        await click(sidebar('Snippets'));
        focusBody();
        await click(sidebar('Appearance'));
        focusBody();
        await click(sidebar('Snippets'));
        expect(document.activeElement).toBe(search());
    });

    it('focuses when the Settings tab is reactivated', async () => {
        const store = makeStore();
        await renderPage(true, store);
        await click(sidebar('Snippets'));
        await renderPage(false, store);
        focusBody();
        expect(document.activeElement).not.toBe(search());
        await renderPage(true, store);
        expect(document.activeElement).toBe(search());
    });

    it('focuses on a same-category deep link', async () => {
        const store = makeStore();
        await renderPage(true, store);
        await click(sidebar('Snippets'));
        focusBody();
        await act(async () => {
            window.dispatchEvent(new CustomEvent('settings:goto-category', { detail: 'snippets' }));
        });
        expect(document.activeElement).toBe(search());
    });

    it('focuses after discarding the dirty navigation prompt', async () => {
        const store = makeStore();
        await renderPage(true, store);
        await act(async () => {
            store.dispatch(setFontSize(22));
        });
        focusBody();
        await click(sidebar('Snippets'));
        expect(container.querySelector('[role="dialog"]')).not.toBeNull();
        const discard = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent?.includes('Discard'),
        );
        await click(discard);
        expect(document.activeElement).toBe(search());
    });

    it('leaves focus inside an open snippet dialog on tab reactivation and deep link', async () => {
        const store = makeStore();
        await renderPage(true, store);
        await click(sidebar('Snippets'));
        // The real SnippetDialog: its useDialogA11y puts focus on the textarea, and that is the
        // focus an entry edge must not take back.
        await click(Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent?.includes('New Snippet'),
        ));
        // Portalled to document.body, so not under `container`.
        const textarea = document.querySelector('.snippet-dialog-textarea') as HTMLTextAreaElement | null;
        expect(textarea).not.toBeNull();
        expect(document.activeElement).toBe(textarea);

        await renderPage(false, store);
        await renderPage(true, store);
        expect(document.activeElement).toBe(textarea);

        await act(async () => {
            window.dispatchEvent(new CustomEvent('settings:goto-category', { detail: 'snippets' }));
        });
        expect(document.activeElement).toBe(textarea);
    });

    it('leaves focus inside an open delete confirmation on tab reactivation', async () => {
        // The guard has TWO modals to respect; the edit case above cannot tell a guard that
        // checks only `dialogOpen` from one that also checks `deleteTarget`.
        const store = makeStore();
        store.dispatch(addSnippet({ id: 'sn-1', text: 'echo hello', createdAt: 1000 }));
        await renderPage(true, store);
        await click(sidebar('Snippets'));
        await click(container.querySelector('[aria-label^="Delete "]') ?? undefined);
        // Destructive ConfirmDialog puts initial focus on Cancel; portalled to document.body.
        const cancel = Array.from(document.querySelectorAll('.confirm-dialog button')).find(
            (button) => button.textContent?.includes('Cancel'),
        ) as HTMLButtonElement | undefined;
        expect(cancel).toBeDefined();
        expect(document.activeElement).toBe(cancel);

        await renderPage(false, store);
        await renderPage(true, store);
        expect(document.activeElement).toBe(cancel);
    });

    it('focuses on a fresh mount already directed to Snippets', async () => {
        pendingCategory.mockReturnValueOnce('snippets');
        const store = makeStore();
        focusBody();
        await renderPage(true, store);
        expect(document.activeElement).toBe(search());
    });
});
