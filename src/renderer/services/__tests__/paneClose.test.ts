import { closePaneNonBlocking } from '../paneClose';

describe('closePaneNonBlocking', () => {
  it('removes the pane from the UI synchronously even though the backend close never resolves', () => {
    const removeFromUi = jest.fn();
    const clearCwdSnapshot = jest.fn();
    const releaseSurface = jest.fn();
    // Never resolves — proves the UI removal does not wait on it.
    const closeTerminal = jest.fn(() => new Promise<void>(() => {}));

    closePaneNonBlocking({
      terminalId: 'term-1',
      removeFromUi,
      closeTerminal,
      clearCwdSnapshot,
      releaseSurface,
    });

    expect(removeFromUi).toHaveBeenCalledTimes(1);
    expect(clearCwdSnapshot).toHaveBeenCalledTimes(1);
    expect(clearCwdSnapshot).toHaveBeenCalledWith('term-1');
    expect(closeTerminal).toHaveBeenCalledTimes(1);
    expect(closeTerminal).toHaveBeenCalledWith('term-1');
  });

  /**
   * The cached xterm engine goes with the pane — the leak this dep exists to close.
   *
   * `cleanupTerminalCache` had exactly ONE caller: the TAB-close path. Closing a single pane
   * killed the PTY and left the whole cache entry behind, holding a WebGL context that
   * `countActiveWebGLAddons()` kept counting against the 12-context budget for the rest of
   * the session. Split and close panes for long enough and every terminal opened afterwards
   * silently falls back to DOM rendering.
   */
  it('releases the terminal surface, keyed by the same id as the rest of the teardown', () => {
    const removeFromUi = jest.fn();
    const clearCwdSnapshot = jest.fn();
    const releaseSurface = jest.fn();
    const closeTerminal = jest.fn(() => Promise.resolve());

    closePaneNonBlocking({
      terminalId: 'term-3', removeFromUi, closeTerminal, clearCwdSnapshot, releaseSurface,
    });

    expect(releaseSurface).toHaveBeenCalledTimes(1);
    // The cache is keyed by TERMINAL id, so a tab id here would both miss a split tab's
    // extra panes and dispose a pane that had moved away.
    expect(releaseSurface).toHaveBeenCalledWith('term-3');
    // ...and it happens with the UI removal, not after the backend has finished — the PTY
    // kill takes seconds and is deliberately never awaited.
    expect(removeFromUi).toHaveBeenCalledTimes(1);
  });

  // Nothing to release when there is no terminal, exactly as with the cwd snapshot: the
  // early return covers all three, and this is the negative control for the assert above.
  it('releases nothing when the pane has no terminal', () => {
    const releaseSurface = jest.fn();
    closePaneNonBlocking({
      terminalId: null,
      removeFromUi: jest.fn(),
      closeTerminal: jest.fn(() => Promise.resolve()),
      clearCwdSnapshot: jest.fn(),
      releaseSurface,
    });
    expect(releaseSurface).not.toHaveBeenCalled();
  });

  it('still removes the pane when terminalId is null, without touching the backend', () => {
    const removeFromUi = jest.fn();
    const clearCwdSnapshot = jest.fn();
    const releaseSurface = jest.fn();
    const closeTerminal = jest.fn(() => Promise.resolve());

    closePaneNonBlocking({
      terminalId: null,
      removeFromUi,
      closeTerminal,
      clearCwdSnapshot,
      releaseSurface,
    });

    expect(removeFromUi).toHaveBeenCalledTimes(1);
    expect(clearCwdSnapshot).not.toHaveBeenCalled();
    expect(closeTerminal).not.toHaveBeenCalled();
  });

  it('swallows a rejected closeTerminal (no unhandled rejection)', async () => {
    const removeFromUi = jest.fn();
    const clearCwdSnapshot = jest.fn();
    const releaseSurface = jest.fn();
    const closeTerminal = jest.fn(() => Promise.reject(new Error('backend kill failed')));

    expect(() =>
      closePaneNonBlocking({
        terminalId: 'term-2',
        removeFromUi,
        closeTerminal,
        clearCwdSnapshot,
        releaseSurface,
      }),
    ).not.toThrow();

    // Let the rejected promise's .catch() run.
    await new Promise((resolve) => setImmediate(resolve));

    expect(closeTerminal).toHaveBeenCalledTimes(1);
    expect(removeFromUi).toHaveBeenCalledTimes(1);
  });
});
