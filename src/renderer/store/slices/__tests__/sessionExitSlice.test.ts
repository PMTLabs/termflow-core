import reducer, {
  markSessionClosed, clearSessionClosed, clearAllSessionClosed,
} from '../sessionExitSlice';

/**
 * The per-terminal session-exit fact (`plan/024` Req 4).
 *
 * It exists because the two facts already in the store answer a different question:
 * `Tab.exited` is tab-level and only flips once EVERY pane has exited, and
 * `terminalService.getProcessId` is imperative and re-renders nothing. A canvas node is a PANE
 * and has to paint, so it needed a per-terminal, reactive one.
 */
const init = () => reducer(undefined, { type: '@@INIT' } as never);

describe('sessionExitSlice', () => {
  it('records an exit code against one terminal only', () => {
    const next = reducer(init(), markSessionClosed({ terminalId: 'tm-1', exitCode: 130 }));
    expect(next.byTerminalId['tm-1']).toEqual({ exitCode: 130 });
    expect(next.byTerminalId['tm-2']).toBeUndefined();
  });

  it('records a null exit code when the backend could not report one', () => {
    const next = reducer(init(), markSessionClosed({ terminalId: 'tm-1', exitCode: null }));
    expect(next.byTerminalId['tm-1']).toEqual({ exitCode: null });
  });

  it('records exit code 0 as a real value, not as absence', () => {
    // The trap in every `if (exitCode)` written against this: a clean exit is still an exit.
    const next = reducer(init(), markSessionClosed({ terminalId: 'tm-1', exitCode: 0 }));
    expect(next.byTerminalId['tm-1']).toEqual({ exitCode: 0 });
    expect('tm-1' in next.byTerminalId).toBe(true);
  });

  /**
   * Clearing DELETES the key rather than writing a sentinel, and the two states it collapses are
   * the point: "restarted" and "never started" must be indistinguishable. A terminal left
   * carrying `{ exitCode: null }` as a stand-in for "cleared" would look exactly like one whose
   * shell died without a status, and its node would stay muted for the rest of the session.
   */
  it('clearing removes the entry entirely rather than blanking it', () => {
    let state = reducer(init(), markSessionClosed({ terminalId: 'tm-1', exitCode: 1 }));
    state = reducer(state, clearSessionClosed({ terminalId: 'tm-1' }));
    expect(state.byTerminalId['tm-1']).toBeUndefined();
    expect('tm-1' in state.byTerminalId).toBe(false);
    // Which makes it identical to a terminal that never exited at all.
    expect(state.byTerminalId).toEqual(init().byTerminalId);
  });

  it('clearing one terminal leaves its siblings closed', () => {
    let state = reducer(init(), markSessionClosed({ terminalId: 'tm-1', exitCode: 1 }));
    state = reducer(state, markSessionClosed({ terminalId: 'tm-2', exitCode: 2 }));
    state = reducer(state, clearSessionClosed({ terminalId: 'tm-1' }));
    expect(state.byTerminalId['tm-1']).toBeUndefined();
    expect(state.byTerminalId['tm-2']).toEqual({ exitCode: 2 });
  });

  it('is idempotent — a repeated exit event is not a new fact', () => {
    let state = reducer(init(), markSessionClosed({ terminalId: 'tm-1', exitCode: 1 }));
    const once = state.byTerminalId['tm-1'];
    state = reducer(state, markSessionClosed({ terminalId: 'tm-1', exitCode: 1 }));
    expect(state.byTerminalId['tm-1']).toEqual(once);
  });

  it('clearing a terminal that was never closed is a no-op', () => {
    const state = reducer(init(), clearSessionClosed({ terminalId: 'tm-nope' }));
    expect(state.byTerminalId).toEqual({});
  });

  it('clearAll drops every entry', () => {
    let state = reducer(init(), markSessionClosed({ terminalId: 'tm-1', exitCode: 1 }));
    state = reducer(state, markSessionClosed({ terminalId: 'tm-2', exitCode: 0 }));
    state = reducer(state, clearAllSessionClosed());
    expect(state.byTerminalId).toEqual({});
  });
});
