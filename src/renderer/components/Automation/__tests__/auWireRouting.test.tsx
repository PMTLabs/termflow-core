/**
 * @jest-environment jsdom
 *
 * **The dot and the line must pick the same edge.**
 *
 * `portSides` decides which side of a card each port sits on, and TWO components act on that
 * decision: `AuNode` draws the dot (via a `side-l` / `side-r` class) and `AuWires` anchors the path
 * to it (via `portAnchor`). `automationSteps.test.ts` covers the rule itself; nothing there can
 * catch the two consumers being handed different answers, which is the failure the shared map exists
 * to prevent and the same shape as the `.au-tog` defect — two owners of one decision.
 *
 * So this asserts the DOM class and the path geometry together, on a layout where the answer is not
 * the default one. Either assertion alone would pass a build where only its own component had been
 * updated.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AuCanvas } from '../AuCanvas';
import { DEFAULT_LAYOUT, draftFromRule } from '../automationDraft';
import { faceFor, stateFor } from '../automationDerive';
import type { NodeFace, NodeState } from '../automationDerive';
import { problems } from '../automationValidation';
import { STEP_ORDER } from '../automationSteps';
import type { StepKind } from '../automationSteps';
import { AUTOMATION_TEMPLATES, draftFromTemplate } from '../../Settings/Automations/automationTemplates';

const NOW = 1_700_000_000_000;

describe('AuCanvas — wire routing follows the cards', () => {
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

    /** Render the four-step canvas on a caller-supplied arrangement. */
    async function renderOn(layout: typeof DEFAULT_LAYOUT) {
        const rule = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const draft = { ...draftFromRule(rule), layout };
        const ctx = { now: NOW, problems: problems(rule) };
        const faces = {} as Record<StepKind, NodeFace>;
        const states = {} as Record<StepKind, NodeState>;
        for (const step of STEP_ORDER) {
            faces[step] = faceFor(rule, step, ctx);
            states[step] = stateFor(rule, step, ctx);
        }
        await act(async () => {
            root.render(
                <AuCanvas
                    draft={draft}
                    faces={faces}
                    states={states}
                    chips={{}}
                    onSelect={() => {}}
                    onMove={() => {}}
                    onConnect={() => {}}
                    onDisconnect={() => {}}
                    onRefuse={() => {}}
                    onViewportReady={() => {}}
                />,
            );
        });
    }

    /** `cond`'s first output dot — the one wired on to the action. */
    const condOutput = () =>
        container.querySelector('.au-node.cond')!.querySelectorAll('.au-port.out')[0] as HTMLElement;

    /** Where every wire path begins, from its `M x y` command. */
    const pathStarts = () =>
        [...container.querySelectorAll('path.au-wire')]
            .map((p) => p.getAttribute('d') ?? '')
            .map((d) => Number(d.split(' ')[1]));

    it('leaves the right edge when the next card is to the right', async () => {
        await renderOn(DEFAULT_LAYOUT);

        expect(condOutput().className).toContain('side-r');
        // The dot is on the right edge, so the line must start there too. `AU_NODE_W` is not
        // restated here: the assertion is that the start is further right than the card's own x,
        // which is false for every left-edge anchor and true for every right-edge one.
        expect(pathStarts().some((x) => x > DEFAULT_LAYOUT.cond.x)).toBe(true);
    });

    it('leaves the LEFT edge, and the line follows it, when the next card is dragged past it', async () => {
        const flipped = { ...DEFAULT_LAYOUT, action: { x: -900, y: 0 } };
        await renderOn(flipped);

        expect(condOutput().className).toContain('side-l');

        // The geometric half: some wire now starts exactly ON `cond`'s left edge. If `AuWires` had
        // kept the old direction-based anchor while `AuNode` moved the dot, this would still be
        // `cond.x + AU_NODE_W` and the line would visibly detach from its dot.
        expect(pathStarts()).toContain(flipped.cond.x);
    });
});
