/**
 * @jest-environment jsdom
 *
 * **T4-d / M4 — the rule's sentence is one implementation, and both surfaces prove it.**
 *
 * `describeRule` has always been the single source of the words. The MARKUP was written twice, once
 * in the Settings list row and once in the template gallery's card, each spreading `RuleSentence`
 * out field by field — and a returned field nobody reads is invisible to `tsc`. So §6.2's
 * `waitClause` landed in the row and silently not in the gallery: the same rule, described two ways,
 * one screen apart, which is the rev-1 failure this whole module exists to prevent.
 *
 * The two surfaces are rendered TOGETHER here, from one rule, because that is what makes the
 * agreement assertable rather than inferred from two files that could drift apart again. Dropping
 * `waitClause` from `AuRuleSentence` fails both halves at once, which is the proof they share one
 * renderer; before the merge it could only ever have failed one.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AutomationRow } from '../AutomationRow';
import { TemplateCard } from '../TemplateGallery';
import type { AutomationTemplate } from '../automationTemplates';
import type { AutomationRule } from '../../../../types/electron';

const WAITING_RULE: AutomationRule = {
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
    schemaVersion: 2,
    graph: {
        monitor: { read: 'newOutput', cadence: 'timer', everyMs: 30000 },
        parse: { preset: 'percentage', literal: null, find: 'ctx:(\\d+)%', keep: 'brackets' },
        cond: { kind: 'number', op: 'gt', threshold: 25 },
        timer: { mode: { afterMatch: { delayMs: 30_000 } } },
        action: {
            message: 'prepare to do context-hand-off',
            sendTo: 'matched',
            submit: true,
            cliType: 'default',
        },
    },
    createdAt: 0,
    updatedAt: 0,
};

const AS_TEMPLATE: AutomationTemplate = {
    id: 'waiting',
    title: 'A rule that waits',
    accent: 'action',
    why: 'Carries a wait step, which none of the six built-in templates does.',
    youllChange: ['message'],
    rule: WAITING_RULE,
};

/** The words the Wait step contributes — from `describeDelay`, never spelled a second way here. */
const WAIT_WORDS = 'wait 30 seconds';

describe('the rule sentence, on both surfaces that draw it', () => {
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

    const show = async () => {
        await act(async () => {
            root.render(
                <>
                    <AutomationRow
                        rule={WAITING_RULE}
                        pairs={undefined}
                        now={1_700_000_000_000}
                        onToggle={() => {}}
                        onEdit={() => {}}
                        onDuplicate={() => {}}
                        onLog={() => {}}
                        onDelete={() => {}}
                        onReset={() => {}}
                        onForget={() => {}}
                    />
                    <TemplateCard template={AS_TEMPLATE} onPick={() => {}} />
                </>,
            );
        });
    };

    const textOf = (selector: string) => container.querySelector(selector)?.textContent ?? '';

    // One `it` per surface, deliberately: a single test asserting both would stop at the first
    // failure, and the proof wanted here is that dropping the clause kills BOTH — which is what
    // "they share one renderer" means and what could not have been true before the merge.
    it('says the wait on the Settings list row', async () => {
        await show();
        expect(textOf('.au-sentence')).toContain(WAIT_WORDS);
    });

    it('says the wait on the template gallery card', async () => {
        await show();
        expect(textOf('.au-tplsay')).toContain(WAIT_WORDS);
    });

    /**
     * The rest of the sentence, so a renderer that dropped a different field to keep this one
     * cannot pass. Both surfaces carry the whole claim; only the line break differs.
     */
    it('says the same condition and the same message on both', async () => {
        await show();
        for (const surface of ['.au-sentence', '.au-tplsay']) {
            expect(textOf(surface)).toContain('rises above');
            expect(textOf(surface)).toContain('25');
            expect(textOf(surface)).toContain('prepare to do context-hand-off');
        }
    });
});
