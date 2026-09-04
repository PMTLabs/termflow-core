/**
 * @jest-environment jsdom
 *
 * **Which way the automation canvas pans.**
 *
 * `AuCanvas` reused `canvasGeometry.panBy` for its Space/middle-button DRAG. `panBy` carries the
 * WHEEL and ARROW-KEY convention — "scroll down" means the view moves down, so the world translates
 * the other way, and `canvasGestures.ts` says so twice in its own comments. A drag is the opposite
 * gesture: the hand holds the world, so the world moves WITH the pointer. Passing the raw delta made
 * this canvas pan backwards from every other surface in the app, while the file's own header claimed
 * *"Space arms panning, exactly as Canvas Mode does — one gesture vocabulary across the app."*
 *
 * Measured on a live build before the fix: a 600px space-drag to the RIGHT moved the world 617px to
 * the LEFT. Nothing covered `AuCanvas` panning at all.
 *
 * The oracle is `onViewportReady`'s `toWorld` — the screen→world transform the palette drag also
 * depends on — rather than a private viewport, so the assertion is about what the canvas does with a
 * screen point, not about the arithmetic on the way there.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AuCanvas } from '../AuCanvas';
import { draftFromRule } from '../automationDraft';
import { faceFor, stateFor } from '../automationDerive';
import type { NodeFace, NodeState } from '../automationDerive';
import { problems } from '../automationValidation';
import { STEP_ORDER } from '../automationSteps';
import type { StepKind } from '../automationSteps';
import { AUTOMATION_TEMPLATES, draftFromTemplate } from '../../Settings/Automations/automationTemplates';

const NOW = 1_700_000_000_000;
const DRAG = 300;

describe('AuCanvas — a drag moves the world with the pointer', () => {
    let container: HTMLDivElement;
    let root: Root;
    let toWorld: ((x: number, y: number) => { x: number; y: number } | null) | null;

    beforeAll(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(async () => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        toWorld = null;

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
                    onRefuse={() => {}}
                    onViewportReady={(fn) => { toWorld = fn; }}
                />,
            );
        });

        // jsdom lays nothing out, and `toWorldOrNull` refuses a point outside the host's box —
        // correctly, since a drop outside the canvas is not a drop on it. Give the host a real box.
        const host = container.querySelector('.au-canvas') as HTMLElement;
        host.getBoundingClientRect = () => ({
            left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, x: 0, y: 0,
            toJSON: () => ({}),
        }) as DOMRect;
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    /** jsdom ships no `PointerEvent`; a `MouseEvent` under the pointer type name reaches both
     *  React's delegated listener and the component's own `window` listeners. */
    const pointer = (type: string, over: MouseEventInit = {}) =>
        new MouseEvent(type, { bubbles: true, buttons: 1, ...over });

    /** Space arms the hand tool, then the drag runs through `window`, exactly as the component does. */
    async function spaceDragRight(): Promise<void> {
        const host = container.querySelector('.au-canvas') as HTMLElement;
        await act(async () => {
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
        });
        await act(async () => {
            host.dispatchEvent(pointer('pointerdown', { clientX: 500, clientY: 400 }));
        });
        await act(async () => {
            window.dispatchEvent(pointer('pointermove', { clientX: 500 + DRAG, clientY: 400 }));
        });
        await act(async () => {
            window.dispatchEvent(pointer('pointerup', { buttons: 0 }));
            window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
        });
    }

    it('drags the world right, so a fixed screen point lands further LEFT in world space', async () => {
        expect(toWorld).not.toBeNull();
        const before = toWorld!(500, 400);
        expect(before).not.toBeNull();

        await spaceDragRight();

        const after = toWorld!(500, 400);
        expect(after).not.toBeNull();

        // The canvas fits itself on mount, so the zoom is not 1 and must not be assumed: derive the
        // world-units-per-screen-pixel from the transform itself. Asserting the raw number instead
        // would pin whatever `fit()` happens to choose, which is not what this test is about.
        const perPixel = (toWorld!(600, 400)!.x - toWorld!(500, 400)!.x) / 100;
        expect(perPixel).toBeGreaterThan(0);

        // NEGATIVE: the world travelled with the hand, so the screen point now sits further left in
        // world space. The inverted version moved it +DRAG * perPixel instead.
        expect(after!.x - before!.x).toBeCloseTo(-DRAG * perPixel, 6);
        expect(after!.y - before!.y).toBeCloseTo(0, 6);
    });
});
