/**
 * @jest-environment jsdom
 *
 * §10.27 — the panel's data layer.
 *
 * Two claims, and the first is the one that cannot be seen by reading the file: **the subscriptions
 * are registered before the first fetch.** The log is append-only with no second chance, so an entry
 * written between "we asked for the list" and "we started listening" is lost forever and nothing
 * downstream can tell. A stubbed `listen` recording call order is the only way to assert it.
 *
 * The repo deliberately avoids React Testing Library (its installed v13 predates React 19), so this
 * drives a real render with `react-dom/client` + `React.act`, as the Settings suites do.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

/** Every call, in the order it happened, across the event API and the bridge. */
const calls: string[] = [];
/** The handlers the hook registered, so a test can actually deliver an event to one. */
const handlers = new Map<string, (event: { payload: unknown }) => void>();
/**
 * The unlisten function returned for each subscription — SPIES, not stubs.
 *
 * They used to be anonymous no-ops, which meant nothing could observe whether they were ever
 * called: emptying the hook's entire cleanup left all six tests green. A mock's return value is
 * part of its oracle, and an untracked one silently exempts everything downstream of it.
 */
const unlistens: jest.Mock[] = [];
/** Set to make a named subscription fail, so the partial-registration path can be driven. */
let failListenFor: string | null = null;

jest.mock('@tauri-apps/api/event', () => ({
    listen: jest.fn((name: string, handler: (event: { payload: unknown }) => void) => {
        calls.push(`listen:${name}`);
        if (failListenFor === name) return Promise.reject(new Error(`refused ${name}`));
        handlers.set(name, handler);
        const un = jest.fn();
        unlistens.push(un);
        return Promise.resolve(un);
    }),
}));

jest.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ label: 'main-2' }),
}));

// eslint-disable-next-line import/first
import { LOG_BUFFER_MAX, useAutomations, UseAutomations } from '../useAutomations';
// eslint-disable-next-line import/first
import type { AutomationLogEntry } from '../../../../types/electron';

function logRows(n: number): AutomationLogEntry[] {
    return Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        ruleId: 'au-1',
        terminalId: 'tm-a',
        terminalName: 'claude',
        kind: 'held' as const,
        detail: `read ${i}`,
        at: i,
    }));
}

let latest: UseAutomations | null = null;

const Probe: React.FC = () => {
    latest = useAutomations();
    return null;
};

async function flush() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

describe('useAutomations', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeAll(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
            true;
    });

    beforeEach(() => {
        calls.length = 0;
        handlers.clear();
        unlistens.length = 0;
        failListenFor = null;
        latest = null;
        (window as unknown as { electronAPI: unknown }).electronAPI = {
            listAutomations: jest.fn(() => {
                calls.push('fetch:rules');
                return Promise.resolve([]);
            }),
            getAutomationRuntime: jest.fn(() => {
                calls.push('fetch:runtime');
                return Promise.resolve({ rules: {} });
            }),
            loadAutomationLog: jest.fn(() => {
                calls.push('fetch:log');
                return Promise.resolve(logRows(250));
            }),
        };
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        jest.clearAllMocks();
    });

    async function mount() {
        await act(async () => {
            root.render(<Probe />);
        });
        await flush();
    }

    it('registers every listener BEFORE the first fetch', async () => {
        await mount();

        const firstFetch = calls.findIndex((c) => c.startsWith('fetch:'));
        expect(firstFetch).toBeGreaterThan(-1);
        const listens = calls.slice(0, firstFetch);
        expect(listens).toEqual([
            'listen:automation:changed',
            'listen:automation:state',
            'listen:automation:activity',
        ]);
        // And the premise: a fetch really did happen, so the assertion above is not passing on an
        // empty tail.
        expect(calls.slice(firstFetch)).toContain('fetch:rules');
    });

    it('carries this window′s label as the origin, so the log can name it', async () => {
        await mount();
        expect(latest?.origin).toBe('main-2');
    });

    it('holds the log buffer at 200 however many rows come back', async () => {
        await mount();
        await act(async () => {
            latest?.setLogScope({ ruleId: 'au-1', newestFirst: false });
        });
        await flush();
        expect(latest?.log).toHaveLength(LOG_BUFFER_MAX);
        expect(LOG_BUFFER_MAX).toBe(200);

        // TWO separate claims, and the fake only exercises one of them by itself: the merge clamps
        // whatever arrives, AND the request asks for no more than the buffer holds. A fake that
        // ignores the limit argument makes the second invisible — mutation found exactly that, by
        // changing the requested limit and watching this test stay green.
        const api = window.electronAPI as unknown as { loadAutomationLog: jest.Mock };
        expect(api.loadAutomationLog).toHaveBeenCalledWith('au-1', false, LOG_BUFFER_MAX);
    });

    it('does not fetch the log until a scope is opened, not even when one arrives', async () => {
        await mount();
        expect(calls).not.toContain('fetch:log');

        // The real pressure on this guard is not mount — it is `automation:activity`, which fires
        // every time any rule writes a row. With the log view closed there is nothing to refresh,
        // and defaulting the scope would hit SQLite on every append for a view nobody is looking at.
        await act(async () => {
            handlers.get('automation:activity')!({ payload: { ruleIds: ['au-1'] } });
        });
        await flush();
        expect(calls).not.toContain('fetch:log');
    });

    it('refreshes the log when activity arrives WITH a scope open', async () => {
        // The positive half: the guard above must be a scope check, not an off switch.
        await mount();
        await act(async () => {
            latest?.setLogScope({ ruleId: 'au-1', newestFirst: false });
        });
        await flush();
        const before = calls.filter((c) => c === 'fetch:log').length;

        await act(async () => {
            handlers.get('automation:activity')!({ payload: { ruleIds: ['au-1'] } });
        });
        await flush();
        expect(calls.filter((c) => c === 'fetch:log').length).toBe(before + 1);
    });

    it('unregisters every listener on unmount', async () => {
        await mount();
        expect(unlistens).toHaveLength(3);
        expect(unlistens.every((un) => un.mock.calls.length === 0)).toBe(true);

        await act(async () => root.unmount());
        expect(unlistens.every((un) => un.mock.calls.length === 1)).toBe(true);

        // Re-created so afterEach's unmount has a root to act on.
        root = createRoot(container);
    });

    it('does not strand the subscriptions that succeeded when one of them fails', async () => {
        // `Promise.all` rejects on the first failure and abandons the other results, so the two
        // that DID register used to be unreachable: their unlisten handles were never bound to
        // anything and the subscriptions outlived the component.
        failListenFor = 'automation:activity';
        await mount();
        expect(unlistens.length).toBeGreaterThan(0);

        await act(async () => root.unmount());
        expect(unlistens.every((un) => un.mock.calls.length === 1)).toBe(true);
        root = createRoot(container);
    });

    it('reports a log read failure instead of swallowing it', async () => {
        // The log view REPLACES the list, so the list's error line is not on screen while the log
        // is showing — a swallowed failure rendered "Nothing logged yet" over a refusing store.
        const api = window.electronAPI as unknown as { loadAutomationLog: jest.Mock };
        api.loadAutomationLog.mockRejectedValueOnce(new Error('the rule store is disabled'));
        await mount();
        await act(async () => {
            latest?.setLogScope({ ruleId: 'au-1', newestFirst: false });
        });
        await flush();
        expect(latest?.logError).toContain('disabled');
        expect(latest?.log).toEqual([]);
    });

    it('reports unavailable rather than empty when the bridge has no automation surface', async () => {
        // An empty list is indistinguishable from "you have no automations yet" and would draw the
        // panel's empty state over a feature that is simply not present in this host.
        //
        // The shape below is what `browser-bridge.ts` actually produces: it does NOT define the
        // eleven automation methods. It used to define them as throwing stubs, which are truthy
        // properties — so this detection never fired in the one host it exists for, and this test
        // passed anyway because `{}` is a shape no host in the repo makes. An oracle has to name a
        // real host, not a convenient one.
        (window as unknown as { electronAPI: unknown }).electronAPI = {
            getTerminalOutput: jest.fn(),
            createTerminal: jest.fn(),
        };
        await mount();
        expect(latest?.unavailable).toBe(true);
        expect(latest?.loading).toBe(false);
    });
});
