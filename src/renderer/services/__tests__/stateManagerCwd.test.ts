/**
 * Spec 045 §3.3b: a restored terminal resumes in the directory it was last in.
 * The map is persisted alongside the pane trees and seeded back before any pane
 * spawns. Legacy saved state (no terminalCwds key) must still load.
 */
import { pruneCwds, seedRestoredCwds } from '../stateManagerCwd';
import { getCwdSnapshot, setCwdSnapshot, getAllCwdSnapshots, __resetCwdSnapshots } from '../cwdSnapshot';

jest.mock('../TerminalService', () => ({ terminalService: { getProcessId: () => undefined } }));

beforeEach(() => __resetCwdSnapshots());

describe('pruneCwds', () => {
  it('keeps only directories for terminals that still exist', () => {
    expect(pruneCwds({ 'tm-1': 'C:\\a', 'tm-gone': 'C:\\b' }, new Set(['tm-1']))).toEqual({ 'tm-1': 'C:\\a' });
  });

  it('returns an empty map when nothing survives', () => {
    expect(pruneCwds({ 'tm-gone': 'C:\\b' }, new Set())).toEqual({});
  });

  it('tolerates an empty input map', () => {
    expect(pruneCwds({}, new Set(['tm-1']))).toEqual({});
  });
});

describe('seedRestoredCwds', () => {
  it('seeds saved directories so the spawn path can use them', () => {
    seedRestoredCwds({ 'tm-1': 'D:\\work', 'tm-2': 'C:\\other' });
    expect(getCwdSnapshot('tm-1')).toBe('D:\\work');
    expect(getCwdSnapshot('tm-2')).toBe('C:\\other');
  });

  it('tolerates legacy state with no cwd map', () => {
    expect(() => seedRestoredCwds(undefined)).not.toThrow();
    expect(getAllCwdSnapshots()).toEqual({});
  });

  it('ignores malformed entries rather than throwing mid-restore', () => {
    seedRestoredCwds({ 'tm-1': '', 'tm-2': null as unknown as string, 'tm-3': 'C:\\ok' });
    expect(getCwdSnapshot('tm-1')).toBeUndefined();
    expect(getCwdSnapshot('tm-2')).toBeUndefined();
    expect(getCwdSnapshot('tm-3')).toBe('C:\\ok');
  });

  it('does not clobber a fresher live value with a stale saved one', () => {
    setCwdSnapshot('tm-1', 'D:\\fresh');
    seedRestoredCwds({ 'tm-1': 'D:\\stale' });
    expect(getCwdSnapshot('tm-1')).toBe('D:\\fresh');
  });
});
