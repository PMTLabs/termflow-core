/**
 * The right-hand column's chrome: **how wide it is, and whether it is there at all.**
 *
 * The inspector itself stays exactly what it was — a pure projection of the draft — and this wraps
 * it rather than growing it two more responsibilities. That also keeps `AuInspector`'s signature
 * unchanged, so the six test call sites that mount it directly are unaffected.
 *
 * **The dock is the grid child now, not the `<aside>`.** `.au-mbody`'s third track became `auto`
 * and the width is an inline style here, so one number drives the column: a CSS variable and a
 * grid track would be two places for it to be wrong.
 *
 * **Collapsed is a RAIL, never zero.** A zero-width column has no affordance to bring it back, and
 * the panel holds the only editor for whichever step is selected — a user who collapsed it and then
 * clicked a card would be looking at a card they cannot edit. The rail keeps the reopen button, and
 * `AutomationEditor` opens the dock on any card selection besides.
 */
import React, { useCallback, useEffect, useRef } from 'react';

/** Narrow enough that a long value still wraps rather than ellipsing, at the smallest useful size. */
export const AU_INSPECT_MIN = 300;
/**
 * Past this the panel is winning an argument with the canvas it is describing. The editor is a
 * 95vh dialog, so a 640px column already leaves the canvas the larger half at any usable size.
 */
export const AU_INSPECT_MAX = 640;
/**
 * Wider than the 340px it was. That number clipped the comparison row — a source select, an
 * operator select and a value field on one line — which is what put a `con...` ellipsis on an
 * operator whose whole job is to be read.
 */
export const AU_INSPECT_DEFAULT = 400;
/** The collapsed rail: the reopen button and nothing else. */
export const AU_INSPECT_RAIL = 30;

/** How far one arrow-key press moves the edge. Big enough to be worth pressing, small enough to aim. */
const STEP = 16;

export const clampInspectWidth = (w: number): number =>
    Math.max(AU_INSPECT_MIN, Math.min(AU_INSPECT_MAX, Math.round(w)));

export interface AuInspectorDockProps {
    width: number;
    collapsed: boolean;
    onWidth: (width: number) => void;
    onToggle: () => void;
    children: React.ReactNode;
}

export const AuInspectorDock: React.FC<AuInspectorDockProps> = ({
    width,
    collapsed,
    onWidth,
    onToggle,
    children,
}) => {
    const dragging = useRef(false);
    // Through a ref so the window listeners below can be attached ONCE. Keyed on `onWidth`, they
    // would tear down and re-arm on every frame of a drag, which is the same trap `CanvasMenu`
    // documents for its own dismissal listener.
    const onWidthRef = useRef(onWidth);
    onWidthRef.current = onWidth;

    useEffect(() => {
        const move = (e: PointerEvent) => {
            if (!dragging.current) return;
            // A button that is no longer down ended this gesture, whatever the browser told us:
            // releasing outside the window never delivers `pointerup`. The canvas's own pan uses
            // the same guard for the same reason.
            if (e.buttons === 0) {
                dragging.current = false;
                return;
            }
            // The edge is on the LEFT of the panel, so dragging left makes it wider: the width is
            // the distance from the pointer to the window's right edge, not a delta to accumulate.
            // Measured absolutely, so a drag that outruns the clamp and comes back tracks the
            // pointer again instead of staying stuck at the bound.
            onWidthRef.current(clampInspectWidth(window.innerWidth - e.clientX));
        };
        const up = () => { dragging.current = false; };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up, true);
        return () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up, true);
        };
    }, []);

    const onKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        // Left widens, matching the drag: the handle is the panel's left edge in both gestures.
        onWidthRef.current(clampInspectWidth(width + (e.key === 'ArrowLeft' ? STEP : -STEP)));
    }, [width]);

    return (
        <div
            className={`au-idock${collapsed ? ' collapsed' : ''}`}
            style={{ width: collapsed ? AU_INSPECT_RAIL : width }}
        >
            {!collapsed && (
                <div
                    className="au-igrip"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize the settings panel"
                    aria-valuenow={width}
                    aria-valuemin={AU_INSPECT_MIN}
                    aria-valuemax={AU_INSPECT_MAX}
                    tabIndex={0}
                    onKeyDown={onKeyDown}
                    onPointerDown={(e) => {
                        e.preventDefault();
                        dragging.current = true;
                    }}
                />
            )}
            <button
                type="button"
                className="au-icollapse"
                aria-label={collapsed ? 'Show the settings panel' : 'Hide the settings panel'}
                aria-expanded={!collapsed}
                onClick={onToggle}
            >
                <span aria-hidden="true">{collapsed ? '‹' : '›'}</span>
            </button>
            {!collapsed && children}
        </div>
    );
};
