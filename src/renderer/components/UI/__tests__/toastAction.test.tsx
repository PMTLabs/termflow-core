/**
 * @jest-environment jsdom
 *
 * plan/025 §2.6 Task B2 — a toast's inline action button.
 *
 * `Toast.action` can only ever be `{ label, actionId }` (Redux must stay serialisable
 * for RTK's `serializableCheck`), so the actual handler lives in
 * `services/toastActions.ts`'s module registry and `ToastContainer` looks it up by id
 * when the button is clicked. The card's OWN `onClick` (see `ToastContainer.tsx`)
 * dismisses the toast, so the action button must `stopPropagation()` — the whole
 * point of this suite is proving that guard actually works: clicking the action
 * fires the registered handler AND leaves the card exactly where it was, never
 * dismissed as a side effect of the click bubbling up.
 *
 * Follows the repo's no-RTL convention (installed v13 predates React 19): a real DOM
 * render via `react-dom/client` + `React.act`, mirroring `ToastContainer.test.tsx`.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import uiReducer, { addToast } from '../../../store/slices/uiSlice';
import {
    registerToastAction,
    unregisterToastAction,
    runToastAction,
    makeToastActionId,
    __resetToastActionsForTests,
} from '../../../services/toastActions';

// Jest has no CSS transform; stub the stylesheet import pulled in by the component.
jest.mock('../ToastContainer.css', () => ({}));

// eslint-disable-next-line import/first
import { ToastContainer } from '../ToastContainer';

function makeStore() {
    return configureStore({ reducer: { ui: uiReducer } });
}

/** ToastContainer portals to <body> — see ToastContainer.test.tsx's identical note. */
const toastRoot = (): HTMLElement =>
    document.body.querySelector('.toast-container') as HTMLElement ?? document.body;

describe('toastActions registry (services/toastActions.ts)', () => {
    beforeEach(() => __resetToastActionsForTests());

    it('runs the handler registered for an id', () => {
        const handler = jest.fn();
        registerToastAction('a1', handler);
        runToastAction('a1');
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('is a silent no-op for an unregistered (or already-unregistered) id', () => {
        expect(() => runToastAction('missing')).not.toThrow();
        const handler = jest.fn();
        registerToastAction('a2', handler);
        unregisterToastAction('a2');
        runToastAction('a2');
        expect(handler).not.toHaveBeenCalled();
    });

    it('mints distinct ids on successive calls', () => {
        const ids = new Set([makeToastActionId(), makeToastActionId(), makeToastActionId()]);
        expect(ids.size).toBe(3);
    });
});

describe('ToastContainer — inline toast action', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeAll(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        jest.useFakeTimers();
        __resetToastActionsForTests();
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

    it('renders the action label as a distinct button on the card', () => {
        const store = makeStore();
        mount(store);
        act(() => {
            store.dispatch(addToast({
                message: 'Layout switched.',
                sticky: true,
                action: { label: 'Undo', actionId: 'undo-1' },
            }));
        });
        const btn = toastRoot().querySelector('.toast-action') as HTMLButtonElement;
        expect(btn).toBeTruthy();
        expect(btn.textContent).toBe('Undo');
    });

    it('a toast with no action renders no action button', () => {
        const store = makeStore();
        mount(store);
        act(() => { store.dispatch(addToast({ message: 'plain', sticky: true })); });
        expect(toastRoot().querySelector('.toast-action')).toBeNull();
    });

    it('clicking the action button fires the registered handler', () => {
        const store = makeStore();
        mount(store);
        const handler = jest.fn();
        registerToastAction('undo-2', handler);
        act(() => {
            store.dispatch(addToast({
                message: 'Layout switched.',
                sticky: true,
                action: { label: 'Undo', actionId: 'undo-2' },
            }));
        });
        const btn = toastRoot().querySelector('.toast-action') as HTMLButtonElement;
        act(() => { btn.click(); });
        expect(handler).toHaveBeenCalledTimes(1);
    });

    /**
     * THE regression this whole file exists for. `.toast-item`'s own onClick
     * dismisses the toast (see ToastContainer.test.tsx's "removes a sticky toast when
     * the user clicks it") — a click on the action button bubbles to that same
     * handler unless it stops propagation. Without the guard this toast would vanish
     * from `store.getState().ui.toasts` the instant the action fired.
     */
    it('does NOT dismiss the card as a side effect of clicking its action', () => {
        const store = makeStore();
        mount(store);
        registerToastAction('undo-3', jest.fn());
        act(() => {
            store.dispatch(addToast({
                message: 'Layout switched.',
                sticky: true,
                action: { label: 'Undo', actionId: 'undo-3' },
            }));
        });
        expect(store.getState().ui.toasts).toHaveLength(1);
        const btn = toastRoot().querySelector('.toast-action') as HTMLButtonElement;
        act(() => { btn.click(); });
        expect(store.getState().ui.toasts).toHaveLength(1);
        expect(toastRoot().querySelector('.toast-item')).not.toBeNull();
    });

    it('clicking elsewhere on the same card still dismisses it (the guard is scoped to the action button only)', () => {
        const store = makeStore();
        mount(store);
        registerToastAction('undo-4', jest.fn());
        act(() => {
            store.dispatch(addToast({
                message: 'Layout switched.',
                sticky: true,
                action: { label: 'Undo', actionId: 'undo-4' },
            }));
        });
        const item = toastRoot().querySelector('.toast-item') as HTMLElement;
        act(() => { item.click(); });
        expect(store.getState().ui.toasts).toHaveLength(0);
    });
});
