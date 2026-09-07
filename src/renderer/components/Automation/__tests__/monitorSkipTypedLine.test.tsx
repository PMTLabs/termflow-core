/**
 * @jest-environment jsdom
 *
 * **"Ignore the line being typed"** — the *Watch output* inspector's opt-out.
 *
 * Reported: *"Whatever I choose, it will capture the value on the screen whenever I type in, not
 * press enter yet. It still capture the value and activate the trigger."* A command being typed is
 * echoed onto the screen like anything else, and nothing in the bytes says the user has not pressed
 * Enter — so the rule is given a way to say that the line the cursor is parked on is not output
 * yet. What that then DROPS is decided in `state.rs` (`typed_line_span`, and the tests around it);
 * this file is about the control, its default, and whether the setting survives a save.
 *
 * Mounted through the real `AuInspector`, for the reason `timerPanel` states: a panel that is never
 * reached from the inspector's `step === …` chain renders nothing however well it renders alone.
 *
 * **Off is the default and that is a decision, not caution.** The cursor's line is genuine output
 * for plenty of terminals — a full-screen TUI parks it wherever it likes — so a rule that silently
 * gained this would lose matches with no way to see why.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AuInspector } from '../AuInspector';
import { draftFromRule, draftReducer, ruleFromDraft } from '../automationDraft';
import type { DraftAction } from '../automationDraft';
import { problems } from '../automationValidation';
import { blankDraft } from '../../Settings/Automations/automationTemplates';
import type { AutomationReadMode, AutomationRule } from '../../../types/electron';

const ruleWith = (over: { read?: AutomationReadMode; skipTypedLine?: boolean } = {}): AutomationRule => {
    const rule = blankDraft();
    const monitor = rule.graph.monitor!;
    return {
        ...rule,
        graph: {
            ...rule.graph,
            monitor: {
                ...monitor,
                read: over.read ?? monitor.read,
                ...(over.skipTypedLine === undefined ? {} : { skipTypedLine: over.skipTypedLine }),
            },
        },
    };
};

describe('ignore the line being typed', () => {
    let container: HTMLDivElement;
    let root: Root;
    let sent: DraftAction[];

    beforeAll(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        sent = [];
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    async function show(rule: AutomationRule) {
        const draft = { ...draftFromRule(rule), selected: 'monitor' as const };
        await act(async () => {
            root.render(
                <AuInspector
                    draft={draft}
                    problems={problems(rule)}
                    now={1_700_000_000_000}
                    terminals={[]}
                    terminalsError={null}
                    terminalsLoading={false}
                    report={null}
                    onRearm={null}
                    onTest={() => {}}
                    onFocusStep={() => {}}
                    dispatch={(a) => sent.push(a)}
                />,
            );
        });
    }

    /** The checkbox row carrying these words, and its input. `includes`, not `startsWith`: the row
     *  opens with `AuCheck`'s own tick glyph. */
    const row = () =>
        [...container.querySelectorAll('label.au-checkrow')].find((l) =>
            l.textContent?.includes('Ignore the line being typed'),
        ) as HTMLLabelElement | undefined;
    const box = () => row()?.querySelector('input') as HTMLInputElement | undefined;

    const click = async (el: HTMLInputElement) => {
        await act(async () => {
            el.click();
        });
    };

    /** The monitor patches the panel dispatched, in order. */
    const patches = () =>
        sent.filter((a): a is { type: 'monitor'; patch: Record<string, unknown> } => a.type === 'monitor')
            .map((a) => a.patch);

    it('offers the box unticked on a rule that never asked for it', async () => {
        await show(ruleWith());
        expect(box()).toBeDefined();
        expect(box()!.checked).toBe(false);
    });

    /**
     * It narrows whichever read mode is picked, so it belongs to neither of them. A shell echoing a
     * half-typed command reaches `newOutput` exactly as an input box reaches `onScreen` — offering
     * it under only one would leave the reported bug live in the other.
     */
    it.each<AutomationReadMode>(['newOutput', 'onScreen'])('is offered for %s', async (read) => {
        await show(ruleWith({ read }));
        expect(box()).toBeDefined();
    });

    it('asks for it, and asks to drop it again', async () => {
        await show(ruleWith());
        await click(box()!);
        expect(patches()).toEqual([{ skipTypedLine: true }]);

        // A second toggle must turn it OFF. A handler that dispatched `true` unconditionally passes
        // the test above and leaves a box the user cannot untick.
        await show(ruleWith({ skipTypedLine: true }));
        expect(box()!.checked).toBe(true);
        await click(box()!);
        expect(patches().at(-1)).toEqual({ skipTypedLine: false });
    });

    /**
     * The rest of the chain: the patch has to reach the reducer, and the reducer's rule has to
     * reach what a SAVE writes. A control wired to a field nothing persists is the failure mode
     * this half exists for — it looks exactly like a working control until the editor is reopened.
     */
    it('survives the reducer and the save', async () => {
        const draft = draftFromRule(ruleWith());
        const ticked = draftReducer(draft, { type: 'monitor', patch: { skipTypedLine: true } });
        expect(ticked.rule.graph.monitor?.skipTypedLine).toBe(true);
        expect(ruleFromDraft(ticked).graph.monitor?.skipTypedLine).toBe(true);

        const unticked = draftReducer(ticked, { type: 'monitor', patch: { skipTypedLine: false } });
        expect(ruleFromDraft(unticked).graph.monitor?.skipTypedLine).toBe(false);
    });

    /**
     * What the row actually says. The reported use is an agentic CLI whose status line sits UNDER
     * its input box — the text such a rule is usually watching for — so the wording has to promise
     * that everything else is still read, not merely that something is skipped.
     */
    it('says what it keeps, not only what it drops', async () => {
        await show(ruleWith());
        const text = row()?.textContent ?? '';
        expect(text).toMatch(/cursor/i);
        expect(text).toMatch(/still read/i);
    });
});
