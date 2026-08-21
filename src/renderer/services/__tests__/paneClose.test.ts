import { closePaneNonBlocking } from '../paneClose';

describe('closePaneNonBlocking', () => {
  it('removes the pane from the UI synchronously even though the backend close never resolves', () => {
    const removeFromUi = jest.fn();
    const clearCwdSnapshot = jest.fn();
    const releaseSurface = jest.fn();
    const clearSessionExit = jest.fn();
    // Never resolves — proves the UI removal does not wait on it.
    const closeTerminal = jest.fn(() => new Promise<void>(() => {}));

    closePaneNonBlocking({
      terminalId: 'term-1',
      removeFromUi,
      closeTerminal,
      clearCwdSnapshot,
      releaseSurface,
      clearSessionExit,
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
    const clearSessionExit = jest.fn();
    const closeTerminal = jest.fn(() => Promise.resolve());

    closePaneNonBlocking({
      terminalId: 'term-3', removeFromUi, closeTerminal, clearCwdSnapshot, releaseSurface,
      clearSessionExit,
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
    const clearSessionExit = jest.fn();
    closePaneNonBlocking({
      terminalId: null,
      removeFromUi: jest.fn(),
      closeTerminal: jest.fn(() => Promise.resolve()),
      clearCwdSnapshot: jest.fn(),
      releaseSurface,
      clearSessionExit,
    });
    expect(releaseSurface).not.toHaveBeenCalled();
  });

  it('still removes the pane when terminalId is null, without touching the backend', () => {
    const removeFromUi = jest.fn();
    const clearCwdSnapshot = jest.fn();
    const releaseSurface = jest.fn();
    const clearSessionExit = jest.fn();
    const closeTerminal = jest.fn(() => Promise.resolve());

    closePaneNonBlocking({
      terminalId: null,
      removeFromUi,
      closeTerminal,
      clearCwdSnapshot,
      releaseSurface,
      clearSessionExit,
    });

    expect(removeFromUi).toHaveBeenCalledTimes(1);
    expect(clearCwdSnapshot).not.toHaveBeenCalled();
    expect(closeTerminal).not.toHaveBeenCalled();
  });

  it('swallows a rejected closeTerminal (no unhandled rejection)', async () => {
    const removeFromUi = jest.fn();
    const clearCwdSnapshot = jest.fn();
    const releaseSurface = jest.fn();
    const clearSessionExit = jest.fn();
    const closeTerminal = jest.fn(() => Promise.reject(new Error('backend kill failed')));

    expect(() =>
      closePaneNonBlocking({
        terminalId: 'term-2',
        removeFromUi,
        closeTerminal,
        clearCwdSnapshot,
        releaseSurface,
        clearSessionExit,
      }),
    ).not.toThrow();

    // Let the rejected promise's .catch() run.
    await new Promise((resolve) => setImmediate(resolve));

    expect(closeTerminal).toHaveBeenCalledTimes(1);
    expect(removeFromUi).toHaveBeenCalledTimes(1);
  });
});

/**
 * The session-closed record goes with the pane — `plan/024` Req 4.
 *
 * Same argument as `clearCwdSnapshot` and `releaseSurface`, and it is the third per-terminal map
 * this one function is responsible for draining. Two things go wrong without it: the map grows
 * for the life of the session, and — the reason this is more than tidiness — a recycled terminal
 * id inherits a dead shell's exit code and paints a "Session closed" banner over a live terminal.
 */
describe('closePaneNonBlocking — session-exit record', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    terminalId: 'term-9',
    removeFromUi: jest.fn(),
    closeTerminal: jest.fn(() => Promise.resolve()),
    clearCwdSnapshot: jest.fn(),
    releaseSurface: jest.fn(),
    clearSessionExit: jest.fn(),
    ...over,
  });

  it('drops the record, keyed by the same id as the rest of the teardown', () => {
    const d = deps();
    closePaneNonBlocking(d);
    expect(d.clearSessionExit).toHaveBeenCalledTimes(1);
    expect(d.clearSessionExit).toHaveBeenCalledWith('term-9');
  });

  // Synchronously, with the other two — not after the multi-second backend kill, which is
  // deliberately never awaited and may never resolve at all.
  it('drops it without waiting on the backend close', () => {
    const d = deps({ closeTerminal: jest.fn(() => new Promise<void>(() => {})) });
    closePaneNonBlocking(d);
    expect(d.clearSessionExit).toHaveBeenCalledTimes(1);
  });

  // The negative control, matching the one the cwd snapshot and the surface already have: the
  // early return covers all three.
  it('drops nothing when the pane has no terminal', () => {
    const d = deps({ terminalId: null });
    closePaneNonBlocking(d);
    expect(d.clearSessionExit).not.toHaveBeenCalled();
  });
});
