/**
 * @jest-environment jsdom
 *
 * Two hosts claiming the same terminal session: the backend announces it once, and the window
 * must show it. The announcement used to be emitted with no listener anywhere, so the notice the
 * design promised never appeared.
 */
import path from 'path';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import uiReducer from '../../store/slices/uiSlice';
import { readSource } from '../../utils/readSource';
import { DUPLICATE_SESSION_EVENT, GlobalHostNotices } from '../GlobalHostNotices';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function announce(detail: unknown) {
    act(() => { window.dispatchEvent(new CustomEvent(DUPLICATE_SESSION_EVENT, { detail })); });
}

describe('GlobalHostNotices', () => {
    let container: HTMLDivElement;
    let root: Root;
    let store: ReturnType<typeof makeStore>;
    const makeStore = () => configureStore({ reducer: { ui: uiReducer } });

    beforeAll(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        store = makeStore();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => { root.render(<Provider store={store}><GlobalHostNotices /></Provider>); });
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it('warns once per announcement and says how many sessions are doubled', () => {
        announce({ sessionKeys: ['a~1', 'b~2'] });
        const toasts = store.getState().ui.toasts;
        expect(toasts).toHaveLength(1);
        expect(toasts[0].type).toBe('warning');
        expect(toasts[0].message).toContain('2 terminal sessions');

        announce({ sessionKeys: ['c~3'] });
        expect(store.getState().ui.toasts).toHaveLength(2);
        expect(store.getState().ui.toasts[1].message).toContain('One terminal session');
    });

    it('shows nothing for an announcement that names no session', () => {
        announce({ sessionKeys: [] });
        announce({});
        announce(undefined);
        expect(store.getState().ui.toasts).toHaveLength(0);
    });

    it('stops listening when it unmounts', () => {
        act(() => root.unmount());
        announce({ sessionKeys: ['a~1'] });
        expect(store.getState().ui.toasts).toHaveLength(0);
        root = createRoot(container);
    });

    it('is wired at every link: the backend emits the name the bridge forwards and App mounts the owner', () => {
        const rust = readSource(path.resolve(ROOT, 'src-tauri', 'src', 'state', 'terminals.rs'));
        const bridge = readSource(path.resolve(ROOT, 'src', 'renderer', 'api', 'tauri-bridge.ts'));
        const app = readSource(path.resolve(ROOT, 'src', 'renderer', 'App.tsx'));
        expect(rust).toContain(`emit("${DUPLICATE_SESSION_EVENT}"`);
        expect(bridge).toContain(`listen('${DUPLICATE_SESSION_EVENT}'`);
        expect(bridge).toContain(`new CustomEvent('${DUPLICATE_SESSION_EVENT}', { detail: event.payload })`);
        expect(app).toContain('<GlobalHostNotices />');
    });
});
