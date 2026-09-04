/**
 * Dragging a card around the editor canvas.
 *
 * Pointer events on `window` rather than the node, so a fast drag that outruns the cursor does not
 * drop the gesture — the same reason `useCanvasDrag` does it, which is where the shape comes from.
 * The code itself is not reused: that hook dispatches straight into `canvasSlice` and `panesSlice`,
 * and this canvas has neither.
 *
 * `DRAG_SLOP` is shared with Canvas Mode via `canvasGestures`, so a click and a drag are told apart
 * by the same number everywhere in the app.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { exceedsDragSlop } from '../Canvas/canvasGestures';
import type { NodePos } from './automationDraft';
import type { StepKind } from './automationSteps';

export interface AuNodeDragOptions {
    /** Screen → world, from the canvas that owns the viewport. */
    toWorld: (clientX: number, clientY: number) => NodePos;
    layout: Record<StepKind, NodePos>;
    onMove: (step: StepKind, pos: NodePos) => void;
}

export interface AuNodeDrag {
    /** The step being dragged, once the pointer has moved far enough to mean it. */
    dragging: StepKind | null;
    begin: (step: StepKind, e: { clientX: number; clientY: number }) => void;
}

export function useAuNodeDrag({ toWorld, layout, onMove }: AuNodeDragOptions): AuNodeDrag {
    const [dragging, setDragging] = useState<StepKind | null>(null);
    const gesture = useRef<{
        step: StepKind;
        startClient: { x: number; y: number };
        startWorld: NodePos;
        origin: NodePos;
        live: boolean;
    } | null>(null);

    // The latest values, so the window listeners registered once can still see them. Re-registering
    // per render would drop a gesture in progress every time the draft changed — which, while
    // dragging, is every frame.
    const latest = useRef({ toWorld, onMove });
    latest.current = { toWorld, onMove };

    const begin = useCallback(
        (step: StepKind, e: { clientX: number; clientY: number }) => {
            gesture.current = {
                step,
                startClient: { x: e.clientX, y: e.clientY },
                startWorld: latest.current.toWorld(e.clientX, e.clientY),
                origin: layout[step],
                live: false,
            };
        },
        [layout],
    );

    useEffect(() => {
        const move = (e: PointerEvent) => {
            const g = gesture.current;
            if (!g) return;
            if (!g.live) {
                if (!exceedsDragSlop(e.clientX - g.startClient.x, e.clientY - g.startClient.y)) return;
                g.live = true;
                setDragging(g.step);
            }
            const world = latest.current.toWorld(e.clientX, e.clientY);
            latest.current.onMove(g.step, {
                x: g.origin.x + (world.x - g.startWorld.x),
                y: g.origin.y + (world.y - g.startWorld.y),
            });
        };
        const up = () => {
            gesture.current = null;
            setDragging(null);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        return () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
        };
    }, []);

    return { dragging, begin };
}
