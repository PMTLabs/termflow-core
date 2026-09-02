import { collectTerminalIds, unionKeepSet, terminalIdsInOtherWindows, KeyValueStore } from '../sessionKeepSet';
import { __setWindowForTests, SLOT_ZERO_ID } from '../windowScope';
import { __setProfileForTests, DEFAULT_SCOPE } from '../profileScope';

/** A minimal in-memory store with deterministic key order. */
function store(entries: Record<string, string>): KeyValueStore {
  const keys = Object.keys(entries);
  return {
    get length() {
      return keys.length;
    },
    key: (i: number) => keys[i] ?? null,
    getItem: (k: string) => (k in entries ? entries[k] : null),
  };
}

const session = (tabIds: string[], panes: Record<string, unknown> = {}) =>
  JSON.stringify({ tabs: tabIds.map(id => ({ id })), tabPanes: panes });

const leaf = (terminalId: string) => ({ type: 'terminal', terminalId });

describe('collectTerminalIds', () => {
  it('collects tab roots and every terminal node in the pane trees', () => {
    const ids = collectTerminalIds({
      tabs: [{ id: 'tb-1' }, { id: 'tb-2' }],
      tabPanes: {
        'tb-1': { type: 'split', children: [leaf('tm-a'), { type: 'split', children: [leaf('tm-b')] }] },
        'tb-2': leaf('tm-c'),
      },
    });
    expect([...ids].sort()).toEqual(['tb-1', 'tb-2', 'tm-a', 'tm-b', 'tm-c']);
  });

  it('survives a malformed or empty session without throwing', () => {
    expect(collectTerminalIds(null).size).toBe(0);
    expect(collectTerminalIds({}).size).toBe(0);
    expect(collectTerminalIds({ tabs: 'not-an-array', tabPanes: null }).size).toBe(0);
  });
});

describe('unionKeepSet', () => {
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

  it('unions EVERY window session, not just this window s', () => {
    // The defect: window A restores first and prunes history down to its own
    // terminals, deleting B's and C's scrollback before they ever boot.
    const s = store({
      'auto-terminal-state': session(['tb-A'], { 'tb-A': leaf('tm-a1') }),
      'auto-terminal-state#w1': session(['tb-B'], { 'tb-B': leaf('tm-b1') }),
      'auto-terminal-state#w2': session(['tb-C'], { 'tb-C': leaf('tm-c1') }),
    });
    const keep = unionKeepSet(s);
    expect(keep.windows).toBe(3);
    // Assert the SIZE against the real contents, not a spot-check: a keep-set
    // silently missing one window is exactly the failure being prevented.
    expect(keep.ids.size).toBe(6);
    expect([...keep.ids].sort()).toEqual(['tb-A', 'tb-B', 'tb-C', 'tm-a1', 'tm-b1', 'tm-c1']);
    expect(keep.complete).toBe(true);
  });

  it('never reads a sibling profile s sessions', () => {
    // Running as the DEFAULT profile. Sweeping against `work`'s terminals would
    // delete a live sibling instance's scrollback.
    const s = store({
      'auto-terminal-state': session(['tb-A']),
      'auto-terminal-state:work': session(['tb-W']),
      'auto-terminal-state:work#w1': session(['tb-W2']),
    });
    const keep = unionKeepSet(s);
    expect(keep.windows).toBe(1);
    expect([...keep.ids]).toEqual(['tb-A']);
  });

  it('reads only this profile s sessions when running as that profile', () => {
    __setProfileForTests({ name: 'work', scope: 'work', isDefault: false });
    const s = store({
      'auto-terminal-state': session(['tb-DEFAULT']),
      'auto-terminal-state:work': session(['tb-W']),
      'auto-terminal-state:work#w1': session(['tb-W2']),
    });
    const keep = unionKeepSet(s);
    expect(keep.windows).toBe(2);
    expect([...keep.ids].sort()).toEqual(['tb-W', 'tb-W2']);
  });

  it('ignores keys that are not sessions at all', () => {
    const s = store({
      'auto-terminal-state': session(['tb-A']),
      'auto-terminal-layouts': session(['tb-LAYOUT']),
      api_token: 'secret',
      'some-other-app': 'x',
    });
    const keep = unionKeepSet(s);
    expect(keep.windows).toBe(1);
    expect([...keep.ids]).toEqual(['tb-A']);
  });

  it('reports incomplete when a session blob cannot be parsed', () => {
    // A window whose session we cannot read is a window whose terminals we
    // cannot name. Contributing nothing SILENTLY would prune its scrollback.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const keep = unionKeepSet(
      store({
        'auto-terminal-state': session(['tb-A']),
        'auto-terminal-state#w1': '{ truncated',
      }),
    );
    expect(keep.complete).toBe(false);
    expect(keep.ids.has('tb-A')).toBe(true);
    warn.mockRestore();
  });

  it('is complete for an empty store, so a first run still sweeps', () => {
    const keep = unionKeepSet(store({}));
    expect(keep.complete).toBe(true);
    expect(keep.windows).toBe(0);
    expect(keep.ids.size).toBe(0);
  });
});

/**
 * `terminalIdsInOtherWindows` answers a different question from `unionKeepSet`:
 * not "which terminals must survive a prune" but "which terminals is some OTHER
 * window showing". The difference is my own window, and it matters in the
 * opposite direction — including myself here would make every terminal I have
 * ever had on screen look owned, and the hidden-CLI badge would go permanently
 * silent.
 */
describe('terminalIdsInOtherWindows', () => {
  afterEach(() => {
    __setWindowForTests(SLOT_ZERO_ID);
  });

  it('excludes MY window and includes every other one', () => {
    __setWindowForTests('w1');
    const out = terminalIdsInOtherWindows(
      store({
        'auto-terminal-state#w1': session(['tb-mine'], { 'tb-mine': leaf('tm-mine') }),
        'auto-terminal-state#w2': session(['tb-theirs'], { 'tb-theirs': leaf('tm-theirs') }),
      }),
      'w1',
    );
    // Presence and absence together: asserting only that mine is missing passes
    // against a function that returns nothing at all.
    expect(out.ids.has('tm-theirs')).toBe(true);
    expect(out.ids.has('tm-mine')).toBe(false);
    expect(out.windows).toBe(1);
    expect(out.complete).toBe(true);
  });

  it('excludes slot zero when slot zero is ME, and includes it when it is not', () => {
    // The unsuffixed key IS a window (`w0`), not a global — a filter keyed on the
    // `#` suffix would silently treat the commonest window as nobody's.
    const s = store({
      'auto-terminal-state': session(['tb-zero'], { 'tb-zero': leaf('tm-zero') }),
      'auto-terminal-state#w1': session(['tb-one'], { 'tb-one': leaf('tm-one') }),
    });

    expect(terminalIdsInOtherWindows(s, SLOT_ZERO_ID).ids.has('tm-zero')).toBe(false);
    expect(terminalIdsInOtherWindows(s, 'w1').ids.has('tm-zero')).toBe(true);
  });

  it('ignores another PROFILE\'s sessions', () => {
    const out = terminalIdsInOtherWindows(
      store({ 'auto-terminal-state:work#w2': session(['tb-x'], { 'tb-x': leaf('tm-work') }) }),
      'w1',
    );
    expect(out.ids.size).toBe(0);
    expect(out.windows).toBe(0);
  });

  it('reports incomplete when another window\'s session cannot be parsed', () => {
    // The caller under-claims on this, so it must be distinguishable from "that
    // window has no terminals" — which is what a silent skip would look like.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = terminalIdsInOtherWindows(
      store({ 'auto-terminal-state#w2': '{ truncated' }),
      'w1',
    );
    expect(out.complete).toBe(false);
    expect(out.windows).toBe(1);
    warn.mockRestore();
  });
});
