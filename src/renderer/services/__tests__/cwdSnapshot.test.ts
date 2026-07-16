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
