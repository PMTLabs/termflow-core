/**
 * An **ⓘ** beside a field label, and the styled panel it opens.
 *
 * **Why not `title`.** A native tooltip is the browser's: one size, one colour, no markup, a delay
 * before it appears and a timeout that takes it away mid-sentence. What belongs behind this icon is
 * a few worked examples — several lines, a `<code>` run per example, a heading per case — which is
 * not something a `title` string can hold at all. It also has to be reachable by keyboard and by
 * touch, and a hover tooltip is neither.
 *
 * **Click, not hover**, for the same reason: the panel is content to read, and content that
 * vanishes when the pointer travels toward it cannot be read.
 *
 * **Portalled and `fixed`, like `AuSelect` and `AuTerminalHoverCard`.** The inspector column is
 * `overflow-y: auto` and the editor's `.au-modal` is `overflow: hidden`, so a panel rendered in
 * flow is clipped twice over. Every placement decision therefore has to be made against the
 * trigger's `getBoundingClientRect()` — see `infoPopPosition`, which is a pure function for the
 * same reason the rest of this folder's geometry is: jsdom lays nothing out, and a placement that
 * can only be checked by eye is a placement nobody checks.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** The panel's box. Needed as NUMBERS, not only as CSS — `infoPopPosition` reasons about them. */
export const AU_INFO_W = 320;
/**
 * The tallest it may get, and the height the clamp assumes. Measuring the rendered element instead
 * would be exact and would cost a second render pass; a `max-height` the CSS also enforces cannot
 * be wrong in the direction that matters — the panel can be shorter and still fit, never taller.
 */
export const AU_INFO_MAX_H = 300;
/** Air between the panel and its icon. */
const GAP = 6;
/** Air between the panel and the window edge, on every side. */
const MARGIN = 8;

/**
 * Where the panel goes, given the icon it belongs to and the window it has to stay inside.
 *
 * **Below unless it does not fit, then above** — the icon sits in a label at the top of a field, so
 * below is where there is normally room and where the eye already is. Horizontally the panel hangs
 * from the icon's LEFT edge, because these labels are left-aligned and a panel that grew leftwards
 * from a left-hand icon would sit over the margin.
 *
 * Both clamps end with the low edge, deliberately: on a window smaller than the panel the top-left
 * is the corner that wins, so it is never pushed off the side or the top you read from.
 */
export function infoPopPosition(
    anchor: { top: number; bottom: number; left: number },
    view: { width: number; height: number },
): { left: number; top: number } {
    let left = anchor.left;
    if (left + AU_INFO_W > view.width - MARGIN) left = view.width - MARGIN - AU_INFO_W;
    if (left < MARGIN) left = MARGIN;

    const below = anchor.bottom + GAP;
    // Above only when below genuinely cannot hold it, so the panel does not jump sides as the
    // inspector scrolls a few pixels.
    const top = below + AU_INFO_MAX_H <= view.height - MARGIN
        ? below
        : Math.max(MARGIN, anchor.top - GAP - AU_INFO_MAX_H);
    return { left, top };
}

export interface AuInfoProps {
    /** Names the button AND the panel: a screen reader meets the panel with no icon to look at. */
    label: string;
    children: React.ReactNode;
}

export const AuInfo: React.FC<AuInfoProps> = ({ label, children }) => {
    const [open, setOpen] = useState(false);
    const [at, setAt] = useState<{ left: number; top: number } | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const popRef = useRef<HTMLDivElement>(null);

    const place = useCallback(() => {
        const el = triggerRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        setAt(infoPopPosition(r, { width: window.innerWidth, height: window.innerHeight }));
    }, []);

    useLayoutEffect(() => {
        if (!open) return;
        place();
        // Capture, so a scroll of the inspector column repositions too and not only one of the
        // window itself — the same reason `AuSelect` gives.
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
        };
    }, [open, place]);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            const target = e.target as Node;
            // The panel itself is exempt: it holds text people select and links they may click.
            if (popRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            // Stopped here so the editor's own Escape does not ALSO close the whole dialog behind
            // it: dismissing a panel and discarding an unsaved rule are not the same gesture.
            e.stopPropagation();
            setOpen(false);
            triggerRef.current?.focus();
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey, true);
        };
    }, [open]);

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                className={`au-info${open ? ' on' : ''}`}
                aria-label={label}
                aria-expanded={open}
                onClick={() => setOpen((was) => !was)}
            >
                <span aria-hidden="true">i</span>
            </button>
            {open && at && createPortal(
                <div
                    ref={popRef}
                    className="au-infopop"
                    role="dialog"
                    aria-label={label}
                    style={{ left: at.left, top: at.top }}
                >
                    {children}
                </div>,
                document.body,
            )}
        </>
    );
};
