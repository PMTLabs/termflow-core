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
import { ActionPanel } from '../panels/ActionPanel';
import { CondPanel } from '../panels/CondPanel';
import { draftFromRule } from '../automationDraft';
import type { AutomationDraft } from '../automationDraft';
import { faceFor, panelFor } from '../automationDerive';
import { problems } from '../automationValidation';
import { displayedPattern } from '../automationPresets';
import { STEP_ORDER } from '../automationSteps';
import type { StepKind } from '../automationSteps';
import {
    AUTOMATION_TEMPLATES,
    draftFromTemplate,
} from '../../Settings/Automations/automationTemplates';
import type {
    AutomationActionStep,
    AutomationClause,
    AutomationCompareOp,
    AutomationRule,
    AutomationSource,
    AutomationTextOp,
} from '../../../types/electron';

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

            // **The DISPLAYED VALUE, not the whole panel's text.** Task 7 added static chrome to
            // this panel — chip labels `$0`/`$1`/`$2`, help copy that names `$1` by example — which
            // is present on EVERY action panel regardless of which rule is open, and one template's
            // own message is the single character `'1'`. A whole-container substring check flags
            // that chrome as if it were a leaked value; reading the same `.au-cap` span the
            // per-template loop above reads is the precise oracle for "the value this panel is
            // SHOWING", exactly as that loop's own comment already argues.
            await show(rule, 'action');
            // Assert the node EXISTS before reading it — `?? ''` here made every `not.toContain`
            // below pass vacuously against an empty string whenever the preview was blocked and
            // `.au-cap` was absent from the DOM altogether.
            const capNode = container.querySelector('.au-cap');
            expect(capNode).not.toBeNull();
            const shownMessage = capNode!.textContent ?? '';
            for (const other of others) {
                if (other.graph.action.message === rule.graph.action.message) continue;
                expect(shownMessage).not.toContain(other.graph.action.message);
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
            // Task 14: the face's single `fires` row (the clause sentence, or its legacy
            // fallback) replaced the old two-row `compare`/`threshold` layout — see `FACE_ROWS`.
            cond: ['fires'],
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

/**
 * Task 7 — the substitute checkbox, the token chips, and the live preview (plan 032 §4.2, mockup
 * §04). Mounts `ActionPanel` directly rather than through `AuInspector`: the behaviour under test
 * is entirely this panel's own (the checkbox and chips write only `action.*`, and the preview reads
 * only `draft.rule.graph` + `sample`), so a direct mount is the narrowest oracle that still reads
 * the real component's DOM rather than `automationDerive`'s records — the same reasoning the file
 * header gives for testing panels rendered instead of `stepValues() === stepValues()`.
 */
describe('ActionPanel — the substitute checkbox, token chips, and live preview (mockup §04)', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    const noop = () => {};

    /**
     * The first template's own pattern — `ctx:(\d+)%`, exactly ONE bracketed group — with only the
     * action step overridden. `$1` is therefore always in range and `$2`/`$3` never are, which is
     * what lets a test tell "resolves" apart from "out of range" without inventing a pattern of
     * its own.
     */
    function draftWith(actionPatch: Partial<AutomationActionStep>): AutomationDraft {
        const base = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const rule: AutomationRule = {
            ...base,
            graph: { ...base.graph, action: { ...base.graph.action, ...actionPatch } },
        };
        return { ...draftFromRule(rule), selected: 'action' };
    }

    async function renderAction(
        actionPatch: Partial<AutomationActionStep>,
        opts: { sample?: Record<string, string>; dispatch?: (a: unknown) => void } = {},
    ) {
        const draft = draftWith(actionPatch);
        const model = panelFor(draft.rule, 'action', { problems: [] });
        await act(async () => {
            root.render(
                <ActionPanel
                    draft={draft}
                    model={model}
                    dispatch={opts.dispatch ?? noop}
                    sample={opts.sample}
                />,
            );
        });
        return {
            draft,
            preview: () => container.querySelector('[data-testid="action-preview"]'),
            messageInput: () =>
                container.querySelector<HTMLInputElement>('input[aria-label="Message to send"]')!,
        };
    }

    it('types $1 literally when substitution is off', async () => {
        const { preview } = await renderAction({ message: 'fix $1', substitute: false });
        expect(preview()?.textContent).toContain('fix $1');
    });

    it('resolves $1 from the sample capture when substitution is on', async () => {
        const { preview } = await renderAction(
            { message: 'fix $1', substitute: true },
            { sample: { 1: '17' } },
        );
        expect(preview()?.textContent).toContain('fix 17');
    });

    it('shows the blocking problem and no preview for an out-of-range token', async () => {
        const { preview } = await renderAction(
            { message: 'fix $3', substitute: true },
            { sample: { 1: '17' } },
        );
        expect(preview()?.textContent).toContain('Nothing would be sent');
    });

    it('renders the substitute toggle as a real, labelled checkbox — not a styled div', async () => {
        await renderAction({ message: 'fix $1', substitute: false });
        const box = container.querySelector<HTMLInputElement>('.au-checkrow input[type="checkbox"]');
        expect(box).not.toBeNull();
        expect(box!.checked).toBe(false);
        expect(container.querySelector('.au-checkrow')?.textContent).toContain('Insert captured values');
    });

    it('checks the box once substitution is already on', async () => {
        await renderAction({ message: 'fix $1', substitute: true });
        const box = container.querySelector<HTMLInputElement>('.au-checkrow input[type="checkbox"]');
        expect(box!.checked).toBe(true);
    });

    it('dispatches the toggle when the checkbox is clicked', async () => {
        const dispatch = jest.fn();
        await renderAction({ message: 'fix $1', substitute: false }, { dispatch });
        const box = container.querySelector<HTMLInputElement>('.au-checkrow input[type="checkbox"]')!;
        await act(async () => box.click());
        expect(dispatch).toHaveBeenCalledWith({ type: 'action', patch: { substitute: true } });
    });

    it("renders one chip per group the pattern produces, plus $0 and $$, and marks the next one out of range as dead", async () => {
        await renderAction({ message: '', substitute: false });
        const chips = [...container.querySelectorAll('.au-tokens .au-token')].map((el) => el.textContent);
        expect(chips).toEqual(['$0', '$1', '$2', '$$']);
        const dead = [...container.querySelectorAll('.au-tokens .au-token.dead')].map((el) => el.textContent);
        expect(dead).toEqual(['$2']);
    });

    it('clicking a chip inserts it into the message at the cursor', async () => {
        const dispatch = jest.fn();
        const { messageInput } = await renderAction({ message: 'fix ', substitute: false }, { dispatch });
        const input = messageInput();
        input.focus();
        input.setSelectionRange(4, 4); // right after "fix "
        const chip = [...container.querySelectorAll('.au-tokens .au-token')]
            .find((el) => el.textContent === '$1') as HTMLButtonElement;
        await act(async () => chip.click());
        expect(dispatch).toHaveBeenCalledWith({ type: 'action', patch: { message: 'fix $1' } });
    });

    /**
     * Mutation guard: the preview must read `action.message` through the resolution rule, not
     * print it verbatim regardless of `substitute`. See task-7-report.md's mutation-check note —
     * this is the test that fails when the resolution branch is bypassed.
     */
    it('does not show the raw token once substitution has resolved it', async () => {
        const { preview } = await renderAction(
            { message: 'fix $1', substitute: true },
            { sample: { 1: '17' } },
        );
        expect(preview()?.textContent).not.toContain('$1');
    });

    /**
     * Milestone M1 review, Important 1. The plan's own flagship example: `\S` is not in
     * `sayPattern`'s escape table, so its paraphrase — and with it `sampleFromPattern`'s worked
     * example — is `null` for this pattern. Before this fix, `previewSubstitute`'s `sample[key] ??
     * ''` rendered that identically to "this optional group did not match", so the preview showed
     * `Fix the  failing tests in ` for a message that would actually type real captured text. Both
     * tokens are IN RANGE (the pattern has two groups), so the preview must not be `blocked` —
     * there is nothing wrong with the message, only nothing yet to show for it.
     */
    it('renders a placeholder — not nothing — for a token with no derivable sample, and says the preview is an example', async () => {
        const base = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const rule: AutomationRule = {
            ...base,
            graph: {
                ...base.graph,
                parse: {
                    ...base.graph.parse,
                    preset: 'custom',
                    literal: null,
                    find: 'FAILED (\\d+) tests in (\\S+)',
                    keep: 'brackets',
                },
                action: { ...base.graph.action, message: 'Fix the $1 failing tests in $2', substitute: true },
            },
        };
        const draft = { ...draftFromRule(rule), selected: 'action' as StepKind };
        const model = panelFor(draft.rule, 'action', { problems: [] });
        await act(async () => {
            root.render(<ActionPanel draft={draft} model={model} dispatch={noop} />);
        });

        const preview = container.querySelector('[data-testid="action-preview"]');
        expect(preview?.classList.contains('blocked')).toBe(false);

        const placeholders = [...container.querySelectorAll('.au-tok-ph')].map((el) => el.textContent);
        expect(placeholders).toEqual(['⟨$1⟩', '⟨$2⟩']);

        // The literal text around the placeholders is still shown — only the two tokens lack a
        // sample.
        expect(preview?.textContent).toContain('Fix the');
        expect(preview?.textContent).toContain('failing tests in');

        // And the panel says plainly that this is a guessed example, not a real capture.
        expect(container.textContent).toContain('This preview uses an example');
    });

    /**
     * The paired negative: once a real sample is supplied — a test pinning one, or in future a
     * real dry-run capture — the SAME pattern resolves normally and carries no "this is an
     * example" disclaimer, because it is no longer a guess.
     */
    it('does not call the preview an example once a real sample resolves every token', async () => {
        const base = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const rule: AutomationRule = {
            ...base,
            graph: {
                ...base.graph,
                parse: {
                    ...base.graph.parse,
                    preset: 'custom',
                    literal: null,
                    find: 'FAILED (\\d+) tests in (\\S+)',
                    keep: 'brackets',
                },
                action: { ...base.graph.action, message: 'Fix the $1 failing tests in $2', substitute: true },
            },
        };
        const draft = { ...draftFromRule(rule), selected: 'action' as StepKind };
        const model = panelFor(draft.rule, 'action', { problems: [] });
        await act(async () => {
            root.render(
                <ActionPanel
                    draft={draft}
                    model={model}
                    dispatch={noop}
                    sample={{ 1: '17', 2: 'a.ts' }}
                />,
            );
        });

        expect(container.querySelector('.au-tok-ph')).toBeNull();
        expect(container.querySelector('[data-testid="action-preview"]')?.textContent)
            .toContain('Fix the 17 failing tests in a.ts');
        expect(container.textContent).not.toContain('This preview uses an example');
    });
});

/**
 * Task 14 — CondPanel becomes a clause list with an explicit join (plan 032 §5.9, mockup §06).
 *
 * Mounts `CondPanel` directly, for the same reason the ActionPanel block above does: the behaviour
 * under test — adding/removing rows, the join's visibility, clearing an operand on a type switch,
 * and the token dropdown's contents — is entirely this panel's own.
 *
 * Adapted from the task brief's illustrative (vitest/testing-library) snippets to this project's
 * actual jest + raw-DOM (`react-dom/client` + `act`) conventions — there is no `@testing-library/*`
 * dependency here, and the real `CondPanel` is dispatch-based (`dispatch`), not `onChange`-based.
 */
describe('CondPanel — the finds radio, the clause list, the join (mockup §06)', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    const noop = () => {};

    const TEXT_OP_BY_LABEL: Record<string, AutomationTextOp> = {
        is: 'is',
        'is not': 'isNot',
        contains: 'contains',
        'does not contain': 'notContains',
        matches: 'matches',
        'is empty': 'isEmpty',
        'is not empty': 'isNotEmpty',
    };
    const NUM_OP_BY_LABEL: Record<string, AutomationCompareOp> = {
        'is over': 'gt',
        'is at least': 'gte',
        'is under': 'lt',
        'is at most': 'lte',
        equals: 'eq',
        'does not equal': 'neq',
    };

    /** A clause from the mockup's own shorthand — `clause('$1', 'is over', '30')`. */
    function clause(token: string, opLabel: string, value: string): AutomationClause {
        const source: AutomationSource = token === '$0' ? 'whole' : { group: Number(token.slice(1)) };
        if (opLabel in NUM_OP_BY_LABEL) {
            return { source, test: { number: { op: NUM_OP_BY_LABEL[opLabel], value: Number(value) } } };
        }
        return { source, test: { text: { op: TEXT_OP_BY_LABEL[opLabel], value } } };
    }

    /** Two declared groups by default, so `$1`/`$2` are always in range unless a test overrides `find`. */
    function draftWithClauses(clauses: AutomationClause[], find = '(\\d+):(\\d+)'): AutomationDraft {
        const base = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const rule: AutomationRule = {
            ...base,
            graph: {
                ...base.graph,
                parse: { ...base.graph.parse, preset: 'custom', literal: null, find, keep: 'brackets' },
                cond: { ...base.graph.cond, kind: 'text', clauses, join: 'and' },
            },
        };
        return { ...draftFromRule(rule), selected: 'cond' };
    }

    async function renderCond(
        clauses: AutomationClause[],
        opts: { find?: string; dispatch?: (a: unknown) => void } = {},
    ) {
        const draft = draftWithClauses(clauses, opts.find);
        const model = panelFor(draft.rule, 'cond', { problems: [] });
        await act(async () => {
            root.render(
                <CondPanel
                    draft={draft}
                    model={model}
                    now={1_700_000_000_000}
                    onRearm={null}
                    dispatch={(opts.dispatch ?? noop) as never}
                />,
            );
        });
    }

    it('adds and removes clause rows', async () => {
        const dispatch = jest.fn();
        await renderCond([clause('$1', 'is', '529')], { dispatch });
        const addBtn = [...container.querySelectorAll('button')]
            .find((b) => /add a comparison/i.test(b.textContent ?? '')) as HTMLButtonElement;
        expect(addBtn).toBeTruthy();
        await act(async () => addBtn.click());
        expect(dispatch).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'clauses',
                clauses: expect.arrayContaining([expect.anything(), expect.anything()]),
            }),
        );
    });

    it('hides the join control until there are two clauses', async () => {
        await renderCond([clause('$1', 'is', '529')]);
        expect(container.querySelector('[role="group"]')).toBeNull();

        await renderCond([clause('$1', 'is', '529'), clause('$2', 'is over', '30')]);
        const group = container.querySelector('[role="group"]');
        expect(group).not.toBeNull();
        expect(group!.getAttribute('aria-label')).toMatch(/combine/i);
    });

    it('clears the operand when a row switches between text and number', async () => {
        const dispatch = jest.fn();
        await renderCond([clause('$1', 'is', '529')], { dispatch });
        const opSelect = container.querySelector<HTMLSelectElement>('[aria-label="How to compare"]')!;
        const overOption = [...opSelect.options].find((o) => /is over/i.test(o.textContent ?? ''))!;
        expect(overOption).toBeTruthy();
        await act(async () => {
            opSelect.value = overOption.value;
            opSelect.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
        const action = dispatch.mock.calls[0][0] as { type: string; clauses: AutomationClause[] };
        expect(action.type).toBe('clauses');
        expect(action.clauses).toHaveLength(1);
        const { test } = action.clauses[0];
        expect('number' in test).toBe(true);
        if ('number' in test) {
            expect(test.number.op).toBe('gt');
            // Otherwise "529" silently becomes a numeric threshold — the clause's own operand must
            // be cleared, never coerced, on a text-to-number switch.
            expect(test.number.value).toBeNull();
        }

        /**
         * **And what the panel mints has to cross the IPC wire.** This is the same switch, followed
         * by the hop `invoke` performs — the editor sends a blocked draft deliberately (switched
         * off, never refused), so this clause reaches the backend on the very next Save.
         *
         * `null` survives `JSON.stringify`; `NaN` does not — it becomes `null` in transit, so the
         * value the panel held and the value the backend received were two different things, and
         * `Test::Number { value: f64 }` refused the whole rule with an opaque
         * ``invalid args `rule` ``. The editor could then neither save nor close.
         */
        const crossed = JSON.parse(JSON.stringify(action.clauses)) as AutomationClause[];
        expect(crossed).toEqual(action.clauses);
    });

    it('offers only tokens the pattern actually produces', async () => {
        await renderCond([clause('$1', 'is', 'x')], { find: 'a(\\d+)b' });
        const select = container.querySelector<HTMLSelectElement>('[aria-label="Which captured value"]')!;
        const opts = [...select.options].map((o) => o.textContent ?? '');
        expect(opts).toHaveLength(2);
        expect(opts[0]).toContain('$0');
        expect(opts[1]).toContain('$1');
    });
});
