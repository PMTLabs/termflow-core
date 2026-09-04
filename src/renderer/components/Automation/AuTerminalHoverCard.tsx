/**
 * *"Which of these two is which?"* — the hover card behind a row of the §04 terminal picker.
 *
 * The picker's row is a four-column grid (`18px 108px minmax(0,1fr) 74px`) and three of those
 * columns ellipse, so two agents running in sibling folders render as two rows that are identical
 * up to the last few characters of a path neither of them shows. The row stores an **id** — *"a name
 * isn't unique and a folder isn't either"* — and the id was the first thing to be clipped.
 *
 * So this draws every field `WatchableTerminal` actually carries, including the two that were
 * fetched and never shown anywhere (`shell`, `pid`), plus a few lines of what is on the terminal's
 * screen right now. A folder tells you where a terminal is; its screen tells you what it *is*.
 *
 * ## Three things here are load-bearing rather than decorative
 *
 * **1. It is portalled, and it has to be.** The inspector column is a fixed 340px that scrolls
 * (`.au-inspect`), and the picker's own list is `max-height: 260px; overflow-y: auto`. A panel
 * rendered in that flow is clipped by both. Fixed positioning against the hovered row's
 * `getBoundingClientRect()` is the only placement that escapes them, and `hoverCardPosition` below
 * is what keeps it on screen once it has.
 *
 * **2. `/snapshot`, never `/output`.** `Canvas/snapshotCache.ts`'s own header says why: `/output`
 * replays a lossy ring buffer through a FRESH parser, so it is not what the user is looking at,
 * which is the only question this card is answering. Its `isUsableSnapshot` is what turns the
 * endpoint's silent failure — HTTP **200** with an empty blob when handed the wrong id space — into
 * a failure instead of a cached blank frame.
 *
 * **3. It is a hover affordance and nothing more.** `pointer-events: none` on the card, no
 * `tabIndex`, no `focus()`, no listeners of its own: the pointer can travel straight through it, so
 * moving down the list cannot get stuck behind the panel describing the row above. The full id,
 * name and folder are ALSO on the row's own `title`, so a keyboard user and a screen reader get the
 * identifying half of this without a pointer, and so does a viewer for whom the snapshot fetch
 * never resolves.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WatchableTerminal } from '../../types/electron';
import { SnapshotCache, isUsableSnapshot, stripAnsi } from '../Canvas/snapshotCache';

/** The card's own box. Both are needed as NUMBERS, not just as CSS — see `hoverCardPosition`. */
export const AU_HOVER_W = 330;
/**
 * The tallest the card is allowed to get, and the height the clamp below assumes.
 *
 * Measuring the rendered element instead would be more exact and would cost a second render pass
 * plus a layout read on every row the pointer crosses. A `max-height` the CSS also enforces means
 * the assumption cannot be wrong in the direction that matters: the card can be shorter than this
 * and still fit, never taller.
 */
export const AU_HOVER_MAX_H = 280;
/** Air between the card and the row it describes. */
const AU_HOVER_GAP = 10;
/** Air between the card and the window edge, on every side. */
const AU_HOVER_MARGIN = 8;

/** How many lines of the terminal's screen the card shows. The last ones — that is where the
 *  cursor is, and a screenful of scrollback would not fit in a tooltip anyway. */
export const AU_PREVIEW_LINES = 6;

/**
 * How often the tick WAKES UP while the pointer is on the row — which is not how often the preview
 * refreshes.
 *
 * The refresh is gated by `previewCache.shouldRefresh`, and that gate is `SNAPSHOT_TTL_MS`. So the
 * real cadence is this interval rounded up to the first wakeup past the TTL —
 * `ceil(2000 / 700) * 700` = **2100ms** — and two wakeups in three find the entry still fresh and
 * do nothing. This comment used to claim the preview re-read "faster than `SNAPSHOT_TTL_MS`
 * deliberately", which the cache never allowed it to do.
 *
 * Sampling below the TTL is still worth its two no-op `Map` reads: it is what caps the worst-case
 * staleness at `TTL + one poll` rather than at `2 × TTL`, which is what a card hovered onto a cache
 * entry that is nearly expired would otherwise wait. Refreshing *genuinely* faster than Canvas
 * Mode's 2s is not something this file can decide — `SNAPSHOT_TTL_MS` is a module constant of
 * `Canvas/snapshotCache.ts`, and it would take a per-instance TTL on `SnapshotCache` for this card
 * to poll at its own rate without also re-tuning a whole workspace of Canvas nodes.
 *
 * The loop stops when the pointer leaves the row: the effect below is keyed on `processId`, so
 * moving to the next row cancels this one, and leaving the list unmounts the card outright.
 */
export const AU_PREVIEW_POLL_MS = 700;

/**
 * A cache of this card's OWN, deliberately not the `snapshotCache` singleton.
 *
 * The class is exported precisely so a second consumer can have one, and sharing the singleton
 * would have coupled two unrelated surfaces: `CanvasMode` calls `snapshotCache.evictAllBut(…)` with
 * the ids currently on ITS screen, which would evict this card's entries every frame Canvas Mode is
 * open. Nothing would break — a snapshot is cheap to refetch — but the cache would quietly stop
 * being a cache, and "quietly stops working when an unrelated tab is open" is not a thing to leave
 * in the tree on purpose.
 *
 * Keyed by **process** id, since that is the key `/snapshot` itself uses and the one the row hands
 * us; the singleton is keyed by renderer id, so even shared the two would not have collided.
 *
 * Being module-level, it lives as long as the window — so it needs an owner for the other half of a
 * cache, which is `evictPreviewsOutside` below.
 */
const previewCache = new SnapshotCache();

/**
 * Drop every cached preview whose terminal is not in `roster`.
 *
 * A cache with no eviction is a leak with a nice name. Every distinct process id the pointer crossed
 * left a full styled ANSI screen here — plus a `failedAt` stamp — for the life of the window, and
 * process ids CHURN: a terminal that is closed and reopened is a new one, so the key space was
 * bounded by *terminals ever hovered*, never by *terminals that exist*. Canvas Mode's own cache has
 * had `evictAllBut` from the start for exactly this reason; this one simply never called it.
 *
 * Takes ROWS rather than a list of ids on purpose. The cache is keyed by process id and the picker
 * is otherwise full of terminal ids, and handed the wrong id space `evictAllBut` would keep nothing
 * and quietly turn the cache off — the same silent-nothing failure `isUsableSnapshot` exists to
 * catch one layer down.
 *
 * `AuTerminalPicker` owns the calls: it is the only thing that knows both when a hover has ended
 * and what the roster currently holds.
 */
export function evictPreviewsOutside(roster: readonly WatchableTerminal[]): void {
    previewCache.evictAllBut(
        roster
            .map((row) => row.processId)
            .filter((id): id is string => typeof id === 'string' && id.length > 0),
    );
}

/**
 * Where the card goes, given the row it describes and the window it has to fit in.
 *
 * **Left of the row first.** The picker lives in the inspector, which is the right-hand column of a
 * three-column body, so the room is on the left; opening to the right would put the card off the
 * window on any normal editor width and force the clamp to slide it back over the row it is
 * describing. It flips to the right only when the left side genuinely has no room — a narrow window
 * at the collapsed 280px inspector — and clamps into the viewport after either choice, because
 * neither side is guaranteed to fit.
 *
 * Pure, and exported, so the clamp can be tested without a layout engine: jsdom's
 * `getBoundingClientRect()` returns zeroes for everything, which makes every DOM-driven assertion
 * about placement vacuous.
 */
export function hoverCardPosition(
    anchor: { top: number; left: number; right: number },
    view: { width: number; height: number },
): { left: number; top: number } {
    const toTheLeft = anchor.left - AU_HOVER_W - AU_HOVER_GAP;
    let left = toTheLeft >= AU_HOVER_MARGIN ? toTheLeft : anchor.right + AU_HOVER_GAP;
    if (left + AU_HOVER_W > view.width - AU_HOVER_MARGIN) {
        left = view.width - AU_HOVER_MARGIN - AU_HOVER_W;
    }
    // After the right-edge clamp, not before it: on a window narrower than the card, the left edge
    // is the one that wins, so a card is never pushed off the side you read from.
    if (left < AU_HOVER_MARGIN) left = AU_HOVER_MARGIN;

    const lowestTop = view.height - AU_HOVER_MARGIN - AU_HOVER_MAX_H;
    const top = Math.max(AU_HOVER_MARGIN, Math.min(anchor.top, lowestTop));
    return { left, top };
}

/**
 * The last few lines of a screen, as text.
 *
 * A vt100 screen is a fixed grid, so its tail is almost always blank padding — taking the last six
 * ROWS of an 80x24 snapshot shows six empty lines under a prompt that is still on screen. The
 * trailing blanks go first, and only then does it take the tail.
 */
export function previewLines(ansi: string, limit: number = AU_PREVIEW_LINES): string[] {
    const lines = stripAnsi(ansi)
        .split('\n')
        // Trailing whitespace, which also disposes of the CR of a CRLF pair.
        .map((line) => line.replace(/\s+$/, ''));
    while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop();
    return lines.slice(-limit);
}

/** One `label: value` line of the identity block. `null` is reported as such rather than as a gap:
 *  a blank row reads as a field this card forgot to fill in. */
const Field: React.FC<{ label: string; value: string | null; mono?: boolean }> = ({
    label,
    value,
    mono,
}) => (
    <div className="au-hovfield">
        <span className="au-hovk">{label}</span>
        <span className={`au-hovv${mono ? ' mono' : ''}${value === null ? ' none' : ''}`}>
            {value ?? 'not reported'}
        </span>
    </div>
);

/**
 * The live half of the card.
 *
 * A separate component so that the identity block is already on screen while this is still
 * fetching: the fields come from the row we were handed and need no round trip, and a card that
 * waits for the network to show a folder it already knows is a card that feels broken.
 */
const AuTerminalPreview: React.FC<{ processId: string }> = ({ processId }) => {
    // Seeded from the cache so re-hovering a row inside the TTL paints its screen immediately
    // instead of flashing the waiting line — which is what running the pointer down the list does.
    const [ansi, setAnsi] = useState<string | null>(() => previewCache.get(processId)?.ansi ?? null);
    const [failed, setFailed] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        // `cancelled` rather than a bare unmount check: the pointer leaves rows far faster than a
        // round trip settles, so the common case is an in-flight fetch resolving into a component
        // that is already gone.
        let cancelled = false;

        // The initialiser above does not re-run when `processId` changes, so without this the card
        // would keep showing the PREVIOUS terminal's screen under the new terminal's name — the one
        // mistake this whole card exists to prevent.
        setAnsi(previewCache.get(processId)?.ansi ?? null);
        setFailed(false);

        const schedule = () => {
            if (cancelled) return;
            timer.current = setTimeout(() => { void tick(); }, AU_PREVIEW_POLL_MS);
        };

        const tick = async () => {
            if (cancelled) return;
            if (!previewCache.shouldRefresh(processId, Date.now())) return schedule();

            // Optional on the API surface and guarded the way every other caller guards it: the
            // browser bridge and older hosts do not provide it.
            const getSnapshot = window.electronAPI?.getTerminalSnapshot;
            if (!getSnapshot) {
                previewCache.markFailed(processId, Date.now());
                setFailed(true);
                return schedule();
            }

            try {
                const snap = await getSnapshot(processId);
                if (cancelled) return;
                // HTTP 200 with an empty blob is how `/snapshot` says no. Cached, it would be a
                // permanently blank preview with nothing anywhere reporting an error.
                if (!isUsableSnapshot(snap)) {
                    previewCache.markFailed(processId, Date.now());
                    setFailed(true);
                    return schedule();
                }
                previewCache.put(processId, {
                    ansi: snap.snapshot, rows: snap.rows, cols: snap.cols, fetchedAt: Date.now(),
                });
                setAnsi(snap.snapshot);
                setFailed(false);
            } catch {
                if (cancelled) return;
                // The last good frame is kept: a screen a second old is a better answer than an
                // empty box, and the empty box is the one that reads as broken.
                previewCache.markFailed(processId, Date.now());
                setFailed(true);
            }
            schedule();
        };

        void tick();
        return () => {
            cancelled = true;
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
        };
    }, [processId]);

    const lines = useMemo(() => (ansi === null ? null : previewLines(ansi)), [ansi]);

    if (lines === null) {
        return (
            <div className="au-hovprev">
                <span className="au-hovwait">
                    {failed ? 'Its screen could not be read just now.' : 'Reading its screen…'}
                </span>
            </div>
        );
    }
    return (
        <div className="au-hovprev">
            <pre>{lines.join('\n')}</pre>
        </div>
    );
};

export interface AuTerminalHoverCardProps {
    row: WatchableTerminal;
    /** The hovered row's own box, in client coordinates. */
    anchor: { top: number; left: number; right: number };
}

export const AuTerminalHoverCard: React.FC<AuTerminalHoverCardProps> = ({ row, anchor }) => {
    const { left, top } = hoverCardPosition(anchor, {
        width: window.innerWidth,
        height: window.innerHeight,
    });

    return createPortal(
        // `role="tooltip"` and nothing else: it is not referenced by an `aria-describedby`, so
        // assistive tech is not sent here — the row's own `title` is what carries the identity for
        // anyone not using a pointer, and it is the reason this card is allowed to be pointer-only.
        //
        // The z-index (9991) sits one above `.au-editor`'s 9990 and below `ConfirmDialog`'s 9999,
        // in the stack `AutomationEditor.css`'s header lists. A card that outranked the delete
        // confirmation would hang over a dialog asking a question.
        <div
            className="au-hovcard"
            role="tooltip"
            style={{ left, top, width: AU_HOVER_W, maxHeight: AU_HOVER_MAX_H }}
        >
            <div className="au-hovid">
                <Field label="ID" value={row.terminalId} mono />
                <Field label="Name" value={row.label ?? null} />
                <Field label="Folder" value={row.cwd ?? null} />
                <Field label="Shell" value={row.shell ?? null} />
                <Field label="PID" value={row.pid === null || row.pid === undefined ? null : String(row.pid)} />
                <Field label="State" value={row.alive ? 'open' : 'not open'} />
            </div>

            {/*
              * Three outcomes, and the closed one is NOT an empty preview box.
              *
              * A dead row has no process to read — `processId` is null by definition — so fetching
              * would ask `/snapshot` about `null` and get its silent 200 back. An empty frame under
              * a heading is indistinguishable from a fetch that failed, and this is the row the
              * picker deliberately keeps around and greys out, so it is the one a user is most
              * likely to be hovering when they are trying to work out what happened.
              *
              * `alive` with no `processId` is the third: open, but not attached to a run this
              * renderer can name. Rare, and it must not fall into either of the other two.
              */}
            {!row.alive && (
                <p className="au-hovclosed">
                    This terminal is not open, so it has no screen to show. Its name and folder
                    above are the ones it had when the rule last saw it.
                </p>
            )}
            {row.alive && !row.processId && (
                <p className="au-hovclosed">
                    It is open, but no process is attached to it right now, so there is nothing to
                    read.
                </p>
            )}
            {row.alive && row.processId && <AuTerminalPreview processId={row.processId} />}
        </div>,
        document.body,
    );
};
