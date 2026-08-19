/**
 * @jest-environment jsdom
 *
 * The memo around `resolveApiPort` — the part that decides HOW OFTEN the backend is asked,
 * and whether a stale answer can survive a port change. `resolveApiPort` itself is pinned
 * in `apiBase.test.ts`; this covers the module state wrapped around it, which is where a
 * "resolved once at startup" bug lives.
 */

// Must be hoisted before the module under test is imported.
const invokeMock = jest.fn();

jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => invokeMock(...args),
}));

import {
  apiBase,
  apiPort,
  invalidateApiBase,
  __resetApiBaseForTests,
  RESOLVE_TIMEOUT_MS,
  RESOLVE_POLL_MS,
} from '../apiBase';

// Fake timers: the first resolution deliberately polls for RESOLVE_TIMEOUT_MS before
// admitting there is no server, and no test should spend fifteen real seconds proving it.
beforeEach(() => {
  jest.useFakeTimers();
  __resetApiBaseForTests();
  invokeMock.mockReset();
  // The resolver refuses outright when there is no Tauri host to ask, so every test that
  // means "running in the app" has to say so.
  (window as any).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  jest.useRealTimers();
});

const effective = (apiPort: number | null) => ({ apiPort, mcpPort: null });

/**
 * Drive the poll loop past its deadline, then hand back the settled promise.
 *
 * The outcome is captured BEFORE the clock advances: the promise settles while the timers
 * run, which is before the caller's `expect(...).rejects` could subscribe to it, and Node
 * reports that gap as an unhandled rejection.
 */
async function runOutTheClock<T>(p: Promise<T>): Promise<T> {
  const settled = p.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  await jest.advanceTimersByTimeAsync(RESOLVE_TIMEOUT_MS + RESOLVE_POLL_MS);
  const outcome = await settled;
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}

describe('apiBase memo', () => {
  it('builds the URL from the EFFECTIVE port, never the configured one', async () => {
    // 42031 is what every release profile is configured for; 42035 is what this instance
    // actually bound. A URL naming 42031 is another app's server.
    invokeMock.mockResolvedValue(effective(42035));
    await expect(apiBase()).resolves.toBe('http://localhost:42035/api');
    expect(invokeMock).toHaveBeenCalledWith('get_effective_endpoints');
    expect(invokeMock).not.toHaveBeenCalledWith('get_network_config');
  });

  it('asks the backend once and reuses the answer', async () => {
    invokeMock.mockResolvedValue(effective(42033));
    await Promise.all([apiPort(), apiPort(), apiPort()]);
    await apiPort();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('re-reads after invalidation, and follows the port to its new home', async () => {
    invokeMock.mockResolvedValue(effective(42033));
    await expect(apiPort()).resolves.toBe(42033);

    // A Settings apply / stop+start re-binds; the window must not keep addressing 42033,
    // which a sibling instance is now free to take.
    invokeMock.mockResolvedValue(effective(42041));
    invalidateApiBase();
    await expect(apiPort()).resolves.toBe(42041);
  });

  it('throws rather than guessing when no port was ever bound', async () => {
    invokeMock.mockResolvedValue(effective(null));
    await expect(runOutTheClock(apiPort())).rejects.toThrow(/not available/i);
  });

  it('does not cache the failure — a late-starting API is picked up', async () => {
    invokeMock.mockResolvedValue(effective(null));
    await expect(runOutTheClock(apiPort())).rejects.toThrow();

    // Settings > Start servers.
    invokeMock.mockResolvedValue(effective(42035));
    await expect(apiPort()).resolves.toBe(42035);
  });

  it('refuses immediately with no Tauri host rather than polling for fifteen seconds', async () => {
    // `start-web-dev` runs the browser bridge against its own compiled-in port; there is
    // no `get_effective_endpoints` to ask, and a rejecting probe would otherwise read as
    // "not yet" and make every caller wait out the whole boot-race window.
    delete (window as any).__TAURI_INTERNALS__;
    await expect(apiPort()).rejects.toThrow(/Tauri host/i);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('does not re-run the boot-race wait on every later attempt', async () => {
    // With no server, `getActiveProcesses` polls forever. If each attempt re-ran the
    // 15s poll the window would accumulate one long-lived resolution per tick.
    invokeMock.mockResolvedValue(effective(null));
    await expect(runOutTheClock(apiPort())).rejects.toThrow();
    const afterFirst = invokeMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(1); // the first attempt really did poll

    await expect(apiPort()).rejects.toThrow();
    expect(invokeMock.mock.calls.length - afterFirst).toBe(1);
  });
});
