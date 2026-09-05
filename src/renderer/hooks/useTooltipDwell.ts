/**
 * The dwell a pointer must serve before a `title` tooltip is allowed to appear.
 *
 * Tam: *"on hover on the item in the right-context menu, delay 3 seconds to show the tooltip, so
 * it does not annoy user to just open it and quickly navigate to item they want"*.
 *
 * **A hook of its own, in `hooks/`, rather than a private helper of `Terminal/ContextMenu`.** It
 * started there and had to move on its first review: the app has more than one right-click menu,
 * and the automation rule rows are drawn by `AutomationMenuSection` into BOTH a flyout (that menu)
 * and an accordion (`PaneContextMenu` / `CanvasNodeMenu`, which have their own menu
 * implementation). Scoped to one file, the identical row — same rule, same name, same glyph —
 * delayed in one host and popped instantly in the other. `AutomationMenuSection`'s header forbids
 * importing anything from `Terminal/ContextMenu` at runtime, because that would drag its
 * stylesheet into the two hosts that do not use it, so the shared thing has to live somewhere
 * neither owns. This file imports React and nothing else.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How long the pointer must REST on a row before its `title` may appear, in ms.
 *
 * Every row in a context menu carries a `title` explaining what it does, and the browser pops that
 * after its own short dwell — around a second, and not configurable from CSS or from the
 * attribute. Opening a menu and sweeping down it to the row you were already aiming at is the
 * common case, and it drags a trail of yellow boxes across the list on the way. Three seconds is
 * long enough that a deliberate sweep never trips one, and short enough that stopping to ask
 * *"what does this do?"* is answered before it feels broken.
 *
 * **It is three seconds ADDED IN FRONT of the browser's own delay, not three seconds instead of
 * it.** Chromium's show timer cannot start before the text exists, so what a user waits is this
 * plus the native delay. The number is the one that was asked for; the sentence is here so nobody
 * reads it as a total.
 */
export const TOOLTIP_DWELL_MS = 3000;

export interface TooltipDwell {
    /** `title` for the row keyed by `key` — `undefined` until the pointer has rested on it. */
    titleFor(key: string, title: string | undefined): string | undefined;
    /** Wire to the row's `onMouseEnter`. */
    onEnter(key: string): void;
    /** Wire to the row's `onMouseLeave`. */
    onLeave(): void;
    /**
     * Forget whatever was dwelt, with no pointer event involved.
     *
     * The same clear as `onLeave`, under the name its other caller needs. A LIST can change under
     * a pointer that never moved — type into a flyout's auto-focused search box and its rows
     * re-filter — and a dwelt key that outlives the row it was earned on is a tooltip the next
     * occupant of that key inherits for free. See the note on `titleFor` about what a key must be.
     */
    reset(): void;
}

/**
 * A `title` that exists only once the pointer has stopped moving.
 *
 * **The attribute is withheld, rather than a tooltip of our own being drawn.** A native tooltip's
 * delay cannot be changed, but whether there is anything to show can: an element with no `title`
 * has no tooltip, so arming the attribute on a timer puts three seconds in front of the browser's
 * own delay without inventing a second tooltip surface that would then have to answer for its own
 * positioning, edge-flipping, theming and z-index inside a menu that already portals and cascades.
 *
 * **What no test here can hold is the OUTCOME.** A native tooltip is drawn by the browser and is
 * invisible to jsdom, so every test around this asserts the attribute. Whether Chromium then
 * paints a tooltip for a `title` that appeared while the pointer was already stationary is a
 * real-window question — it is the one thing about this feature that has to be checked by hand,
 * with a trackpad and a lifted finger, and it has no fallback if it turns out to be false.
 *
 * **Two exemptions belong at the CALL SITES, not here.**
 * - A **disabled** control keeps its title unconditionally: a disabled `<button>` dispatches no
 *   mouse events, so a dwell over one can never be measured and a delayed title would simply never
 *   arrive. It is also the row that needs its tooltip most — a control you cannot press explains
 *   why only in that string.
 * - A **keyboard-reached** row keeps its title too, and that is an accessibility fix rather than a
 *   convenience: `onEnter` is reachable only from a mouse, so arrow-key navigation would otherwise
 *   never surface a description at all — and for a snippet or a history command the `title` is the
 *   only copy of the full, untruncated text. A keyboard user cannot generate the trail this hook
 *   exists to suppress, so gating them buys nothing.
 */
export function useTooltipDwell(): TooltipDwell {
    const [dwelt, setDwelt] = useState<string | null>(null);
    const timer = useRef<number | null>(null);

    const stop = useCallback(() => {
        if (timer.current !== null) {
            window.clearTimeout(timer.current);
            timer.current = null;
        }
    }, []);

    const reset = useCallback(() => {
        stop();
        setDwelt(null);
    }, [stop]);

    const onEnter = useCallback((key: string) => {
        stop();
        // **Not merely belt-and-braces with `onLeave`.** On every path a sweep takes, the row being
        // left clears first and this line has nothing to do — which is why mutation testing found
        // both clears individually removable with the suite green. The path only this one covers is
        // a row that left the DOM without a `mouseleave`, which React does not synthesize on
        // unmount; `reset()` covers the same shape from the list's side, and this covers the
        // pointer's.
        setDwelt(null);
        timer.current = window.setTimeout(() => {
            timer.current = null;
            setDwelt(key);
        }, TOOLTIP_DWELL_MS);
    }, [stop]);

    // A timer that outlives its menu would set state on an unmounted component.
    useEffect(() => stop, [stop]);

    const titleFor = useCallback(
        /**
         * **The key must identify the ROW, never its position.** Both defects found in review were
         * this: the host menu keyed on `item-${index}` while its owner rebuilt `items` with a
         * varying length, and Command History minted `history-${i}` from a list it re-filters on
         * every keystroke — so a row the pointer had never rested on inherited an armed tooltip and
         * popped with no delay at all, which is the trail this hook removes, triggered by typing
         * instead of by sweeping. Two rows sharing a key is harmless by comparison: only one of
         * them can be under the pointer.
         */
        (key: string, title: string | undefined) => (dwelt === key ? title : undefined),
        [dwelt],
    );

    return { titleFor, onEnter, onLeave: reset, reset };
}
