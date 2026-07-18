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
import uiReducer, { addToast } from '../../../store/slices/uiSlice';

// Jest has no CSS transform; stub the stylesheet import pulled in by the component.
jest.mock('../ToastContainer.css', () => ({}));

// eslint-disable-next-line import/first
import { ToastContainer } from '../ToastContainer';

function makeStore() {
    return configureStore({ reducer: { ui: uiReducer } });
}

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
        expect(container.textContent).toContain('transient');
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
        expect(container.textContent).toContain('New activity in "build"');
    });

    it('removes a sticky toast when the user clicks it', () => {
        const store = makeStore();
        mount(store);
        act(() => { store.dispatch(addToast({ message: 'click me', sticky: true })); });
        const item = container.querySelector('.toast-item') as HTMLElement;
        expect(item).toBeTruthy();
        act(() => { item.click(); });
        expect(store.getState().ui.toasts).toHaveLength(0);
    });
});
