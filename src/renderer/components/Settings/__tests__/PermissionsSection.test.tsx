/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { PermissionsSection } from '../PermissionsSection';
import type { PermissionView } from '../../../types/electron';

const base = (changes: Partial<PermissionView> = {}): PermissionView => ({
    epoch: 1, target: 'host', subject: { pid: 1 }, accessibility: 'notGranted',
    screenRecording: 'granted', otherHosts: [], appSessions: false, ...changes,
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
    return { promise, resolve, reject };
}

describe('PermissionsSection', () => {
    let container: HTMLDivElement;
    let root: Root;
    let api: { macosPermissionStatus: jest.Mock; requestMacosPermission: jest.Mock; openMacosPermissionPane: jest.Mock };
    let actions: any[];
    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        actions = [];
        api = { macosPermissionStatus: jest.fn(async () => base()), requestMacosPermission: jest.fn(async () => base()), openMacosPermissionPane: jest.fn(async () => {}) };
        (window as any).electronAPI = api;
        container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    });
    afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete (window as any).electronAPI; jest.useRealTimers(); jest.restoreAllMocks(); });
    async function render() {
        const store = configureStore({ reducer: (state = {}, action) => { actions.push(action); return state; } });
        await act(async () => { root.render(<Provider store={store}><PermissionsSection /></Provider>); });
    }
    const button = (index: number) => container.querySelectorAll('button')[index] as HTMLButtonElement;
    async function click(index: number) { await act(async () => { button(index).click(); }); }
    async function focus() { await act(async () => { window.dispatchEvent(new Event('focus')); }); }

    it('shows target, status, migration and grant timing; requests each kind and opens its pane', async () => {
        await render();
        expect(container.textContent).toContain('TermFlow Host');
        expect(container.textContent).toContain('Not granted');
        expect(container.textContent).toContain('Restart the program that needs this permission');
        expect(container.textContent).toContain("Programs in terminals now use the 'TermFlow Host' permission. If you previously allowed TermFlow, allow TermFlow Host once.");
        await click(0); await click(1);
        expect(api.requestMacosPermission.mock.calls).toEqual([['accessibility'], ['screenRecording']]);
        expect(api.openMacosPermissionPane.mock.calls).toEqual([['accessibility'], ['screenRecording']]);
    });
    it.each([['hostLegacy', 'legacy host'], ['app', 'TermFlow'], ['host', 'TermFlow Host']] as const)('labels %s', async (target, label) => {
        api.macosPermissionStatus.mockResolvedValue(base({ target })); await render();
        expect(container.textContent).toContain(`Permission target: ${label}`);
        if (target === 'hostLegacy') expect(container.textContent).toContain('terminals already open keep their current identity');
    });
    it('warns about other hosts and app sessions', async () => {
        api.macosPermissionStatus.mockResolvedValue(base({ otherHosts: [{ pid: 42, generation: 'old', reason: 'legacy' }], appSessions: true }));
        await render(); expect(container.textContent).toContain('PID 42 (old)'); expect(container.textContent).toContain('app sessions');
    });
    it('labels app-attributed other hosts', async () => {
        api.macosPermissionStatus.mockResolvedValue(base({ otherHosts: [{ pid: 43, reason: 'appAttributed' }] }));
        await render();
        expect(container.textContent).toContain("PID 43 — uses TermFlow's permission");
    });
    it('disables both buttons during a request', async () => {
        const pending = deferred<PermissionView>(); api.requestMacosPermission.mockReturnValue(pending.promise); await render(); await click(0);
        expect(button(0).disabled && button(1).disabled).toBe(true);
        await act(async () => pending.resolve(base())); expect(button(0).disabled).toBe(false);
    });
    it('refreshes on focus and host changes only while focused', async () => {
        await render(); const hasFocus = jest.spyOn(document, 'hasFocus').mockReturnValue(false);
        await act(async () => window.dispatchEvent(new Event('pty-host:state'))); expect(api.macosPermissionStatus).toHaveBeenCalledTimes(1);
        hasFocus.mockReturnValue(true); await act(async () => window.dispatchEvent(new Event('pty-host:state'))); await focus();
        expect(api.macosPermissionStatus).toHaveBeenCalledTimes(3);
    });
    it('keeps the newest started refresh when completions reverse', async () => {
        await render(); const old = deferred<PermissionView>(); const newer = deferred<PermissionView>();
        api.macosPermissionStatus.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
        await focus(); await focus(); await act(async () => newer.resolve(base({ target: 'app' })));
        await act(async () => old.resolve(base())); expect(container.textContent).toContain('Permission target: TermFlow'); expect(container.textContent).not.toContain('Permission target: TermFlow Host');
    });
    it.each(['focus', 'pty-host:state'])('opens the pane after a same-subject %s refresh without overwriting it', async event => {
        await render(); const pending = deferred<PermissionView>(); api.requestMacosPermission.mockReturnValue(pending.promise); await click(1);
        jest.spyOn(document, 'hasFocus').mockReturnValue(true);
        api.macosPermissionStatus.mockResolvedValue(base({ accessibility: 'granted' }));
        await act(async () => window.dispatchEvent(new Event(event)));
        await act(async () => pending.resolve(base()));
        expect(api.openMacosPermissionPane.mock.calls).toEqual([['screenRecording']]);
        expect(container.textContent).not.toContain('Not granted');
    });
    it.each(['focus', 'pty-host:state'])('shows a request error after a same-subject %s refresh', async event => {
        await render(); const pending = deferred<PermissionView>(); api.requestMacosPermission.mockReturnValue(pending.promise); await click(0);
        jest.spyOn(document, 'hasFocus').mockReturnValue(true);
        await act(async () => window.dispatchEvent(new Event(event)));
        await act(async () => pending.resolve(base({ error: 'disconnected', accessibility: 'unknown', screenRecording: 'unknown' })));
        expect(actions.some(a => a.type === 'ui/addToast' && a.payload.message.includes('disconnected'))).toBe(true);
        expect(api.openMacosPermissionPane.mock.calls).toEqual([['accessibility']]);
    });
    it('does not publish a slow request for an old subject', async () => {
        await render(); const pending = deferred<PermissionView>(); api.requestMacosPermission.mockReturnValue(pending.promise); await click(0);
        api.macosPermissionStatus.mockResolvedValue(base({ subject: { pid: 2 }, target: 'app' })); await focus();
        await act(async () => pending.resolve(base({ accessibility: 'granted' })));
        expect(container.textContent).toContain('Permission target: TermFlow'); expect(api.openMacosPermissionPane).not.toHaveBeenCalled();
    });
    it('rejects a request response for a different subject even without a refresh', async () => {
        api.requestMacosPermission.mockResolvedValue(base({ subject: { pid: 2 }, accessibility: 'granted' })); await render(); await click(0);
        expect(container.textContent).toContain('Not granted'); expect(api.openMacosPermissionPane).not.toHaveBeenCalled();
    });
    it.each(['unmount', 'pagehide', 'beforeunload'])('invalidates a request on %s', async event => {
        await render(); const pending = deferred<PermissionView>(); api.requestMacosPermission.mockReturnValue(pending.promise); await click(0);
        if (event === 'unmount') await act(async () => root.unmount()); else await act(async () => window.dispatchEvent(new Event(event)));
        await act(async () => pending.reject(new Error('gone'))); expect(api.openMacosPermissionPane).not.toHaveBeenCalled(); expect(actions.some(a => a.type === 'ui/addToast')).toBe(false);
    });
    it('does not open a pane when a successful request completes after unmount', async () => {
        await render(); const pending = deferred<PermissionView>(); api.requestMacosPermission.mockReturnValue(pending.promise); await click(0);
        await act(async () => root.unmount()); await act(async () => pending.resolve(base()));
        expect(api.openMacosPermissionPane).not.toHaveBeenCalled();
    });
    it('times out to Unknown', async () => {
        jest.useFakeTimers(); await render(); api.requestMacosPermission.mockReturnValue(new Promise(() => {})); await click(0);
        await act(async () => { jest.advanceTimersByTime(30000); }); expect(container.textContent).toContain('Unknown'); expect(button(0).disabled).toBe(false);
    });
    it('explains unresolved and never requests', async () => {
        api.macosPermissionStatus.mockResolvedValue(base({ target: 'unresolved' })); await render(); await click(0);
        expect(container.textContent).toContain('Open a terminal'); expect(api.requestMacosPermission).not.toHaveBeenCalled();
    });
    it('reports request errors as toast and Unknown', async () => {
        api.requestMacosPermission.mockRejectedValue(new Error('disconnected')); await render(); await click(0);
        expect(container.textContent).toContain('Unknown'); expect(actions.some(a => a.type === 'ui/addToast' && a.payload.message.includes('disconnected'))).toBe(true); expect(api.openMacosPermissionPane).not.toHaveBeenCalled();
    });
    it.each(['request', 'status'])('shows a resolved %s error and Unknown states', async operation => {
        const failed = base({ error: 'disconnected', accessibility: 'unknown', screenRecording: 'unknown' });
        if (operation === 'status') api.macosPermissionStatus.mockResolvedValue(failed);
        else api.requestMacosPermission.mockResolvedValue(failed);
        await render(); if (operation === 'request') await click(0);
        expect(container.textContent?.match(/Unknown/g)).toHaveLength(2);
        expect(actions.some(a => a.type === 'ui/addToast' && a.payload.message.includes('disconnected'))).toBe(true);
    });
    it('publishes a resolution error instead of the old subject', async () => {
        api.requestMacosPermission.mockResolvedValue(base({ target: 'unresolved', subject: {}, error: 'resolution failed', accessibility: 'unknown', screenRecording: 'unknown' }));
        await render(); await click(0);
        expect(container.textContent?.match(/Unknown/g)).toHaveLength(2);
        expect(actions.some(a => a.type === 'ui/addToast')).toBe(true);
        expect(api.openMacosPermissionPane).not.toHaveBeenCalled();
    });
    it('shows opener failure separately without changing the result', async () => {
        api.requestMacosPermission.mockResolvedValue(base({ accessibility: 'granted' })); api.openMacosPermissionPane.mockRejectedValue(new Error('open failed'));
        await render(); await click(0); expect(container.querySelector('[role=alert]')?.textContent).toContain('open failed'); expect(container.textContent).toContain('Granted'); expect(actions.some(a => a.type === 'ui/addToast')).toBe(false);
    });
    it.each(['macosPermissionStatus', 'requestMacosPermission', 'openMacosPermissionPane'])('shows Unsupported when %s is missing', async method => {
        delete (api as any)[method]; await render(); expect(container.textContent?.match(/Unsupported/g)).toHaveLength(2); expect(button(0).disabled).toBe(true);
    });
});
