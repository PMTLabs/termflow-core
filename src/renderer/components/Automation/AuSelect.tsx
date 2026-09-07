/**
 * A dropdown that cannot be clipped by the window.
 *
 * **Why not `<select>`.** TermFlow runs with `decorations: false`, so WebView2 composites the native
 * option popup INSIDE the window surface instead of handing it to the OS. Chromium still chooses
 * where to put it from screen geometry, so a select near the bottom of the window opens downward
 * into space the compositor then clips — the list is cut off mid-row with no scrollbar and no way to
 * reach the hidden options. The editor is a 95vh dialog whose inspector column scrolls, so ANY of
 * its selects can be the bottom-most control; this is not a property of one field.
 *
 * Nothing in CSS reaches a native popup, so the list has to be ours. It is portalled to `body` and
 * positioned `fixed`: the inspector column is `overflow-y: auto`, which would clip an absolutely
 * positioned child of the trigger, and the editor's `.au-modal` is `overflow: hidden` besides.
 *
 * **It flips up when there is no room below**, and caps its height to the space it has, so the list
 * is always whole and always scrollable to its end.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface AuSelectOption {
    value: string;
    label: string;
    /**
     * The `<optgroup>` this row belongs to, if any. Rendered as a heading above the first row that
     * carries it — the comparison list is *Text* and *Number*, and flattening those two into one
     * list of fifteen verbs loses the only thing that makes it skimmable.
     */
    group?: string;
    /** Shown greyed and unpickable — the test pane lists terminals that have since closed. */
    disabled?: boolean;
}

export interface AuSelectProps {
    value: string;
    options: readonly AuSelectOption[];
    /** Named the same as the `<select>` this replaces, so callers and tests address it unchanged. */
    ariaLabel: string;
    onChange: (value: string) => void;
    className?: string;
    style?: React.CSSProperties;
}

/** Never draw a list shorter than this; below it, flipping is better than scrolling three rows. */
const MIN_LIST_H = 96;
/** Nor taller: a 20-option list that fills the window reads as a page, not a menu. */
const MAX_LIST_H = 260;
/** Between the trigger and the list, and between the list and the window edge. */
const GAP = 4;
const EDGE = 8;

/**
 * The list is **at least** as wide as its trigger and as wide as its content needs, bounded by the
 * window.
 *
 * A fixed `width: trigger` was the trigger's width exactly, and `.au-selopt` ellipses what does not
 * fit — so `does not equal` opened as `does not e…`, which is the one thing a list of options must
 * never do. Growing rightwards is enough for every select here: they sit in the inspector column at
 * the right of the window, and the whole width of that column is room the portalled list can use.
 */
type Span = { left: number; minWidth: number; maxWidth: number; maxHeight: number };
type Placement = ({ side: 'below'; top: number } | { side: 'above'; bottom: number }) & Span;

export const AuSelect: React.FC<AuSelectProps> = ({
    value,
    options,
    ariaLabel,
    onChange,
    className,
    style,
}) => {
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const [placement, setPlacement] = useState<Placement | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const selectedIndex = options.findIndex((o) => o.value === value);
    const current = selectedIndex >= 0 ? options[selectedIndex] : undefined;

    const place = useCallback(() => {
        const el = triggerRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const below = window.innerHeight - r.bottom - GAP - EDGE;
        const above = r.top - GAP - EDGE;
        // Below unless it cannot hold a usable list AND above is roomier. Preferring below keeps the
        // common case where both fit reading the way every other menu in the app does.
        const flip = below < MIN_LIST_H && above > below;
        const room = Math.max(MIN_LIST_H, Math.min(MAX_LIST_H, flip ? above : below));
        const span: Span = {
            left: r.left,
            // Never narrower than the control it belongs to, never wider than the window can show.
            minWidth: r.width,
            maxWidth: Math.max(r.width, window.innerWidth - r.left - EDGE),
            maxHeight: room,
        };
        setPlacement(
            flip
                // Anchored by its BOTTOM, so a list shorter than the room available still sits
                // against the trigger instead of floating above it.
                ? { side: 'above', bottom: window.innerHeight - r.top + GAP, ...span }
                : { side: 'below', top: r.bottom + GAP, ...span },
        );
    }, []);

    useLayoutEffect(() => {
        if (!open) return;
        place();
        // `true` — capture — so a scroll of the inspector column repositions too, not only one of
        // the window itself. A menu that stays put while its trigger slides away is worse than one
        // that closes.
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
            if (listRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
            setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]);

    /** The next pickable row in `step`'s direction, or `from` when there is none. */
    const nextEnabled = (from: number, step: number): number => {
        for (let i = from + step; i >= 0 && i < options.length; i += step) {
            if (!options[i].disabled) return i;
        }
        return from;
    };

    const commit = (index: number) => {
        const option = options[index];
        // A disabled row is reachable by neither key nor click; guarding here as well means a future
        // caller that opens one some third way still cannot choose it.
        if (option && option.disabled) return;
        if (option) onChange(option.value);
        setOpen(false);
        triggerRef.current?.focus();
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (!open) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setActive(selectedIndex >= 0 ? selectedIndex : 0);
                setOpen(true);
            }
            return;
        }
        switch (e.key) {
            case 'Escape':
                // The editor closes on Escape too. Stop here, or picking a value would be
                // indistinguishable from abandoning the whole dialog.
                e.stopPropagation();
                e.preventDefault();
                setOpen(false);
                triggerRef.current?.focus();
                break;
            case 'ArrowDown':
                e.preventDefault();
                setActive((i) => nextEnabled(i, 1));
                break;
            case 'ArrowUp':
                e.preventDefault();
                setActive((i) => nextEnabled(i, -1));
                break;
            case 'Home':
                e.preventDefault();
                setActive(nextEnabled(-1, 1));
                break;
            case 'End':
                e.preventDefault();
                setActive(nextEnabled(options.length, -1));
                break;
            case 'Enter':
            case ' ':
                e.preventDefault();
                commit(active);
                break;
            case 'Tab':
                setOpen(false);
                break;
            default:
                break;
        }
    };

    return (
        <>
            <button
                type="button"
                ref={triggerRef}
                className={`au-finput au-sel${className ? ` ${className}` : ''}`}
                style={style}
                aria-label={ariaLabel}
                aria-haspopup="listbox"
                aria-expanded={open}
                onKeyDown={onKeyDown}
                onClick={() => {
                    setActive(selectedIndex >= 0 ? selectedIndex : 0);
                    setOpen((was) => !was);
                }}
            >
                <span className="au-seltext">{current?.label ?? ''}</span>
                <span className="au-selchev" aria-hidden="true">▾</span>
            </button>
            {open && placement && createPortal(
                <div
                    ref={listRef}
                    className="au-selmenu"
                    role="listbox"
                    aria-label={ariaLabel}
                    tabIndex={-1}
                    style={{
                        left: placement.left,
                        // No `width`: a fixed-position box with none shrink-wraps its content, so
                        // these two bounds are what decide it.
                        minWidth: placement.minWidth,
                        maxWidth: placement.maxWidth,
                        maxHeight: placement.maxHeight,
                        ...(placement.side === 'below'
                            ? { top: placement.top }
                            : { bottom: placement.bottom }),
                    }}
                    onKeyDown={onKeyDown}
                >
                    {options.map((option, index) => (
                        <React.Fragment key={option.value}>
                            {option.group && option.group !== options[index - 1]?.group && (
                                <div className="au-selgroup" role="presentation">{option.group}</div>
                            )}
                        <div
                            role="option"
                            // The value a row holds, readable from the DOM. A `<div>` has no
                            // `value`, and a list whose rows can only be identified by their
                            // rendered text cannot be asserted against the keys it round-trips.
                            data-value={option.value}
                            aria-selected={option.value === value}
                            aria-disabled={option.disabled || undefined}
                            className={`au-selopt${index === active && !option.disabled ? ' active' : ''}${
                                option.value === value ? ' on' : ''
                            }${option.disabled ? ' dead' : ''}`}
                            onMouseEnter={() => { if (!option.disabled) setActive(index); }}
                            onMouseDown={(e) => {
                                // `mousedown`, not `click`: the outside-close listener above runs on
                                // mousedown, and a click handler would fire after this menu had
                                // already been torn down.
                                e.preventDefault();
                                commit(index);
                            }}
                        >
                            {option.label}
                        </div>
                        </React.Fragment>
                    ))}
                </div>,
                document.body,
            )}
        </>
    );
};
