/**
 * The editor's own little node canvas (plan 028 §6.1, mockup §03).
 *
 * **It holds its own `Viewport`.** `CanvasViewport.tsx` reads `s.canvas.viewport` and dispatches
 * `setViewport`/`panViewport` into the *same* canvas slice Canvas Mode uses — so panning here would
 * move the Canvas Mode tab's viewport, and back again — and it consumes `useCanvasMetrics()`, which
 * throws `'no CanvasMetricsContext — render inside CanvasMode'`. What IS reused is everything pure:
 * `screenToWorld`, `panBy`, `zoomAt`, `clampZoom`, `worldStyle`, `gridStyle`, `boundsOf`,
 * `fitViewport`, `wheelAction`, `shouldArmSpacePan`, `exceedsDragSlop`. One implementation of the
 * arithmetic, two hosts.
 *
 * **No minimap**, per §6.5: a finished rule is four cards on a ~900×260 world, and the mockup ships
 * a zoom cluster and no minimap.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Viewport } from '../Canvas/canvasGeometry';
import { Z_MIN, clampZoom, panBy, screenToWorld, zoomAt } from '../Canvas/canvasGeometry';
import { shouldArmSpacePan, shouldDisarmSpacePan, wheelAction } from '../Canvas/canvasGestures';
import { boundsOf, fitViewport, gridStyle, rasterStyle, worldStyle } from '../Canvas/viewportStyles';
import type { AutomationDraft, NodePos } from './automationDraft';
import { AU_NODE_H, AU_NODE_W, portSides } from './automationDraft';
import type { NodeFace, NodeState } from './automationDerive';
import type { PortRef, StepKind, Wire } from './automationSteps';
import { AuNode } from './AuNode';
import { AuWires } from './AuWires';
import { useAuNodeDrag } from './useAuNodeDrag';
import { useAuWireDrag } from './useAuWireDrag';

/** The editor is a modal, not an infinite world: four cards never need 12×. */
const AU_Z_MAX = 2.2;

export interface AuCanvasProps {
    draft: AutomationDraft;
    faces: Record<StepKind, NodeFace>;
    states: Record<StepKind, NodeState>;
    chips: Record<string, string>;
    onSelect: (step: StepKind | null) => void;
    onMove: (step: StepKind, pos: NodePos) => void;
    onConnect: (wire: Wire) => void;
    onDisconnect: (wire: Wire) => void;
    onRefuse: (reason: string) => void;
    /** The palette drag needs screen → world too, and only this component knows the transform. */
    onViewportReady: (toWorld: (x: number, y: number) => NodePos | null) => void;
    children?: React.ReactNode;
}

export const AuCanvas: React.FC<AuCanvasProps> = ({
    draft,
    faces,
    states,
    chips,
    onSelect,
    onMove,
    onConnect,
    onDisconnect,
    onRefuse,
    onViewportReady,
    children,
}) => {
    const hostRef = useRef<HTMLDivElement | null>(null);
    // Read the same way `CanvasViewport` reads it: the world transform and the raster zoom are two
    // halves of one scale and must come from one number.
    const dpr = typeof window === 'undefined' ? 1 : (window.devicePixelRatio || 1);
    const [vp, setVp] = useState<Viewport>({ x: 0, y: 0, z: 1 });
    const [spacePan, setSpacePan] = useState(false);
    const panning = useRef<{ x: number; y: number } | null>(null);

    const toWorldOrNull = useCallback((clientX: number, clientY: number): NodePos | null => {
        const host = hostRef.current;
        if (!host) return null;
        const box = host.getBoundingClientRect();
        if (
            clientX < box.left || clientX > box.right
            || clientY < box.top || clientY > box.bottom
        ) {
            return null;
        }
        return screenToWorld(vp, clientX - box.left, clientY - box.top);
    }, [vp]);

    const toWorld = useCallback((clientX: number, clientY: number): NodePos => {
        const host = hostRef.current;
        if (!host) return { x: clientX, y: clientY };
        const box = host.getBoundingClientRect();
        return screenToWorld(vp, clientX - box.left, clientY - box.top);
    }, [vp]);

    useEffect(() => {
        onViewportReady(toWorldOrNull);
    }, [onViewportReady, toWorldOrNull]);

    const nodeDrag = useAuNodeDrag({ toWorld, layout: draft.layout, onMove });
    const wireDrag = useAuWireDrag({ toWorld, draft, onConnect, onRefuse });

    const fit = useCallback(() => {
        const host = hostRef.current;
        if (!host || draft.present.length === 0) {
            setVp({ x: 0, y: 0, z: 1 });
            return;
        }
        const bounds = boundsOf(
            draft.present.map((step) => ({
                x: draft.layout[step].x,
                y: draft.layout[step].y,
                w: AU_NODE_W,
                h: AU_NODE_H,
            })),
        );
        if (!bounds) return;
        setVp(fitViewport(bounds, host.clientWidth, host.clientHeight, AU_Z_MAX));
    }, [draft.layout, draft.present]);

    // Fit once the canvas has a size and something to fit. `present.length` rather than the layout:
    // re-fitting on every drag would haul the view back the moment a card was moved.
    useEffect(() => {
        fit();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft.present.length]);

    // Space arms panning, exactly as Canvas Mode does — one gesture vocabulary across the app.
    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const armed = shouldArmSpacePan(
                {
                    key: e.key,
                    code: e.code,
                    repeat: e.repeat,
                    target: target
                        ? {
                            tagName: target.tagName,
                            isContentEditable: target.isContentEditable,
                            // Read from the attribute rather than the `role` IDL property, which is
                            // ARIA reflection and is not in every runtime this code is tested in.
                            role: target.getAttribute?.('role') ?? null,
                        }
                        : null,
                },
                // No node ever holds the keyboard here: these cards have no terminal in them, which
                // is the one reason Canvas Mode's version takes this argument.
                null,
            );
            if (armed) {
                e.preventDefault();
                setSpacePan(true);
            }
        };
        const up = (e: KeyboardEvent) => {
            if (shouldDisarmSpacePan(e)) setSpacePan(false);
        };
        window.addEventListener('keydown', down);
        window.addEventListener('keyup', up);
        return () => {
            window.removeEventListener('keydown', down);
            window.removeEventListener('keyup', up);
        };
    }, []);

    const onWheel = (e: React.WheelEvent) => {
        // `mode: 'zoom'` and no overlay: a plain wheel zooms, and Ctrl+wheel is left to the browser
        // (which is where the app's own font zoom lives). The shared function rather than an
        // inlined `if`, so this canvas cannot develop its own wheel convention.
        const action = wheelAction(
            { ctrlKey: e.ctrlKey, metaKey: e.metaKey },
            { overlayId: null, mode: 'zoom', onFocusedTerminal: false },
        );
        if (action !== 'zoom') return;
        const host = hostRef.current;
        if (!host) return;
        const box = host.getBoundingClientRect();
        setVp((v) =>
            zoomAt(v, e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - box.left, e.clientY - box.top, AU_Z_MAX));
    };

    const onPointerDown = (e: React.PointerEvent) => {
        if (e.button === 1 || spacePan) {
            panning.current = { x: e.clientX, y: e.clientY };
            return;
        }
        if (e.target === e.currentTarget) {
            onSelect(null);
            // Dragging the BACKGROUND pans, alongside Space+drag and the middle button. The three
            // arm the same `panning` ref, so they share one move/up path and cannot drift apart.
            //
            // It is armed on the same branch that deselects rather than above it, and that is the
            // whole of the correctness argument: `e.target === e.currentTarget` is true only for the
            // canvas host itself, so a press that begins on a node, a port, a wire chip or any
            // control still reaches its own handler untouched. A press with no movement deselects
            // exactly as before — `panning` is armed but every move handler is a no-op until the
            // pointer actually moves, and `up` clears it.
            panning.current = { x: e.clientX, y: e.clientY };
        }
    };

    useEffect(() => {
        const move = (e: PointerEvent) => {
            const start = panning.current;
            if (!start) return;
            // A BUTTON THAT IS NO LONGER DOWN ended this gesture, whatever the browser told us — the
            // same guard the three drag hooks carry, for the same two reasons. Releasing outside the
            // window never delivers `pointerup`, and a release over a PORT does not deliver one here
            // either: `AuNode`'s port handler calls `stopPropagation()`, React 18 attaches its
            // delegated listener to the portal container (`document.body`), and a native event
            // stopped at `body` never reaches `window`.
            if (e.buttons === 0) {
                up();
                return;
            }
            panning.current = { x: e.clientX, y: e.clientY };
            // NEGATED, and that is the whole point. `panBy` takes the WHEEL/ARROW-KEY convention —
            // "scroll down" means the view moves down, so the world translates the other way, and
            // `panBy` owns that inversion (`canvasGestures.ts`: *"the world therefore translates the
            // other way; `panBy` owns that inversion"*). A DRAG is the opposite gesture: the hand
            // holds the world, so the world must move WITH the pointer. Canvas Mode's own drag does
            // exactly this by a different route (`CanvasViewport`: `x: e.clientX - pan.current.x`).
            // Passing the raw delta made this canvas pan BACKWARDS from every other one in the app —
            // a 600px drag to the right moved the world 600px to the LEFT.
            setVp((v) => panBy(v, start.x - e.clientX, start.y - e.clientY));
        };
        const up = () => {
            panning.current = null;
        };
        window.addEventListener('pointermove', move);
        // CAPTURE, so a `stopPropagation()` on the way up cannot leave the world panning. Nothing
        // here depends on running after a target handler; the wire drag is the one gesture that
        // does, and it keeps its own bubble-phase listener for exactly that reason.
        window.addEventListener('pointerup', up, true);
        return () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up, true);
        };
    }, []);

    // ONE computation of which edge each port uses, handed to both the cards and the wires. Two
    // callers deriving it separately is how the dot and the line end up on opposite edges.
    const sides = useMemo(
        () => portSides(draft.wires, draft.layout),
        [draft.wires, draft.layout],
    );

    const dropPorts = useMemo(() => {
        const byStep: Partial<Record<StepKind, Set<string>>> = {};
        for (const entry of wireDrag.legal) {
            const [step, port] = entry.split('.') as [StepKind, string];
            (byStep[step] ??= new Set()).add(port);
        }
        return byStep;
    }, [wireDrag.legal]);

    const zoomBy = (factor: number) => {
        const host = hostRef.current;
        if (!host) return;
        setVp((v) => zoomAt(v, factor, host.clientWidth / 2, host.clientHeight / 2, AU_Z_MAX));
    };

    return (
        <div
            className={`au-canvas${spacePan ? ' panning' : ''}${nodeDrag.dragging ? ' dragging' : ''}`}
            ref={hostRef}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
        >
            <div className="au-grid" aria-hidden="true" style={gridStyle(vp)} />
            {/* TWO elements, not one, since develop's `0104ebf`: `.au-world` pans and zooms while
                `.au-raster` supersamples, and `worldStyle` divides by exactly the factor
                `rasterStyle` multiplies back. Splitting them is not optional — `worldStyle` alone
                renders the whole canvas `worldRaster(z, dpr)` times too small. The PRODUCT is `z`, so
                `screenToWorld` and every `getBoundingClientRect` here are untouched: this component
                measures the outer host, never `.au-world`. */}
            <div className="au-world" style={worldStyle(vp, dpr)}>
                <div className="au-raster" style={rasterStyle(vp, dpr)}>
                <AuWires
                    wires={draft.wires}
                    layout={draft.layout}
                    chips={chips}
                    dragging={wireDrag.line}
                    sides={sides}
                    onRemove={onDisconnect}
                />
                {draft.present.map((step) => (
                    <AuNode
                        key={step}
                        step={step}
                        x={draft.layout[step].x}
                        y={draft.layout[step].y}
                        face={faces[step]}
                        state={states[step]}
                        selected={draft.selected === step}
                        dropPorts={dropPorts[step]}
                        sides={sides}
                        onSelect={() => onSelect(step)}
                        // Space-pan wins over a node drag. React's bubble handler on the node runs
                        // BEFORE the canvas's own, so without this a space+drag that happened to
                        // start on a card moved the card AND the viewport, by the same delta, in
                        // opposite directions — which looks like the card sticking to the cursor.
                        onPointerDown={(e) => {
                            if (!spacePan) nodeDrag.begin(step, e);
                        }}
                        onPortPointerDown={(port: PortRef, e) => wireDrag.begin(port, e)}
                        onPortPointerUp={(port: PortRef) => wireDrag.drop(port)}
                    />
                ))}
                </div>
            </div>

            {draft.present.length === 0 && (
                <div className="au-emptyhint">
                    <b>Start with “Watch output”</b>
                    Drag a step from the left onto this canvas. Every rule begins by watching a
                    terminal, then reads a value, compares it, and sends something back.
                </div>
            )}

            <div className="au-canvashint">
                <kbd>Space</kbd> + drag to pan · scroll to zoom
            </div>
            <div className="au-canvasctl">
                <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">
                    −
                </button>
                <span className="au-zl">{Math.round(vp.z * 100)}%</span>
                <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
                    +
                </button>
                <button type="button" onClick={fit} aria-label="Fit to view">
                    ▢
                </button>
            </div>

            {children}
        </div>
    );
};

/** Exported for the zoom control's own test, and so the floor is not restated in the stylesheet. */
export const AU_ZOOM_RANGE = { min: Z_MIN, max: AU_Z_MAX, clamp: (z: number) => clampZoom(z, AU_Z_MAX) };
