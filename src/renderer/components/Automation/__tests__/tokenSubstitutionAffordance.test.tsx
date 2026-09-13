/** @jest-environment jsdom
 *
 * **A capture token must not be offered by a control that will not resolve it.**
 *
 * Reported from a live build: a webhook body reading `the context is over $0` posted the literal
 * `$0` to Discord. The engine was right — `run_webhook` substitutes, and
 * `a_crossing_posts_the_resolved_webhook_body` now proves the resolved bytes reach the wire — and
 * the editor was wrong in two separate ways, which is why this file asserts both:
 *
 * 1. **The chips and the toggle disagreed.** Clicking `$0` inserted a reference into a body that
 *    was posted verbatim, so the click produced nothing but literal text. Inserting a token now
 *    turns substitution on in the same patch.
 * 2. **A TYPED token said nothing at all.** The chips cannot help someone who wrote `$0` by hand,
 *    so the panel says what will happen to it — and only when a token is really there, or the note
 *    would fire on every message containing a dollar sign, including `awk '{print $1}'`, which is
 *    the case the toggle exists for.
 *
 * Both destinations, as a table. The defect was reported against the webhook, but the terminal
 * action carries the same chips over the same toggle, and a fix applied to one side of a pair is
 * how the other side keeps the bug.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AuInspector } from '../AuInspector';
import { draftFromRule } from '../automationDraft';
import type { DraftAction } from '../automationDraft';
import { problems } from '../automationValidation';
import type { AutomationRule } from '../../../types/electron';
import { blankDraft } from '../../Settings/Automations/automationTemplates';

// The picker has its own mounted-menu tests; this small seam exercises the panel's splice path
// with the exact text a selected picker row hands back, without coupling the caret assertion to
// the store-backed menu's portal.
jest.mock('../panels/SnippetPickerButton', () => ({
    SnippetPickerButton: ({ onInsert }: { onInsert: (text: string) => void }) => (
        <button
            type="button"
            aria-label="Test snippet picker"
            onClick={() => onInsert('a\n$1 $$ ${terminal.id}\nb')}
        >
            Test snippet
        </button>
    ),
}));

const URL = 'https://hooks.example.invalid/secret';
const PATTERN = String.raw`ctx:(\d+)%`;

type Destination = 'action' | 'webhook';

/** A complete rule whose destination carries `message`, with substitution off. */
function ruleWith(destination: Destination, message: string): AutomationRule {
    const blank = blankDraft();
    const graph = { ...blank.graph, parse: { ...blank.graph.parse!, preset: 'custom' as const, find: PATTERN } };
    if (destination === 'webhook') {
        const { action: _action, ...rest } = graph;
        return {
            ...blank,
            graph: { ...rest, webhook: { provider: 'discord', url: URL, body: message, substitute: false } },
        };
    }
    return {
        ...blank,
        graph: { ...graph, action: { ...graph.action!, message, substitute: false } },
    };
}

describe.each(['action', 'webhook'] as Destination[])('%s — token chips and the toggle', (destination) => {
    let container: HTMLDivElement;
    let root: Root;
    let dispatched: DraftAction[];

    beforeAll(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        dispatched = [];
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    async function show(message: string) {
        const rule = ruleWith(destination, message);
        const draft = { ...draftFromRule(rule), selected: destination };
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
                    dispatch={(action) => { dispatched.push(action); }}
                />,
            );
        });
    }

    const chip = (text: string) =>
        [...container.querySelectorAll<HTMLElement>('.au-token')].find((b) => b.textContent === text)!;

    /**
     * Put the caret at the end of the message box.
     *
     * A real textarea keeps its selection across a blur, so a user who types and then clicks a chip
     * has the caret where they left it. jsdom's value is set by React, never typed, so its
     * `selectionStart` is 0 and a chip would insert at the FRONT — an artefact of the environment,
     * not of the panel, and one that would make the assertion below about the wrong thing.
     */
    function caretToEnd() {
        // Both the action's message box and the webhook's body are `<textarea>`s.
        const box = container.querySelector<HTMLTextAreaElement>(
            'textarea, input[aria-label="Message to send"]',
        )!;
        box.setSelectionRange(box.value.length, box.value.length);
    }

    it('turns substitution on in the same patch that inserts a token', async () => {
        await show('the context is over ');
        caretToEnd();
        await act(async () => { chip('$0').click(); });

        expect(dispatched).toHaveLength(1);
        const [action] = dispatched as [{ type: string; patch: Record<string, unknown> }];
        expect(action.type).toBe(destination);
        // ONE patch, not two dispatches: the message and the flag cannot land apart.
        expect(action.patch.substitute).toBe(true);
        expect(action.patch[destination === 'webhook' ? 'body' : 'message']).toBe('the context is over $0');
    });

    it('shows all four reserved terminal chips and inserts time with substitution enabled', async () => {
        await show('sent at ');
        caretToEnd();
        for (const token of ['${terminal.id}', '${terminal.title}', '${terminal.cwd}', '${time}']) {
            expect(chip(token)).not.toBeUndefined();
            expect(chip(token).title).toBeTruthy();
        }

        await act(async () => { chip('${time}').click(); });

        expect(dispatched).toEqual([{
            type: destination,
            patch: {
                [destination === 'webhook' ? 'body' : 'message']: 'sent at ${time}',
                substitute: true,
            },
        }]);
    });

    it('says what will happen to a token that was typed rather than clicked', async () => {
        await show('the context is over $0');
        const warning = container.querySelector<HTMLElement>('.au-fhelp.warn')!;
        expect(warning).not.toBeNull();
        expect(warning.textContent).toContain('$0');
        expect(warning.textContent).toContain('Insert captured values');
    });

    /**
     * The half that keeps the note from becoming noise, and it corrects an assumption this file
     * was first written on: `$5` in *"the build cost $5 of compute"* IS a token by the grammar, so
     * a note built on `tokensUsed` alone fires on prose. It is filtered by what the PATTERN can
     * supply — this rule declares one group, so `$5` is not something the rule could have filled
     * in, and there is nothing to tell the user they are missing.
     */
    it('stays silent for a dollar amount the pattern could never have supplied', async () => {
        await show('the build cost $5 of compute');
        expect(container.querySelector('.au-fhelp.warn')).toBeNull();
    });

    /** ...while the group the pattern DOES declare is exactly what the note is for. */
    it('names a token the pattern really does supply', async () => {
        await show('context is at $1 percent');
        expect(container.querySelector<HTMLElement>('.au-fhelp.warn')!.textContent).toContain('$1');
    });

    it('stays silent once substitution is on, where a token is not literal', async () => {
        const rule = ruleWith(destination, 'the context is over $0');
        const graph = rule.graph;
        const on: AutomationRule = destination === 'webhook'
            ? { ...rule, graph: { ...graph, webhook: { ...graph.webhook!, substitute: true } } }
            : { ...rule, graph: { ...graph, action: { ...graph.action!, substitute: true } } };
        const draft = { ...draftFromRule(on), selected: destination };
        await act(async () => {
            root.render(
                <AuInspector
                    draft={draft}
                    problems={problems(on)}
                    now={1_700_000_000_000}
                    terminals={[]}
                    terminalsError={null}
                    terminalsLoading={false}
                    report={null}
                    onRearm={null}
                    onTest={() => {}}
                    onFocusStep={() => {}}
                    dispatch={() => {}}
                />,
            );
        });
        expect(container.querySelector('.au-fhelp.warn')).toBeNull();
    });

    /**
     * The caret lands after what was inserted, in BOTH panels — the webhook panel used to insert at
     * the caret and then leave focus and the selection wherever they were. `dispatch` here records
     * rather than re-renders, so the textarea's value never grows and jsdom would clamp a real
     * selection; the spy pins the position the panel ASKED for, which is the fact under test.
     */
    it('restores focus and puts the caret after the inserted token', async () => {
        await show('sent at ');
        caretToEnd();
        const box = container.querySelector<HTMLTextAreaElement>('textarea')!;
        const setRange = jest.spyOn(box, 'setSelectionRange');
        box.blur();

        await act(async () => { chip('${time}').click(); });
        await act(async () => { await new Promise<void>((done) => requestAnimationFrame(() => done())); });

        expect(document.activeElement).toBe(box);
        const after = 'sent at ${time}'.length;
        expect(setRange).toHaveBeenLastCalledWith(after, after);
    });

    it('does not block a schedule message that uses only a reserved token', async () => {
        if (destination !== 'action') return;
        const blank = blankDraft();
        const rule: AutomationRule = {
            ...blank,
            graph: {
                ...blank.graph,
                monitor: undefined,
                parse: undefined,
                cond: undefined,
                timer: { mode: { dailyAt: { minuteOfDay: 540, days: 0b0001_1111 } } },
                action: { ...blank.graph.action!, message: '${terminal.id}', substitute: true },
            },
        };
        const draft = { ...draftFromRule(rule), selected: 'action' as const };
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
                    dispatch={(action) => { dispatched.push(action); }}
                />,
            );
        });
        const preview = container.querySelector<HTMLElement>('[data-testid="action-preview"]')!;
        expect(preview.classList.contains('blocked')).toBe(false);
        expect(preview.textContent).toContain('⟨${terminal.id}⟩');
    });

    it('splices a picked multiline snippet at the selection without enabling substitution', async () => {
        await show('0123456789');
        const box = container.querySelector<HTMLTextAreaElement>('textarea')!;
        box.setSelectionRange(3, 5);
        const setRange = jest.spyOn(box, 'setSelectionRange');

        await act(async () => {
            container.querySelector<HTMLButtonElement>('[aria-label="Test snippet picker"]')!.click();
        });
        await act(async () => { await new Promise<void>((done) => requestAnimationFrame(() => done())); });

        const field = destination === 'webhook' ? 'body' : 'message';
        expect(dispatched).toEqual([{
            type: destination,
            patch: { [field]: '012a\n$1 $$ ${terminal.id}\nb56789' },
        }]);
        // After the snippet, not after the replaced selection: 3 + the snippet's own length.
        const after = 3 + 'a\n$1 $$ ${terminal.id}\nb'.length;
        expect(setRange).toHaveBeenLastCalledWith(after, after);
        expect(document.activeElement).toBe(box);
    });
});
