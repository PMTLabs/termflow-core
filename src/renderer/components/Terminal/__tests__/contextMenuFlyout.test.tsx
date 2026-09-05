/**
 * @jest-environment jsdom
 *
 * The flyout submenu inside the terminal context menu (design 029 §4).
 *
 * Three traps decide the whole shape of this component, and all three are pinned here:
 *
 *  1. **The flyout must live INSIDE the menu container.** `ContextMenu` closes on
 *     any `mousedown` whose target is not inside `menuRef` — a flyout portalled to
 *     `document.body` is "outside" by that test, so the very first press on a
 *     flyout row would close the whole menu before the click landed. The
 *     `does not close the menu` test below is the regression that catches it.
 *  2. **`ContextMenu` runs `item.click?.(); onClose();` on every item.** A submenu
 *     parent has to toggle its flyout *instead of* closing the menu, so the click
 *     handler must branch before that `onClose()`.
 *  3. **…and it must live outside the SCROLLING LIST.** `.context-menu-flyout-list`
 *     is `overflow-y:auto`, so a nested panel rendered inside a row of that list is
 *     clipped at the list box by every real engine. Trap 1 and trap 3 pull in
 *     opposite directions, which is why placement is asserted structurally below.
 *
 * Repo convention: no React Testing Library (the installed v13 predates React 19),
 * so this drives a real DOM render through `react-dom/client` inside `act()`.
 */
import * as path from 'path';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { readSource } from '../../../utils/readSource';

// jest has no CSS transform (the moduleNameMapper stub covers it too, but the
// explicit mock keeps this file readable next to the other component suites).
jest.mock('../ContextMenu.css', () => ({}));

// eslint-disable-next-line import/first
import { ContextMenu, ContextMenuItem, ContextMenuFlyoutRow } from '../ContextMenu';

let container: HTMLDivElement;
let root: Root;
let onClose: jest.Mock;

beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onClose = jest.fn();
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    jest.restoreAllMocks();
});

async function render(items: ContextMenuItem[]) {
    await act(async () => {
        root.render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />);
    });
}

/* ── DOM queries ──────────────────────────────────────────────────────────── */

const menu = () => document.querySelector<HTMLElement>('.context-menu')!;
const menuItems = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu-item'));
const menuItem = (label: string) =>
    menuItems().find((b) => b.textContent?.includes(label))!;

const panels = () => Array.from(document.querySelectorAll<HTMLElement>('.context-menu-flyout'));
const panel = (depth = 0) =>
    document.querySelector<HTMLElement>(`.context-menu-flyout[data-flyout-depth="${depth}"]`);
const search = (depth = 0) =>
    panel(depth)!.querySelector<HTMLInputElement>('.context-menu-flyout-search')!;
/** Rows of ONE panel — `:scope >` keeps a nested panel's rows out of the list. */
const rows = (depth = 0) =>
    Array.from(
        panel(depth)!.querySelectorAll<HTMLButtonElement>(
            ':scope > .context-menu-flyout-list > .context-menu-flyout-item > .context-menu-flyout-row',
        ),
    );
const labels = (depth = 0) =>
    rows(depth).map((r) => r.querySelector('.context-menu-flyout-label')!.textContent);
const activeIndex = (depth = 0) => rows(depth).findIndex((r) => r.classList.contains('is-active'));

/* ── Event helpers ────────────────────────────────────────────────────────── */

const fire = async (el: EventTarget, ev: Event) => {
    await act(async () => {
        el.dispatchEvent(ev);
    });
};
const click = (el: EventTarget) => fire(el, new MouseEvent('click', { bubbles: true }));
/**
 * Move the pointer onto `el`, coming from `from`.
 *
 * React synthesizes mouseenter/mouseleave from a delegated `mouseover`, using
 * `relatedTarget` to work out which elements were entered and which were left. A null
 * `from` therefore reads as "the pointer came from outside the document" and fires
 * enter on `el` AND every ancestor - which is what entering a submenu host from
 * off-menu does in a browser. Passing the previously-hovered element is what makes
 * "moved from one item to another" distinguishable from "arrived".
 */
const hoverMove = (el: EventTarget, from: EventTarget | null) =>
    from === null
        ? { on: el, ev: new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }) }
        // React IGNORES a `mouseover` whose relatedTarget is inside a React tree: it
        // expects the paired `mouseout` to carry an intra-tree move, and handles the
        // whole enter/leave pair from that one event. Dispatching `mouseover` here
        // instead is a silent no-op, which looks exactly like a handler that is missing.
        : { on: from, ev: new MouseEvent('mouseout', { bubbles: true, relatedTarget: el as EventTarget }) };
const hover = (el: EventTarget, from: EventTarget | null = null) => {
    const { on, ev } = hoverMove(el, from);
    return fire(on, ev);
};
/** Synchronous twin, for the fake-timer suite: React's async `act` flushes through
 *  timer APIs that `jest.useFakeTimers()` has replaced, and can hang there. */
const hoverSync = (el: EventTarget, from: EventTarget | null = null) => {
    const { on, ev } = hoverMove(el, from);
    act(() => {
        on.dispatchEvent(ev);
    });
};
const mousedown = (el: EventTarget) =>
    fire(el, new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
const key = (el: EventTarget, k: string) =>
    fire(el, new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

/** React owns the input's value, so a plain assignment is invisible to it. */
const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
};

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const row = (id: string, label: string, extra: Partial<ContextMenuFlyoutRow> = {}): ContextMenuFlyoutRow => ({
    id,
    label,
    ...extra,
});

/** A menu with one plain item and one submenu parent. */
function menuWith(
    submenu: ContextMenuItem['submenu'],
    plainClick = jest.fn(),
): ContextMenuItem[] {
    return [
        { label: 'Copy', icon: '📋', click: plainClick },
        { type: 'separator' },
        { label: 'Snippets', icon: '✂️', submenu },
    ];
}

/* ── Trap 2: the parent item toggles, it does not close ───────────────────── */

describe('submenu parent item', () => {
    it('opens the flyout and does NOT close the menu', async () => {
        const onSelect = jest.fn();
        await render(menuWith({ rows: [row('a', 'kubectl get pods', { onSelect })] }));

        expect(panels()).toHaveLength(0);
        await click(menuItem('Snippets'));

        expect(panels()).toHaveLength(1);
        expect(labels()).toEqual(['kubectl get pods']);
        // Trap 2 — `item.click?.(); onClose();` must not run for a submenu parent.
        expect(onClose).not.toHaveBeenCalled();
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('never calls the parent item click handler', async () => {
        const parentClick = jest.fn();
        await render([{ label: 'Snippets', click: parentClick, submenu: { rows: [row('a', 'x')] } }]);
        await click(menuItem('Snippets'));
        expect(parentClick).not.toHaveBeenCalled();
    });

    it('opens on HOVER, with no click at all', async () => {
        await render(menuWith({ rows: [row('a', 'kubectl get pods')] }));
        expect(panels()).toHaveLength(0);
        await hover(menuItem('Snippets'));
        expect(panels()).toHaveLength(1);
        expect(labels()).toEqual(['kubectl get pods']);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('a click on the parent OPENS it and never toggles it shut', async () => {
        // Hover has already opened the panel by the time any click can land, so a
        // toggling click would make "click the item you are pointing at" the gesture
        // that HIDES the thing you were reaching for.
        await render(menuWith({ rows: [row('a', 'x')] }));
        await hover(menuItem('Snippets'));
        expect(panels()).toHaveLength(1);
        await click(menuItem('Snippets'));
        expect(panels()).toHaveLength(1);
        await click(menuItem('Snippets'));
        expect(panels()).toHaveLength(1);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('does not open a flyout when a DISABLED parent is hovered', async () => {
        await render([{ label: 'Snippets', enabled: false, submenu: { rows: [row('a', 'x')] } }]);
        await hover(menuItem('Snippets'));
        expect(panels()).toHaveLength(0);
    });

    it('fires onOpen ONCE across a hover followed by a click', async () => {
        // The hover handler is idempotent on purpose: the host's mouseenter fires again
        // every time the pointer comes back from a neighbouring item, and onOpen is a
        // cache warm (ensureDirLoaded), not a render hook.
        const onOpen = jest.fn();
        await render(menuWith({ rows: [row('a', 'x')], onOpen }));
        await hover(menuItem('Snippets'));
        await click(menuItem('Snippets'));
        await hover(menuItem('Snippets'), menuItem('Copy'));
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('keeps only ONE flyout open — opening a second closes the first', async () => {
        await render([
            { label: 'Command History', submenu: { searchPlaceholder: 'history…', rows: [row('h', 'ls -la')] } },
            { label: 'Snippets', submenu: { searchPlaceholder: 'snippets…', rows: [row('s', 'docker ps')] } },
        ]);

        await click(menuItem('Command History'));
        expect(panels()).toHaveLength(1);
        expect(search().placeholder).toBe('history…');

        await click(menuItem('Snippets'));
        expect(panels()).toHaveLength(1);
        expect(search().placeholder).toBe('snippets…');
        expect(labels()).toEqual(['docker ps']);
    });

    it('does not open a flyout for a disabled parent', async () => {
        await render([{ label: 'Snippets', enabled: false, submenu: { rows: [row('a', 'x')] } }]);
        await click(menuItem('Snippets'));
        expect(panels()).toHaveLength(0);
    });

    it('fires onOpen once, when the flyout opens', async () => {
        const onOpen = jest.fn();
        await render(menuWith({ rows: [row('a', 'x')], onOpen }));
        expect(onOpen).not.toHaveBeenCalled();
        await click(menuItem('Snippets'));
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('leaves the three existing plain-item call sites untouched', async () => {
        const plainClick = jest.fn();
        await render(menuWith({ rows: [row('a', 'x')] }, plainClick));
        await click(menuItem('Copy'));
        expect(plainClick).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

/* -- hover: retiring the flyout again ------------------------------------- */

/**
 * The delay is the whole subtlety of hover-to-open, so it is asserted rather than
 * described: a panel hangs at `left: 100%` of its item, so the pointer's route into it
 * crosses the items BELOW that one. Closing on the first foreign hover would tear the
 * panel down mid-reach; never closing would leave it up over an unrelated item.
 */
describe('hovering away', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        // Runs BEFORE the outer afterEach (inner hooks first), so the unmount there
        // happens on real timers.
        jest.useRealTimers();
    });

    const renderSync = (items: ContextMenuItem[]) => {
        act(() => {
            root.render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />);
        });
    };
    const tick = (ms: number) => {
        act(() => {
            jest.advanceTimersByTime(ms);
        });
    };

    it('closes the flyout once the pointer has sat on a plain item', () => {
        renderSync(menuWith({ rows: [row('a', 'x')] }));
        hoverSync(menuItem('Snippets'));
        expect(panels()).toHaveLength(1);

        hoverSync(menuItem('Copy'), menuItem('Snippets'));
        // NOT yet: crossing an item on the way to the panel must not be enough.
        expect(panels()).toHaveLength(1);

        tick(400);
        expect(panels()).toHaveLength(0);
        // Retiring a flyout is not dismissing the menu.
        expect(onClose).not.toHaveBeenCalled();
    });

    it('cancels the pending close when the pointer reaches the PANEL', () => {
        renderSync(menuWith({ rows: [row('a', 'x')] }));
        hoverSync(menuItem('Snippets'));
        const host = menuItem('Snippets').parentElement!;

        // Cross a neighbouring item, then arrive in the panel - the diagonal this exists for.
        hoverSync(menuItem('Copy'), menuItem('Snippets'));
        hoverSync(rows()[0], menuItem('Copy'));
        expect(host.contains(rows()[0])).toBe(true); // the panel really is inside the host

        tick(400);
        expect(panels()).toHaveLength(1);
    });

    it('switches directly to another submenu parent, with no gap', () => {
        renderSync([
            { label: 'Command History', submenu: { searchPlaceholder: 'history', rows: [row('h', 'ls -la')] } },
            { label: 'Snippets', submenu: { searchPlaceholder: 'snippets', rows: [row('s', 'docker ps')] } },
        ]);
        hoverSync(menuItem('Command History'));
        expect(search().placeholder).toBe('history');

        hoverSync(menuItem('Snippets'), menuItem('Command History'));
        expect(panels()).toHaveLength(1);
        expect(search().placeholder).toBe('snippets');

        // A close armed by the FIRST hover must not fire into the second panel.
        tick(400);
        expect(panels()).toHaveLength(1);
        expect(search().placeholder).toBe('snippets');
    });

    it('a timer armed before the menu unmounts does not outlive it', () => {
        renderSync(menuWith({ rows: [row('a', 'x')] }));
        hoverSync(menuItem('Snippets'));
        hoverSync(menuItem('Copy'), menuItem('Snippets'));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        act(() => root.unmount());
        tick(400);
        expect(error).not.toHaveBeenCalled();
        // Re-created so the shared afterEach still has something to unmount.
        root = createRoot(container);
    });
});

/* -- opening a flyout with no pointer at all ------------------------------- */

describe('standaloneSubmenu', () => {
    const onOpen = jest.fn();
    const renderStandalone = async (index = 0) => {
        onOpen.mockClear();
        await act(async () => {
            root.render(
                <ContextMenu
                    x={10}
                    y={10}
                    items={[
                        { label: 'Copy', click: jest.fn() },
                        { type: 'separator' },
                        { label: 'Snippets', submenu: { rows: [row('a', 'docker ps')], onOpen } },
                    ]}
                    standaloneSubmenu={index}
                    onClose={onClose}
                />,
            );
        });
    };

    it('renders the panel on the FIRST paint, with no hover and no click', async () => {
        await renderStandalone(2);
        expect(panels()).toHaveLength(1);
        expect(labels()).toEqual(['docker ps']);
        // Warming the cache is part of opening; a shortcut-opened Command History that
        // skipped it would browse an unloaded directory.
        expect(onOpen).toHaveBeenCalledTimes(1);
        // Focus lands in the search box, so the shortcut leads straight into typing.
        expect(document.activeElement).toBe(search());
    });

    it('draws NO menu around it - not the parent row, not the other items, not a separator', async () => {
        await renderStandalone(2);
        // The row you would have clicked has nothing left to do, and it pushes the panel
        // a row's width away from where the shortcut was aimed.
        expect(menuItems()).toHaveLength(0);
        expect(document.querySelectorAll('.context-menu-separator')).toHaveLength(0);
        // …and the container itself must not paint a bordered box beside the panel.
        expect(menu().classList.contains('is-bare')).toBe(true);
    });

    it('Escape dismisses the whole thing, since there is no menu to fall back to', async () => {
        await renderStandalone(2);
        await key(search(), 'Escape');
        // Retiring the panel alone would leave an empty box on screen still swallowing
        // the next outside click.
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('shows nothing at all when pointed at an item that has no flyout', async () => {
        await renderStandalone(0);
        expect(panels()).toHaveLength(0);
        expect(menuItems()).toHaveLength(0);
    });

    it('is absent by default - an ordinary menu draws its items and opens nothing', async () => {
        await render(menuWith({ rows: [row('a', 'x')] }));
        expect(panels()).toHaveLength(0);
        expect(menuItems().length).toBeGreaterThan(0);
        expect(menu().classList.contains('is-bare')).toBe(false);
    });

    it('the bare container really is transparent - jsdom computes no layout, so read the CSS', () => {
        const css = readSource(path.join(__dirname, '..', 'ContextMenu.css'));
        const start = css.indexOf('.context-menu.is-bare {');
        expect(start).toBeGreaterThan(-1);
        const block = css.slice(start, css.indexOf('}', start));
        expect(block).toMatch(/background:\s*none/);
        expect(block).toMatch(/border:\s*none/);
        // The one that actually MOVES the panel: `.context-menu` is `min-width: 200px`,
        // and the empty host inside stretches to it, so `left: 100%` would place the
        // flyout 200px right of the point the caller anchored it at.
        expect(block).toMatch(/min-width:\s*0/);
        const base = css.slice(css.indexOf('.context-menu {'), css.indexOf('}', css.indexOf('.context-menu {')));
        expect(base).toMatch(/min-width:\s*\d+px/);
    });
});

/* ── Trap 1: the flyout lives inside the menu container ───────────────────── */

describe('flyout DOM placement (the portal trap)', () => {
    it('renders the flyout inside the menu container, not in a portal', async () => {
        await render(menuWith({ rows: [row('a', 'x')] }));
        await click(menuItem('Snippets'));
        expect(menu().contains(panel()!)).toBe(true);
    });

    it('a mousedown on a flyout ROW does not close the menu', async () => {
        await render(menuWith({ rows: [row('a', 'kubectl get pods')] }));
        await click(menuItem('Snippets'));

        await mousedown(rows()[0]);

        // A portalled flyout would fail here: the row is not inside `menuRef`, so
        // the document mousedown listener would have closed the menu.
        expect(onClose).not.toHaveBeenCalled();
        expect(panels()).toHaveLength(1);
    });

    it('a mousedown on the flyout SEARCH BOX does not close the menu', async () => {
        await render(menuWith({ rows: [row('a', 'x')] }));
        await click(menuItem('Snippets'));
        await mousedown(search());
        expect(onClose).not.toHaveBeenCalled();
    });

    // Paired positive: the outside-click close still works, so the negative above
    // is not passing simply because the listener is dead.
    it('still closes on a mousedown outside the menu', async () => {
        await render(menuWith({ rows: [row('a', 'x')] }));
        await click(menuItem('Snippets'));
        await mousedown(document.body);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

/* ── Row activation ───────────────────────────────────────────────────────── */

describe('activating a row', () => {
    it('fires that row handler exactly once, and a row that did not ask to dismiss does not', async () => {
        const a = jest.fn();
        const b = jest.fn();
        await render(menuWith({ rows: [row('a', 'alpha', { onSelect: a }), row('b', 'beta', { onSelect: b })] }));
        await click(menuItem('Snippets'));

        await click(rows()[1]);

        expect(b).toHaveBeenCalledTimes(1);
        expect(a).not.toHaveBeenCalled();
        // §4.5 ("every row closes the menu") is a decision about the SNIPPET and HISTORY
        // rows, and `snippetsHistoryMenu.ts` states it as `closeMenuOnSelect: true` on
        // each one — where a test can read it as data. The component-level default stays
        // opt-in, so a row that never considered dismissal cannot tear down the surface
        // the user is mid-interaction with. This pins the default; do not read it as the
        // product rule.
        expect(onClose).not.toHaveBeenCalled();
    });

    /**
     * **"Both fired" is the assertion that let this host be reordered on a false premise.**
     *
     * `add` once plus `onClose` once is satisfied by either sequence, so for as long as that was
     * all this said, the order here was free. It was briefly changed to dismiss-then-act, on the
     * argument that a `closeMenuOnSelect` row opens a surface and this menu holds a document-level
     * `mousedown` trap and Escape listener until it is asked to go — so acting first would mount a
     * modal under a live menu. Measured against the real component, that argument is wrong:
     * `onCloseMenu()` is a queued `setState` that React does not flush until the end of the
     * discrete event, so the menu is still mounted with both handlers installed when the row opens
     * its surface EITHER WAY ROUND. Nothing was bought, and the reorder cost something real — see
     * `ContextMenu.tsx`'s `closeMenuOnSelect` doc for the spurious terminal focus it caused.
     *
     * So the sequence is pinned, and pinned to the ACTION FIRST: the row states its intent, then
     * the host acts on the dismissal, which is the order a close callback doing synchronous DOM
     * work needs. This is the generic host's ordering oracle — every future `closeMenuOnSelect`
     * caller inherits the rule from here — and the guarantee that matters for the row's sake is
     * the separate one below: the dismissal happens even when the action throws.
     */
    it('runs a row that asks to dismiss, THEN dismisses (Add New Snippet)', async () => {
        const order: string[] = [];
        onClose.mockImplementation(() => { order.push('close'); });
        const add = jest.fn(() => { order.push('select'); });
        await render(
            menuWith({
                rows: [row('a', 'alpha')],
                footerRows: [row('add', 'Add New Snippet', { onSelect: add, closeMenuOnSelect: true })],
            }),
        );
        await click(menuItem('Snippets'));
        await click(rows()[1]);

        expect(add).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(order).toEqual(['select', 'close']);
    });

    /**
     * …and the dismissal survives a row whose action THROWS — which, for a caller of this generic
     * host, is where the two orders stop settling to the same DOM.
     *
     * With nothing throwing they do settle the same: React batches the dismissal and whatever
     * `onSelect` schedules into one commit, so "close first" and "close second" are told apart
     * only by a recorded sequence (the test above). A throw splits them. `AutomationMenuSection`'s
     * rows call `openAutomationEditorFor`, which mutates the host's `openRuleId` and THEN notifies
     * its subscribers synchronously — so a subscriber that raises used to take the dismissal down
     * with it, leaving the editor open under a menu that never closed and still owned Escape.
     *
     * The oracle here is settled state rather than a counter: a host that really unmounts on
     * `onClose`, and `.context-menu` gone from the document afterwards. Reordering `activate`
     * fails this on that DOM query, not on a mock — with the dismissal after `onSelect` the throw
     * skips it, and the whole menu is still rendered.
     */
    it('still dismisses when the action of the row throws', async () => {
        let thrown = 0;
        const Host: React.FC = () => {
            const [open, setOpen] = React.useState(true);
            return open
                ? (
                    <ContextMenu
                        x={10}
                        y={10}
                        items={menuWith({
                            rows: [row('boom', 'Explodes', {
                                onSelect: () => { thrown += 1; throw new Error('subscriber raised'); },
                                closeMenuOnSelect: true,
                            })],
                        })}
                        onClose={() => setOpen(false)}
                    />
                )
                : null;
        };
        await act(async () => { root.render(<Host />); });
        await click(menuItem('Snippets'));
        expect(rows()).toHaveLength(1);

        // React reports a handler's exception through the global error path rather than
        // rethrowing it at the dispatch site, and jest-environment-jsdom turns that report into
        // an uncaught exception that fails whichever test is running. `preventDefault()` in the
        // capture phase marks the ErrorEvent handled, which is what jsdom checks before
        // escalating. It suppresses the REPORT only — the throw has already happened, and the
        // assertion below is a DOM query, so nothing about this rig can make the test pass for
        // the wrong reason.
        const swallow = (e: Event) => e.preventDefault();
        window.addEventListener('error', swallow, true);
        try {
            await click(rows()[0]);
        } finally {
            window.removeEventListener('error', swallow, true);
        }
        expect(thrown).toBe(1);

        expect(document.querySelector('.context-menu')).toBeNull();
    });

    it('does nothing for a disabled row', async () => {
        const nope = jest.fn();
        await render(menuWith({ rows: [row('a', 'nothing here', { disabled: true, onSelect: nope })] }));
        await click(menuItem('Snippets'));
        await click(rows()[0]);
        expect(nope).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });
});

/* ── Keyboard (§4.4) ──────────────────────────────────────────────────────── */

describe('keyboard navigation', () => {
    const three = () =>
        menuWith({ rows: [row('a', 'alpha'), row('b', 'beta'), row('c', 'gamma')] });

    it('starts with the first row active and keeps DOM focus in the search box', async () => {
        await render(three());
        await click(menuItem('Snippets'));
        expect(activeIndex()).toBe(0);
        expect(document.activeElement).toBe(search());
    });

    it('ArrowDown / ArrowUp move the active row and WRAP at both ends', async () => {
        await render(three());
        await click(menuItem('Snippets'));

        await key(search(), 'ArrowDown');
        expect(activeIndex()).toBe(1);
        await key(search(), 'ArrowDown');
        expect(activeIndex()).toBe(2);
        // wrap forwards
        await key(search(), 'ArrowDown');
        expect(activeIndex()).toBe(0);
        // wrap backwards
        await key(search(), 'ArrowUp');
        expect(activeIndex()).toBe(2);
        await key(search(), 'ArrowUp');
        expect(activeIndex()).toBe(1);

        // The row is styled, never focused — the input still owns the caret.
        expect(document.activeElement).toBe(search());
    });

    it('Enter activates the active row', async () => {
        const b = jest.fn();
        await render(menuWith({ rows: [row('a', 'alpha'), row('b', 'beta', { onSelect: b })] }));
        await click(menuItem('Snippets'));

        await key(search(), 'ArrowDown');
        await key(search(), 'Enter');

        expect(b).toHaveBeenCalledTimes(1);
    });

    it('Escape closes the flyout but not the menu; a second Escape closes the menu', async () => {
        await render(three());
        await click(menuItem('Snippets'));

        await key(search(), 'Escape');
        expect(panels()).toHaveLength(0);
        // stopPropagation() must keep this off the document-level Escape handler,
        // or one press would close the flyout AND the menu (CanvasGroupMenu precedent).
        expect(onClose).not.toHaveBeenCalled();

        await fire(document, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('Tab closes the flyout and does not trap focus', async () => {
        await render(three());
        await click(menuItem('Snippets'));
        const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        await fire(search(), ev);
        expect(panels()).toHaveLength(0);
        expect(ev.defaultPrevented).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
    });
});

/* ── Search ───────────────────────────────────────────────────────────────── */

describe('search box', () => {
    it('filters the rows as you type', async () => {
        await render(menuWith({ rows: [row('a', 'kubectl get pods'), row('b', 'docker compose up'), row('c', 'docker ps')] }));
        await click(menuItem('Snippets'));
        expect(labels()).toHaveLength(3);

        await type(search(), 'docker');

        expect(labels()).toEqual(['docker compose up', 'docker ps']);
        expect(document.activeElement).toBe(search());
        expect(activeIndex()).toBe(0);
    });

    it('flattens folders away once the query is non-empty (§4.3)', async () => {
        await render(
            menuWith({
                rows: [
                    row('git', 'Git', { children: [row('g1', 'git status'), row('g2', 'git log')] }),
                    row('top', 'docker ps'),
                ],
            }),
        );
        await click(menuItem('Snippets'));
        expect(labels()).toEqual(['Git', 'docker ps']);

        await type(search(), 'git ');
        expect(labels()).toEqual(['git status', 'git log']);
    });

    it('hands filtering to the caller when rows is a function', async () => {
        const rowsFn = jest.fn((q: string) => (q ? [row('m', `match:${q}`)] : [row('r', 'recent')]));
        await render(menuWith({ rows: rowsFn }));
        await click(menuItem('Snippets'));
        expect(labels()).toEqual(['recent']);

        await type(search(), 'ls');
        expect(labels()).toEqual(['match:ls']);
        expect(rowsFn).toHaveBeenCalledWith('ls');
    });
});

/* ── Folders (second level) ───────────────────────────────────────────────── */

describe('folder rows', () => {
    const withFolder = () =>
        menuWith({
            rows: [
                row('git', 'Git', { icon: '📁', children: [row('g1', 'git status'), row('g2', 'git log')] }),
                row('top', 'docker ps'),
            ],
        });

    it('ArrowRight enters the folder, ArrowLeft leaves it', async () => {
        await render(withFolder());
        await click(menuItem('Snippets'));

        await key(search(), 'ArrowRight');
        expect(panels()).toHaveLength(2);
        expect(labels(1)).toEqual(['git status', 'git log']);
        expect(document.activeElement).toBe(search(1));

        await key(search(1), 'ArrowLeft');
        expect(panels()).toHaveLength(1);
        expect(document.activeElement).toBe(search(0));
    });

    it('clicking a folder row opens it instead of selecting it', async () => {
        await render(withFolder());
        await click(menuItem('Snippets'));
        await click(rows()[0]);
        expect(panels()).toHaveLength(2);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('Escape inside a folder returns to the parent flyout, not to the menu', async () => {
        await render(withFolder());
        await click(menuItem('Snippets'));
        await key(search(), 'ArrowRight');

        await key(search(1), 'Escape');
        expect(panels()).toHaveLength(1);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('selects a row from inside the folder', async () => {
        const pick = jest.fn();
        await render(
            menuWith({
                rows: [row('git', 'Git', { children: [row('g1', 'git status', { onSelect: pick })] })],
            }),
        );
        await click(menuItem('Snippets'));
        await key(search(), 'ArrowRight');
        await key(search(1), 'Enter');
        expect(pick).toHaveBeenCalledTimes(1);
    });
});

/* ── Placement: the clip trap (D-02) and the cascade (D-03) ───────────────── */

/**
 * **Why these tests need a layout simulator.**
 *
 * jsdom implements no layout: `getBoundingClientRect()` is a zero rect for every
 * element, and `FlyoutPanel`'s placement effect deliberately bails on a zero rect
 * (there is genuinely nothing to measure). A placement test written without a stub
 * therefore exercises none of the flip arithmetic and cannot fail — which is exactly
 * how an inverted cascade shipped past 31 green tests in this file.
 *
 * `layout()` installs a simulator rather than a fixed rect table: each panel's box is
 * derived from the flip class it is *currently* rendering with, the way a real engine
 * resolves `left: 100%` against `right: 100%`. A child therefore measures its parent
 * *where the parent actually ended up*, which is the entire substance of D-03. It also
 * models the pre-fix DOM (a nested panel inside `.context-menu-flyout-item`) honestly,
 * so the D-03 tests fail against the old structure for the real reason.
 *
 * Borders are ignored — a 1px modelling error, orders of magnitude below any assertion
 * made here.
 */
interface Box {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** `.context-menu-flyout`'s `margin-left` / `margin-right`. */
const FLYOUT_GAP = 2;
const ZERO_BOX: Box = { left: 0, top: 0, width: 0, height: 0 };

function layout(opts: {
    viewport: { width: number; height: number };
    /** `.context-menu-submenu-host` — the depth-0 anchor (one menu row). */
    host: Box;
    /** Every flyout panel is modelled with the same intrinsic size. */
    panel: { width: number; height: number };
    /** Depths whose panel reports a ZERO rect — the "nothing to measure" case. */
    unmeasurable?: number[];
}) {
    Object.defineProperty(window, 'innerWidth', { value: opts.viewport.width, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: opts.viewport.height, configurable: true, writable: true });

    const boxOf = (el: HTMLElement): Box => {
        if (el.classList.contains('context-menu-submenu-host')) return opts.host;
        if (el.classList.contains('context-menu-flyout')) {
            if (opts.unmeasurable?.includes(Number(el.dataset.flyoutDepth ?? -1))) return ZERO_BOX;
            const anchor = el.parentElement ? boxOf(el.parentElement as HTMLElement) : ZERO_BOX;
            const { width, height } = opts.panel;
            const left = el.classList.contains('flip-left')
                ? anchor.left - FLYOUT_GAP - width
                : anchor.left + anchor.width + FLYOUT_GAP;
            // `top: 0` inside the anchor, plus whatever lift the effect applied.
            return { left, top: anchor.top + (parseFloat(el.style.top) || 0), width, height };
        }
        if (el.classList.contains('context-menu-flyout-item')) {
            // A row wrapper spans the list, i.e. the panel it sits in. Modelled so the
            // OLD (clipped) structure — where a nested panel's parent was a row — is
            // measured the way a browser would have measured it.
            const panelEl = el.closest('.context-menu-flyout') as HTMLElement | null;
            return panelEl ? boxOf(panelEl) : ZERO_BOX;
        }
        return ZERO_BOX;
    };

    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const b = boxOf(this);
        return {
            x: b.left,
            y: b.top,
            left: b.left,
            top: b.top,
            width: b.width,
            height: b.height,
            right: b.left + b.width,
            bottom: b.top + b.height,
            toJSON: () => ({}),
        } as DOMRect;
    });
}

describe('nested flyout placement', () => {
    const withFolder = () =>
        menuWith({
            rows: [
                row('git', 'Git', { icon: '📁', children: [row('g1', 'git status'), row('g2', 'git log')] }),
                row('top', 'docker ps'),
            ],
        });

    const openFolder = async () => {
        await render(withFolder());
        await click(menuItem('Snippets'));
        await key(search(), 'ArrowRight');
    };

    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    afterEach(() => {
        Object.defineProperty(window, 'innerWidth', { value: innerWidth, configurable: true, writable: true });
        Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true, writable: true });
    });

    /* ── D-02: the panel must escape the scrolling list ───────────────────── */

    it('renders the depth-1 panel OUTSIDE the scrolling list — a descendant of it would be clipped', async () => {
        await openFolder();
        const nested = panel(1)!;
        expect(nested).toBeTruthy();

        // Kills the shipped implementation, which rendered the nested panel inside
        // `.context-menu-flyout-item` inside `.context-menu-flyout-list`. That list is
        // `overflow-y: auto; overflow-x: hidden`, so every real engine clips a
        // positioned descendant at the list box and the folder submenu is invisible.
        // jsdom implements no clipping, so this has to be asserted structurally.
        expect(nested.closest('.context-menu-flyout-list')).toBeNull();
        // ...and it hangs off the parent PANEL, which declares no `overflow` at all.
        expect(nested.parentElement).toBe(panel(0));
    });

    it('keeps the depth-1 panel inside the menu container (trap 1 still holds at depth 1)', async () => {
        await openFolder();
        // Kills a "fix" that escapes the clip by portalling the panel to document.body:
        // it would be outside `menuRef`, and the mousedown below would close the menu.
        expect(menu().contains(panel(1)!)).toBe(true);

        await mousedown(rows(1)[0]);
        expect(onClose).not.toHaveBeenCalled();
        expect(panels()).toHaveLength(2);
    });

    it('activating a depth-1 row still works after the hoist', async () => {
        const pick = jest.fn();
        await render(
            menuWith({
                rows: [row('git', 'Git', { children: [row('g1', 'git status', { onSelect: pick })] })],
            }),
        );
        await click(menuItem('Snippets'));
        await key(search(), 'ArrowRight');
        await click(rows(1)[0]);
        expect(pick).toHaveBeenCalledTimes(1);
    });

    it('keeps the list itself scrollable — the fix must NOT be "delete overflow-y" (§4.3)', () => {
        // Kills the tempting non-fix: dropping the list's overflow would un-clip the
        // nested panel and silently delete the long-list scrolling §4.3 requires.
        const css = readSource(path.join(__dirname, '..', 'ContextMenu.css'));
        const start = css.indexOf('.context-menu-flyout-list {');
        expect(start).toBeGreaterThan(-1);
        const block = css.slice(start, css.indexOf('}', start));
        expect(block).toMatch(/max-height:\s*\d+px/);
        expect(block).toMatch(/overflow-y:\s*auto/);
    });

    /* ── D-03: the cascade keeps its direction ────────────────────────────── */

    it('does not flip either level when there is room on the right', async () => {
        // Kills an implementation that flips unconditionally, and proves the two
        // "flips" below are not simply the default.
        layout({
            viewport: { width: 1920, height: 1080 },
            host: { left: 100, top: 100, width: 200, height: 24 },
            panel: { width: 250, height: 300 },
        });
        await openFolder();
        expect(panel(0)!.classList.contains('flip-left')).toBe(false);
        expect(panel(1)!.classList.contains('flip-left')).toBe(false);
    });

    it('flips depth 0 left at the right edge, and depth 1 CASCADES left with it', async () => {
        // The D-03 repro, with the review's own numbers. Depth 0: right edge 1800 +
        // 250 = 2050 > 1915 ⇒ flip, landing at 1348..1598. Depth 1 then measures its
        // parent at 1598 and finds 1598 + 250 = 1848 ≤ 1915 — "room on the right" —
        // so a purely local decision sends it back to 1600..1850, directly on top of
        // the root context menu it just flipped away from.
        layout({
            viewport: { width: 1920, height: 1080 },
            host: { left: 1600, top: 100, width: 200, height: 24 },
            panel: { width: 250, height: 300 },
        });
        await openFolder();
        expect(panel(0)!.classList.contains('flip-left')).toBe(true);
        // Kills the shipped `left: overflowsRight && fitsLeft`, which is false here.
        expect(panel(1)!.classList.contains('flip-left')).toBe(true);
    });

    it('stops cascading left when the LEFT edge forbids it', async () => {
        // Depth 0 flips to 48..298; depth 1 would need to start at -202. Kills the
        // over-eager `left: parentFlippedLeft || (overflowsRight && fitsLeft)`, which
        // inherits the direction without re-checking that the panel still fits.
        layout({
            viewport: { width: 700, height: 1080 },
            host: { left: 300, top: 100, width: 200, height: 24 },
            panel: { width: 250, height: 300 },
        });
        await openFolder();
        expect(panel(0)!.classList.contains('flip-left')).toBe(true);
        expect(panel(1)!.classList.contains('flip-left')).toBe(false);
    });

    it('inherits the parent direction when the child itself cannot be measured', async () => {
        // Same geometry as the repro above, but the child reports a zero rect (the
        // first paint, and every jsdom run). Measurement is impossible, so the only
        // defensible direction for a child is its parent's. Kills a fix that threads
        // `parentFlippedLeft` through the arithmetic but leaves the zero-rect path
        // handing the child the un-flipped default.
        layout({
            viewport: { width: 1920, height: 1080 },
            host: { left: 1600, top: 100, width: 200, height: 24 },
            panel: { width: 250, height: 300 },
            unmeasurable: [1],
        });
        await openFolder();
        expect(panel(0)!.classList.contains('flip-left')).toBe(true);
        expect(panel(1)!.classList.contains('flip-left')).toBe(true);
    });

    /* ── Vertical: lift a panel that runs off the bottom ──────────────────── */

    it('lifts a panel that would run off the bottom of the viewport', async () => {
        // 900 + 300 − (1000 − 5) = 205 of overflow. Kills an implementation that
        // ignores bottom overflow entirely.
        layout({
            viewport: { width: 1920, height: 1000 },
            host: { left: 100, top: 900, width: 200, height: 24 },
            panel: { width: 250, height: 300 },
        });
        await openFolder();
        expect(panel(0)!.style.top).toBe('-205px');
    });

    it('never lifts a panel past the top of the viewport', async () => {
        // A panel taller than the viewport: 50 + 900 − 495 = 455 of overflow, but only
        // 45px of room above. Kills an unclamped `shiftY = -overflowY`, which would
        // push the search box 405px off the top of the screen.
        layout({
            viewport: { width: 1920, height: 500 },
            host: { left: 100, top: 50, width: 200, height: 24 },
            panel: { width: 250, height: 900 },
        });
        await openFolder();
        expect(panel(0)!.style.top).toBe('-45px');
    });
});

/* ── Empty states (§4.5) ──────────────────────────────────────────────────── */

describe('empty state', () => {
    it('renders the empty row and keeps the flyout usable', async () => {
        const add = jest.fn();
        await render(
            menuWith({
                rows: [],
                emptyRow: (q) => row('empty', q ? `No snippets match “${q}”` : 'No snippets yet', { disabled: true }),
                footerRows: [row('add', 'Add New Snippet', { icon: '➕', onSelect: add, closeMenuOnSelect: true })],
            }),
        );
        await click(menuItem('Snippets'));

        expect(labels()).toEqual(['No snippets yet', 'Add New Snippet']);
        expect(rows()[0].disabled).toBe(true);
        // The inert row must not swallow the arrows: the footer action is active.
        expect(activeIndex()).toBe(1);

        await key(search(), 'Enter');
        expect(add).toHaveBeenCalledTimes(1);
    });

    it('reports the query in the empty row when the search matches nothing', async () => {
        await render(
            menuWith({
                rows: [row('a', 'alpha')],
                emptyRow: (q) => row('empty', `No snippets match “${q}”`, { disabled: true }),
            }),
        );
        await click(menuItem('Snippets'));
        await type(search(), 'zzz');
        expect(labels()).toEqual(['No snippets match “zzz”']);
    });

    it('accepts a static empty row too', async () => {
        await render(menuWith({ rows: [], emptyRow: row('none', 'No command history yet', { disabled: true }) }));
        await click(menuItem('Snippets'));
        expect(labels()).toEqual(['No command history yet']);
        // Nothing navigable: the arrows and Enter are inert, not a crash.
        await key(search(), 'ArrowDown');
        await key(search(), 'Enter');
        expect(onClose).not.toHaveBeenCalled();
    });
});

/* ── Row rendering surface T6 depends on ──────────────────────────────────── */

describe('row rendering', () => {
    it('renders icon, label and secondary detail text', async () => {
        await render(
            menuWith({ rows: [row('a', 'deploy', { icon: '🚀', detail: 'infra', title: 'full snippet text' })] }),
        );
        await click(menuItem('Snippets'));

        const r = rows()[0];
        expect(r.querySelector('.context-menu-flyout-icon')!.textContent).toBe('🚀');
        expect(r.querySelector('.context-menu-flyout-label')!.textContent).toBe('deploy');
        expect(r.querySelector('.context-menu-flyout-detail')!.textContent).toBe('infra');
        expect(r.title).toBe('full snippet text');
    });

    it('gives the detail its own tooltip, defaulting to the text it truncates', async () => {
        await render(menuWith({
            rows: [
                row('a', 'one', { detail: 'a very long folder and tag line', title: 'the snippet text' }),
                row('b', 'two', { detail: 'chip', detailTitle: 'Folder: Ops' }),
            ],
        }));
        await click(menuItem('Snippets'));
        const detail = (i: number) => rows()[i].querySelector('.context-menu-flyout-detail')!;
        // No `detailTitle`: the chip still gets one, showing what the ellipsis hid.
        expect(detail(0).getAttribute('title')).toBe('a very long folder and tag line');
        expect(rows()[0].getAttribute('title')).toBe('the snippet text');
        // With one: it wins, so a caller can expand the chip into something readable.
        expect(detail(1).getAttribute('title')).toBe('Folder: Ops');
    });

    it('points aria-activedescendant at the active row', async () => {
        await render(menuWith({ rows: [row('a', 'alpha'), row('b', 'beta')] }));
        await click(menuItem('Snippets'));
        expect(search().getAttribute('aria-activedescendant')).toBe(rows()[0].id);
        await key(search(), 'ArrowDown');
        expect(search().getAttribute('aria-activedescendant')).toBe(rows()[1].id);
    });
});
