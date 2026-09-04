/**
 * @jest-environment jsdom
 *
 * §10.24b — **R11 is visible in both places, from one field.**
 *
 * `runsOnce` drives the list row's badge *and* the editor header's segmented control. Its only
 * previous coverage was prose, and a field with two renderers and no test is how a second spelling
 * of one idea appears — one surface saying *Runs once* while the other says *Repeatable*, about the
 * same rule, eight pixels apart. That is the mockup's own rev-1 failure, at a different site.
 *
 * The editor is a PORTALLED modal over the still-mounted list, so one render has both surfaces on
 * screen at once — which is what makes the agreement assertable rather than inferred from two
 * separate tests.
 *
 * *(§10.24b's number sits in M4's block, but it gates M5: the second surface does not exist until
 * the editor does.)*
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

jest.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));
jest.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));

// eslint-disable-next-line import/first
import { AutomationsPanel } from '../../Settings/Automations/AutomationsPanel';
// eslint-disable-next-line import/first
import type { AutomationRule } from '../../../types/electron';

function rule(over: Partial<AutomationRule> = {}): AutomationRule {
    return {
        id: 'au-1',
        name: 'Context handoff reminder',
        enabled: false,
        runsOnce: false,
        targetMode: 'rule',
        criterion: 'commandContains',
        criterionValue: 'claude',
        followNew: true,
        targetIds: [],
        completedAt: null,
        verboseUntil: null,
        sortOrder: 0,
        schemaVersion: 1,
        graph: {
            monitor: { read: 'newOutput', cadence: 'timer', everyMs: 30000 },
            parse: { preset: 'percentage', literal: null, find: 'ctx:(\\d+)%', keep: 'brackets' },
            cond: { kind: 'number', op: 'gt', threshold: 25 },
            action: {
                message: 'prepare to do context-hand-off',
                sendTo: 'matched',
                submit: true,
                cliType: 'default',
            },
        },
        createdAt: 0,
        updatedAt: 0,
        ...over,
    };
}

function installApi(rules: AutomationRule[]) {
    const api = {
        listAutomations: jest.fn(() => Promise.resolve(rules)),
        getAutomationRuntime: jest.fn(() => Promise.resolve({ rules: {} })),
        loadAutomationLog: jest.fn(() => Promise.resolve([])),
        listWatchableTerminals: jest.fn(() => Promise.resolve([])),
        dryRunAutomation: jest.fn(() => Promise.resolve(null)),
        duplicateAutomation: jest.fn(() => Promise.resolve(rules[0])),
        setAutomationEnabled: jest.fn(() => Promise.resolve()),
        deleteAutomation: jest.fn(() => Promise.resolve(true)),
        resetAutomation: jest.fn(() => Promise.resolve()),
        rearmAutomation: jest.fn(() => Promise.resolve()),
        saveAutomation: jest.fn(() => Promise.resolve({ id: 'au-1', previousUpdatedAt: null })),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
    return api;
}

describe('runsOnce, on both surfaces', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeAll(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        document.querySelectorAll('.au-editor, .confirm-dialog-overlay').forEach((n) => n.remove());
        jest.clearAllMocks();
    });

    async function openEditorOn(subject: AutomationRule) {
        installApi([subject]);
        await act(async () => {
            root.render(<AutomationsPanel />);
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const edit = [...container.querySelectorAll<HTMLButtonElement>('.au-btn.sm')].find(
            (b) => b.textContent === 'Edit',
        );
        await act(async () => edit!.click());
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }

    /** The editor is portalled to `body`, so it is not inside `container`. */
    const editor = () => document.querySelector('.au-editor')!;

    const rowBadge = () => container.querySelector('.au-runmode')?.textContent;

    const segPressed = () =>
        [...editor().querySelectorAll<HTMLButtonElement>('.au-seg button')]
            .filter((b) => b.getAttribute('aria-pressed') === 'true')
            .map((b) => b.textContent);

    it.each([
        [false, 'Repeatable'],
        [true, 'Runs once'],
    ])('runsOnce=%s reads as "%s" on the row AND in the editor header', async (runsOnce, words) => {
        await openEditorOn(rule({ runsOnce }));
        expect(rowBadge()).toBe(words);
        expect(segPressed()).toEqual([words]);
    });

    it('the editor header offers both, and marks exactly one', async () => {
        // A segmented control with neither pressed, or both, would still pass an assertion that only
        // looked for the right label somewhere on screen.
        await openEditorOn(rule({ runsOnce: true }));
        const buttons = [...editor().querySelectorAll<HTMLButtonElement>('.au-seg button')];
        expect(buttons.map((b) => b.textContent)).toEqual(['Repeatable', 'Runs once']);
        expect(buttons.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    });

    it('changing it in the editor changes the editor, and NOT the saved row', async () => {
        // The list reads what the store returned; the editor reads its draft. Until Save they are
        // allowed to differ — and they must, or an unsaved change would look saved.
        await openEditorOn(rule({ runsOnce: false }));
        expect(rowBadge()).toBe('Repeatable');

        const once = [...editor().querySelectorAll<HTMLButtonElement>('.au-seg button')].find(
            (b) => b.textContent === 'Runs once',
        )!;
        await act(async () => once.click());

        expect(segPressed()).toEqual(['Runs once']);
        expect(rowBadge()).toBe('Repeatable');
        // And the editor says so, rather than leaving the disagreement unexplained.
        expect(editor().querySelector('.au-unsaved')).not.toBeNull();
    });

    it('sends the changed field to the store on Save', async () => {
        // The end of the chain. Without this the two surfaces could agree perfectly about a value
        // that never reaches the row.
        await openEditorOn(rule({ runsOnce: false }));
        const api = (window as unknown as { electronAPI: { saveAutomation: jest.Mock } }).electronAPI;
        const once = [...editor().querySelectorAll<HTMLButtonElement>('.au-seg button')].find(
            (b) => b.textContent === 'Runs once',
        )!;
        await act(async () => once.click());
        const save = [...editor().querySelectorAll<HTMLButtonElement>('.au-btn')].find(
            (b) => b.textContent === 'Save',
        )!;
        await act(async () => save.click());
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(api.saveAutomation).toHaveBeenCalledTimes(1);
        expect(api.saveAutomation.mock.calls[0][0].runsOnce).toBe(true);
    });
});
