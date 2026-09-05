/**
 * @jest-environment jsdom
 *
 * Where the bridge's REST calls actually GO.
 *
 * The canvas edge bug was never in the canvas: `POST /api/canvas/edges` was correct, and
 * it was sent to the port this instance was CONFIGURED for rather than the one it BOUND.
 * Under a second profile that is a sibling app's server, which answers 404 for terminal
 * ids it has never seen, and `createEdge` turns a 404 into `null` — so the wire silently
 * never appeared.
 *
 * `apiBase.test.ts` pins the resolver and `apiBaseMemo.test.ts` the memo; this pins the
 * HANDOFF, which is the link that was missing. The table below is meant to be the COMPLETE
 * roster of the bridge's `fetch` call sites — `canvasApiRequest` has its own case above only
 * because it takes a path rather than a terminal id — since they all read the same base URL
 * and so all had the same bug. A fetching method that arrives with no row here is unpinned,
 * and `getTerminalScreenText` shipped as exactly that.
 */

// Needs a working implementation from the moment it is created: tauri-bridge invokes at
// MODULE level (the auth token, the Windows build number), which runs on import — before
// any beforeEach could configure it.
const invokeMock = jest.fn((_cmd: string, _args?: any): Promise<any> => Promise.resolve(undefined));

jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => invokeMock(...args),
}));

jest.mock('@tauri-apps/api/event', () => ({
  listen: jest.fn(() => Promise.resolve(() => {})),
}));

jest.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: jest.fn(() => ({ label: 'main' })),
}));

Object.defineProperty(global, 'localStorage', {
  value: { getItem: jest.fn(() => null), setItem: jest.fn() },
  writable: true,
});

import tauriBridge from '../tauri-bridge';
import { __resetApiBaseForTests } from '../apiBase';

/** What every release profile is configured for, and what only ONE of them owns. */
const CONFIGURED = 42031;
/** What this instance actually bound after walking forward past its siblings. */
const BOUND = 42035;

const fetchMock = jest.fn();

beforeEach(() => {
  __resetApiBaseForTests();
  // These calls only exist under the Tauri host; the resolver checks for it.
  (window as any).__TAURI_INTERNALS__ = {};
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case 'get_effective_endpoints':
        return Promise.resolve({ apiPort: BOUND, mcpPort: null });
      case 'get_network_config':
        return Promise.resolve({
          apiPort: CONFIGURED,
          mcpPort: 42032,
          exposeOnNetwork: false,
          authToken: 'tok',
        });
      default:
        return Promise.resolve(undefined);
    }
  });

  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ processes: [] }),
  });
  (global as any).fetch = fetchMock;
});

const urlOf = (call: number) => String(fetchMock.mock.calls[call][0]);

describe('tauri-bridge REST calls address the bound port', () => {
  it('sends canvas requests to the bound port, not the configured one', async () => {
    await tauriBridge.canvasApiRequest!('/canvas/edges', {
      method: 'POST',
      body: { from: 'a', to: 'b', label: null },
    });
    expect(urlOf(0)).toBe(`http://localhost:${BOUND}/api/canvas/edges`);
    expect(urlOf(0)).not.toContain(String(CONFIGURED));
  });

  it.each([
    ['getTerminalOutput', () => tauriBridge.getTerminalOutput('t1'), '/terminals/t1/output'],
    ['getTerminalSnapshot', () => tauriBridge.getTerminalSnapshot('t1'), '/terminals/t1/snapshot'],
    // Sits next to `/snapshot` deliberately: those two are the pair a single character swap
    // turns into each other, and the swap is INVISIBLE everywhere else. The only consumer is
    // the rule editor's terminal hover card, whose tests mock `window.electronAPI` outright and
    // never reach this module; and the card guards its read with `typeof body?.screen ===
    // 'string'`, so a `/snapshot` body — which has no `screen` key — degrades to '' and leaves
    // the card stuck on “Reading its screen…” forever rather than failing anything.
    [
      'getTerminalScreenText',
      () => tauriBridge.getTerminalScreenText('t1'),
      '/terminals/t1/screen',
    ],
    [
      'getTerminalFullScrollback',
      () => tauriBridge.getTerminalFullScrollback!('t1'),
      '/terminals/t1/full-scrollback',
    ],
    ['getActiveProcesses', () => tauriBridge.getActiveProcesses!(), '/processes'],
  ])('%s addresses the bound port', async (_name, call, path) => {
    await call();
    expect(urlOf(0)).toContain(`http://localhost:${BOUND}/api${path}`);
    expect(urlOf(0)).not.toContain(`:${CONFIGURED}/`);
  });

  it('never asks for the configured port in order to build a URL', async () => {
    await tauriBridge.getActiveProcesses!();
    const commands = invokeMock.mock.calls.map(([cmd]) => cmd);
    expect(commands).toContain('get_effective_endpoints');
  });

  // Each of these is a separate invalidation call site, and a shared test would let two of
  // them be deleted while it still passed on the third.
  it.each([
    ['stopServers', () => tauriBridge.stopServers!('all')],
    ['startServers', () => tauriBridge.startServers!('all')],
  ])('%s drops the memo so the next call re-reads the port', async (_name, act) => {
    await tauriBridge.getActiveProcesses!();
    expect(urlOf(0)).toContain(`:${BOUND}/`);

    // Stopping clears the effective port server-side; starting re-binds and may land
    // somewhere else entirely. Either way the memo from before is no longer an address.
    const MOVED = 42043;
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'get_effective_endpoints'
        ? Promise.resolve({ apiPort: MOVED, mcpPort: null })
        : Promise.resolve(undefined),
    );
    await act();

    await tauriBridge.getActiveProcesses!();
    expect(urlOf(1)).toContain(`:${MOVED}/`);
  });

  it('re-resolves after the servers are restarted', async () => {
    await tauriBridge.getActiveProcesses!();
    expect(urlOf(0)).toContain(`:${BOUND}/`);

    // Settings > Apply moves the listener; the window must follow it rather than keep
    // addressing a port a sibling instance is now free to take.
    const MOVED = 42041;
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'get_effective_endpoints'
        ? Promise.resolve({ apiPort: MOVED, mcpPort: null })
        : Promise.resolve({ apiPort: CONFIGURED, mcpPort: 42032, authToken: 'tok' }),
    );
    await tauriBridge.setNetworkConfig!(CONFIGURED, 42032, false);

    await tauriBridge.getActiveProcesses!();
    expect(urlOf(1)).toContain(`:${MOVED}/`);
  });
});
