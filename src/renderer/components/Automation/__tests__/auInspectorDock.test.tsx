/**
 * @jest-environment jsdom
 *
 * The right-hand column's chrome: **wider, resizable, collapsible, and reachable again afterwards.**
 *
 * The fourth of those is the one worth writing a test for. The inspector holds the only editor for
 * whichever step is selected, so a collapsed panel plus a card click is a user selecting something
 * they cannot see or change — which is why collapsed is a RAIL with a reopen button rather than a
 * zero-width column, and why `AutomationEditor` opens the dock on selection. Both halves are
 * asserted: the rail keeps its button, and the editor's own `selectStep` un-collapses.
 *
 * The resize is asserted through the CLAMP rather than through a pixel. jsdom lays nothing out, so
 * `window.innerWidth - clientX` is the only real input the drag has, and the bounds are the part a
 * mistake actually shows up in — a panel that can be dragged to 12px or past the canvas.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import {
    AU_INSPECT_DEFAULT,
    AU_INSPECT_MAX,
    AU_INSPECT_MIN,
    AU_INSPECT_RAIL,
    AuInspectorDock,
    clampInspectWidth,
} from '../AuInspectorDock';

describe('clampInspectWidth', () => {
    it.each([
        [10, AU_INSPECT_MIN],
        [AU_INSPECT_MIN - 1, AU_INSPECT_MIN],
        [AU_INSPECT_MIN, AU_INSPECT_MIN],
        [420, 420],
        [AU_INSPECT_MAX, AU_INSPECT_MAX],
        [AU_INSPECT_MAX + 1, AU_INSPECT_MAX],
        [99999, AU_INSPECT_MAX],
    ])('clamps %d to %d', (given, expected) => {
        expect(clampInspectWidth(given)).toBe(expected);
    });

    it('starts wider than the 340px that clipped the comparison row', () => {
        // A source select, an operator select and a value field share one line there; at 340 the
        // operator ellipsed to `con...`, which is the whole of what it has to say.
        expect(AU_INSPECT_DEFAULT).toBeGreaterThan(340);
        expect(clampInspectWidth(AU_INSPECT_DEFAULT)).toBe(AU_INSPECT_DEFAULT);
    });
});

describe('AuInspectorDock', () => {
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

    async function show(props: { width?: number; collapsed?: boolean } = {}) {
        const onWidth = jest.fn();
        const onToggle = jest.fn();
        await act(async () => {
            root.render(
                <AuInspectorDock
                    width={props.width ?? AU_INSPECT_DEFAULT}
                    collapsed={props.collapsed ?? false}
                    onWidth={onWidth}
                    onToggle={onToggle}
                >
                    <aside className="au-inspect">panel body</aside>
                </AuInspectorDock>,
            );
        });
        return { onWidth, onToggle };
    }

    const dock = () => container.querySelector<HTMLElement>('.au-idock')!;
    const grip = () => container.querySelector<HTMLElement>('.au-igrip');
    const collapseButton = () => container.querySelector<HTMLButtonElement>('.au-icollapse')!;

    /** jsdom ships no pointer-event constructor; a `MouseEvent` under the pointer type name
     *  reaches both React's synthetic handler and the window listeners, and carries `buttons`.
     *  The same shim `auCanvasPan.test.tsx` uses. */
    const pointer = (type: string, over: MouseEventInit = {}) =>
        new MouseEvent(type, { bubbles: true, buttons: 1, ...over });

    it('carries its own width, so one number drives the grid column', async () => {
        await show({ width: 420 });
        expect(dock().style.width).toBe('420px');
    });

    it('collapses to a rail that still holds the reopen button', async () => {
        await show({ collapsed: true });
        expect(dock().style.width).toBe(`${AU_INSPECT_RAIL}px`);
        // The panel body is gone and the way back is not — a zero-width column would lose both.
        expect(container.textContent).not.toContain('panel body');
        expect(collapseButton()).not.toBeNull();
        expect(collapseButton().getAttribute('aria-expanded')).toBe('false');
    });

    it('offers no resize handle while collapsed, where there is nothing to size', async () => {
        await show({ collapsed: true });
        expect(grip()).toBeNull();
    });

    it('reports a width measured from the window edge, clamped', async () => {
        const { onWidth } = await show();
        (window as unknown as { innerWidth: number }).innerWidth = 1400;

        await act(async () => {
            grip()!.dispatchEvent(pointer('pointerdown'));
            window.dispatchEvent(pointer('pointermove', { clientX: 940 }));
        });
        // Absolute, not a delta: 1400 - 940.
        expect(onWidth).toHaveBeenLastCalledWith(460);

        // Dragged past the far bound, it reports the bound rather than a runaway number.
        await act(async () => {
            window.dispatchEvent(pointer('pointermove', { clientX: 10 }));
        });
        expect(onWidth).toHaveBeenLastCalledWith(AU_INSPECT_MAX);
    });

    it('stops reporting once the button is no longer down', async () => {
        const { onWidth } = await show();
        (window as unknown as { innerWidth: number }).innerWidth = 1400;
        await act(async () => {
            grip()!.dispatchEvent(pointer('pointerdown'));
            window.dispatchEvent(pointer('pointerup'));
            window.dispatchEvent(pointer('pointermove', { clientX: 940 }));
        });
        expect(onWidth).not.toHaveBeenCalled();
    });

    /**
     * A release outside the window never delivers `pointerup`, so the button state on the next
     * move is the only thing that can end the gesture — the same guard the canvas's own pan keeps,
     * for the same reason. Without it the panel follows the pointer forever after one drag.
     */
    it('ends the drag on a move that arrives with no button held', async () => {
        const { onWidth } = await show();
        (window as unknown as { innerWidth: number }).innerWidth = 1400;
        await act(async () => {
            grip()!.dispatchEvent(pointer('pointerdown'));
            window.dispatchEvent(pointer('pointermove', { clientX: 940, buttons: 0 }));
            window.dispatchEvent(pointer('pointermove', { clientX: 900 }));
        });
        expect(onWidth).not.toHaveBeenCalled();
    });

    it('resizes by keyboard, left widening the way the drag does', async () => {
        const { onWidth } = await show({ width: 400 });
        await act(async () => {
            grip()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        });
        expect(onWidth).toHaveBeenLastCalledWith(416);

        await act(async () => {
            grip()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        });
        expect(onWidth).toHaveBeenLastCalledWith(384);
    });

    it('exposes the handle as a separator with its real range', async () => {
        await show({ width: 420 });
        expect(grip()!.getAttribute('role')).toBe('separator');
        expect(grip()!.getAttribute('aria-valuenow')).toBe('420');
        expect(grip()!.getAttribute('aria-valuemin')).toBe(String(AU_INSPECT_MIN));
        expect(grip()!.getAttribute('aria-valuemax')).toBe(String(AU_INSPECT_MAX));
    });
});
