import { commandHistoryService } from '../commandHistoryService';

describe('commandHistoryService (backlog 011)', () => {
  const addCommandHistory = jest.fn().mockResolvedValue(undefined);
  const deleteCommandHistory = jest.fn().mockResolvedValue(undefined);
  const loadCommandHistory = jest
    .fn()
    .mockResolvedValue(['bun run test', 'dotnet build', 'git status']);

  beforeEach(() => {
    commandHistoryService.__reset();
    addCommandHistory.mockClear();
    deleteCommandHistory.mockClear();
    loadCommandHistory.mockClear();
    loadCommandHistory.mockResolvedValue(['bun run test', 'dotnet build', 'git status']);
    (global as any).window = (global as any).window || {};
    (global as any).window.electronAPI = { addCommandHistory, deleteCommandHistory, loadCommandHistory };
  });

  it('hydrate loads the most-recent-first list from the bridge', async () => {
    await commandHistoryService.hydrate();
    expect(loadCommandHistory).toHaveBeenCalledWith(2000);
    expect(commandHistoryService.match('git')).toEqual(['git status']);
  });

  it('record puts the command in front, dedupes, and persists', async () => {
    await commandHistoryService.hydrate();
    commandHistoryService.record('git status'); // re-run: moves to front
    expect(addCommandHistory).toHaveBeenCalledWith('git status');
    expect(commandHistoryService.match('g')[0]).toBe('git status');
    // dedupe: still exactly one "git status" entry
    expect(commandHistoryService.match('git st')).toEqual(['git status']);
  });

  it('match: prefix matches before substring matches, capped at limit', async () => {
    await commandHistoryService.hydrate();
    commandHistoryService.record('run build');
    expect(commandHistoryService.match('run')).toEqual(['run build', 'bun run test']);
    expect(commandHistoryService.match('run', { limit: 1 })).toEqual(['run build']);
  });

  it('match: empty input and exact-only match return nothing', async () => {
    await commandHistoryService.hydrate();
    expect(commandHistoryService.match('   ')).toEqual([]);
    expect(commandHistoryService.match('git status')).toEqual([]); // already fully typed
  });

  it('remove drops the entry from the index and persists the deletion', async () => {
    await commandHistoryService.hydrate();
    commandHistoryService.remove('git status');
    expect(deleteCommandHistory).toHaveBeenCalledWith('git status');
    expect(commandHistoryService.match('git')).toEqual([]);
    expect(commandHistoryService.match('b')[0]).toBe('bun run test'); // others intact
  });

  it('record ignores blank commands', () => {
    commandHistoryService.record('   ');
    expect(addCommandHistory).not.toHaveBeenCalled();
  });

  it('hydrate failure degrades to empty history (no throw)', async () => {
    loadCommandHistory.mockRejectedValueOnce(new Error('db gone'));
    await expect(commandHistoryService.hydrate()).resolves.toBeUndefined();
    expect(commandHistoryService.match('git')).toEqual([]);
  });
});

describe('commandHistoryService cwd-relevant ranking (Stream 4)', () => {
  const addCommandHistory = jest.fn().mockResolvedValue(undefined);
  const addCommandDirUsage = jest.fn().mockResolvedValue(undefined);
  const deleteCommandHistory = jest.fn().mockResolvedValue(undefined);
  const loadCommandHistory = jest.fn();
  const loadCommandDirUsage = jest.fn();

  beforeEach(() => {
    commandHistoryService.__reset();
    [addCommandHistory, addCommandDirUsage, deleteCommandHistory, loadCommandHistory, loadCommandDirUsage]
      .forEach((m) => m.mockClear());
    loadCommandHistory.mockResolvedValue(['curl x', 'cargo build', 'git status']);
    loadCommandDirUsage.mockResolvedValue([]);
    (global as any).window = (global as any).window || {};
    (global as any).window.electronAPI = {
      addCommandHistory, addCommandDirUsage, deleteCommandHistory, loadCommandHistory, loadCommandDirUsage,
    };
  });

  it('lifts an exact-directory command above unrelated global history', async () => {
    await commandHistoryService.hydrate(); // global: curl x, cargo build, git status
    loadCommandDirUsage.mockResolvedValue([
      { command: 'cargo build', dir: 'c:/proj/a', useCount: 3, lastUsedAt: 5 },
    ]);
    await commandHistoryService.ensureDirLoaded('C:\\proj\\a'); // normalizes to c:/proj/a
    // both 'curl x' and 'cargo build' prefix-match 'c'; global order puts curl first,
    // but cwd affinity lifts 'cargo build' to the front.
    expect(commandHistoryService.match('c', { cwd: 'C:\\proj\\a' })[0]).toBe('cargo build');
    expect(loadCommandDirUsage).toHaveBeenCalledWith('c:/proj/a');
  });

  it('ranks exact > descendant > ancestor', async () => {
    loadCommandHistory.mockResolvedValue(['a-cmd', 'b-cmd', 'c-cmd']);
    await commandHistoryService.hydrate();
    loadCommandDirUsage.mockResolvedValue([
      { command: 'c-cmd', dir: 'c:/proj/a', useCount: 1, lastUsedAt: 1 },     // exact
      { command: 'b-cmd', dir: 'c:/proj/a/sub', useCount: 1, lastUsedAt: 2 }, // descendant
      { command: 'a-cmd', dir: 'c:/proj', useCount: 1, lastUsedAt: 3 },       // ancestor
    ]);
    await commandHistoryService.ensureDirLoaded('c:/proj/a');
    expect(commandHistoryService.match('cmd', { cwd: 'c:/proj/a' })).toEqual(['c-cmd', 'b-cmd', 'a-cmd']);
  });

  it('with no cwd, order is the global recency/prefix order (no dir lookup)', async () => {
    await commandHistoryService.hydrate();
    expect(commandHistoryService.match('c')).toEqual(['curl x', 'cargo build']);
    expect(loadCommandDirUsage).not.toHaveBeenCalled();
  });

  it('falls back to global order when the cwd has no cached affinity', async () => {
    await commandHistoryService.hydrate();
    // ensureDirLoaded never called for this cwd → no cache → global order.
    expect(commandHistoryService.match('c', { cwd: 'c:/unknown' })).toEqual(['curl x', 'cargo build']);
  });

  it('ensureDirLoaded is a no-op for empty/absent cwd (no bridge call)', async () => {
    await commandHistoryService.ensureDirLoaded(undefined);
    await commandHistoryService.ensureDirLoaded('');
    expect(loadCommandDirUsage).not.toHaveBeenCalled();
  });

  it('record(cmd, cwd) persists dir usage with a normalized path', async () => {
    commandHistoryService.record('cargo build', 'C:\\proj\\A\\');
    expect(addCommandHistory).toHaveBeenCalledWith('cargo build');
    expect(addCommandDirUsage).toHaveBeenCalledWith('cargo build', 'c:/proj/a');
  });

  it('record without a cwd never touches dir usage', async () => {
    commandHistoryService.record('ls');
    expect(addCommandDirUsage).not.toHaveBeenCalled();
  });
});
