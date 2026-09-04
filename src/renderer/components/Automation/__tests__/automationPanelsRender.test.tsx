/**
 * @jest-environment jsdom
 *
 * §10.20's other half — **the inspector panels, RENDERED, carry each template's own values.**
 *
 * `automationDerive.test.ts` says it asserts the six-template table "through both renderers", and
 * the two renderers it exercises are `faceFor` and `panelFor` — both defined in one module and both
 * returning `stepValues(rule, step)`. That oracle reduces to `stepValues() === stepValues()`, so it
 * cannot see the thing its own header says it holds the line against: **a hard-coded panel keeps it
 * green.** Replace `{model.values.message.text}` in `ActionPanel` with the literal
 * `prepare to do context-hand-off` and every assertion in that file still passes. That is the
 * mockup's rev-1 bug exactly — four hard-coded panels, five of six templates showing one rule on the
 * canvas and a different one in the panel — surviving the test written to kill it.
 *
 * The subject an oracle needs here is *what a panel component puts on screen*, not what two
 * functions in one module return. So this file mounts the real inspector, for every step of every
 * template, and reads the DOM.
 *
 * Both halves of the M5 dual review found this independently, which is the strongest signal a
 * review round produces.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AuInspector } from '../AuInspector';
import { draftFromRule } from '../automationDraft';
import { faceFor } from '../automationDerive';
import { problems } from '../automationValidation';
import { displayedPattern } from '../automationPresets';
import { STEP_ORDER } from '../automationSteps';
import type { StepKind } from '../automationSteps';
import {
    AUTOMATION_TEMPLATES,
    draftFromTemplate,
} from '../../Settings/Automations/automationTemplates';
import type { AutomationRule } from '../../../types/electron';

describe('the inspector panels — rendered, per template', () => {
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
    });

    async function show(rule: AutomationRule, step: StepKind) {
        const draft = { ...draftFromRule(rule), selected: step };
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
                    dispatch={() => {}}
                />,
            );
        });
        return container.textContent ?? '';
    }

    /** Every input's value too — a control binding is still this panel describing the rule. */
    const fields = () =>
        [...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')]
            .map((el) => el.value)
            .join(' | ');

    it.each(AUTOMATION_TEMPLATES.map((t) => [t.title, t] as const))(
        '%s — every panel shows THIS template',
        async (_title, template) => {
            const rule = draftFromTemplate(template);
            const { parse, cond, action } = rule.graph;

            // The pattern is a control binding — the field's `value` — and the panel's prose about
            // it is the paraphrase, which has its own tests below.
            await show(rule, 'parse');
            expect(fields()).toContain(displayedPattern(parse));

            const condText = await show(rule, 'cond');
            if (cond.kind === 'number' && cond.threshold !== null && cond.threshold !== undefined) {
                expect(`${condText} ${fields()}`).toContain(String(cond.threshold));
            }

            // **The DISPLAY, not the field.** Asserting over the two together is what let the first
            // draft of this test survive the very mutation it was written for: the preview span was
            // replaced with a hard-coded string and the textarea still carried the right value, so
            // `contains` found it anyway. A displayed value has to be read where it is displayed.
            await show(rule, 'action');
            expect(container.querySelector('.au-cap')?.textContent).toBe(action.message);
            expect(fields()).toContain(action.message);
        },
    );

    /**
     * The cross-check the per-template loop cannot make on its own.
     *
     * A panel hard-coded to template A's values passes template A's row and fails the other five —
     * but only if the values differ, and only if the assertion is `toContain`. This asserts the
     * complement directly: **no template's panel carries another template's message or pattern.**
     */
    it('no panel shows a value belonging to a DIFFERENT template', async () => {
        const rules = AUTOMATION_TEMPLATES.map(draftFromTemplate);
        for (const rule of rules) {
            const others = rules.filter((r) => r !== rule);

            const actionText = await show(rule, 'action');
            for (const other of others) {
                if (other.graph.action.message === rule.graph.action.message) continue;
                expect(actionText).not.toContain(other.graph.action.message);
            }

            await show(rule, 'parse');
            const shown = fields();
            for (const other of others) {
                const pattern = displayedPattern(other.graph.parse);
                if (pattern === displayedPattern(rule.graph.parse)) continue;
                expect(shown).not.toContain(pattern);
            }
        }
    });

    /**
     * The panel and the CARD say the same thing, read from the DOM on one side and the record on the
     * other — which is the agreement `stepValues` exists to guarantee and the one the old oracle
     * asserted against itself.
     */
    it('agrees with the node face on every value it puts into words', async () => {
        // **Which keys, and why not all of them.** A panel renders CONTROLS for most of the record —
        // the cadence is a list of radio buttons, and "Checks every 30s" is the face's wording of
        // the chosen one, not a string the panel is obliged to print. The keys below are the ones
        // both surfaces state in prose, which is where a second source would show up as two
        // different sentences about one rule.
        const SAID: Record<StepKind, string[]> = {
            monitor: ['terminals'],
            parse: ['find'],
            cond: ['compare', 'threshold'],
            action: ['message', 'send'],
        };
        const rule = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        for (const step of STEP_ORDER) {
            const text = `${await show(rule, step)} ${fields()}`;
            const face = faceFor(rule, step, { now: 1_700_000_000_000, problems: problems(rule) });
            for (const key of SAID[step]) {
                const row = face.rows.find((r) => r.key === key);
                expect(row).toBeDefined();
                expect(text).toContain(row!.value.text);
            }
        }
    });

    /**
     * The ⏎ in the *Preview* block is a displayed fact about the rule, so it comes from the model
     * like the message beside it. It was a direct read of `action.submit`.
     */
    it('shows the Enter mark exactly when the rule presses Enter', async () => {
        const base = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const submits: AutomationRule = {
            ...base,
            graph: { ...base.graph, action: { ...base.graph.action, submit: true } },
        };
        await show(submits, 'action');
        expect(container.querySelector('.au-enter')).not.toBeNull();

        const holds: AutomationRule = {
            ...base,
            graph: { ...base.graph, action: { ...base.graph.action, submit: false } },
        };
        await show(holds, 'action');
        expect(container.querySelector('.au-enter')).toBeNull();
    });

    /**
     * The paraphrase is displayed prose derived from the rule, so it comes from `panelFor` too. It
     * was the panel's own `sayPattern` call — and the one displayed string in the editor that was
     * WRONG, announcing *"keep the number"* about a group the engine does not keep.
     */
    it('paraphrases the pattern, and names the value the engine would keep', async () => {
        const base = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const wordFirst: AutomationRule = {
            ...base,
            graph: {
                ...base.graph,
                parse: { ...base.graph.parse, preset: 'custom', literal: null, find: '(\\w+):(\\d+)', keep: 'brackets' },
                cond: { ...base.graph.cond, kind: 'number' },
            },
        };
        const text = await show(wordFirst, 'parse');
        expect(text).toContain('In plain words:');
        // The engine keeps group 1, the word. The panel said "the number" directly above its own
        // `parse.manyGroups` warning saying the first group is used.
        expect(text).toContain('keep the part in brackets');
        expect(text).not.toContain('keep the number');
        expect(text).toContain('more than one bracketed group');
    });

    /**
     * **The picker's bar is a claim about the roster, so it waits for one.**
     *
     * `open` and `gone` are counted against the rows the editor fetched, and that list is empty both
     * while it is loading and when reading it FAILED. So a rule watching three terminals rendered
     * *"0 open, 3 not open right now"* directly under this component's own banner saying the list
     * could not be read **and the rule is still watching them** — two sentences on one screen making
     * opposite claims about the same three terminals.
     */
    it('does not count terminals it has not been able to look at', async () => {
        const base = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const pinned: AutomationRule = {
            ...base,
            targetMode: 'pinned',
            targetIds: ['tm-1', 'tm-2', 'tm-3'],
        };
        const draft = { ...draftFromRule(pinned), selected: 'monitor' as StepKind };

        const render = async (over: { loading: boolean; error: string | null }) => {
            await act(async () => {
                root.render(
                    <AuInspector
                        draft={draft}
                        problems={problems(pinned)}
                        now={1_700_000_000_000}
                        terminals={[]}
                        terminalsError={over.error}
                        terminalsLoading={over.loading}
                        report={null}
                        onRearm={null}
                        onTest={() => {}}
                        onFocusStep={() => {}}
                        dispatch={() => {}}
                    />,
                );
            });
            // EVERY matching node, not the first. The mutant that removes the guard renders the
            // honest span AND the false one, and `querySelector` would have read the honest one
            // and passed.
            return [...container.querySelectorAll('.au-picksay')].map((n) => n.textContent).join(' ');
        };

        expect(await render({ loading: true, error: null })).not.toContain('not open');
        const failed = await render({ loading: false, error: 'the bridge is gone' });
        expect(failed).not.toContain('not open');
        expect(container.textContent).toContain('could not be read');

        // The paired positive: with a roster in hand it says exactly what it knows.
        await act(async () => {
            root.render(
                <AuInspector
                    draft={draft}
                    problems={problems(pinned)}
                    now={1_700_000_000_000}
                    terminals={[
                        { terminalId: 'tm-1', processId: null, label: 'claude', shell: null, pid: null, cwd: null, alive: true },
                    ]}
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
        expect([...container.querySelectorAll('.au-picksay')].map((n) => n.textContent).join(' '))
            .toContain('1 open, 2 not open right now');
    });

    /**
     * A pattern the vocabulary cannot word falls back to the raw pattern, and the fallback is a
     * design decision (§6.4b) rather than an accident, so it is asserted.
     */
    it('falls back to the raw pattern rather than guessing', async () => {
        const base = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const hard: AutomationRule = {
            ...base,
            graph: {
                ...base.graph,
                parse: { ...base.graph.parse, preset: 'custom', literal: null, find: '^ctx:(\\d+)%$', keep: 'brackets' },
            },
        };
        const text = await show(hard, 'parse');
        expect(text).toContain('more than plain words can describe');
        expect(text).toContain('^ctx:(\\d+)%$');
    });

    /**
     * The paraphrase and its worked example are two SENTENCES, and nothing asserted the join.
     *
     * `sayPattern` builds a clause and never terminates it, and the panel appended
     * `Matches lines like …` after a bare space, so the GUI read *"…and keep the number Matches
     * lines like `ctx:63%`."* — a run-on no unit test could see, because no test read `.au-plainsay`
     * at all. Asserted on the rendered node, not on `sayingText`, since the defect is in the markup.
     */
    it('ends the paraphrase before the worked example', async () => {
        await show(draftFromTemplate(AUTOMATION_TEMPLATES[0]), 'parse');
        const said = container.querySelector('.au-plainsay')?.textContent ?? '';
        expect(said).toContain('keep the number. Matches lines like');
        expect(said).not.toContain('keep the number Matches');
    });

    /**
     * *Right now* has an empty pair map for two different reasons and must not describe them alike.
     *
     * `AuInspector` passes no `pairs` here, which is exactly the shape a SAVED, ENABLED rule has for
     * the moment after a save: the save moves `updated_at`, `reload` drops the arm keys (Q11), and
     * the map is empty until the next check. The panel asserted "This rule is not running … switch
     * it on" beside a green toggle on a rule that had already fired twice.
     */
    it.each([
        [true, 'This rule is running', 'is not running'],
        [false, 'is not running', 'This rule is running'],
    ])('the Right-now empty state matches enabled=%s', async (enabled, says, doesNotSay) => {
        const rule = { ...draftFromTemplate(AUTOMATION_TEMPLATES[0]), enabled };
        const text = await show(rule, 'cond');
        expect(text).toContain(says);
        expect(text).not.toContain(doesNotSay);
    });
});
