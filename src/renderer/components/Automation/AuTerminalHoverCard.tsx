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
 * **2. `/screen`, and neither of the other two reads.** `/output` replays a lossy ring of raw PTY
 * chunks through a FRESH parser, so it is not what the user is looking at — which is the only
 * question this card is answering. `/snapshot` *is* the live screen, but it serves
 * `contents_formatted()`, a REPLAY STREAM meant to be written into an xterm: runs of blanks are
 * encoded as cursor motion rather than as spaces, so stripping the escapes back out of it in the
 * client COLLAPSES the column layout, and a two-column status bar butts its columns together. This
 * card spent its first draft doing exactly that — with the counter-example already in the tree, as
 * a passing test, one file away. `/api/terminals/:id/screen` renders from the grid the parser has
 * ALREADY applied those cursor ops to (`AppState::screen_text`), so the alignment survives and
 * there is nothing left to strip. See `api_server.rs`'s
 * `the_screen_route_body_keeps_columns_the_snapshot_blob_encodes_as_cursor_ops`.
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
import { SnapshotCache } from '../Canvas/snapshotCache';

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
 * `SnapshotCache` is reused here for its BOOKKEEPING — the TTL, the failure backoff, the eviction —
 * and not for its payload: what this instance stores under `SnapshotEntry.ansi` is the plain grid
 * text `/screen` returns, with no escape sequences in it at all. That field is named for Canvas
 * Mode, the other consumer, which does hold a replay blob. Nothing here reads it as ANSI, so the
 * mismatch is a name and not a bug — said out loud because a reader is otherwise entitled to assume
 * the payload matches the field, and would reach for `stripAnsi` on the way past.
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
 * left a full screen of text here — plus a `failedAt` stamp — for the life of the window, and
 * process ids CHURN: a terminal that is closed and reopened is a new one, so the key space was
 * bounded by *terminals ever hovered*, never by *terminals that exist*. Canvas Mode's own cache has
 * had `evictAllBut` from the start for exactly this reason; this one simply never called it.
 *
 * Takes ROWS rather than a list of ids on purpose. The cache is keyed by process id and the picker
 * is otherwise full of terminal ids, and handed the wrong id space `evictAllBut` would keep nothing
 * and quietly turn the cache off — the same silent-nothing failure `snapshotCache.ts`'s own
 * `isUsableSnapshot` guards its other consumer against.
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
 * ROWS of an 80x24 screen shows six empty lines under a prompt that is still on screen. The
 * trailing blanks go first, and only then does it take the tail.
 *
 * **Takes PLAIN text, and strips nothing.** `/screen` renders from the parser's own grid, so there
 * are no escapes here to remove; running `stripAnsi` over it anyway — which this did while it was
 * reading `/snapshot` — would be a no-op that quietly invites the next reader to point the fetch
 * back at the replay blob, where stripping is not a no-op but a loss of the alignment.
 */
export function previewLines(screen: string, limit: number = AU_PREVIEW_LINES): string[] {
    const lines = screen
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
 * The screen the card is showing, and the terminal it was read FROM, as one value.
 *
 * They are one value because they were two, and the split is what let terminal A's screen paint
 * under terminal B's name. See `AuTerminalPreview`.
 */
export interface Preview {
    processId: string;
    /** `null` = nothing has been read for this terminal yet, so the card shows its waiting line. */
    screen: string | null;
    failed: boolean;
}

/**
 * What to show for `processId` before anything has been fetched for it.
 *
 * Seeded from the cache so re-hovering a row inside the TTL paints its screen immediately instead
 * of flashing the waiting line — which is what running the pointer down a list of rows does.
 */
const seedFor = (processId: string): Preview => ({
    processId,
    screen: previewCache.get(processId)?.ansi ?? null,
    failed: false,
});

/**
 * What to paint for `processId`, given whatever the component last committed.
 *
 * **The whole of the fix for "terminal A's screen under terminal B's name", and pure so that it can
 * be pinned.** State that belongs to another terminal is not merely out of date, it is wrong, so it
 * is discarded here rather than corrected later: a `Preview` carrying a different `processId` is
 * replaced by that terminal's own seed before anything renders.
 *
 * Exported because this invariant is not observable from the outside. The mis-attribution it
 * prevents lasts exactly one commit — the identity block repaints from props in the same render,
 * and an effect's correction lands on the next tick — and jsdom offers no way to read that frame: a
 * `MutationObserver` callback is a microtask and is served the already-corrected DOM, and
 * `flushSync` does not force a continuous-priority update like the one a `mouseover` schedules.
 * Both were tried, and both passed against the broken component. So the property is asserted here,
 * where it is a function of its arguments and nothing else.
 */
export function previewFor(shown: Preview, processId: string): Preview {
    return shown.processId === processId ? shown : seedFor(processId);
}

/**
 * The live half of the card.
 *
 * A separate component so that the identity block is already on screen while this is still
 * fetching: the fields come from the row we were handed and need no round trip, and a card that
 * waits for the network to show a folder it already knows is a card that feels broken.
 *
 * **The screen and the terminal it came from are ONE piece of state, and that is the fix for the
 * bug this component was written to prevent.** It used to hold a bare `ansi` string, with a
 * `setAnsi(previewCache.get(processId) ?? null)` at the top of the effect below and a comment
 * saying that reset was what stopped the card showing the previous terminal's screen under the new
 * terminal's name. It stopped it one frame LATE. `processId` changes during render and effects run
 * after the commit, so React painted terminal B's identity block over terminal A's screen and only
 * then corrected it — a visible frame of exactly the mis-attribution the whole card exists to
 * prevent, on the one gesture (running the pointer down the list) that produces it every time.
 *
 * Pairing the text with its own id makes a stale value unusable rather than merely short-lived: the
 * comparison happens in render, and a screen that does not belong to the terminal being drawn is
 * never drawn at all. A `key={row.processId}` at the call site would also have worked, by
 * remounting — but that puts the guarantee in the CALLER, where a second call site can opt out of
 * it by forgetting the key and get a bug whose symptom appears here.
 */
const AuTerminalPreview: React.FC<{ processId: string }> = ({ processId }) => {
    const [shown, setShown] = useState<Preview>(() => seedFor(processId));
    // Whatever React last committed belongs to the terminal it was fetched FOR. On the render where
    // `processId` changes, that is the previous one — so this render re-seeds from the cache rather
    // than trusting an effect that has not run yet.
    const current = previewFor(shown, processId);

    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        // `cancelled` rather than a bare unmount check: the pointer leaves rows far faster than a
        // round trip settles, so the common case is an in-flight fetch resolving into a component
        // that is already gone.
        let cancelled = false;

        const schedule = () => {
            if (cancelled) return;
            timer.current = setTimeout(() => { void tick(); }, AU_PREVIEW_POLL_MS);
        };

        // Every `setShown` in here stamps the id it fetched for — including the failure paths, which
        // is what stops a failure recorded against the row the pointer just left from rendering as
        // "could not be read" over the row it has just arrived at.
        const failWith = (failed: boolean = true): Preview => ({
            processId,
            // `markFailed` deliberately does not discard the entry, so this is the last good frame
            // if there is one. A screen a second old is a better answer than an empty box, and the
            // empty box is the one that reads as broken.
            screen: previewCache.get(processId)?.ansi ?? null,
            failed,
        });

        const tick = async () => {
            if (cancelled) return;
            if (!previewCache.shouldRefresh(processId, Date.now())) return schedule();

            // Optional on the API surface and guarded the way every other caller guards it: the
            // browser bridge and older hosts do not provide it.
            const readScreen = window.electronAPI?.getTerminalScreenText;
            if (!readScreen) {
                previewCache.markFailed(processId, Date.now());
                setShown(failWith());
                return schedule();
            }

            try {
                const body = await readScreen(processId);
                if (cancelled) return;
                const screen = typeof body?.screen === 'string' ? body.screen : '';
                if (screen.length === 0) {
                    // Not a failure, and so not backed off: `/screen` 404s for an id it cannot
                    // resolve (the bridge turns that into a rejection, caught below), which leaves
                    // an empty body meaning only "this terminal is registered but its parser has
                    // nothing yet" — a state the next poll normally clears. Nothing is cached, so
                    // the next tick retries at the poll interval rather than after the TTL, and any
                    // frame already cached for this terminal keeps being shown.
                    return schedule();
                }
                previewCache.put(processId, {
                    ansi: screen, rows: body.rows, cols: body.cols, fetchedAt: Date.now(),
                });
                setShown({ processId, screen, failed: false });
            } catch {
                if (cancelled) return;
                previewCache.markFailed(processId, Date.now());
                setShown(failWith());
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

    const lines = useMemo(
        () => (current.screen === null ? null : previewLines(current.screen)),
        [current.screen],
    );

    if (lines === null) {
        return (
            <div className="au-hovprev">
                <span className="au-hovwait">
                    {current.failed ? 'Its screen could not be read just now.' : 'Reading its screen…'}
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
