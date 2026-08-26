/**
 * @jest-environment jsdom
 *
 * Toast auto-dismiss vs. sticky behavior. A normal toast removes itself after its
 * `duration`; a sticky toast (activity notifications) stays until the user clicks it.
 *
 * The repo deliberately avoids React Testing Library (its installed v13 predates
 * React 19), so this drives a real DOM render with `react-dom/client` + `React.act`,
 * mirroring the codebase's other component unit tests (see PeersPanel.test.tsx).
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import uiReducer, { addToast, dismissTabToasts } from '../../../store/slices/uiSlice';
import tabsReducer, { addTab } from '../../../store/slices/tabsSlice';

// Jest has no CSS transform; stub the stylesheet import pulled in by the component.
jest.mock('../ToastContainer.css', () => ({}));

// eslint-disable-next-line import/first
import { ToastContainer } from '../ToastContainer';

function makeStore() {
    return configureStore({ reducer: { ui: uiReducer } });
}

function makeStoreWithTabs() {
    return configureStore({ reducer: { ui: uiReducer, tabs: tabsReducer } });
}

/**
 * ToastContainer portals to <body>, so it is NOT inside the test's own `container` —
 * an overlay cannot escape an ancestor stacking context, and rendering in place made its
 * z-index worth only whatever its caller's ancestors allowed. Query the document instead;
 * asserting through `container` would now find nothing and pass vacuously on any
 * `not.toContain` check.
 */
const toastRoot = (): HTMLElement =>
    document.body.querySelector('.toast-container') as HTMLElement ?? document.body;

describe('ToastContainer — auto-dismiss vs sticky', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeAll(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        jest.useFakeTimers();
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.useRealTimers();
    });

    function mount(store: ReturnType<typeof makeStore>) {
        root = createRoot(container);
        act(() => {
            root.render(
                <Provider store={store}>
                    <ToastContainer />
                </Provider>,
            );
        });
    }

    it('auto-dismisses a normal toast after its duration', () => {
        const store = makeStore();
        mount(store);
        act(() => { store.dispatch(addToast({ message: 'transient', duration: 3000 })); });
        expect(toastRoot().textContent).toContain('transient');
        act(() => { jest.advanceTimersByTime(3000); });
        expect(store.getState().ui.toasts).toHaveLength(0);
    });

    it('does NOT auto-dismiss a sticky toast (stays until clicked)', () => {
        const store = makeStore();
        mount(store);
        act(() => { store.dispatch(addToast({ message: 'New activity in "build"', sticky: true })); });
        // Well past any normal auto-dismiss window — the sticky toast must remain.
        act(() => { jest.advanceTimersByTime(60_000); });
        expect(store.getState().ui.toasts).toHaveLength(1);
        expect(toastRoot().textContent).toContain('New activity in "build"');
    });

    it('removes a sticky toast when the user clicks it', () => {
        const store = makeStore();
        mount(store);
        act(() => { store.dispatch(addToast({ message: 'click me', sticky: true })); });
        const item = toastRoot().querySelector('.toast-item') as HTMLElement;
        expect(item).toBeTruthy();
        act(() => { item.click(); });
        expect(store.getState().ui.toasts).toHaveLength(0);
    });

    it('dismissTabToasts removes only the matching tab\'s toasts', () => {
        const store = makeStore();
        mount(store);
        act(() => {
            store.dispatch(addToast({ message: 'A', sticky: true, tabId: 'tb-1' }));
            store.dispatch(addToast({ message: 'B', sticky: true, tabId: 'tb-2' }));
        });
        expect(store.getState().ui.toasts).toHaveLength(2);
        act(() => { store.dispatch(dismissTabToasts({ tabId: 'tb-1' })); });
        const remaining = store.getState().ui.toasts;
        expect(remaining).toHaveLength(1);
        expect(remaining[0].tabId).toBe('tb-2');
    });
});

describe('ToastContainer — collapsed stack', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeAll(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        jest.useFakeTimers();
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.useRealTimers();
    });

    function mount(store: ReturnType<typeof makeStore>) {
        root = createRoot(container);
        act(() => {
            root.render(
                <Provider store={store}>
                    <ToastContainer />
                </Provider>,
            );
        });
    }

    function addSticky(store: ReturnType<typeof makeStore>, message: string) {
        act(() => { store.dispatch(addToast({ message, sticky: true })); });
    }

    it('does not render stacking chrome for a single toast', () => {
        const store = makeStore();
        mount(store);
        addSticky(store, 'solo');
        expect(toastRoot().querySelectorAll('.toast-item')).toHaveLength(1);
        expect(toastRoot().querySelector('.toast-stack-header')).toBeNull();
        expect(toastRoot().querySelector('.toast-close-all')).toBeNull();
    });

    it('shows only the most recently added toast when collapsed with multiple toasts', () => {
        const store = makeStore();
        mount(store);
        addSticky(store, 'first');
        addSticky(store, 'second');
        const items = toastRoot().querySelectorAll('.toast-item');
        expect(items).toHaveLength(1);
        expect(items[0].textContent).toContain('second');
        expect(items[0].textContent).not.toContain('first');
    });

    it('clicking the visible top toast dismisses only that toast', () => {
        const store = makeStore();
        mount(store);
        addSticky(store, 'first');
        addSticky(store, 'second');
        const item = toastRoot().querySelector('.toast-item') as HTMLElement;
        act(() => { item.click(); });
        const remaining = store.getState().ui.toasts;
        expect(remaining).toHaveLength(1);
        expect(remaining[0].message).toBe('first');
    });

    it('the collapsed stack shows a real, labeled button to expand — not a subtle sliver', () => {
        const store = makeStore();
        mount(store);
        addSticky(store, 'first');
        addSticky(store, 'second');
        addSticky(store, 'third');
        const expandBtn = toastRoot().querySelector('.toast-stack-expand') as HTMLButtonElement;
        expect(expandBtn).toBeTruthy();
        expect(expandBtn.tagName).toBe('BUTTON');
        expect(expandBtn.textContent).toContain('3');
    });

    it('clicking the stack\'s top edge expands to reveal every pending toast', () => {
        const store = makeStore();
        mount(store);
        addSticky(store, 'first');
        addSticky(store, 'second');
        addSticky(store, 'third');
        const expandBtn = toastRoot().querySelector('.toast-stack-expand') as HTMLElement;
        expect(expandBtn).toBeTruthy();
        act(() => { expandBtn.click(); });
        expect(toastRoot().querySelectorAll('.toast-item')).toHaveLength(3);
    });

    it('lists expanded toasts newest-first', () => {
        const store = makeStore();
        mount(store);
        addSticky(store, 'first');
        addSticky(store, 'second');
        const expandBtn = toastRoot().querySelector('.toast-stack-expand') as HTMLElement;
        act(() => { expandBtn.click(); });
        const items = toastRoot().querySelectorAll('.toast-item');
        expect(items[0].textContent).toContain('second');
        expect(items[1].textContent).toContain('first');
    });

    it('selecting close all dismisses every pending toast', () => {
        const store = makeStore();
        mount(store);
        addSticky(store, 'first');
        addSticky(store, 'second');
        const expandBtn = toastRoot().querySelector('.toast-stack-expand') as HTMLElement;
        act(() => { expandBtn.click(); });
        const closeAll = toastRoot().querySelector('.toast-close-all') as HTMLElement;
        expect(closeAll).toBeTruthy();
        act(() => { closeAll.click(); });
        expect(store.getState().ui.toasts).toHaveLength(0);
        expect(toastRoot().querySelectorAll('.toast-item')).toHaveLength(0);
    });

    it('clicking Clear all from the collapsed stack dismisses every toast without expanding first', () => {
        const store = makeStore();
        mount(store);
        addSticky(store, 'first');
        addSticky(store, 'second');
        const closeAll = toastRoot().querySelector('.toast-close-all') as HTMLElement;
        expect(closeAll).toBeTruthy();
        act(() => { closeAll.click(); });
        expect(store.getState().ui.toasts).toHaveLength(0);
    });

    it('pressing Escape while expanded collapses the stack without dismissing toasts', () => {
        const store = makeStore();
        mount(store);
        addSticky(store, 'first');
        addSticky(store, 'second');
        const expandBtn = toastRoot().querySelector('.toast-stack-expand') as HTMLElement;
        act(() => { expandBtn.click(); });
        expect(toastRoot().querySelectorAll('.toast-item')).toHaveLength(2);
        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        expect(toastRoot().querySelectorAll('.toast-item')).toHaveLength(1);
        expect(store.getState().ui.toasts).toHaveLength(2);
    });

    it('clicking outside the stack while expanded collapses it without dismissing toasts', () => {
        const store = makeStore();
        mount(store);
        addSticky(store, 'first');
        addSticky(store, 'second');
        const expandBtn = toastRoot().querySelector('.toast-stack-expand') as HTMLElement;
        act(() => { expandBtn.click(); });
        expect(toastRoot().querySelectorAll('.toast-item')).toHaveLength(2);
        act(() => {
            document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });
        expect(toastRoot().querySelectorAll('.toast-item')).toHaveLength(1);
        expect(store.getState().ui.toasts).toHaveLength(2);
    });

    it('inserts a newly-arriving toast live while the stack is expanded', () => {
        const store = makeStore();
        mount(store);
        addSticky(store, 'first');
        addSticky(store, 'second');
        const expandBtn = toastRoot().querySelector('.toast-stack-expand') as HTMLElement;
        act(() => { expandBtn.click(); });
        addSticky(store, 'third');
        expect(toastRoot().querySelectorAll('.toast-item')).toHaveLength(3);
    });

    it('exposes an accessible status role on the toast container', () => {
        const store = makeStore();
        mount(store);
        addSticky(store, 'solo');
        expect(toastRoot().getAttribute('role')).toBe('status');
    });

    it('adds a canvas-offset modifier class when the active tab is a canvas tab', () => {
        const store = makeStoreWithTabs();
        mount(store);
        act(() => {
            store.dispatch(addTab({ id: 'tb-canvas', title: 'Canvas', shellType: 'canvas' }));
            store.dispatch(addToast({ message: 'hi', sticky: true }));
        });
        expect(toastRoot().classList.contains('toast-container--canvas')).toBe(true);
    });

    it('shows a relative "time ago" label that updates as time passes', () => {
        const store = makeStore();
        mount(store);
        const fixedNow = new Date('2024-03-15T14:05:00');
        jest.setSystemTime(fixedNow);
        addSticky(store, 'solo');
        expect(toastRoot().querySelector('.toast-time')?.textContent).toBe('Just now');

        act(() => {
            jest.setSystemTime(new Date(fixedNow.getTime() + 2 * 60 * 1000));
            jest.advanceTimersByTime(30_000);
        });
        expect(toastRoot().querySelector('.toast-time')?.textContent).toBe('2m ago');
    });

    it('exposes the full local date and time as a hover tooltip on the timestamp', () => {
        const store = makeStore();
        mount(store);
        const fixedNow = new Date('2024-03-15T14:05:00');
        jest.setSystemTime(fixedNow);
        addSticky(store, 'solo');
        const expected = fixedNow.toLocaleString();
        expect(toastRoot().querySelector('.toast-time')?.getAttribute('title')).toBe(expected);
    });
});
