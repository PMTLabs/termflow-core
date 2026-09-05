/**
 * @jest-environment jsdom
 *
 * **The picker had no test at all**, which is how a table whose entire job is telling terminals
 * apart shipped with every identifying column ellipsed and no `title` on any of them. The rows, the
 * filter and *Select all* had no direct coverage either; they get it here alongside the hover card,
 * because they are the same component and a second file would pay the same setup twice.
 *
 * The three claims that matter, and the mutation each is written to kill:
 *
 * 1. **Identity is reachable without the card.** Delete the row's `title` and case 1 fails. This is
 *    the half that has to work when the snapshot never resolves, when the pointer is a keyboard,
 *    and when a screen reader is doing the reading.
 * 2. **The card shows every field the roster carries**, including `shell` and `pid`, which the
 *    editor has always fetched and never displayed. Drop any one `Field` and its case fails.
 * 3. **One row is fetched, and it is the hovered one.** Prefetching the roster — the obvious
 *    "make it feel instant" change — makes the `/snapshot` poll scale with the number of open
 *    terminals on a screen a user opens *while agents are running*. The assertion is over the whole
 *    call list, not over `toHaveBeenCalledWith`, because the latter passes for a mutant that fetches
 *    the hovered row AND everything else.
 *
 * 4. **A fetch still in flight when the pointer moves on must not land.** One card follows the
 *    pointer, so moving from one row to the next does NOT remount it — it re-runs an effect on a
 *    live component. A slow row resolving into that paints the previous terminal's screen under the
 *    new terminal's NAME, which is the single mistake this whole card exists to prevent, and the
 *    `cancelled` check after the `await` is all that stands between them.
 * 5. **The poll stops with the hover, and the cache does not grow for the life of the window.**
 *    Both failures are invisible at runtime — a leaked timer and an immortal `Map` look exactly
 *    like a working card — so both are asserted by COUNTING. Never by watching for a warning:
 *    React 18 removed the setState-after-unmount warning and this repo is on 19, so a
 *    `console.error` spy is green for every mutant there is, which is what the assertion that used
 *    to stand here was.
 * 6. **The refresh cadence belongs to the CACHE, not to the poll interval.** `AU_PREVIEW_POLL_MS`
 *    is how often the tick wakes up; `SNAPSHOT_TTL_MS` is how often it is allowed to do anything.
 *
 * A dead row is asserted separately: it has no process, so an empty preview box would be
 * indistinguishable from a failed fetch on exactly the row the picker keeps around to explain
 * itself.
 */
import fs from 'fs';
import path from 'path';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AuTerminalPicker } from '../AuTerminalPicker';
import {
    AU_HOVER_MAX_H,
    AU_HOVER_W,
    AU_PREVIEW_POLL_MS,
    hoverCardPosition,
    previewFor,
    previewLines,
} from '../AuTerminalHoverCard';
import type { Preview } from '../AuTerminalHoverCard';
import { SNAPSHOT_TTL_MS } from '../../Canvas/snapshotCache';
import type { WatchableTerminal } from '../../../types/electron';

/**
 * The card's own stylesheet, as text.
 *
 * jsdom links no stylesheet and computes no styles, so a CSS contract can only be asserted by
 * reading the source — the technique `auNodeTwoLineValue.test.tsx` uses on the two-line clamp. The
 * reader is repeated here rather than shared: a helper module imported by two suites would be a
 * third file to keep in step, for six lines of `indexOf`.
 */
const CSS = fs.readFileSync(path.join(__dirname, '..', 'AutomationEditor.css'), 'utf8');
function ruleBody(selector: string): string {
    const at = CSS.indexOf(`${selector} {`);
    expect(at).toBeGreaterThanOrEqual(0);
    const open = CSS.indexOf('{', at);
    return CSS.slice(open + 1, CSS.indexOf('}', open));
}

const ESC = '\x1b';

/**
 * Unique ids PER TEST, and the reason is the snapshot cache.
 *
 * `AuTerminalHoverCard` keeps a module-level `SnapshotCache` with a TTL, which is the point of it —
 * running the pointer down and back up the list must not refetch. That cache outlives a test, so a
 * second test hovering `pc-alive` would be served from the first test's entry and assert nothing
 * about fetching at all: a vacuously green test whose subject was never called. Fresh ids per test
 * mean every case exercises a real fetch.
 */
let seq = 0;
function rows(): { live: WatchableTerminal; other: WatchableTerminal; dead: WatchableTerminal } {
    seq += 1;
    return {
        live: {
            terminalId: `tm-alive-${seq}-0f3a91`,
            processId: `pc-alive-${seq}`,
            label: 'claude · api server',
            shell: 'pwsh',
            pid: 4242,
            cwd: 'D:/sources/work/termflow/termflow-core',
            alive: true,
        },
        other: {
            terminalId: `tm-other-${seq}-77b2c4`,
            processId: `pc-other-${seq}`,
            label: 'codex',
            shell: 'bash',
            pid: 913,
            cwd: 'D:/sources/work/termflow/termflow-fabric',
            alive: true,
        },
        dead: {
            terminalId: `tm-gone-${seq}-5ce180`,
            processId: null,
            label: 'gemini',
            shell: null,
            pid: null,
            cwd: 'D:/sources/work/old-checkout',
            alive: false,
        },
    };
}

const SCREEN = [
    'PS D:\\sources> bun run dev',
    '  ready in 812 ms',
    // A two-column row: the shape `/snapshot`'s replay blob encodes as cursor motion, so the gap
    // vanishes the moment anything strips escapes out of that blob instead of reading the grid.
    'NAME                STATUS',
    '',
    'PS D:\\sources> ',
    '',
    '',
].join('\r\n');

interface Api {
    getTerminalScreenText: jest.Mock;
}

/**
 * `/screen`, not `/snapshot` — and the fixture is PLAIN text with no escapes in it, because that
 * is what the route serves.
 *
 * The card read `/snapshot` first and stripped the escapes out of the blob in the client, which
 * collapses column layout: that blob encodes runs of blanks as cursor motion rather than as
 * spaces. This mock returning plain text is what makes the alignment case below assert anything at
 * all — handed a mock that fabricated its own aligned blob, the test would pass over the bug.
 */
function screenBody(id: string, screen: string = SCREEN) {
    return { terminalId: id, screen, rows: 24, cols: 80 };
}

function installApi(): Api {
    const api: Api = {
        getTerminalScreenText: jest.fn((id: string) => Promise.resolve(screenBody(id))),
    };
    (window as unknown as { electronAPI: Api }).electronAPI = api;
    return api;
}

describe('the terminal picker', () => {
    let container: HTMLDivElement;
    let root: Root;
    let api: Api;

    beforeAll(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        api = installApi();
    });

    afterEach(async () => {
        // Before the unmount, not after: a test that left fake timers installed would otherwise
        // hand React a clock nothing is advancing, and `act` would wait on a timer that never fires.
        jest.useRealTimers();
        await act(async () => root.unmount());
        container.remove();
        document.querySelectorAll('.au-hovcard').forEach((n) => n.remove());
        jest.clearAllMocks();
    });

    const settle = () => act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    /** The same, under fake timers: advance the clock AND drain what the clock released. */
    const advance = (ms: number) => act(async () => {
        await jest.advanceTimersByTimeAsync(ms);
    });

    async function show(list: WatchableTerminal[], picked: string[] = []) {
        const onToggle = jest.fn();
        const onSet = jest.fn();
        await act(async () => {
            root.render(
                <AuTerminalPicker
                    rows={list}
                    picked={picked}
                    error={null}
                    loading={false}
                    onToggle={onToggle}
                    onSet={onSet}
                />,
            );
        });
        return { onToggle, onSet };
    }

    const rowFor = (id: string) =>
        [...container.querySelectorAll<HTMLButtonElement>('.au-tpickrow')].find(
            (b) => b.querySelector('.au-idchip')?.textContent === id,
        )!;

    const card = () => document.querySelector('.au-hovcard');

    /**
     * React derives `onMouseEnter` from a `mouseover` whose `relatedTarget` is outside the row, and
     * `onMouseLeave` from a `mouseout` pointing at where the pointer went — there is no `mouseenter`
     * event to dispatch. `document.body` stands in for "somewhere else on the page".
     */
    const hover = async (el: HTMLElement) => {
        await act(async () => {
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
        });
    };
    const unhover = async (el: HTMLElement) => {
        await act(async () => {
            el.dispatchEvent(
                new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
            );
        });
    };
    /** A move WITHIN a row — no enter, no leave, which is the whole point of it. */
    const move = async (el: HTMLElement) => {
        await act(async () => {
            el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        });
    };

    /** A row's box, as `getBoundingClientRect` would return it. jsdom returns all zeroes for every
     *  element, so a test about placement has to supply its own. */
    const boxAt = (top: number): DOMRect => ({
        top, bottom: top + 28, left: 600, right: 940, x: 600, y: top, width: 340, height: 28,
        toJSON: () => ({}),
    });

    // --- 1. the baseline, which owes nothing to the card ------------------------------------------

    it('puts the full id, name and folder on every row as a title', async () => {
        const r = rows();
        await show([r.live, r.dead]);

        const live = rowFor(r.live.terminalId).getAttribute('title') ?? '';
        expect(live).toContain(r.live.terminalId);
        expect(live).toContain(r.live.label!);
        expect(live).toContain(r.live.cwd!);
        expect(live).toContain('open');

        // The dead row's name and folder come from the rule's own snapshot and are the only thing
        // that can describe an id that is gone — so they belong in the title too.
        const dead = rowFor(r.dead.terminalId).getAttribute('title') ?? '';
        expect(dead).toContain(r.dead.terminalId);
        expect(dead).toContain(r.dead.label!);
        expect(dead).toContain(r.dead.cwd!);
        expect(dead).toContain('not open');
    });

    // --- 2. the card ------------------------------------------------------------------------------

    it('shows nothing until a row is hovered', async () => {
        const r = rows();
        await show([r.live, r.other]);
        expect(card()).toBeNull();
    });

    it('reveals every field the roster carries when a row is hovered', async () => {
        const r = rows();
        await show([r.live, r.other]);
        await hover(rowFor(r.live.terminalId));

        const text = card()!.textContent ?? '';
        expect(text).toContain(r.live.terminalId);
        expect(text).toContain(r.live.label!);
        expect(text).toContain(r.live.cwd!);
        // The two the editor fetched and displayed nowhere before this change.
        expect(text).toContain('pwsh');
        expect(text).toContain('4242');
        expect(text).toContain('open');

        // …and it describes THIS row, not whichever row happens to be first.
        expect(text).not.toContain(r.other.terminalId);
        expect(text).not.toContain(r.other.label!);
    });

    it('follows the pointer from one row to the next, and closes when it leaves', async () => {
        const r = rows();
        await show([r.live, r.other]);

        await hover(rowFor(r.live.terminalId));
        expect(card()!.textContent).toContain(r.live.terminalId);

        await unhover(rowFor(r.live.terminalId));
        await hover(rowFor(r.other.terminalId));
        expect(card()!.textContent).toContain(r.other.terminalId);
        expect(card()!.textContent).not.toContain(r.live.terminalId);

        await unhover(rowFor(r.other.terminalId));
        expect(card()).toBeNull();
    });

    it('never takes the pointer or the focus', async () => {
        const r = rows();
        await show([r.live]);
        const row = rowFor(r.live.terminalId);
        await hover(row);

        // The card is a portal that sits over the picker; if it could take a click it would shadow
        // the very row it describes, and it could keep itself alive by being hovered. The
        // stylesheet is where that is decided, so that is where it is read from — jsdom computes no
        // `pointer-events`, and the two assertions that used to stand here could not fail: the card
        // was selected BY `.au-hovcard` and then asserted to have that class, and
        // `document.activeElement` was compared against an element nothing ever focuses.
        expect(ruleBody('.au-hovcard')).toMatch(/pointer-events:\s*none\s*;/);
        expect(card()!.getAttribute('tabindex')).toBeNull();
    });

    it('re-reads the row‘s box as the pointer moves over it', async () => {
        const r = rows();
        await show([r.live]);
        const row = rowFor(r.live.terminalId);

        row.getBoundingClientRect = () => boxAt(120);
        await hover(row);
        expect((card() as HTMLElement).style.top).toBe('120px');

        // **The row moves under a pointer that does not.** The picker's list is a 260px scroller
        // and the inspector column scrolls too, so a wheel slides this row while the pointer rests
        // on it — and no fresh `mouseover` fires for an element that never stopped being under the
        // cursor. Read once at `mouseenter`, the card keeps its original client-y and drifts off
        // the row it is naming, which on a card whose only job is identification is the whole bug.
        row.getBoundingClientRect = () => boxAt(60);
        await move(row);
        expect((card() as HTMLElement).style.top).toBe('60px');
    });

    /**
     * **The row moves and the POINTER does not** — a wheel over a stationary cursor, or a window
     * resize.
     *
     * Neither fires a pointer event of any kind: `mouseover` fires when the element under the
     * cursor CHANGES, and a row scrolling beneath a resting pointer is the case where it does not.
     * `.au-tpick` is a 260px scroller and the inspector column it sits in scrolls too, so both are
     * ordinary gestures rather than exotic ones. Held only by the `mousemove` re-read — which is
     * what the comment here used to claim was sufficient — the card keeps its original client-y and
     * slides off the row it is naming.
     *
     * The scroll is dispatched at the SCROLLER, not at `window`, because that is the difference the
     * fix turns on: `scroll` does not bubble, so a bubble-phase listener on `window` would hear
     * nothing at all from here and this test would be the thing that says so.
     */
    it('re-anchors when the row scrolls under a still pointer', async () => {
        const r = rows();
        await show([r.live]);
        const row = rowFor(r.live.terminalId);

        row.getBoundingClientRect = () => boxAt(120);
        await hover(row);
        expect((card() as HTMLElement).style.top).toBe('120px');

        const scroller = container.querySelector('.au-tpick') ?? container;
        row.getBoundingClientRect = () => boxAt(48);
        await act(async () => {
            scroller.dispatchEvent(new Event('scroll'));
        });
        expect((card() as HTMLElement).style.top).toBe('48px');
    });

    it('re-anchors when the window resizes under a still pointer', async () => {
        const r = rows();
        await show([r.live]);
        const row = rowFor(r.live.terminalId);

        row.getBoundingClientRect = () => boxAt(120);
        await hover(row);
        expect((card() as HTMLElement).style.top).toBe('120px');

        row.getBoundingClientRect = () => boxAt(200);
        await act(async () => {
            window.dispatchEvent(new Event('resize'));
        });
        expect((card() as HTMLElement).style.top).toBe('200px');
    });

    /**
     * **And the listeners go when the pointer does.** A card that re-anchors correctly and leaves a
     * pair of window listeners behind per row hovered is the same leak in a different place — and
     * one that would keep calling `getBoundingClientRect` on rows that have been unmounted.
     */
    it('stops listening once the pointer leaves the row', async () => {
        const r = rows();
        await show([r.live]);
        const row = rowFor(r.live.terminalId);
        row.getBoundingClientRect = () => boxAt(120);
        await hover(row);

        await unhover(row);
        expect(card()).toBeNull();

        // Counted rather than inspected: `removeEventListener` is the only observable, and a scroll
        // arriving after the card has gone must reach nothing that would try to re-render it.
        let reads = 0;
        row.getBoundingClientRect = () => { reads += 1; return boxAt(48); };
        await act(async () => {
            window.dispatchEvent(new Event('resize'));
            (container.querySelector('.au-tpick') ?? container).dispatchEvent(new Event('scroll'));
        });
        expect(reads).toBe(0);
    });

    // --- 3. the live preview ----------------------------------------------------------------------

    it('reads the hovered row‘s screen, and no other row‘s', async () => {
        const r = rows();
        await show([r.live, r.other, r.dead]);
        await hover(rowFor(r.live.terminalId));
        await settle();

        const asked = api.getTerminalScreenText.mock.calls.map((c) => c[0]);
        expect(asked.length).toBeGreaterThan(0);
        // The WHOLE call list. `toHaveBeenCalledWith` would pass for a prefetch of every row.
        expect(Array.from(new Set(asked))).toEqual([r.live.processId]);
    });

    it('asks by PROCESS id, which is the id the screen endpoint is keyed by', async () => {
        const r = rows();
        await show([r.live]);
        await hover(rowFor(r.live.terminalId));
        await settle();

        expect(api.getTerminalScreenText).toHaveBeenCalledWith(r.live.processId);
        // `/screen` resolves `tm-` leaves too, so the renderer id would not 404 here the way it
        // does on some neighbouring routes — it would answer about the right terminal by a longer
        // path. Still pinned: the cache this card keeps is keyed by process id, so mixing the two
        // id spaces would give one terminal two entries and halve the cache's hit rate silently.
        expect(api.getTerminalScreenText).not.toHaveBeenCalledWith(r.live.terminalId);
    });

    /**
     * **The preview paints the screen's own column layout, not a re-flowed version of it.**
     *
     * `toContain('bun run dev')` — which is all this asserted while the card read `/snapshot` and
     * stripped the escapes itself — is satisfied by a preview that has run every column together,
     * because the words survive and only the SPACES between them are lost. The gap is the thing
     * under test, so the gap is what is asserted, by exact string.
     */
    it('paints the last lines of that screen, with its columns still apart', async () => {
        const r = rows();
        await show([r.live]);
        await hover(rowFor(r.live.terminalId));
        await settle();

        const pre = card()!.querySelector('.au-hovprev pre');
        expect(pre).not.toBeNull();
        expect(pre!.textContent).toContain('bun run dev');
        expect(pre!.textContent).toContain('NAME                STATUS');
        expect(pre!.textContent).not.toContain('NAMESTATUS');
        expect(pre!.textContent).not.toContain(ESC);
    });

    it('says a closed terminal is closed, instead of showing an empty preview', async () => {
        const r = rows();
        await show([r.live, r.dead]);
        await hover(rowFor(r.dead.terminalId));
        await settle();

        const text = card()!.textContent ?? '';
        expect(text).toContain(r.dead.terminalId);
        expect(text).toContain('not open');
        expect(text).toMatch(/no screen to show/i);
        // The box itself must be absent, not empty: an empty one reads as a fetch that failed.
        expect(card()!.querySelector('.au-hovprev')).toBeNull();
        // And nothing was asked of the API, because there is no process to ask about.
        expect(api.getTerminalScreenText).not.toHaveBeenCalled();
    });

    it('survives a fetch that fails, and says so instead of showing an empty box', async () => {
        const r = rows();
        api.getTerminalScreenText.mockRejectedValueOnce(new Error('the API said no'));
        await show([r.live]);

        await hover(rowFor(r.live.terminalId));
        await settle();
        expect(card()!.textContent).toMatch(/could not be read/i);
    });

    /**
     * **The pointer moves on while a row is still answering.**
     *
     * There is ONE card, at one position in the tree, so moving from row to row updates its props —
     * it does not unmount. `AuTerminalPreview`'s effect re-runs on the new `processId`, and the old
     * closure's in-flight fetch is still coming. Without the `cancelled` check after the `await` it
     * calls `setAnsi` with the OLD terminal's screen into a card that is now showing the NEW
     * terminal's id, name and folder: the exact "which of these two is which" answer this card
     * exists to give, given wrong, on a component that is alive and rendering.
     *
     * Nothing warns about this and nothing throws. The screens are keyed to their process ids here
     * for that reason — the assertion has to be able to tell one screen from the other.
     */
    it('does not paint a slow row‘s screen under the next row‘s name', async () => {
        const r = rows();
        api.getTerminalScreenText.mockImplementation((id: string) =>
            Promise.resolve(screenBody(id, `on screen: ${id}`)));
        let release: (v: unknown) => void = () => {};
        // The FIRST call — the hovered row's — hangs. `mockImplementationOnce` is consumed in call
        // order, and the first call is `live`'s, because that is the row hovered first.
        api.getTerminalScreenText.mockImplementationOnce(
            () => new Promise((resolve) => { release = resolve; }),
        );
        await show([r.live, r.other]);

        await hover(rowFor(r.live.terminalId));
        await settle();
        // Straight to the next row, with no `mouseout` in between: the card is updated, not remade.
        await hover(rowFor(r.other.terminalId));
        await settle();
        expect(card()!.textContent).toContain(`on screen: ${r.other.processId}`);

        await act(async () => {
            release(screenBody(r.live.processId, `on screen: ${r.live.processId}`));
        });
        await settle();

        const text = card()!.textContent ?? '';
        expect(text).toContain(r.other.terminalId);
        expect(text).toContain(`on screen: ${r.other.processId}`);
        expect(text).not.toContain(`on screen: ${r.live.processId}`);
    });

    /**
     * **The poll is armed while the pointer is on the row, and goes with it.**
     *
     * Counted, not warned about: React 18 removed the setState-after-unmount warning and this repo
     * is on 19, so the `console.error` spy that used to stand here was green for every mutant there
     * is. A timer is the thing that can actually be counted, and both directions matter — a card
     * that arms nothing shows one frame and then a screen that never updates again, and a card that
     * leaves one armed leaves it running for the life of the window with nothing holding its
     * handle.
     */
    it('arms the poll while the pointer is on the row, and clears it when the pointer leaves', async () => {
        jest.useFakeTimers();
        const r = rows();
        await show([r.live]);

        await hover(rowFor(r.live.terminalId));
        await advance(0);
        expect(api.getTerminalScreenText).toHaveBeenCalledTimes(1);
        // Counted straight after an `advance(0)`, both times. `act` and the fake-timer
        // helper leave 0ms timers of their own behind, so an absolute count is only
        // readable at a point where those have just been drained — and the poll, at 700ms,
        // is never one of the ones a zero-length advance drains.
        expect(jest.getTimerCount()).toBe(1);

        await unhover(rowFor(r.live.terminalId));
        await advance(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    /**
     * **And a fetch that lands after the pointer has gone starts nothing.**
     *
     * The ordinary case, not an edge one: the pointer crosses rows far faster than a round trip
     * settles. What has to hold is end-to-end — a card that is gone never asks again — rather than
     * any one of the three `cancelled` checks that implement it between them.
     */
    it('a fetch resolving after the pointer has gone asks nothing more', async () => {
        jest.useFakeTimers();
        const r = rows();
        let release: (v: unknown) => void = () => {};
        api.getTerminalScreenText.mockImplementationOnce(
            () => new Promise((resolve) => { release = resolve; }),
        );
        await show([r.live]);

        await hover(rowFor(r.live.terminalId));
        await advance(0);
        expect(api.getTerminalScreenText).toHaveBeenCalledTimes(1);

        await unhover(rowFor(r.live.terminalId));
        await act(async () => {
            release(screenBody(r.live.processId));
        });
        await advance(0);

        expect(card()).toBeNull();
        expect(jest.getTimerCount()).toBe(0);
        // And nothing wakes up later either, however long the window stays open.
        await advance(AU_PREVIEW_POLL_MS * 6 + SNAPSHOT_TTL_MS);
        expect(api.getTerminalScreenText).toHaveBeenCalledTimes(1);
    });

    /**
     * **What the preview's cadence actually is.**
     *
     * `AU_PREVIEW_POLL_MS` is how often the tick wakes up, not how often the screen is re-read: the
     * tick asks `previewCache.shouldRefresh` first, and that gate is `SNAPSHOT_TTL_MS`. So the real
     * cadence is the first wakeup PAST the TTL, and the constant's comment used to claim the
     * opposite — that the card re-read faster than Canvas Mode's 2s TTL, which the cache it shares
     * that TTL with never allowed. Both numbers are derived here rather than typed, so tuning
     * either one keeps this test honest instead of breaking it.
     */
    it('refreshes on the cache‘s TTL, not on the poll interval', async () => {
        jest.useFakeTimers();
        const r = rows();
        await show([r.live]);
        await hover(rowFor(r.live.terminalId));
        await advance(0);
        expect(api.getTerminalScreenText).toHaveBeenCalledTimes(1);

        // The cadence is the first wakeup at or past the TTL: `ceil(2000 / 700) * 700` = 2100ms.
        const cadence = Math.ceil(SNAPSHOT_TTL_MS / AU_PREVIEW_POLL_MS) * AU_PREVIEW_POLL_MS;

        // Every wakeup strictly inside that finds the entry fresh and does nothing. A tick that
        // fetched on its own schedule — the cadence this constant used to claim — is two extra
        // round trips by here.
        await advance(cadence - AU_PREVIEW_POLL_MS);
        expect(api.getTerminalScreenText).toHaveBeenCalledTimes(1);

        await advance(AU_PREVIEW_POLL_MS);
        expect(api.getTerminalScreenText).toHaveBeenCalledTimes(2);
    });

    /**
     * **The preview cache is bounded by the roster, not by the session.**
     *
     * It is module-level and keyed by PROCESS id — the id that churns, since a terminal closed and
     * reopened is a new one — so without eviction every screen the pointer ever crossed was held,
     * full styled ANSI blob and all, until the window closed. Nothing about that is visible on
     * screen, which is why it has to be counted: the cache is doing its job in both cases, and the
     * only difference is whether it is still doing it for terminals that no longer exist.
     *
     * `Date.now` is frozen so the TTL cannot expire on its own. The second hover is the control —
     * it proves the cache still IS a cache — and the fourth is the claim.
     */
    it('forgets the preview of a terminal that has left the roster', async () => {
        const clock = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        try {
            const r = rows();
            await show([r.live, r.other]);
            await hover(rowFor(r.live.terminalId));
            await settle();
            expect(api.getTerminalScreenText).toHaveBeenCalledTimes(1);

            // Control: re-hovering inside the TTL is served from the cache and asks nothing.
            await unhover(rowFor(r.live.terminalId));
            await hover(rowFor(r.live.terminalId));
            await settle();
            expect(api.getTerminalScreenText).toHaveBeenCalledTimes(1);

            // The terminal closes and drops off the roster…
            await unhover(rowFor(r.live.terminalId));
            await show([r.other]);
            // …and comes back under the same id, which is exactly what session restore does.
            await show([r.live, r.other]);
            await hover(rowFor(r.live.terminalId));
            await settle();
            expect(api.getTerminalScreenText).toHaveBeenCalledTimes(2);
        } finally {
            clock.mockRestore();
        }
    });

    // --- 4. the rows themselves, which had no coverage at all --------------------------------------

    it('filters by id, name or folder, and ticking a row reports the id', async () => {
        const r = rows();
        const { onToggle } = await show([r.live, r.other]);
        expect(container.querySelectorAll('.au-tpickrow')).toHaveLength(2);

        const filter = container.querySelector<HTMLInputElement>('input[aria-label="Filter terminals"]')!;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value',
            )!.set!;
            setter.call(filter, 'termflow-fabric');
            filter.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(container.querySelectorAll('.au-tpickrow')).toHaveLength(1);

        await act(async () => rowFor(r.other.terminalId).click());
        expect(onToggle).toHaveBeenCalledWith(r.other.terminalId);
    });

    it('select-all takes the live rows and leaves the dead one alone', async () => {
        const r = rows();
        const { onSet } = await show([r.live, r.other, r.dead]);
        const all = [...container.querySelectorAll<HTMLButtonElement>('.au-btn.sm')].find(
            (b) => b.textContent === 'Select all',
        )!;
        await act(async () => all.click());
        // Ticking a closed terminal on the user's behalf pins a dead id they never chose — the one
        // thing this screen's own help text warns about.
        expect(onSet).toHaveBeenCalledWith([r.live.terminalId, r.other.terminalId]);
    });

    // --- 5. the placement clamp, which has no DOM to be read from ----------------------------------

    /**
     * `getBoundingClientRect()` is all zeroes in jsdom, so every DOM-driven assertion about where
     * this card lands is vacuous. The function is pure and exported for exactly that reason.
     */
    describe('hoverCardPosition', () => {
        const view = { width: 1400, height: 900 };

        it('opens to the LEFT of the row, because the picker is the right-hand column', () => {
            const at = hoverCardPosition({ top: 300, left: 1000, right: 1330 }, view);
            expect(at.left + AU_HOVER_W).toBeLessThanOrEqual(1000);
            expect(at.top).toBe(300);
        });

        it('flips to the right when the left side has no room', () => {
            const at = hoverCardPosition({ top: 100, left: 40, right: 380 }, view);
            expect(at.left).toBeGreaterThanOrEqual(380);
        });

        it('never leaves the viewport, in either axis', () => {
            const offRight = hoverCardPosition({ top: 10, left: 20, right: 1390 }, view);
            expect(offRight.left).toBeGreaterThanOrEqual(0);
            expect(offRight.left + AU_HOVER_W).toBeLessThanOrEqual(view.width);

            const offBottom = hoverCardPosition({ top: 880, left: 1000, right: 1330 }, view);
            expect(offBottom.top).toBeGreaterThan(0);
            expect(offBottom.top + AU_HOVER_MAX_H).toBeLessThanOrEqual(view.height);
        });

        it('pins to the left edge rather than off it on a window narrower than the card', () => {
            const at = hoverCardPosition({ top: 10, left: 5, right: 200 }, { width: 240, height: 400 });
            expect(at.left).toBeGreaterThanOrEqual(0);
        });
    });

    // --- 6. what "a few lines of the screen" means -------------------------------------------------

describe('previewFor', () => {
        /**
         * **A screen that belongs to another terminal is never painted, not even for one frame.**
         *
         * Moving the pointer from row A to row B changes the card's props, and the identity block
         * repaints from those props IN THAT RENDER. Anything the preview held in its own state was
         * still A's until something updated it — so a preview keeping a bare screen string and
         * resetting it from an effect painted B's id, name and folder over A's screen and corrected
         * itself on the next tick. One frame, no error, no warning, and precisely the wrong answer
         * to the only question this card exists to answer.
         *
         * **Asserted here rather than through the DOM, and that is not for want of trying.** The
         * bad frame is a commit, not a settled state: by the time `act` returns, the effect has put
         * it right, so every end-state assertion is identical for both implementations. A
         * `MutationObserver` is served the corrected DOM (its callback is a microtask), and
         * `flushSync` does not force the continuous-priority update a `mouseover` schedules. Both
         * were written, and both passed against the broken component — which is why the invariant
         * now lives in a function that takes its inputs as arguments.
         */
        const of = (processId: string, screen: string | null): Preview =>
            ({ processId, screen, failed: false });

        it('discards a screen belonging to a different terminal', () => {
            expect(previewFor(of('pc-a', 'A is on screen'), 'pc-b').screen).toBeNull();
            // The id travels with it: a `Preview` that kept A's id would fail the same comparison
            // on the very next render and re-seed for ever.
            expect(previewFor(of('pc-a', 'A is on screen'), 'pc-b').processId).toBe('pc-b');
        });

        it('keeps the screen that does belong to this terminal', () => {
            const mine = of('pc-a', 'A is on screen');
            // By identity: re-seeding a value that was already correct would drop a fetched screen
            // on every render and leave the card fetching for ever.
            expect(previewFor(mine, 'pc-a')).toBe(mine);
        });

        it('clears a failure recorded against a different terminal', () => {
            const failed: Preview = { processId: 'pc-a', screen: null, failed: true };
            // Otherwise the row the pointer has just arrived at inherits "could not be read" from
            // the row it left — the same mis-attribution wearing the error message instead of the
            // screen.
            expect(previewFor(failed, 'pc-b').failed).toBe(false);
        });
    });

        describe('previewLines', () => {
        it('drops the blank tail of the grid before taking the last lines', () => {
            // A vt100 screen is a fixed grid, so its tail is padding. Taking the last six ROWS of an
            // 80x24 snapshot shows six blank lines under a prompt that is still on screen.
            expect(previewLines('a\nb\nc\n\n\n\n\n')).toEqual(['a', 'b', 'c']);
        });

        it('keeps only the last `limit` lines', () => {
            expect(previewLines('1\n2\n3\n4', 2)).toEqual(['3', '4']);
        });

        it('drops the CR of a CRLF pair, and every other trailing blank', () => {
            expect(previewLines('red   \r\nplain\r\n')).toEqual(['red', 'plain']);
        });

        /**
         * **It does not strip escapes, and that is the point rather than an omission.**
         *
         * It used to run `stripAnsi`, back when the card read `/snapshot`. Against `/screen`'s
         * plain grid text that call is a no-op — and a no-op that invites the next reader to point
         * the fetch back at the replay blob, where stripping is not a no-op but a silent loss of
         * every column gap. Pinned so that reintroducing the strip fails here rather than passing
         * quietly.
         */
        it('leaves interior spacing alone — the column gaps ARE the content', () => {
            expect(previewLines('NAME     STATUS\nbuild    ok')).toEqual([
                'NAME     STATUS',
                'build    ok',
            ]);
        });
    });
});
