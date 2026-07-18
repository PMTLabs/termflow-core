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
      }),
    ).not.toThrow();

    // Let the rejected promise's .catch() run.
    await new Promise((resolve) => setImmediate(resolve));

    expect(closeTerminal).toHaveBeenCalledTimes(1);
    expect(removeFromUi).toHaveBeenCalledTimes(1);
  });
});
