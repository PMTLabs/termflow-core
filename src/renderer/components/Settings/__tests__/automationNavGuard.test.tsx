/**
 * @jest-environment jsdom
 *
 * §10.30 / §5.2 — **site 7**: the unsaved-automation-draft guard.
 *
 * Automations is deliberately excluded from the settings dirty tracker (`isTracked`), because
 * `settingsDirty.ts` snapshots a subset of the settings Redux slice and undoes by re-dispatching
 * settings setters, and automation rules live in SQLite and have neither. Being excluded is the
 * right call and it opened a blocker that **both** the settings verifier and the editor verifier
 * found independently: clicking any other sidebar category while the editor held an unsaved draft
 * silently discarded it, with no confirmation. One ordinary click. The tray deep-link and closing
 * the Settings tab had the same effect.
 *
 * So the editor answers for itself through `automationEditorGuard`, and this suite proves the
 * hook-up **before its only real caller exists** — the editor arrives in M5. A registered fake
 * guard is what makes that a real assertion rather than a listener with no dispatcher.
 *
 * Note what is NOT claimed here: that `isTracked('automations')` is false is kept for hygiene, not
 * asserted by a mutation check. Without the clause `snapshotCategory` falls off its switch to
 * `undefined`, `setBaseline(undefined)`, and `isDirty()` short-circuits on `!baseline` exactly as
 * `revertToBaseline` does — so observable behaviour is unchanged and only a tautological assertion
 * would go red. The plan's own doctrine, applied to itself.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

jest.mock('../SettingsPage.css', () => ({}));
jest.mock('../PeersPanel', () => ({ PeersPanel: () => null }));
jest.mock('../AboutLegalPanel', () => ({ AboutLegalPanel: () => null }));
jest.mock('../McpConnectModal', () => ({ McpConnectModal: () => null }));
// Mocked to a marker rather than to null: `renderActiveCategory`'s switch is enumeration site 6,
// and a missing `case 'automations'` falls through to `default: return null` — a sidebar entry that
// selects and then shows an empty pane, type-checking clean the whole way. A mock that rendered
// nothing could not tell those apart.
jest.mock('../Automations/AutomationsPanel', () => ({
    AutomationsPanel: () => <div data-testid="automations-panel" />,
}));
jest.mock('../../UI/SplitButton', () => ({ SplitButton: () => null }));
jest.mock('../../../services/openSettings', () => ({
    consumePendingSettingsCategory: () => null,
}));
jest.mock('../../../hooks/useSurfaceZoom', () => ({
    useSurfaceZoom: () => ({ zoom: 1, zoomIn: () => {}, zoomOut: () => {}, reset: () => {} }),
    useZoomGestures: () => {},
}));

// eslint-disable-next-line import/first
import settingsReducer from '../../../store/slices/settingsSlice';
// eslint-disable-next-line import/first
import { SettingsPage } from '../SettingsPage';
// eslint-disable-next-line import/first
import { clearSettingsGuard, runSettingsGuard } from '../../../services/settingsNavGuard';
// eslint-disable-next-line import/first
import {
    clearAutomationEditorGuard,
    registerAutomationEditorGuard,
} from '../../../services/automationEditorGuard';

const makeStore = () => configureStore({ reducer: { settings: settingsReducer } });

/** Click a sidebar category by its label. */
function clickCategory(container: HTMLElement, label: string): HTMLButtonElement {
    const button = [...container.querySelectorAll<HTMLButtonElement>('.settings-nav-item')].find(
        (b) => b.textContent?.includes(label),
    );
    if (!button) throw new Error(`no sidebar category labelled ${label}`);
    return button;
}

function activeCategoryLabel(container: HTMLElement): string {
    return (
        container.querySelector('.settings-nav-item.active')?.textContent?.trim() ?? '(none)'
    );
}

describe('the unsaved automation draft guard', () => {
    let container: HTMLDivElement;
    let root: Root;
    let save: jest.Mock;
    let discard: jest.Mock;

    beforeEach(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
            true;
        global.fetch = jest.fn(() => Promise.reject(new Error('no server in test'))) as never;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        save = jest.fn();
        discard = jest.fn();
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        clearSettingsGuard();
        clearAutomationEditorGuard();
        document.querySelectorAll('.confirm-dialog-overlay').forEach((n) => n.remove());
        jest.restoreAllMocks();
    });

    async function mountOnAutomations(dirty: boolean) {
        await act(async () => {
            root.render(
                <Provider store={makeStore()}>
                    <SettingsPage isActive />
                </Provider>,
            );
        });
        await act(async () => {
            clickCategory(container, 'Automations').click();
        });
        registerAutomationEditorGuard({ isDirty: () => dirty, save, discard });
    }

    /** The Save / Discard / Cancel prompt, if it is up. */
    const prompt = () => document.querySelector('.confirm-dialog-overlay, .unsaved-dialog-overlay');

    const promptButton = (label: string) =>
        [...document.querySelectorAll<HTMLButtonElement>('button')].find(
            (b) => b.textContent?.trim() === label,
        );

    it('renders the panel when the category is selected, not an empty pane', async () => {
        await mountOnAutomations(false);
        expect(activeCategoryLabel(container)).toContain('Automations');
        expect(container.querySelector('[data-testid="automations-panel"]')).not.toBeNull();
    });

    it('sits on Automations and lets you leave when the draft is clean', async () => {
        await mountOnAutomations(false);
        expect(activeCategoryLabel(container)).toContain('Automations');

        await act(async () => {
            clickCategory(container, 'Appearance').click();
        });
        expect(activeCategoryLabel(container)).toContain('Appearance');
        expect(prompt()).toBeNull();
    });

    it('blocks a sidebar click while the draft is dirty, and Cancel keeps you there', async () => {
        await mountOnAutomations(true);

        await act(async () => {
            clickCategory(container, 'Appearance').click();
        });
        // The category has NOT changed and a prompt is up.
        expect(activeCategoryLabel(container)).toContain('Automations');
        expect(prompt()).not.toBeNull();

        await act(async () => {
            promptButton('Cancel')!.click();
        });
        expect(activeCategoryLabel(container)).toContain('Automations');
        expect(save).not.toHaveBeenCalled();
        expect(discard).not.toHaveBeenCalled();
    });

    it('routes Save to the EDITOR, not to the settings page', async () => {
        await mountOnAutomations(true);
        await act(async () => {
            clickCategory(container, 'Appearance').click();
        });
        await act(async () => {
            promptButton('Save')!.click();
        });
        // Saving a dirty automation draft must persist the DRAFT. Routing both owners through one
        // handler would have saved the settings and then thrown the draft away.
        expect(save).toHaveBeenCalledTimes(1);
        expect(discard).not.toHaveBeenCalled();
        expect(activeCategoryLabel(container)).toContain('Appearance');
    });

    it('routes Discard to the editor and then lets the navigation through', async () => {
        await mountOnAutomations(true);
        await act(async () => {
            clickCategory(container, 'Appearance').click();
        });
        await act(async () => {
            promptButton('Discard')!.click();
        });
        expect(discard).toHaveBeenCalledTimes(1);
        expect(save).not.toHaveBeenCalled();
        expect(activeCategoryLabel(container)).toContain('Appearance');
    });

    it('blocks CLOSING THE SETTINGS TAB too, which is the same discard by another route', async () => {
        await mountOnAutomations(true);
        const proceed = jest.fn();
        let blocked = false;
        await act(async () => {
            blocked = runSettingsGuard(proceed);
        });
        expect(blocked).toBe(true);
        expect(proceed).not.toHaveBeenCalled();

        await act(async () => {
            promptButton('Discard')!.click();
        });
        expect(discard).toHaveBeenCalledTimes(1);
        expect(proceed).toHaveBeenCalledTimes(1);
    });

    it('does not claim a dirty draft while another category is showing', async () => {
        // The guard is scoped to the category that owns the draft. A dirty automation draft must
        // not block navigation between Appearance and Terminal, which have nothing to do with it.
        await mountOnAutomations(true);
        registerAutomationEditorGuard({ isDirty: () => false, save, discard });
        await act(async () => {
            clickCategory(container, 'Appearance').click();
        });
        registerAutomationEditorGuard({ isDirty: () => true, save, discard });

        await act(async () => {
            clickCategory(container, 'Terminal').click();
        });
        expect(activeCategoryLabel(container)).toContain('Terminal');
        expect(prompt()).toBeNull();
    });

    it('is inert with no guard registered, which is every build before the editor lands', async () => {
        await mountOnAutomations(false);
        clearAutomationEditorGuard();
        await act(async () => {
            clickCategory(container, 'Shortcuts').click();
        });
        expect(activeCategoryLabel(container)).toContain('Shortcuts');
        expect(prompt()).toBeNull();
    });
});
