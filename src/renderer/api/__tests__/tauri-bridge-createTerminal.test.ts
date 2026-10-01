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
  it('registers modern and migrated leaves with camelCase argument keys', async () => {
    const leaves = [{ leafId: 'tm-modern' }, { leafId: 'tm-migrated', sessionKey: 'tb-legacy' }];
    await tauriBridge.registerRestoringLeaves(leaves);
    expect(invokeMock).toHaveBeenCalledWith('register_restoring_leaves', { leaves });
  });

  it('forgets the leaf identity, not its override key', async () => {
    await tauriBridge.forgetRestoringLeaf('tm-migrated');
    expect(invokeMock).toHaveBeenCalledWith('forget_restoring_leaf', { leafId: 'tm-migrated' });
  });

  it('qualifies a live pane close by process and forwards the handled acknowledgement', async () => {
    invokeMock.mockResolvedValueOnce(true);
    await expect(tauriBridge.forgetRestoringLeaf('tm-leaf', 'pc-p')).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('forget_restoring_leaf', { leafId: 'tm-leaf', processId: 'pc-p' });
  });

  it('brackets restore installation without caller-selected window labels', async () => {
    await tauriBridge.beginShellRestore();
    await tauriBridge.endShellRestore();
    expect(invokeMock.mock.calls).toEqual([['begin_shell_restore'], ['end_shell_restore']]);
  });

  it('releases a binding by leaf without an offer or a caller-supplied window label', async () => {
    await tauriBridge.releaseShellBinding('tm-moved');
    expect(invokeMock).toHaveBeenCalledWith('release_shell_binding', { leafId: 'tm-moved' });
  });

  it('binds the registered leaf with an optional expected process identity', async () => {
    invokeMock.mockResolvedValueOnce({ status: 'bound', processId: 'pc-created' });
    await expect(tauriBridge.bindShell('tm-moved', 'pc-created')).resolves.toEqual({ status: 'bound', processId: 'pc-created' });
    expect(invokeMock).toHaveBeenCalledWith('bind_shell', { leafId: 'tm-moved', processId: 'pc-created' });
  });

  it.each([{ status: 'pending' }, { status: 'refused' }, { status: 'none' }])('passes the binding answer %j through unchanged', async answer => {
    invokeMock.mockResolvedValueOnce(answer);
    await expect(tauriBridge.bindShell('tm-moved')).resolves.toEqual(answer);
    expect(invokeMock).toHaveBeenCalledWith('bind_shell', { leafId: 'tm-moved', processId: undefined });
  });

  it('surfaces register failure instead of allowing an unkeyed mount', async () => {
    invokeMock.mockRejectedValueOnce(new Error('transport down'));
    await expect(tauriBridge.registerRestoringLeaves([{ leafId: 'tm-modern' }])).rejects.toThrow('transport down');
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
