/**
 * @jest-environment jsdom
 *
 * The lightweight flyout host `TabContextMenu` uses for Color Schema / Tab Color / Open admin
 * Tab (2026-09-16): a side panel, not `ContextMenu`'s own search+row flyout, so this only pins
 * the two things that are actually this component's job — mounting the panel exactly when
 * `open` says to, and forwarding the host's own mouse events — leaving the hover-open debounce
 * and hover-close grace to the caller that owns them (`TabContextMenu`, mirroring `ContextMenu`).
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { SubmenuFlyoutHost } from '../SubmenuFlyoutHost';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const render = (open: boolean, onMouseEnter?: () => void, onMouseLeave?: () => void) => {
    act(() => {
        root.render(
            <SubmenuFlyoutHost
                open={open}
                trigger={<button type="button">Color Schema</button>}
                onMouseEnter={onMouseEnter}
                onMouseLeave={onMouseLeave}
            >
                <div className="probe">panel content</div>
            </SubmenuFlyoutHost>,
        );
    });
};

const panel = () => container.querySelector('.submenu-flyout-panel');

it('always renders the trigger', () => {
    render(false);
    expect(container.querySelector('button')?.textContent).toBe('Color Schema');
});

it('mounts the panel only while open', () => {
    render(false);
    expect(panel()).toBeNull();

    render(true);
    expect(panel()).not.toBeNull();
    expect(panel()!.querySelector('.probe')?.textContent).toBe('panel content');
});

it('unmounts the panel the moment `open` goes false again', () => {
    render(true);
    expect(panel()).not.toBeNull();
    render(false);
    expect(panel()).toBeNull();
});

it('the panel lives inside the host, not portalled away', () => {
    // The same placement constraint `ContextMenu`'s own flyout relies on (see its own
    // comment): a panel portalled to `document.body` would be "outside" the menu for an
    // outside-mousedown dismissal listener, closing the whole menu on the panel's own first
    // click. This host renders in place for exactly that reason.
    render(true);
    const host = container.querySelector('.submenu-flyout-host')!;
    expect(host.contains(panel())).toBe(true);
});

it('forwards mouseenter/mouseleave on the host to the caller', () => {
    const onEnter = jest.fn();
    const onLeave = jest.fn();
    render(true, onEnter, onLeave);
    const host = container.querySelector('.submenu-flyout-host')!;
    act(() => {
        host.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
    });
    expect(onEnter).toHaveBeenCalledTimes(1);
    act(() => {
        host.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
    });
    expect(onLeave).toHaveBeenCalledTimes(1);
});

it('adds the caller\'s `panelClassName` alongside the base panel class', () => {
    act(() => {
        root.render(
            <SubmenuFlyoutHost
                open
                trigger={<button type="button">Color Schema</button>}
                panelClassName="submenu-flyout-panel--wide"
            >
                <div className="probe">panel content</div>
            </SubmenuFlyoutHost>,
        );
    });
    expect(panel()!.classList.contains('submenu-flyout-panel--wide')).toBe(true);
    expect(panel()!.classList.contains('submenu-flyout-panel')).toBe(true);
});

it('swallows a right-click on the panel instead of raising the native menu over it', () => {
    render(true);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    const prevented = !act(() => panel()!.dispatchEvent(event)) || event.defaultPrevented;
    expect(prevented).toBe(true);
});
