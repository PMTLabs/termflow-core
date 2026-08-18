import { closePaneNonBlocking } from '../paneClose';

describe('closePaneNonBlocking', () => {
  it('removes the pane from the UI synchronously even though the backend close never resolves', () => {
    const removeFromUi = jest.fn();
    const clearCwdSnapshot = jest.fn();
    // Never resolves — proves the UI removal does not wait on it.
    const closeTerminal = jest.fn(() => new Promise<void>(() => {}));

    closePaneNonBlocking({
      terminalId: 'term-1',
      removeFromUi,
      closeTerminal,
      clearCwdSnapshot,
      releaseSurface: jest.fn(),
    });

    expect(removeFromUi).toHaveBeenCalledTimes(1);
    expect(clearCwdSnapshot).toHaveBeenCalledTimes(1);
    expect(clearCwdSnapshot).toHaveBeenCalledWith('term-1');
    expect(closeTerminal).toHaveBeenCalledTimes(1);
    expect(closeTerminal).toHaveBeenCalledWith('term-1');
  });

  it('still removes the pane when terminalId is null, without touching the backend', () => {
    const removeFromUi = jest.fn();
    const clearCwdSnapshot = jest.fn();
    const closeTerminal = jest.fn(() => Promise.resolve());

    closePaneNonBlocking({
      terminalId: null,
      removeFromUi,
      closeTerminal,
      clearCwdSnapshot,
      releaseSurface: jest.fn(),
    });

    expect(removeFromUi).toHaveBeenCalledTimes(1);
    expect(clearCwdSnapshot).not.toHaveBeenCalled();
    expect(closeTerminal).not.toHaveBeenCalled();
  });

  it('swallows a rejected closeTerminal (no unhandled rejection)', async () => {
    const removeFromUi = jest.fn();
    const clearCwdSnapshot = jest.fn();
    const closeTerminal = jest.fn(() => Promise.reject(new Error('backend kill failed')));

    expect(() =>
      closePaneNonBlocking({
        terminalId: 'term-2',
        removeFromUi,
        closeTerminal,
        clearCwdSnapshot,
        releaseSurface: jest.fn(),
      }),
    ).not.toThrow();

    // Let the rejected promise's .catch() run.
    await new Promise((resolve) => setImmediate(resolve));

    expect(closeTerminal).toHaveBeenCalledTimes(1);
    expect(removeFromUi).toHaveBeenCalledTimes(1);
  });

  /**
   * The pane's xterm engine owns a WebGL context, and a browser renderer allows only
   * ~16 of them. `cleanupTerminalCache` had ONE production caller — tab close — so
   * closing a split pane killed the PTY and left the cache entry, and its context,
   * alive for the rest of the session. Once the browser cap is passed it drops the
   * OLDEST context, which is the longest-running terminal; that terminal's addon is
   * disposed and never reloaded, so it falls back to the DOM renderer permanently and
   * re-renders full rows on every selection change.
   */
  it('releases the cached surface for the pane terminal, so its WebGL context is not leaked', () => {
    const releaseSurface = jest.fn();

    closePaneNonBlocking({
      terminalId: 'term-3',
      removeFromUi: jest.fn(),
      closeTerminal: jest.fn(() => new Promise<void>(() => {})),
      clearCwdSnapshot: jest.fn(),
      releaseSurface,
    });

    expect(releaseSurface).toHaveBeenCalledTimes(1);
    expect(releaseSurface).toHaveBeenCalledWith('term-3');
  });

  it('does not release a surface when the pane has no terminal', () => {
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
});
