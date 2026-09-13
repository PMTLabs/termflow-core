/**
 * @jest-environment jsdom
 *
 * **The drawer is overlaid content, not canvas content.** Its wheel is left to the drawer,
 * not consumed or used to zoom, and `AuCanvas` itself does not cancel Ctrl+wheel there (what the
 * surrounding Settings zoom listener does with it is that hook's business, not tested here).
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { createPortal } from 'react-dom';

import { AuCanvas } from '../AuCanvas';
import { draftFromRule } from '../automationDraft';
import { faceFor, stateFor } from '../automationDerive';
import type { NodeFace, NodeState } from '../automationDerive';
import { problems } from '../automationValidation';
import { STEP_ORDER } from '../automationSteps';
import type { StepKind } from '../automationSteps';
import { AUTOMATION_TEMPLATES, draftFromTemplate } from '../../Settings/Automations/automationTemplates';
import { AU_NODE_H, AU_NODE_W } from '../automationDraft';

const NOW = 1_700_000_000_000;
const FIT_MARGIN = 140;

describe('AuCanvas — wheel zoom excludes overlaid children', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeAll(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(async () => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);

        const rule = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const draft = draftFromRule(rule);
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
                    onRemove={() => {}}
                    onRefuse={() => {}}
                    onViewportReady={() => {}}
                >
                    <div className="au-drawer" data-testid="drawer">
                        <div className="au-dpane">
                            <select data-testid="picker" />
                            {/* What `AuSelect` does with its open listbox: a React child of the
                                drawer whose DOM lives under document.body. */}
                            {createPortal(
                                <div role="listbox" data-testid="portalled-listbox" />,
                                document.body,
                            )}
                        </div>
                    </div>
                </AuCanvas>,
            );
        });

        const host = container.querySelector('.au-canvas') as HTMLElement;
        const boundsWidth = Math.max(...draft.present.map((step) => draft.layout[step].x + AU_NODE_W))
            - Math.min(...draft.present.map((step) => draft.layout[step].x));
        Object.defineProperty(host, 'clientWidth', { configurable: true, value: boundsWidth + FIT_MARGIN });
        Object.defineProperty(host, 'clientHeight', { configurable: true, value: AU_NODE_H + FIT_MARGIN });
        host.getBoundingClientRect = () => ({
            left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, x: 0, y: 0,
            toJSON: () => ({}),
        }) as DOMRect;

        await act(async () => {
            (container.querySelector('[aria-label="Fit to view"]') as HTMLButtonElement).click();
        });
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    const wheel = (target: Element, options: WheelEventInit = {}) => {
        const event = new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaY: -100,
            clientX: 600,
            clientY: 400,
            ...options,
        });
        target.dispatchEvent(event);
        return event;
    };

    it('zooms when the wheel starts on the canvas host', async () => {
        const host = container.querySelector('.au-canvas') as HTMLElement;
        expect(container.querySelector('.au-zl')?.textContent).toBe('100%');

        await act(async () => {
            wheel(host);
        });

        expect(container.querySelector('.au-zl')?.textContent).toBe('112%');
    });

    it('zooms when the wheel starts on a graph descendant', async () => {
        const node = container.querySelector('.au-node') as HTMLElement;
        expect(node).not.toBeNull();
        expect(container.querySelector('.au-zl')?.textContent).toBe('100%');

        await act(async () => {
            wheel(node);
        });

        expect(container.querySelector('.au-zl')?.textContent).toBe('112%');
    });

    it('does not zoom when the wheel starts in the drawer', async () => {
        const picker = container.querySelector('[data-testid="picker"]') as HTMLElement;
        expect(container.querySelector('.au-zl')?.textContent).toBe('100%');

        await act(async () => {
            wheel(picker);
        });

        expect(container.querySelector('.au-zl')?.textContent).toBe('100%');
    });

    it('does not zoom when the wheel starts in a listbox the drawer portalled to body', async () => {
        // Bubbles to AuCanvas through the REACT tree only; a DOM-ancestry check cannot see it.
        const listbox = document.querySelector('[data-testid="portalled-listbox"]') as HTMLElement;
        expect(listbox).not.toBeNull();
        expect(container.contains(listbox)).toBe(false);
        expect(container.querySelector('.au-zl')?.textContent).toBe('100%');

        await act(async () => {
            wheel(listbox);
        });

        expect(container.querySelector('.au-zl')?.textContent).toBe('100%');
    });

    it('does not cancel Ctrl+wheel in the drawer', async () => {
        const picker = container.querySelector('[data-testid="picker"]') as HTMLElement;
        let event: WheelEvent;

        await act(async () => {
            event = wheel(picker, { ctrlKey: true });
        });

        expect(event!.defaultPrevented).toBe(false);
        expect(container.querySelector('.au-zl')?.textContent).toBe('100%');
    });
});
