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
    expect(commandHistoryService.match('run', 1)).toEqual(['run build']);
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
