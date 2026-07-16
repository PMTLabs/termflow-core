/**
 * @jest-environment jsdom
 */
/**
 * Spec 045 §3.3 — last-known cwd per terminal.
 *
 * The value arrives two ways, each exact for its moment:
 *  - restart: from the terminal:exit payload (Task 3), because the backend wipes
 *    terminal_cwds BEFORE emitting the event — a renderer read is always None.
 *  - session save: refreshLiveCwds() on the existing autosave tick, because a
 *    terminal still running at quit never fires an exit event at all.
 */
import {
  setCwdSnapshot,
  getCwdSnapshot,
  clearCwdSnapshot,
  getAllCwdSnapshots,
  refreshLiveCwds,
  __resetCwdSnapshots,
} from '../cwdSnapshot';

const getTerminalCwd = jest.fn();
const getProcessId = jest.fn();
jest.mock('../TerminalService', () => ({
  terminalService: { getProcessId: (id: string) => getProcessId(id) },
}));

beforeEach(() => {
  __resetCwdSnapshots();
  jest.clearAllMocks();
  (window as any).electronAPI = { getTerminalCwd };
});

describe('snapshot store', () => {
  it('keeps snapshots per terminal id', () => {
    setCwdSnapshot('tm-1', 'C:\\a');
    setCwdSnapshot('tm-2', 'C:\\b');
    expect(getCwdSnapshot('tm-1')).toBe('C:\\a');
    expect(getCwdSnapshot('tm-2')).toBe('C:\\b');
  });

  it('ignores null/undefined/empty (the exit payload may carry no cwd)', () => {
    setCwdSnapshot('tm-1', null);
    setCwdSnapshot('tm-2', undefined);
    setCwdSnapshot('tm-3', '');
    expect(getAllCwdSnapshots()).toEqual({});
  });

  it('clears one snapshot', () => {
    setCwdSnapshot('tm-1', 'C:\\a');
    clearCwdSnapshot('tm-1');
    expect(getCwdSnapshot('tm-1')).toBeUndefined();
  });

  it('exposes all snapshots for persistence', () => {
    setCwdSnapshot('tm-1', 'C:\\a');
    expect(getAllCwdSnapshots()).toEqual({ 'tm-1': 'C:\\a' });
  });
});

describe('refreshLiveCwds (spec 045 §3.3b)', () => {
  it('captures the cwd of RUNNING terminals — the session-restore case', async () => {
    getProcessId.mockImplementation((id: string) => (id === 'tm-1' ? 'proc-1' : 'proc-2'));
    getTerminalCwd.mockImplementation(async (pid: string) =>
      pid === 'proc-1' ? 'D:\\one' : 'D:\\two',
    );
    await refreshLiveCwds(['tm-1', 'tm-2']);
    expect(getAllCwdSnapshots()).toEqual({ 'tm-1': 'D:\\one', 'tm-2': 'D:\\two' });
  });

  it('keeps the previous value when a terminal reports no cwd', async () => {
    setCwdSnapshot('tm-1', 'D:\\old');
    getProcessId.mockReturnValue('proc-1');
    getTerminalCwd.mockResolvedValue(null);
    await refreshLiveCwds(['tm-1']);
    expect(getCwdSnapshot('tm-1')).toBe('D:\\old');
  });

  it('skips terminals with no live process', async () => {
    getProcessId.mockReturnValue(undefined);
    await refreshLiveCwds(['tm-1']);
    expect(getTerminalCwd).not.toHaveBeenCalled();
    expect(getAllCwdSnapshots()).toEqual({});
  });

  it('never rejects when one terminal read fails — autosave must not break', async () => {
    getProcessId.mockImplementation((id: string) => (id === 'tm-1' ? 'proc-1' : 'proc-2'));
    getTerminalCwd.mockImplementation(async (pid: string) => {
      if (pid === 'proc-1') throw new Error('gone');
      return 'D:\\two';
    });
    await expect(refreshLiveCwds(['tm-1', 'tm-2'])).resolves.toBeUndefined();
    // The healthy terminal is still captured.
    expect(getCwdSnapshot('tm-2')).toBe('D:\\two');
  });

  it('survives a missing getTerminalCwd API', async () => {
    (window as any).electronAPI = {};
    getProcessId.mockReturnValue('proc-1');
    await expect(refreshLiveCwds(['tm-1'])).resolves.toBeUndefined();
  });
});

/**
 * The exit payload is the AUTHORITY on where a shell finally stood; a refresh is
 * only a periodic guess about a still-live shell. A refresh reads the terminal id
 * BEFORE its await, so a slow read can land after the terminal has already exited
 * (or been restarted) and clobber the exact value with a pre-`cd` one — the very
 * wrong-directory bug this snapshot exists to prevent. Exit writes and clears
 * therefore invalidate any refresh that was in flight when they happened.
 */
describe('exit writes outrank a refresh in flight (spec 045 §3.3)', () => {
  /** Start a refresh whose read is stuck, so the test can act "during" it. */
  function refreshWithPendingRead(terminalId: string) {
    getProcessId.mockReturnValue('proc-1');
    let resolveRead!: (cwd: string) => void;
    getTerminalCwd.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRead = resolve;
      }),
    );
    return { done: refreshLiveCwds([terminalId]), resolveRead };
  }

  it('a stale refresh must not overwrite the cwd captured at exit', async () => {
    // t=0: autosave tick starts reading tm-1, which is sitting in D:\a.
    const { done, resolveRead } = refreshWithPendingRead('tm-1');

    // t=50ms: the user runs `cd D:\b; exit`. The backend captures D:\b at exit and
    // hands it to us in the terminal:exit payload — this is the exact directory.
    setCwdSnapshot('tm-1', 'D:\\b', { final: true });

    // t=200ms: the read from t=0 finally resolves with the now-stale D:\a.
    resolveRead('D:\\a');
    await done;

    // Restart must reopen in D:\b, not the directory the shell had left.
    expect(getCwdSnapshot('tm-1')).toBe('D:\\b');
  });

  it('a stale refresh must not repopulate an entry a restart just cleared', async () => {
    const { done, resolveRead } = refreshWithPendingRead('tm-1');

    // The shell exits, then the user hits Restart: handleRestart consumes the
    // snapshot and clears it so a LATER cwd-less exit cannot reuse this directory.
    setCwdSnapshot('tm-1', 'D:\\b', { final: true });
    clearCwdSnapshot('tm-1');

    // The refresh from before the exit resolves and must NOT resurrect the entry.
    resolveRead('D:\\a');
    await done;

    expect(getCwdSnapshot('tm-1')).toBeUndefined();
  });

  it('a clear alone (pane closed) also invalidates a refresh in flight', async () => {
    const { done, resolveRead } = refreshWithPendingRead('tm-1');
    clearCwdSnapshot('tm-1');
    resolveRead('D:\\a');
    await done;
    expect(getCwdSnapshot('tm-1')).toBeUndefined();
  });

  it('still stores a refresh that raced with nothing — the normal tick', async () => {
    const { done, resolveRead } = refreshWithPendingRead('tm-1');
    resolveRead('D:\\a');
    await done;
    expect(getCwdSnapshot('tm-1')).toBe('D:\\a');
  });

  it('a later refresh may update a terminal that exited and was restarted', async () => {
    // The generation guard must not permanently freeze an id: after the restart's
    // clear, a NEW refresh (started afterwards) is current and must be stored.
    setCwdSnapshot('tm-1', 'D:\\b', { final: true });
    clearCwdSnapshot('tm-1');
    getProcessId.mockReturnValue('proc-9');
    getTerminalCwd.mockResolvedValue('D:\\fresh');
    await refreshLiveCwds(['tm-1']);
    expect(getCwdSnapshot('tm-1')).toBe('D:\\fresh');
  });
});
