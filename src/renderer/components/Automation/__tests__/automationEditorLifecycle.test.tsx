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
import { ENABLE_FLASH_MS } from '../AutomationEditor';
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
     * Escape closed nothing once focus reached the body, and a plain `<div>` is how it got there.
     *
     * `useDialogA11y` binds Escape and the Tab trap to the container in the BUBBLE phase — chosen so
     * a nested `ConfirmDialog` answers its own Escape — which means neither exists for a keydown
     * whose target sits outside the container. `.au-editor` carried no `tabIndex`, so it could not
     * hold focus, so every click on a non-focusable area sent focus to `<body>`: the canvas
     * background is how a step is DESELECTED, making it the most common click in the editor.
     * Measured live at plan §11.16 — click a node, click Save, press Escape three times and nothing
     * happens; click into the name field and the same key opens the unsaved-changes dialog.
     *
     * The attribute IS the mechanism, so the attribute is what this asserts: jsdom does not
     * implement "focus the nearest focusable ancestor on mousedown", so the behaviour it buys cannot
     * be driven here. Without `tabIndex` the hook's own fallback `(target ?? container).focus?.()`
     * is a silent no-op and its `active === container` Tab branch is unreachable.
     */
    it('gives the dialog container a focus of its own, so Escape survives a click on the canvas', async () => {
        await openEditorOn(rule());

        const host = editor() as HTMLElement;
        // `getAttribute`, NOT `.tabIndex`. The IDL accessor returns -1 for a div with no `tabindex`
        // attribute at all, identically to one that sets `tabIndex={-1}` — so the obvious
        // assertion passes with the fix reverted, which is the whole defect this test exists for.
        expect(host.getAttribute('tabindex')).toBe('-1');
        // The hook's contract is "trap focus inside the container", and a container that cannot be
        // focused cannot satisfy it — this is the element it was handed.
        expect(host.getAttribute('role')).toBe('dialog');
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
     * **Dimmed AND non-modal — the two halves are one decision, so they are asserted together.**
     *
     * Read apart they look contradictory: there is a full-bleed backdrop at 70% black, and the
     * dialog does not block the window behind it. Both were asked for. The backdrop is a DIM, not a
     * barrier — it inherits `pointer-events: none` from `.au-editor` and never opts back in — so a
     * later reading of "this scrim is broken, backdrops should catch clicks" would satisfy one half
     * by destroying the other, silently and with the dialog still looking correct.
     *
     * `aria-modal` is the honest half to assert: it is the machine-readable claim about whether the
     * rest of the window is inert, and it is what a screen reader acts on. The scrim's presence is
     * asserted beside it so removing the dim also fails, rather than quietly passing.
     */
    it('renders a backdrop while still declaring itself non-modal', async () => {
        await openEditorOn(rule({ enabled: false }));
        expect(editor()!.getAttribute('aria-modal')).toBe('false');
        expect(editor()!.querySelector('.au-scrim')).not.toBeNull();
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
        // The OTHER route to a rule that is stored switched off, and it must not flash either: the
        // switch it would point at is disabled and would refuse. The table below covers a rule that
        // was ALREADY off; this covers one this save turned off.
        expect(editor()!.querySelector('.au-tog')!.classList.contains('flash')).toBe(false);
    });

    /**
     * **Add a comparison, remove it again, and the v1 rule keeps the one it always had.**
     *
     * The clearing of the superseded `op`/`threshold` pair lived in the reducer's `clauses` case,
     * so it fired on the way IN: *+ Add a comparison* nulled the pair, *Remove comparison 1* left
     * an empty list, and the rule was then blocked (`cond.incomplete`) and written with its only
     * comparison gone — a rule that had worked, saved switched off and unable to fire.
     *
     * Driven through the real panel rather than the reducer, because the reducer-level test can
     * only pin what `ruleFromDraft` returns and the thing that reaches the store is whatever
     * `save` decides to send. That was `draft.rule`, which `ruleFromDraft` never touched.
     */
    it('a comparison added and removed again leaves the v1 rule its own comparison', async () => {
        const api = await openEditorOn(rule());
        await selectStep('cond');

        const add = [...document.querySelectorAll<HTMLButtonElement>('.au-editor button')].find(
            (b) => b.textContent?.includes('Add a comparison'),
        );
        await act(async () => add!.click());
        const remove = document.querySelector<HTMLButtonElement>(
            '.au-editor [aria-label="Remove comparison 1"]',
        );
        await act(async () => remove!.click());

        await pressCtrlS();
        await settle();

        const sent = api.saveAutomation.mock.calls[0][0] as AutomationRule;
        expect(sent.graph.cond?.clauses ?? []).toEqual([]);
        expect(sent.graph.cond?.op).toBe('gt');
        expect(sent.graph.cond?.threshold).toBe(25);
    });

    /**
     * **The paired positive, and the one that pins WHERE the clearing now happens.**
     *
     * A clause list supersedes `op`/`threshold` (§5.3), and a row carrying both is a row with two
     * contradictory conditions — this build runs the clause, an older one ignores `clauses`
     * entirely and runs `> 25`. Moving the clearing out of the reducer would silently reintroduce
     * exactly that unless `save` sends `ruleFromDraft(draft)`, which it did not: it sent
     * `draft.rule`, the one shape `ruleFromDraft` never touches.
     */
    it('drops the superseded v1 pair from the row a clause-carrying save writes', async () => {
        const api = await openEditorOn(rule());
        await selectStep('cond');

        const add = [...document.querySelectorAll<HTMLButtonElement>('.au-editor button')].find(
            (b) => b.textContent?.includes('Add a comparison'),
        );
        await act(async () => add!.click());

        await pressCtrlS();
        await settle();

        const sent = api.saveAutomation.mock.calls[0][0] as AutomationRule;
        expect(sent.graph.cond?.clauses).toHaveLength(1);
        expect(sent.graph.cond?.op ?? null).toBeNull();
        expect(sent.graph.cond?.threshold ?? null).toBeNull();
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

    /**
     * **A save that visibly does nothing, on the most common path into this editor.**
     *
     * A rule taken from a template lands `enabled: false` — `automationTemplates.ts` calls that its
     * safety property and it is NOT being changed — and `save` above can only ever turn `enabled`
     * OFF, never on. So: pick a template, edit it, save, and the screen reports a successful write
     * of a rule that will never run, with nothing anywhere saying so. Tam's ruling was to keep the
     * safety property and make the next step visible instead: the switch flashes.
     *
     * **Three cases, and two of them must NOT flash**, which is the half worth testing. Pointing a
     * user at a control that is dimmed and will refuse them is worse than saying nothing at all, and
     * a rule that saved switched ON is already running — there is nothing to prompt for. The
     * blocking check is `blockingProblems(...)`, the SAME list the toggle's own `disabled` is
     * computed from, so the cue and the control cannot disagree about whether the rule may run.
     *
     * `saveAutomation` is asserted to have happened in every row: without it, "did not flash" is
     * green for a save that never took place, which is true of any mutation that breaks saving.
     */
    const tog = () => editor()!.querySelector<HTMLButtonElement>('.au-tog')!;

    /** Disabled, and with a blocking problem — an empty message (`action.empty`). */
    const blocked = () => {
        const base = rule({ enabled: false });
        return rule({
            enabled: false,
            graph: { ...base.graph, action: { ...base.graph.action, message: '' } },
        });
    };

    // Ordered `[case, flashes, subject]` so both `%s` in the title land on the two values worth
    // reading in the runner's output — with the factory second, jest prints its SOURCE as the name.
    it.each([
        ['off, with nothing wrong with it', true, () => rule({ enabled: false })],
        ['on, so it is already running', false, () => rule({ enabled: true })],
        ['off BECAUSE something blocks it', false, blocked],
    ] as Array<[string, boolean, () => AutomationRule]>)(
        'saved %s — the Enable toggle flashes: %s',
        async (_case, flashes, subject) => {
            const api = await openEditorOn(subject());
            await pressCtrlS();
            await settle();

            expect(api.saveAutomation).toHaveBeenCalledTimes(1);
            expect(tog().classList.contains('flash')).toBe(flashes);
            // `.au-tog` is never replaced by `.flash`, it is joined by it: every selector and every
            // other test in this file reaches this control by that class.
            expect(tog().classList.contains('au-tog')).toBe(true);
        },
    );

    /**
     * It stops on its own. A control that keeps blinking until it is clicked has started nagging.
     *
     * The registered callback is invoked directly rather than through fake timers, because this
     * suite flushes promises on the real clock — the same technique the roster test above uses, and
     * for the same reason. What is asserted is that a timeout of exactly `ENABLE_FLASH_MS` was
     * registered and that running it ENDS the cue.
     */
    it('stops flashing by itself', async () => {
        const spy = jest.spyOn(window, 'setTimeout');
        try {
            await openEditorOn(rule({ enabled: false }));
            await pressCtrlS();
            await settle();
            expect(tog().classList.contains('flash')).toBe(true);

            const ends = spy.mock.calls.filter(([, ms]) => ms === ENABLE_FLASH_MS);
            expect(ends).toHaveLength(1);
            await act(async () => { (ends[0][0] as () => void)(); });

            expect(tog().classList.contains('flash')).toBe(false);
        } finally {
            spy.mockRestore();
        }
    });

    /** …and if the editor is closed while it is still playing, the timer goes with it. */
    it('clears the flash timer when the editor unmounts mid-flash', async () => {
        const setSpy = jest.spyOn(window, 'setTimeout');
        const clearSpy = jest.spyOn(window, 'clearTimeout');
        try {
            await openEditorOn(rule({ enabled: false }));
            await pressCtrlS();
            await settle();

            const at = setSpy.mock.calls.findIndex(([, ms]) => ms === ENABLE_FLASH_MS);
            expect(at).toBeGreaterThanOrEqual(0);
            const handle = setSpy.mock.results[at].value;

            await act(async () => root.unmount());
            expect(clearSpy).toHaveBeenCalledWith(handle);
        } finally {
            setSpy.mockRestore();
            clearSpy.mockRestore();
        }
    });
});
