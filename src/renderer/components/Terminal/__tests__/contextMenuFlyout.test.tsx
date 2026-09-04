/**
 * @jest-environment jsdom
 *
 * The flyout submenu inside the terminal context menu (design 029 §4).
 *
 * Two traps decide the whole shape of this component, and both are pinned here:
 *
 *  1. **The flyout must live INSIDE the menu container.** `ContextMenu` closes on
 *     any `mousedown` whose target is not inside `menuRef` — a flyout portalled to
 *     `document.body` is "outside" by that test, so the very first press on a
 *     flyout row would close the whole menu before the click landed. The
 *     `does not close the menu` test below is the regression that catches it.
 *  2. **`ContextMenu` runs `item.click?.(); onClose();` on every item.** A submenu
 *     parent has to toggle its flyout *instead of* closing the menu, so the click
 *     handler must branch before that `onClose()`.
 *
 * Repo convention: no React Testing Library (the installed v13 predates React 19),
 * so this drives a real DOM render through `react-dom/client` inside `act()`.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

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

    it('toggles closed when clicked a second time', async () => {
        await render(menuWith({ rows: [row('a', 'x')] }));
        await click(menuItem('Snippets'));
        expect(panels()).toHaveLength(1);
        await click(menuItem('Snippets'));
        expect(panels()).toHaveLength(0);
        expect(onClose).not.toHaveBeenCalled();
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
    it('fires that row handler exactly once and leaves the menu open', async () => {
        const a = jest.fn();
        const b = jest.fn();
        await render(menuWith({ rows: [row('a', 'alpha', { onSelect: a }), row('b', 'beta', { onSelect: b })] }));
        await click(menuItem('Snippets'));

        await click(rows()[1]);

        expect(b).toHaveBeenCalledTimes(1);
        expect(a).not.toHaveBeenCalled();
        // Default is "stay open" (§4.5: Add New Snippet is the *only* row that dismisses).
        expect(onClose).not.toHaveBeenCalled();
    });

    it('closes the whole menu for a row that asks to (Add New Snippet)', async () => {
        const add = jest.fn();
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

    it('points aria-activedescendant at the active row', async () => {
        await render(menuWith({ rows: [row('a', 'alpha'), row('b', 'beta')] }));
        await click(menuItem('Snippets'));
        expect(search().getAttribute('aria-activedescendant')).toBe(rows()[0].id);
        await key(search(), 'ArrowDown');
        expect(search().getAttribute('aria-activedescendant')).toBe(rows()[1].id);
    });
});
