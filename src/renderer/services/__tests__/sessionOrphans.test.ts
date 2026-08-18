import { sweepOrphanSessions, MutableKeyValueStore } from '../sessionOrphans';
import { __setWindowForTests, SLOT_ZERO_ID } from '../windowScope';
import { __setProfileForTests, DEFAULT_SCOPE } from '../profileScope';

function store(entries: Record<string, string>): MutableKeyValueStore {
  const data = { ...entries };
  return {
    get length() {
      return Object.keys(data).length;
    },
    key: (i: number) => Object.keys(data)[i] ?? null,
    getItem: (k: string) => (k in data ? data[k] : null),
    removeItem: (k: string) => {
      delete data[k];
    },
    // exposed for assertions
    ...({ _data: data } as object),
  } as MutableKeyValueStore & { _data: Record<string, string> };
}

const remaining = (s: MutableKeyValueStore) =>
  Object.keys((s as unknown as { _data: Record<string, string> })._data).sort();

describe('sweepOrphanSessions', () => {
  afterEach(() => {
    __setWindowForTests(SLOT_ZERO_ID);
    __setProfileForTests({
      name: DEFAULT_SCOPE,
      scope: DEFAULT_SCOPE,
      elevated: false,
      isDefault: true,
      key: '',
    });
  });

  it('drops sessions for windows that are gone and keeps the live ones', () => {
    const s = store({
      'auto-terminal-state': 'slot0',
      'auto-terminal-state#w1': 'live',
      'auto-terminal-state#w2': 'closed',
      'auto-terminal-state#w3': 'closed',
    });
    const result = sweepOrphanSessions(s, ['w0', 'w1']);
    expect(result.removed.sort()).toEqual(['auto-terminal-state#w2', 'auto-terminal-state#w3']);
    // Assert what SURVIVED by count and content, not just what was deleted:
    // an over-eager sweep deletes a live window's tabs.
    expect(remaining(s)).toEqual(['auto-terminal-state', 'auto-terminal-state#w1']);
  });

  it('never touches another profile s sessions', () => {
    // Running as the DEFAULT profile: the `work` keys belong to a separate
    // instance whose windows this registry knows nothing about. Sweeping them
    // would delete a live sibling's tabs.
    const s = store({
      'auto-terminal-state': 'mine',
      'auto-terminal-state:work': 'theirs',
      'auto-terminal-state:work#w9': 'theirs',
    });
    const result = sweepOrphanSessions(s, ['w0']);
    expect(result.removed).toEqual([]);
    expect(remaining(s)).toEqual([
      'auto-terminal-state',
      'auto-terminal-state:work',
      'auto-terminal-state:work#w9',
    ]);
  });

  it('sweeps only its own profile s keys when running as that profile', () => {
    __setProfileForTests({ name: 'work', scope: 'work', isDefault: false });
    const s = store({
      'auto-terminal-state': 'default-instance',
      'auto-terminal-state:work': 'work-slot0',
      'auto-terminal-state:work#w9': 'work-orphan',
    });
    sweepOrphanSessions(s, ['w0']);
    expect(remaining(s)).toEqual(['auto-terminal-state', 'auto-terminal-state:work']);
  });

  it('never touches non-session keys', () => {
    const s = store({
      'auto-terminal-state': 'session',
      'auto-terminal-layouts': 'the user s saved layouts',
      api_token: 'secret',
      'some-other-app': 'x',
    });
    sweepOrphanSessions(s, ['w0']);
    expect(remaining(s)).toEqual([
      'api_token',
      'auto-terminal-layouts',
      'auto-terminal-state',
      'some-other-app',
    ]);
  });

  it('does nothing at all when the live list is empty', () => {
    // An empty list is indistinguishable from a backend that failed to answer.
    // Treating it as "no windows are live" would delete every session there is,
    // including the one this window is about to write.
    const s = store({
      'auto-terminal-state': 'a',
      'auto-terminal-state#w1': 'b',
    });
    const result = sweepOrphanSessions(s, []);
    expect(result.skipped).toBe(true);
    expect(result.removed).toEqual([]);
    expect(remaining(s)).toEqual(['auto-terminal-state', 'auto-terminal-state#w1']);
  });

  it('drops slot 0 s key when slot 0 itself is gone', () => {
    // The original main window can be closed while others stay open; its blob
    // is then an orphan like any other.
    const s = store({
      'auto-terminal-state': 'the old main window',
      'auto-terminal-state#w5': 'live',
    });
    sweepOrphanSessions(s, ['w5']);
    expect(remaining(s)).toEqual(['auto-terminal-state#w5']);
  });

  it('survives removal shifting the key indices', () => {
    // Snapshotting the key list matters: removeItem re-indexes the store, so an
    // in-place loop would skip every key after the first deletion.
    const entries: Record<string, string> = { 'auto-terminal-state': 'live' };
    for (let i = 1; i <= 8; i++) entries[`auto-terminal-state#dead${i}`] = 'x';
    const s = store(entries);
    const result = sweepOrphanSessions(s, ['w0']);
    expect(result.removed).toHaveLength(8);
    expect(remaining(s)).toEqual(['auto-terminal-state']);
  });
});
