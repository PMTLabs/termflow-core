/**
 * @jest-environment jsdom
 *
 * The editor's own header calls three things load-bearing, and a fourth arrived with review round 1.
 * **None of them had a test that mounted the editor.** `automationEditorScope.test.ts` is a good
 * test of `InputHandler` and never touches `useEffect(() => suspendGlobalShortcuts(), [])`; nothing
 * asserted that a refused save leaves the draft where it is; and nothing pressed Ctrl+S at all.
 *
 * Everything here drives the real component through `AutomationsPanel`, the way the app does — the
 * editor is a portalled modal over the still-mounted list, so both surfaces are on screen at once.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

jest.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));
jest.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));

// eslint-disable-next-line import/first
import { AutomationsPanel } from '../../Settings/Automations/AutomationsPanel';
// eslint-disable-next-line import/first
import { inputHandler } from '../../../services/InputHandler';
// eslint-disable-next-line import/first
import type { AutomationRule, WatchableTerminal } from '../../../types/electron';

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

const TERMINALS: WatchableTerminal[] = [
    { terminalId: 'tm-a', processId: 'pc-a', label: 'claude', shell: 'pwsh', pid: 1, cwd: '~/work', alive: true },
    { terminalId: 'tm-b', processId: 'pc-b', label: 'codex', shell: 'pwsh', pid: 2, cwd: '~/other', alive: true },
];

interface Api {
    listAutomations: jest.Mock;
    getAutomationRuntime: jest.Mock;
    loadAutomationLog: jest.Mock;
    listWatchableTerminals: jest.Mock;
    dryRunAutomation: jest.Mock;
    duplicateAutomation: jest.Mock;
    setAutomationEnabled: jest.Mock;
    deleteAutomation: jest.Mock;
    resetAutomation: jest.Mock;
    rearmAutomation: jest.Mock;
    saveAutomation: jest.Mock;
}

function installApi(rules: AutomationRule[]): Api {
    const api: Api = {
        listAutomations: jest.fn(() => Promise.resolve(rules)),
        getAutomationRuntime: jest.fn(() => Promise.resolve({ rules: {} })),
        loadAutomationLog: jest.fn(() => Promise.resolve([])),
        listWatchableTerminals: jest.fn(() => Promise.resolve(TERMINALS)),
        dryRunAutomation: jest.fn(() => Promise.resolve(null)),
        duplicateAutomation: jest.fn(() => Promise.resolve(rules[0])),
        setAutomationEnabled: jest.fn(() => Promise.resolve()),
        deleteAutomation: jest.fn(() => Promise.resolve(true)),
        resetAutomation: jest.fn(() => Promise.resolve()),
        rearmAutomation: jest.fn(() => Promise.resolve()),
        saveAutomation: jest.fn(() => Promise.resolve({ id: 'au-1', previousUpdatedAt: null })),
    };
    (window as unknown as { electronAPI: Api }).electronAPI = api;
    return api;
}

describe('the editor, mounted', () => {
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

    const settle = () => act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    async function openEditorOn(subject: AutomationRule): Promise<Api> {
        const api = installApi([subject]);
        await act(async () => {
            root.render(<AutomationsPanel />);
        });
        await settle();
        const edit = [...container.querySelectorAll<HTMLButtonElement>('.au-btn.sm')].find(
            (b) => b.textContent === 'Edit',
        );
        await act(async () => edit!.click());
        await settle();
        return api;
    }

    const editor = () => document.querySelector('.au-editor');
    const byText = (sel: string, text: string) =>
        [...document.querySelectorAll<HTMLButtonElement>(sel)].find((b) => b.textContent === text);

    /** React owns `value`, so a controlled input is driven through the prototype setter. */
    const type = async (el: HTMLInputElement, text: string) => {
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value',
            )!.set!;
            setter.call(el, text);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };

    /** Select a step by clicking its card, the way the canvas does. */
    const selectStep = async (step: string) => {
        await act(async () => {
            document.querySelector<HTMLElement>(`.au-node.${step}`)!.click();
        });
    };

    const field = (label: string) =>
        document.querySelector<HTMLInputElement>(`.au-editor input[aria-label="${label}"]`)!;

    const pressCtrlS = async (repeat = false) => {
        await act(async () => {
            window.dispatchEvent(
                new KeyboardEvent('keydown', { key: 's', ctrlKey: true, repeat, bubbles: true }),
            );
        });
    };

    /**
     * Header point 1. `InputHandler` owns Ctrl+W, Ctrl+1–9, Alt+[/] and more on `window` in the
     * CAPTURE phase, so without the borrow a Ctrl+W typed into the editor closes a tab behind it.
     * The counter is what makes overlapping owners safe; the cleanup is what gives it back.
     */
    it('borrows the keyboard while it is open, and gives it back on unmount', async () => {
        const before = inputHandler.suspensionCount();
        await openEditorOn(rule());
        expect(inputHandler.suspensionCount()).toBe(before + 1);

        await act(async () => root.unmount());
        expect(inputHandler.suspensionCount()).toBe(before);
        // And the app hears keys again: a suspended handler refuses every combo.
        expect(inputHandler.suspensionCount()).toBe(0);
    });

    /**
     * Header point 3. `save()` resolves `false` when the write did not happen, and the close dialog
     * reads that boolean — so a refused save must leave the editor open with the draft intact.
     */
    it('a refused save does not close the editor or lose the draft', async () => {
        const api = await openEditorOn(rule());
        api.saveAutomation.mockRejectedValue(new Error('the store said no'));

        await type(editor()!.querySelector<HTMLInputElement>('.au-nameinput')!, 'Renamed while offline');

        await act(async () => byText('.au-x', '✕')!.click());
        await settle();
        expect(document.querySelector('.confirm-dialog')).not.toBeNull();

        await act(async () => byText('.confirm-btn', 'Save and close')!.click());
        await settle();

        expect(api.saveAutomation).toHaveBeenCalledTimes(1);
        expect(editor()).not.toBeNull();
        expect(editor()!.querySelector<HTMLInputElement>('.au-nameinput')!.value)
            .toBe('Renamed while offline');
        expect(editor()!.querySelector('.au-unsaved')).not.toBeNull();
    });

    /**
     * The Save BUTTON is `disabled={saving}`; the Ctrl+S listener was not, and had no `e.repeat`
     * guard. Holding it on a new rule fired ~30 times a second, each call read `id: ''`, and the
     * store mints a fresh id per call — one draft, a row per key repeat.
     */
    it('Ctrl+S saves once for a held key', async () => {
        const api = await openEditorOn(rule());
        await pressCtrlS();
        // The OS repeats while the key is down. Every one of these is a real keydown.
        await pressCtrlS(true);
        await pressCtrlS(true);
        await pressCtrlS(true);
        await settle();
        expect(api.saveAutomation).toHaveBeenCalledTimes(1);
    });

    it('Ctrl+S refuses a second save while the first is still in flight', async () => {
        const api = await openEditorOn(rule());
        let release: (v: unknown) => void = () => {};
        api.saveAutomation.mockImplementation(
            () => new Promise((resolve) => { release = resolve; }),
        );

        await pressCtrlS();
        await pressCtrlS();
        expect(api.saveAutomation).toHaveBeenCalledTimes(1);

        await act(async () => {
            release({ id: 'au-1', previousUpdatedAt: null });
        });
        await settle();
        // …and accepts one afterwards, so the guard is a gate rather than a latch.
        await pressCtrlS();
        expect(api.saveAutomation).toHaveBeenCalledTimes(2);
    });

    /**
     * `set_automation_enabled` writes one column on the row SQLite already holds, and the engine
     * reloads THAT row. Switching on while the draft is dirty therefore starts the version the user
     * has just edited away from — retarget the picker, flip the switch, and the message goes to the
     * terminal they moved away from while every surface in the editor describes the new one.
     */
    it('refuses to switch ON while the draft is dirty', async () => {
        const api = await openEditorOn(rule({ enabled: false }));
        await type(editor()!.querySelector<HTMLInputElement>('.au-nameinput')!, 'Edited, not saved');

        await act(async () => editor()!.querySelector<HTMLButtonElement>('.au-tog')!.click());
        await settle();
        expect(api.setAutomationEnabled).not.toHaveBeenCalled();
    });

    /**
     * The OFF direction is never refused: it can only STOP something, and a user who wants it to
     * stop right now should not have to save first. Without this the fix above would be a rule
     * about dirtiness rather than about which version goes live.
     */
    it('still allows switching OFF while the draft is dirty', async () => {
        const api = await openEditorOn(rule({ enabled: true }));
        await type(editor()!.querySelector<HTMLInputElement>('.au-nameinput')!, 'Edited, not saved');

        await act(async () => editor()!.querySelector<HTMLButtonElement>('.au-tog')!.click());
        await settle();
        expect(api.setAutomationEnabled).toHaveBeenCalledWith('au-1', false, expect.any(String));
    });

    /**
     * Header point 4. `save_rule` refuses an ENABLED rule with a blocking problem, so clearing the
     * Message on a live rule to retype it used to meet that refusal mid-edit with *Discard* as the
     * only exit. The rule is written whole and switched off instead.
     */
    it('saves a blocked enabled rule switched OFF rather than refusing the write', async () => {
        const api = await openEditorOn(rule({ enabled: true }));
        api.saveAutomation.mockResolvedValue({ id: 'au-1', previousUpdatedAt: 1 });

        // Clear the message — `action.empty`, which blocks. The field only exists once its step
        // is selected, so this goes through the canvas card the way a user would.
        await selectStep('action');
        await type(field('Message to send'), '');

        await pressCtrlS();
        await settle();

        expect(api.saveAutomation).toHaveBeenCalledTimes(1);
        const sent = api.saveAutomation.mock.calls[0][0] as AutomationRule;
        expect(sent.enabled).toBe(false);
        expect(sent.graph.action.message).toBe('');
        // And the header agrees with what was written, rather than still reading *Enabled*.
        expect(editor()!.querySelector('.au-tog')!.getAttribute('aria-checked')).toBe('false');
    });

    /** A rule with no problems is saved exactly as it is — the paired positive. */
    it('leaves an enabled rule enabled when nothing blocks it', async () => {
        const api = await openEditorOn(rule({ enabled: true }));
        await pressCtrlS();
        await settle();
        expect((api.saveAutomation.mock.calls[0][0] as AutomationRule).enabled).toBe(true);
    });

    /**
     * The roster is re-read on a timer, not once at mount.
     *
     * With a one-shot fetch the picker listed whatever was open when the editor mounted: a terminal
     * opened while the editor is up never appeared and there is no refresh control — measured on a
     * live build, still absent after eight seconds while `/api/terminals` listed it. The same array
     * feeds `MonitorPanel`'s *"Open right now N · refreshed every few seconds"*, which nothing kept.
     *
     * The registered callback is invoked directly rather than through fake timers, because this
     * suite flushes promises on the real clock; what is asserted is the FETCH COUNT it produces,
     * not that a timer was installed.
     */
    it('re-reads the terminal roster while the editor is open', async () => {
        const spy = jest.spyOn(window, 'setInterval');
        try {
            const api = await openEditorOn(rule({}));
            const atMount = api.listWatchableTerminals.mock.calls.length;
            expect(atMount).toBeGreaterThan(0);

            const ticks = spy.mock.calls
                .filter(([, ms]) => typeof ms === 'number' && ms > 0)
                .map(([fn]) => fn as () => void);
            expect(ticks.length).toBeGreaterThan(0);
            await act(async () => { ticks.forEach((tick) => tick()); });
            await settle();

            expect(api.listWatchableTerminals.mock.calls.length).toBeGreaterThan(atMount);
        } finally {
            spy.mockRestore();
        }
    });
});
