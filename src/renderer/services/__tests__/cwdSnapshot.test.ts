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
  sampleCwdGeneration,
  __resetCwdSnapshots,
} from '../cwdSnapshot';

const getTerminalCwds = jest.fn();
const getProcessId = jest.fn();
jest.mock('../TerminalService', () => ({
  terminalService: { getProcessId: (id: string) => getProcessId(id) },
}));

/** The batch command is keyed by PROCESS id (the backend's terminal id — what the
 *  renderer passes as `id`), so tests answer in those terms. */
function mockCwdsByPid(byPid: Record<string, string | null>) {
  getTerminalCwds.mockImplementation(async (pids: string[]) =>
    Object.fromEntries(pids.map(pid => [pid, byPid[pid] ?? null])),
  );
}

beforeEach(() => {
  __resetCwdSnapshots();
  jest.clearAllMocks();
  (window as any).electronAPI = { getTerminalCwds };
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
    mockCwdsByPid({ 'proc-1': 'D:\\one', 'proc-2': 'D:\\two' });
    await refreshLiveCwds(['tm-1', 'tm-2']);
    expect(getAllCwdSnapshots()).toEqual({ 'tm-1': 'D:\\one', 'tm-2': 'D:\\two' });
  });

  it('reads every terminal in ONE call — a full process scan per terminal is the cost this batch exists to avoid', async () => {
    getProcessId.mockImplementation((id: string) => `proc-${id.slice(3)}`);
    mockCwdsByPid({ 'proc-1': 'D:\\one', 'proc-2': 'D:\\two', 'proc-3': 'D:\\three' });
    await refreshLiveCwds(['tm-1', 'tm-2', 'tm-3']);
    expect(getTerminalCwds).toHaveBeenCalledTimes(1);
    expect(getTerminalCwds).toHaveBeenCalledWith(['proc-1', 'proc-2', 'proc-3']);
  });

  it('keeps the previous value when a terminal reports no cwd', async () => {
    setCwdSnapshot('tm-1', 'D:\\old');
    getProcessId.mockReturnValue('proc-1');
    mockCwdsByPid({ 'proc-1': null });
    await refreshLiveCwds(['tm-1']);
    expect(getCwdSnapshot('tm-1')).toBe('D:\\old');
  });

  it('skips terminals with no live process', async () => {
    getProcessId.mockReturnValue(undefined);
    await refreshLiveCwds(['tm-1']);
    expect(getTerminalCwds).not.toHaveBeenCalled();
    expect(getAllCwdSnapshots()).toEqual({});
  });

  it('does not call the backend at all when no terminal needs a read', async () => {
    getProcessId.mockReturnValue(undefined);
    await refreshLiveCwds([]);
    expect(getTerminalCwds).not.toHaveBeenCalled();
  });

  it('never rejects when the read fails — autosave must not break', async () => {
    getProcessId.mockImplementation((id: string) => (id === 'tm-1' ? 'proc-1' : 'proc-2'));
    getTerminalCwds.mockRejectedValue(new Error('gone'));
    await expect(refreshLiveCwds(['tm-1', 'tm-2'])).resolves.toBeUndefined();
  });

  it('stores the terminals the batch did answer for, ignoring the ones it omitted', async () => {
    getProcessId.mockImplementation((id: string) => (id === 'tm-1' ? 'proc-1' : 'proc-2'));
    // proc-1 died mid-scan, so the backend has no entry for it.
    getTerminalCwds.mockResolvedValue({ 'proc-2': 'D:\\two' });
    await refreshLiveCwds(['tm-1', 'tm-2']);
    expect(getAllCwdSnapshots()).toEqual({ 'tm-2': 'D:\\two' });
  });

  it('survives a missing getTerminalCwds API', async () => {
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
    let resolveBatch!: (byPid: Record<string, string>) => void;
    getTerminalCwds.mockReturnValue(
      new Promise<Record<string, string>>((resolve) => {
        resolveBatch = resolve;
      }),
    );
    const done = refreshLiveCwds([terminalId]);
    return { done, resolveRead: (cwd: string) => resolveBatch({ 'proc-1': cwd }) };
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
    mockCwdsByPid({ 'proc-9': 'D:\\fresh' });
    await refreshLiveCwds(['tm-1']);
    expect(getCwdSnapshot('tm-1')).toBe('D:\\fresh');
  });
});

/**
 * A pane's close path runs `closeTerminal()` then `clearCwdSnapshot()`, but the
 * resulting `terminal:exit` lands AFTERWARDS. An unconditional `final` write would
 * re-add the entry of a pane that no longer exists — contradicting the "cannot grow
 * without bound" guarantee the clear is there to provide.
 *
 * The exit write gets the same contract the refresh has: sample the generation while
 * the terminal is known live (the pane subscribes), and drop the write if a clear
 * moved it in the meantime.
 */
describe('a cleared pane is not resurrected by its own late exit (spec 045 §3.3)', () => {
  it('drops a final write whose terminal was cleared after the sample — the closed-pane case', () => {
    // The pane subscribes to pty:exit while its terminal is live.
    const generation = sampleCwdGeneration('tm-1');
    setCwdSnapshot('tm-1', 'D:\\live');

    // performClose: closeTerminal() then clearCwdSnapshot(). The pane is gone.
    clearCwdSnapshot('tm-1');

    // The backend's exit event finally arrives, carrying the shell's last cwd.
    setCwdSnapshot('tm-1', 'D:\\dead', { final: true, generation });

    expect(getCwdSnapshot('tm-1')).toBeUndefined();
    expect(getAllCwdSnapshots()).toEqual({});
  });

  it('still lands a final write for a LIVE terminal — the restart case, requirement 3', () => {
    // The pane subscribed while live; nothing cleared since.
    const generation = sampleCwdGeneration('tm-1');

    // The shell exits normally. This directory is what Restart must reopen in.
    setCwdSnapshot('tm-1', 'D:\\b', { final: true, generation });

    expect(getCwdSnapshot('tm-1')).toBe('D:\\b');
  });

  it('lands a final write for a terminal that was restarted after a clear', () => {
    // Restart clears, then the pane re-subscribes (processId changed) and so
    // re-samples. The guard must not freeze the id forever.
    clearCwdSnapshot('tm-1');
    const generation = sampleCwdGeneration('tm-1');
    setCwdSnapshot('tm-1', 'D:\\after-restart', { final: true, generation });
    expect(getCwdSnapshot('tm-1')).toBe('D:\\after-restart');
  });

  it('an ungated final write still lands — callers that never sampled are unaffected', () => {
    setCwdSnapshot('tm-1', 'D:\\b', { final: true });
    expect(getCwdSnapshot('tm-1')).toBe('D:\\b');
  });
});
