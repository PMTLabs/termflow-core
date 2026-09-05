/**
 * The §04 terminal picker (R14) — Tam's round-1 request, and the component the boundary audit found
 * had **no owner**: terminals built the endpoint, settings-ui built the list, the editor built
 * panels, and the tick-table itself fell between them (§7.8).
 *
 * What it stores is the terminal **id**, always — *"a name isn't unique and a folder isn't either"* —
 * and the id is the same string the API and MCP tools use, so a rule and a script are talking about
 * the same terminal.
 *
 * **The dead row is the whole reason this table exists rather than a `<select>` of live terminals.**
 * A terminal that closes keeps its tick, greyed, and keeps its NAME and FOLDER, because
 * `list_watchable_terminals` fills a missing id from the rule's own label snapshot. Nothing else can
 * describe an id that is gone, and a bare id in a list of names reads as corruption.
 *
 * **Every column of the row ellipses, so the row alone cannot identify a terminal.** The id chip,
 * the name and the folder all clip, and the grid is `18px 108px minmax(0,1fr) 74px` — 108px holds
 * about a dozen characters of a `tm-` id. Two agents in sibling folders therefore drew
 * as two rows identical up to the characters neither of them showed, in a table whose entire job is
 * telling terminals apart. The full text is now on the row's own `title`, and hovering a row opens
 * `AuTerminalHoverCard`: every field the roster carries — including `shell` and `pid`, which were
 * fetched and displayed nowhere — plus a few lines of what is on that terminal's screen right now.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { WatchableTerminal } from '../../types/electron';
import { AuTerminalHoverCard, evictPreviewsOutside } from './AuTerminalHoverCard';

/**
 * The three fields of the ROW that `hoverCardPosition` reads — and only those: the other half of
 * what that function reads is the viewport, which is not in here and cannot be.
 *
 * Compared field by field rather than by object identity, because `getBoundingClientRect()` mints a
 * fresh `DOMRect` on every call: an identity check would report "moved" on every pointer move and
 * re-render the card at the same coordinates a hundred times a second. Width and height are left
 * out because nothing about the card's placement depends on them.
 *
 * Knowing only the row, this is not on its own an answer to *"does the card need re-clamping"* — a
 * window resize changes the viewport and need not move the row at all. The effect below is where
 * that is settled, by not consulting this on a `resize`.
 */
const sameAnchor = (a: DOMRect, b: DOMRect): boolean =>
    a.top === b.top && a.left === b.left && a.right === b.right;

export interface AuTerminalPickerProps {
    rows: WatchableTerminal[];
    picked: string[];
    /** The picker could not be read at all — distinct from "nothing is open". */
    error: string | null;
    loading: boolean;
    onToggle: (id: string) => void;
    onSet: (ids: string[]) => void;
}

export const AuTerminalPicker: React.FC<AuTerminalPickerProps> = ({
    rows,
    picked,
    error,
    loading,
    onToggle,
    onSet,
}) => {
    const [filter, setFilter] = useState('');
    /**
     * Which row the pointer is on, by ID and not by object.
     *
     * The roster is re-fetched every few seconds while the editor is open (`ROSTER_POLL_MS`), and
     * every poll replaces `rows` with freshly-deserialised objects. Holding the row itself would
     * pin the card to the copy that was current when the pointer arrived, so a terminal that closed
     * — or changed folder — while being hovered would keep describing itself as it was. The id is
     * what survives a refetch, so the card is looked up from the CURRENT `shown` on every render
     * and stays live.
     *
     * `el` is the row's own DOM node, and it is here so that something OTHER than a pointer gesture
     * can re-read the anchor — see the scroll/resize effect below. It is the node rather than a ref
     * because there is one card and N rows: a ref would have to be re-pointed at whichever row the
     * pointer is on, which is this state's job already.
     */
    const [hovered, setHovered] =
        useState<{ id: string; anchor: DOMRect; el: HTMLElement } | null>(null);

    const shown = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        if (needle.length === 0) return rows;
        return rows.filter((row) =>
            [row.terminalId, row.label ?? '', row.cwd ?? ''].some((f) => f.toLowerCase().includes(needle)));
    }, [rows, filter]);

    // Counted over the PICK SET, not over the filtered view: the bar reports what the rule watches,
    // and a filter is a way of looking at the table rather than a change to the rule.
    const open = picked.filter((id) => rows.find((r) => r.terminalId === id)?.alive).length;
    const gone = picked.length - open;

    // Resolved against the FILTERED view, so typing a filter that hides the hovered row takes its
    // card with it: the pointer never leaves that row (it is gone), so no `mouseleave` is coming.
    const hoveredRow = hovered === null
        ? null
        : shown.find((r) => r.terminalId === hovered.id) ?? null;

    // Pulled out as its own value so the effect below can depend on the ELEMENT and not on
    // `hovered`, which that effect writes to.
    const hoveredEl = hovered?.el ?? null;

    /**
     * Keep the card on its row when the row moves and the POINTER does not.
     *
     * `.au-tpick` is a 260px scroller and the inspector column it sits in scrolls too, so a wheel
     * can slide this row up or down under a pointer that never moves — and a window resize can
     * reflow the whole column. Neither fires a pointer event: `mouseover` fires only when the
     * element under the cursor CHANGES, and the row under a stationary pointer very often does not.
     * With the anchor captured once at `mouseenter`, the card stayed at the old client-y and
     * drifted off the row it was naming, on a card whose only job is saying WHICH row this is.
     *
     * **`capture: true`, and on `window`.** A `scroll` event does not bubble, so a bubble-phase
     * listener on `window` hears the document scrolling and nothing else — not `.au-tpick`, not the
     * inspector column, which are the two that actually move this row. The capture phase sees every
     * one of them without this having to know which ancestor is the scroller, which is the part
     * that made a listener look expensive enough to skip.
     *
     * **Not coalesced into a `requestAnimationFrame`, and that is a decision rather than an
     * oversight.** Both events are already frame-rate bounded at the source: the browser queues
     * them and fires them from the "update the rendering" step, at most once per frame per
     * scroller, and a wheel moves one scroller. So the frame an rAF would be de-duplicating almost
     * always holds a single event, and the callback it defers is one `getBoundingClientRect` plus a
     * `setState` that returns `cur` unchanged unless the row actually moved — no React render at
     * all on the scrolls that do not concern this row. Against that, an rAF costs a pending handle
     * to cancel on every path out of this effect, and a frame of lag on a card whose entire
     * complaint is that it lags behind its row.
     *
     * Keyed on the ELEMENT and on the RENDERED LIST — not on `hovered`, whose anchor this effect
     * writes, and which would therefore rebuild it on every update it causes.
     *
     * **`shown` is in there because a row moves for a third reason, and it is the quiet one.** The
     * two events above cover the row moving because something SCROLLED or the window RESIZED. A
     * relayout of the list itself fires neither: the roster poll replaces `rows` every few seconds
     * and any terminal above this one closing shifts it, and so does one keystroke in the filter
     * box hiding a row above. The hovered row is keyed by `terminalId`, so it is the SAME DOM node
     * throughout — the element does not change, no listener re-arms, no pointer event is coming
     * because the pointer never moved, and the card goes on being drawn at the box captured by the
     * last gesture. That is a settled wrong anchor, not a dropped frame: it persists until the user
     * moves the pointer. Re-running on `shown` takes the reading the relayout owed. It costs a
     * listener swap per roster poll, which is two `addEventListener` calls every few seconds
     * against a card that is only mounted while a pointer is resting on a row.
     *
     * **`cur.el !== hoveredEl` is not belt-and-braces, and the window it closes is the ordinary
     * case rather than a rare one.** The cleanup below does remove this listener when the pointer
     * moves on — but not immediately. `mouseover` carries CONTINUOUS priority in React, so the move
     * to the next row is queued, not flushed: for the rest of that frame the previous row's
     * listener is still attached while the state it writes into already names the next row. And a
     * scroll is exactly what changes which row is under a still pointer, so the two arrive in that
     * order by nature. Without the check, row A's box lands on row B's card and the card names one
     * row while pointing at another.
     *
     * `sameAnchor` is the cheaper half: a scroll of some other element on the page still fires here
     * (that is the price of the capture phase), and returning `cur` unchanged is what makes React
     * bail out of the render rather than re-committing the card at the coordinates it already has.
     *
     * **And that guard is why this takes a reading BEFORE it listens.** The window it closes is
     * real, but closing it leaves the arriving row with nobody writing for it: the outgoing row's
     * listener refuses the scroll (`cur.el !== hoveredEl`) and the arriving row's listener does not
     * exist yet, because this effect is passive and runs after the commit that scheduled it. A wheel
     * flick lands both events in that gap by nature — frame N brings row B under a still pointer and
     * commits the hover with B's box as it is at frame N, frame N+1 scrolls again and is dropped by
     * both sides — and then the flick ends, the pointer never moves, and nothing further is coming.
     * The card sits at frame-N coordinates with no correction scheduled. Reading once on attach
     * makes the anchor right as of the moment this effect is ARMED rather than as of the last event
     * that reached it: a settled-state guarantee instead of a race the listeners happen to win. It
     * cannot fight the guard or loop — at attach `cur.el` IS `hoveredEl`, the write changes only
     * `anchor`, and this effect is keyed on the element.
     *
     * That read also makes the guard above unkillable by any test in this repo, and it is worth
     * knowing which of the two a green suite is speaking for. Drop the guard and A's box lands on
     * B's card — and this read then overwrites it with B's, so every settled assertion still holds.
     * What is lost is one PAINTED frame: passive effects flush in a macrotask after paint, so the
     * card is shown at the other row's coordinates once and repaired afterwards. Preventing a wrong
     * paint beats repairing one, so the guard stays; `auTerminalPickerHover.test.tsx` says out loud
     * that it is the read, not the guard, that its assertions pin.
     *
     * **A resize skips the `sameAnchor` bail-out, because it is a change to the OTHER input.**
     * `hoverCardPosition` is a function of the anchor AND the live viewport, and `sameAnchor`
     * compares three numbers off the row: a resize that changes `innerWidth`/`innerHeight` without
     * moving the row returns `cur` unchanged, React bails out of the render, and the card keeps a
     * `top` clamped against a viewport that no longer exists — hanging off the bottom edge, on an
     * element that is `position: fixed`. That it is unreachable today is an accident of a
     * stylesheet: `.au-modal` is `95vw × 95vh` and centred, so every resize does move the row. This
     * component never references that file and cannot check it, and the guarantee is not the CSS's
     * to make. Forcing the write costs one render per `resize` — an event that has just relaid out
     * the entire document.
     */
    useEffect(() => {
        if (hoveredEl === null) return undefined;
        const reread = (viewportMayHaveMoved: boolean) => {
            const box = hoveredEl.getBoundingClientRect();
            setHovered((cur) => (
                cur === null
                || cur.el !== hoveredEl
                || (!viewportMayHaveMoved && sameAnchor(cur.anchor, box))
                    ? cur
                    : { ...cur, anchor: box }
            ));
        };
        const onScroll = () => reread(false);
        const onResize = () => reread(true);
        // Before the listeners, not instead of them: whatever moved this row between the gesture
        // that captured its box and this effect being armed had nobody to report it.
        reread(false);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onResize);
        };
        // `shown` is a dependency for its IDENTITY, not its contents: any re-render that could have
        // relaid the list out mints a new array, and taking a fresh reading is exactly the response.
    }, [hoveredEl, shown]);

    /**
     * A hover ends when its ROW does, and not only when the pointer says so.
     *
     * Every other way out of a hover is a pointer gesture — `mouseleave`, or a `mouseover` on the
     * next row — and there is one way out that is not: the roster poll drops the row. A terminal
     * that closes while unpicked leaves `list_watchable_terminals` outright, and no `mouseleave`
     * is coming for an element React has just unmounted.
     *
     * Three things went wrong while `hovered` survived its row, and they are the same three the
     * scroll listener's own cleanup exists to prevent — which is why this belongs here rather than
     * being written off as tidiness. The listener stayed armed against a DETACHED node, reading a
     * rect of zeroes on every scroll for the life of the picker. `evictPreviewsOutside` is gated on
     * `hovered === null`, so the preview cache stopped being evicted for as long as the phantom
     * hover stood. And `hovered.id` is resolved against the CURRENT roster on every render, so a
     * terminal that came back under the same id — which is exactly what session restore does —
     * re-opened its card, at an anchor captured before it left, under a pointer that had long since
     * moved somewhere else.
     *
     * The JSX guard below is still load-bearing and is not made redundant by this: state settles
     * after the commit, so the render in which the row disappears is one this effect has not run
     * for yet.
     */
    useEffect(() => {
        if (hovered !== null && hoveredRow === null) setHovered(null);
    }, [hovered, hoveredRow]);

    /**
     * Bound the hover card's snapshot cache to the roster, on the way OUT of a hover.
     *
     * That cache is module-level and therefore immortal, and it is keyed by a process id, which is
     * the id that churns: a terminal closed and reopened is a new key, so every screen the pointer
     * ever crossed accumulated for the life of the window. Evicting down to the current roster keeps
     * the whole point of the cache — running the pointer up and down THIS list still never refetches
     * — while making the key space "terminals on the list" rather than "terminals ever hovered".
     *
     * On the way out rather than on the way in: the hovered row's own entry is the one entry that
     * must survive, and while it is hovered it is by definition still on the list.
     */
    useEffect(() => {
        if (hovered !== null) return;
        evictPreviewsOutside(rows);
    }, [hovered, rows]);

    /** And a closed picker needs none of them: nothing can be hovered from a list that is gone. */
    useEffect(() => () => evictPreviewsOutside([]), []);

    return (
        <div className="au-fgroup">
            <span className="au-flabel">Terminals</span>
            <input
                className="au-finput"
                placeholder="Filter by id, name or folder…"
                aria-label="Filter terminals"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
            />

            {error !== null && (
                <div className="au-pickfail" role="alert">
                    <b>The list of terminals could not be read.</b> Any terminals this rule already
                    watches are still watched — this table is the only thing that is missing.
                </div>
            )}

            <div className="au-tpick" role="group" aria-label="Choose terminals to watch">
                <div className="au-tpickhead" aria-hidden="true">
                    <span />
                    <span>Terminal ID</span>
                    <span>Name &amp; folder</span>
                    <span>State</span>
                </div>

                {loading && <div className="au-pickempty">Looking for open terminals…</div>}

                {!loading && error === null && rows.length === 0 && (
                    <div className="au-pickempty">
                        No terminals are open. Open one and this list fills in — or switch to{' '}
                        <b>Terminals matching a rule</b>, which does not need one open right now.
                    </div>
                )}

                {!loading && rows.length > 0 && shown.length === 0 && (
                    <div className="au-pickempty">
                        Nothing matches “{filter.trim()}”. {rows.length}{' '}
                        {rows.length === 1 ? 'terminal is' : 'terminals are'} still here.
                    </div>
                )}

                {shown.map((row) => {
                    const on = picked.includes(row.terminalId);
                    return (
                        <button
                            type="button"
                            key={row.terminalId}
                            className={`au-tpickrow${on ? ' on' : ''}${row.alive ? '' : ' gone'}`}
                            aria-pressed={on}
                            // **The cheap half of "identify this terminal", and it must stay.**
                            // The hover card is a portal, a fetch and a layout clamp; this is an
                            // attribute. It is what a keyboard user, a screen reader and a viewer
                            // whose screen fetch never resolves still get, and it carries the
                            // three fields the row itself clips.
                            title={[
                                row.terminalId,
                                row.label ?? 'unnamed',
                                row.cwd ?? 'folder not reported',
                                row.alive ? 'open' : 'not open',
                            ].join('\n')}
                            // `mouseenter`/`mouseleave` rather than `pointerenter`: these do not
                            // fire for a touch, and a card that appears under a finger it cannot be
                            // dismissed from is worse than no card. The rect is read here, at the
                            // moment of the gesture, because it is the only moment the row's
                            // position is known to be settled.
                            onMouseEnter={(e) => setHovered({
                                id: row.terminalId,
                                anchor: e.currentTarget.getBoundingClientRect(),
                                el: e.currentTarget,
                            })}
                            // **The row moves under a pointer that does not.** Re-read on the
                            // gesture the pointer is already making. This is the cheapest of the
                            // three re-reads and the least load-bearing: a relayout of the list is
                            // caught by the effect above (which depends on `shown`) without waiting
                            // for the pointer, and this one only shortens the wait when the pointer
                            // happens to move anyway.
                            // Unchanged rects return the same state object, so React bails out and
                            // a move across a row that has not shifted costs no render at all.
                            //
                            // This is NOT the whole of that fix, and the comment that used to sit
                            // here said it was: it argued a `scroll`/`resize` listener was needless
                            // because this rect read covers the case. It cannot. A wheel over a
                            // stationary pointer fires no `mousemove`, and neither does a window
                            // resize, so both of the two ways this row moves on its own were the
                            // ones left uncovered. The effect above handles those.
                            onMouseMove={(e) => {
                                const box = e.currentTarget.getBoundingClientRect();
                                setHovered((cur) => (
                                    cur === null
                                    || cur.id !== row.terminalId
                                    || sameAnchor(cur.anchor, box)
                                        ? cur
                                        : { ...cur, anchor: box }
                                ));
                            }}
                            // Cleared only if the card still belongs to THIS row. A leave that
                            // arrives once the pointer has already opened the next row's card would
                            // otherwise close it — one identity check, rather than depending on
                            // React dispatching every leave before the enter that follows it.
                            onMouseLeave={() => setHovered(
                                (cur) => (cur?.id === row.terminalId ? null : cur),
                            )}
                            onClick={() => onToggle(row.terminalId)}
                        >
                            <span className="au-cmark" aria-hidden="true">
                                ✓
                            </span>
                            <span className={`au-idchip${row.alive ? '' : ' gone'}`}>{row.terminalId}</span>
                            <span className="au-who">
                                <span className="au-nm">{row.label ?? 'unnamed'}</span>
                                <span className="au-cw">{row.cwd ?? ''}</span>
                            </span>
                            <span className="au-st">
                                <span className={`au-lv${row.alive ? '' : ' dead'}`} aria-hidden="true" />
                                {/* `open` / `not open`, and NOT the mockup's `running` / `idle`
                                    third state: the roster carries no busy signal, and inventing
                                    one from `pid` would be a guess drawn as a fact. §7.8's row
                                    model names a `busy` field that no backend ever built. */}
                                {row.alive ? 'open' : 'not open'}
                            </span>
                        </button>
                    );
                })}
            </div>

            {/* ONE card, for the row the pointer is actually on — never one per row.
                Rendering a card (and therefore a `/screen` poll) per row would fetch the whole
                roster every couple of seconds for a question the user asked about exactly one
                terminal, and the picker is the surface a user opens WHILE agents are running. */}
            {hoveredRow !== null && hovered !== null && (
                <AuTerminalHoverCard row={hoveredRow} anchor={hovered.anchor} />
            )}

            <div className="au-pickbar">
                <span>
                    Watching <span className="au-n">{picked.length}</span>
                </span>
                {/* The breakdown is a claim about the roster, so it waits for one. `open` and `gone`
                    are counted against `rows`, and `rows` is empty both while the list is loading
                    and when reading it FAILED — so a rule watching three terminals rendered
                    "0 open, 3 not open right now" directly under a banner saying the list could not
                    be read and the rule is still watching them. Two sentences on one screen making
                    opposite claims about the same three terminals. */}
                {picked.length > 0 && loading && <span className="au-picksay">· checking…</span>}
                {picked.length > 0 && !loading && error !== null && (
                    <span className="au-picksay">· whether they are open is not known right now</span>
                )}
                {picked.length > 0 && !loading && error === null && (
                    <span className="au-picksay">
                        · {open} open{gone > 0 ? `, ${gone} not open right now` : ''}
                    </span>
                )}
                <span className="au-grow" />
                <button
                    type="button"
                    className="au-btn sm"
                    // Select-all over the LIVE rows only. Ticking a closed terminal the user has
                    // never chosen would pin a dead id on their behalf — the one thing this screen
                    // warns about — and they can still tick it by hand if they mean it.
                    onClick={() => onSet(Array.from(new Set([...picked, ...rows.filter((r) => r.alive).map((r) => r.terminalId)])))}
                >
                    Select all
                </button>
                <button type="button" className="au-btn sm" onClick={() => onSet([])}>
                    None
                </button>
            </div>

            <div className="au-fhelp">
                A terminal that closes keeps its tick, greyed. The rule keeps running on the others
                and says so on its row; it starts watching that id again only if the terminal comes
                back — session restore brings ids back, closing a tab for good does not. Untick it
                here to drop the id, or use <b>Forget it</b> on the automation&apos;s own row in the
                list, which drops every dead id it is holding at once.
            </div>
        </div>
    );
};
