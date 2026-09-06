/** @jest-environment jsdom */
import React, { act, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AuInspector } from '../AuInspector';
import { draftFromRule } from '../automationDraft';
import type { Problem } from '../automationValidation';
import { AUTOMATION_TEMPLATES, draftFromTemplate } from '../../Settings/Automations/automationTemplates';

describe('AuInspector — a problem can focus a step the graph does not have', () => {
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

    it('focuses Wait from timer.neverRuns and lands on its absent-step help', async () => {
        const base = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const { monitor: _monitor, parse: _parse, cond: _cond, timer: _timer, ...graph } = base.graph;
        const draft = draftFromRule({ ...base, graph });
        const timerNeverRuns: Problem = {
            severity: 'blocks',
            field: 'timer',
            code: 'timer.neverRuns',
            message: 'This rule has nothing that could ever run it.',
        };
        const onFocusStep = jest.fn();

        const FocusableInspector = () => {
            const [selected, setSelected] = useState(draft.selected);
            return (
                <AuInspector
                    draft={{ ...draft, selected }}
                    problems={[timerNeverRuns]}
                    now={1_700_000_000_000}
                    terminals={[]}
                    terminalsError={null}
                    terminalsLoading={false}
                    report={null}
                    onRearm={null}
                    onTest={() => {}}
                    onFocusStep={(step) => {
                        onFocusStep(step);
                        setSelected(step);
                    }}
                    dispatch={() => {}}
                />
            );
        };

        expect(draft.rule.graph.timer).toBeUndefined();
        expect(draft.present).not.toContain('timer');
        await act(async () => root.render(<FocusableInspector />));

        const fix = [...container.querySelectorAll('button')]
            .find((button) => button.textContent?.includes(timerNeverRuns.message));
        expect(fix).toBeDefined();
        await act(async () => fix!.click());

        expect(onFocusStep).toHaveBeenCalledWith('timer');
        expect(container.querySelector('aside')?.getAttribute('aria-label')).toBe('Wait settings');
        expect(container.textContent).toContain('not in this rule');
        expect(container.textContent).toContain('drag Wait in from the palette');
    });
});
