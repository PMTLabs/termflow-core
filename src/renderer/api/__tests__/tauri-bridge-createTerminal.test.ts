/**
 * @jest-environment jsdom
 *
 * Tests that tauri-bridge.createTerminal forwards fitted cols/rows when provided,
 * and falls back to 80×24 when omitted or zero.
 */

// Must be hoisted before any imports of the module under test.
const invokeMock = jest.fn((_cmd: string, _args?: any) => Promise.resolve('mock-pid'));

jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => invokeMock(...args),
}));

jest.mock('@tauri-apps/api/event', () => ({
  listen: jest.fn(() => Promise.resolve(() => {})),
}));

jest.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: jest.fn(() => ({ label: 'main' })),
}));

// Force localStorage to exist for module-level code in tauri-bridge
Object.defineProperty(global, 'localStorage', {
  value: { getItem: jest.fn(() => null), setItem: jest.fn() },
  writable: true,
});

// Import AFTER mocks are set up
import tauriBridge from '../tauri-bridge';

beforeEach(() => {
  invokeMock.mockClear();
  // Reset to resolve 'mock-pid' for createTerminal calls
  invokeMock.mockImplementation((_cmd: string, _args?: any) => Promise.resolve('mock-pid'));
});

describe('tauriBridge restore intent contract', () => {
  it('round-trips full process ids and exact recovered session overrides', async () => {
    const processId = 'pc-0123456789ab4cde8fab0123456789ab';
    const sessionKey = 'tm-original~0123456789ab4cde8fab0123456789ac';
    invokeMock.mockResolvedValueOnce(processId);
    await expect(tauriBridge.createTerminal('default', 'Recovered', undefined, 'tm-recovered', 80, 24, 'tb-owner', sessionKey)).resolves.toBe(processId);
    const create = invokeMock.mock.calls.find(([cmd]) => cmd === 'create_terminal');
    expect(create?.[1]).toMatchObject({ tabId: 'tm-recovered', sessionKey, owningTabId: 'tb-owner' });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('has no hold-free label registration or forget endpoint', () => {
    expect(tauriBridge).not.toHaveProperty('registerRestoringLeaves');
    expect(tauriBridge).not.toHaveProperty('forgetRestoringLeaf');
    expect(typeof tauriBridge.createTerminal).toBe('function');
  });

  it('never adds a per-mount restoring flag to a create request', async () => {
    await tauriBridge.createTerminal('default', 'Restored', undefined, 'tm-modern');
    const args = invokeMock.mock.calls.find(([cmd]) => cmd === 'create_terminal')![1];
    expect(args).not.toHaveProperty('restoring');
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'register_restoring_leaves')).toBe(false);
  });
});

describe('tauriBridge.createTerminal — fitted size forwarding', () => {
  it('forwards fitted cols/rows when provided', async () => {
    const pid = await tauriBridge.createTerminal('default', 'myterm', '/home', 'tab-1', 140, 37);

    expect(pid).toBe('mock-pid');

    const createCall = invokeMock.mock.calls.find(([cmd]) => cmd === 'create_terminal');
    expect(createCall).toBeDefined();
    expect(createCall![1]).toMatchObject({ cols: 140, rows: 37 });
  });

  it('falls back to 80×24 when cols/rows are omitted', async () => {
    await tauriBridge.createTerminal('default', 'myterm', '/home', 'tab-1');

    const createCall = invokeMock.mock.calls.find(([cmd]) => cmd === 'create_terminal');
    expect(createCall).toBeDefined();
    expect(createCall![1]).toMatchObject({ cols: 80, rows: 24 });
  });

  it('falls back to 80×24 when cols/rows are zero', async () => {
    await tauriBridge.createTerminal('default', 'myterm', '/home', 'tab-1', 0, 0);

    const createCall = invokeMock.mock.calls.find(([cmd]) => cmd === 'create_terminal');
    expect(createCall).toBeDefined();
    expect(createCall![1]).toMatchObject({ cols: 80, rows: 24 });
  });
});
