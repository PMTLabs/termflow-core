/**
 * @jest-environment jsdom
 *
 * `findHiddenAgentTerminals` — which running agent CLIs has this workspace lost
 * track of? The join is over two endpoints that each hold half the answer
 * (`/api/processes` has the agent, `/api/terminals` has the renderer identity),
 * so most of the ways this can go wrong are ways the join can go wrong.
 *
 * The window-ownership filter uses the REAL `windowScope` helpers rather than a
 * stub: session keys are built by the same code that parses them, so a test
 * cannot pass against a key shape production would never produce.
 */
jest.mock('../../api/apiBase', () => ({ apiBase: async () => 'http://127.0.0.1:65535/api' }));

import {
  findHiddenAgentTerminals,
  visibleTerminalIds,
  sameHiddenSet,
  hiddenAgentTerminals,
  ProcessRow,
  IdentityRow,
} from '../hiddenAgentTerminals';
import { __setWindowForTests } from '../windowScope';

const ME = 'w1';

const proc = (id: string, agent: string | null, name = 'shell'): ProcessRow => ({ id, agent, name });
const ident = (id: string, terminalId: string | null, extra: Partial<IdentityRow> = {}): IdentityRow =>
  ({ id, processId: id, terminalId, ...extra });

beforeEach(() => {
  __setWindowForTests(ME);
});

describe('visibleTerminalIds', () => {
  it('collects every leaf across every tab, including nested splits', () => {
    const ids = visibleTerminalIds({
      'tb-a': { id: 'pn-1', type: 'terminal', terminalId: 'tm-1' },
      'tb-b': {
        id: 'pn-2', type: 'split', direction: 'horizontal',
        children: [
          { id: 'pn-3', type: 'terminal', terminalId: 'tm-2' },
          { id: 'pn-4', type: 'terminal', terminalId: 'tm-3' },
        ],
      },
      // An open-but-empty tab. Must not throw, must contribute nothing.
      'tb-c': null,
    } as any);
    expect([...ids].sort()).toEqual(['tm-1', 'tm-2', 'tm-3']);
  });
});

describe('findHiddenAgentTerminals', () => {
  it('reports a running agent that no pane is showing', () => {
    const out = findHiddenAgentTerminals(
      [proc('pc-1', 'claude', 'claude')],
      [ident('pc-1', 'tm-1', { name: 'Agent work' })],
      new Set(),
      new Set(),
    );
    expect(out).toEqual([
      { terminalId: 'tm-1', processId: 'pc-1', agent: 'claude', name: 'Agent work', promptHook: undefined },
    ]);
  });

  it('ignores a terminal with no agent — a bare shell is not lost work', () => {
    // `agent` is null for every process in the SHELLS list on the backend. The
    // feature is about stranded CLIs; a stranded `pwsh` is just a closed tab.
    const out = findHiddenAgentTerminals(
      [proc('pc-1', null), proc('pc-2', '   ')],
      [ident('pc-1', 'tm-1'), ident('pc-2', 'tm-2')],
      new Set(),
      new Set(),
    );
    expect(out).toEqual([]);
  });

  it('ignores a terminal a pane in THIS workspace is already showing', () => {
    const out = findHiddenAgentTerminals(
      [proc('pc-1', 'claude'), proc('pc-2', 'codex')],
      [ident('pc-1', 'tm-visible'), ident('pc-2', 'tm-hidden')],
      new Set(['tm-visible']),
      new Set(),
    );
    expect(out.map(h => h.terminalId)).toEqual(['tm-hidden']);
  });

  /**
   * The filter that is easy to forget, and the expensive one to get wrong.
   * `/api/terminals` lists terminals across ALL windows, so "absent from my pane
   * trees" is not "absent from every screen". Offering another window's terminal
   * and having the user accept would put a second pane on a leaf that already
   * has one — and `findTabIdByTerminalId` returns the FIRST match, so the two
   * panes would then disagree about routing and muting.
   */
  it('ignores a terminal ANOTHER window has on screen', () => {
    const out = findHiddenAgentTerminals(
      [proc('pc-1', 'claude'), proc('pc-2', 'codex')],
      [ident('pc-1', 'tm-mine'), ident('pc-2', 'tm-theirs')],
      new Set(),
      new Set(['tm-theirs']),
    );
    expect(out.map(h => h.terminalId)).toEqual(['tm-mine']);
  });

  it('includes a terminal no other window claims', () => {
    // The paired positive for the filter above. Without it, a bug that excluded
    // everything would pass the "another window" test while making the feature
    // report nothing, ever.
    const out = findHiddenAgentTerminals(
      [proc('pc-1', 'claude')],
      [ident('pc-1', 'tm-1')],
      new Set(),
      new Set(),
    );
    expect(out.map(h => h.terminalId)).toEqual(['tm-1']);
  });

  /**
   * The regression guard for the defect this filter shipped with.
   *
   * `/api/terminals.sessionKey` is the PTY-HOST's key — equal to `terminalId`
   * for anything created on this build — and `api_server.rs` calls it
   * "Diagnostic only". The first implementation fed it to
   * `windowIdFromSessionKey`, which parses `auto-terminal-state#<windowId>`
   * localStorage keys, so it returned null for every production row and the
   * filter excluded nothing, ever. A test built on a synthesised
   * `auto-terminal-state#w2` key passed anyway, because it was the only shape
   * that function can parse.
   *
   * So: feed rows the shape the endpoint really returns, and require exclusion
   * to come from the ownership set rather than from anything on the row.
   */
  it('does not treat a production sessionKey as a window identity', () => {
    const out = findHiddenAgentTerminals(
      [proc('pc-1', 'claude'), proc('pc-2', 'codex')],
      [
        // Current terminals: host key == terminalId. Migrated pre-014 terminal:
        // a legacy `tb-` host key. Neither encodes a window.
        { id: 'pc-1', processId: 'pc-1', terminalId: 'tm-mine', sessionKey: 'tm-mine' },
        { id: 'pc-2', processId: 'pc-2', terminalId: 'tm-legacy', sessionKey: 'tb-old7f3a2' },
      ] as any,
      new Set(),
      new Set(),
    );
    // Both are offered: nothing on the row says another window owns them, and
    // the old implementation would have offered them too — the point is that the
    // shape below now decides it.
    expect(out.map(h => h.terminalId)).toEqual(['tm-legacy', 'tm-mine']);

    const excluded = findHiddenAgentTerminals(
      [proc('pc-1', 'claude'), proc('pc-2', 'codex')],
      [
        { id: 'pc-1', processId: 'pc-1', terminalId: 'tm-mine', sessionKey: 'tm-mine' },
        { id: 'pc-2', processId: 'pc-2', terminalId: 'tm-legacy', sessionKey: 'tb-old7f3a2' },
      ] as any,
      new Set(),
      new Set(['tm-legacy']),
    );
    expect(excluded.map(h => h.terminalId)).toEqual(['tm-mine']);
  });

  it('ignores a process with no renderer identity — there is no leaf to rebuild around', () => {
    const out = findHiddenAgentTerminals(
      [proc('pc-1', 'claude'), proc('pc-2', 'codex')],
      [ident('pc-1', null), /* pc-2 has no identity row at all */],
      new Set(),
      new Set(),
    );
    expect(out).toEqual([]);
  });

  it('offers a leaf once even when the backend briefly holds two rows for it', () => {
    // A respawn racing a close leaves two processes pointing at one leaf.
    // Offering it twice would build two tabs for one terminal — the duplicate
    // state this module exists to avoid creating.
    const out = findHiddenAgentTerminals(
      [proc('pc-old', 'claude'), proc('pc-new', 'claude')],
      [ident('pc-old', 'tm-1'), ident('pc-new', 'tm-1')],
      new Set(),
      new Set(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].terminalId).toBe('tm-1');
  });

  it('falls back through identity name, process name, then the agent label', () => {
    const out = findHiddenAgentTerminals(
      [proc('pc-1', 'claude', 'proc-name'), proc('pc-2', 'codex', 'proc-name'), proc('pc-3', 'gemini', null)],
      [
        ident('pc-1', 'tm-1', { name: 'identity-name' }),
        ident('pc-2', 'tm-2', { name: null }),
        ident('pc-3', 'tm-3', { name: null }),
      ],
      new Set(),
      new Set(),
    );
    expect(out.map(h => h.name)).toEqual(['identity-name', 'proc-name', 'gemini']);
  });

  it('returns a stable order regardless of backend iteration order', () => {
    // The indicator's count and the restore dialog's list are rendered from this
    // array; an order that flapped between polls would reorder the list under
    // the user mid-read.
    const identities = [ident('pc-1', 'tm-c'), ident('pc-2', 'tm-a'), ident('pc-3', 'tm-b')];
    const forward = findHiddenAgentTerminals(
      [proc('pc-1', 'claude'), proc('pc-2', 'codex'), proc('pc-3', 'gemini')],
      identities, new Set(), new Set(),
    );
    const reversed = findHiddenAgentTerminals(
      [proc('pc-3', 'gemini'), proc('pc-2', 'codex'), proc('pc-1', 'claude')],
      [...identities].reverse(), new Set(), new Set(),
    );
    expect(forward.map(h => h.terminalId)).toEqual(['tm-a', 'tm-b', 'tm-c']);
    expect(reversed.map(h => h.terminalId)).toEqual(forward.map(h => h.terminalId));
  });
});

describe('sameHiddenSet', () => {
  const row = (terminalId: string, name: string, processId = 'pc') =>
    ({ terminalId, processId, agent: 'claude', name });

  it('is insensitive to a name change — a retitling shell must not re-render the badge', () => {
    expect(sameHiddenSet([row('tm-1', 'before')] as any, [row('tm-1', 'after')] as any)).toBe(true);
  });

  it('sees a membership change', () => {
    expect(sameHiddenSet([row('tm-1', 'x')] as any, [row('tm-2', 'x')] as any)).toBe(false);
    expect(sameHiddenSet([row('tm-1', 'x')] as any, [] as any)).toBe(false);
  });

  /**
   * `processId` is what restore BINDS, so treating a set as unchanged when only
   * the process moved is not a cosmetic saving — `publish()` returns early on
   * "same", so the stale row stays in `current` and every later restore attaches
   * to a process that no longer exists. Polling never repairs it, because every
   * later poll compares equal too.
   */
  it('sees the same leaf moving to a NEW process — the value restore binds', () => {
    expect(sameHiddenSet(
      [row('tm-1', 'x', 'pc-old')] as any,
      [row('tm-1', 'x', 'pc-new')] as any,
    )).toBe(false);
  });
});

/**
 * The badge must appear AS the workspace changes, not up to a poll interval
 * later. The reported symptom was exactly that delay: loading a saved layout
 * hid a running CLI, and the indicator turned up "after a few seconds".
 *
 * The cause was that nothing observed the workspace — the only on-demand
 * refreshes were the Layout Manager opening and a restore finishing, so a
 * layout LOAD waited out the interval. The fix caches the backend half and
 * recomputes the moment `panes.treesByTabId` changes, which is free.
 */
describe('hiddenAgentTerminals tracker reacts to the workspace, not just the clock', () => {
  const makeStore = () => {
    let state: any = { panes: { treesByTabId: {} } };
    const subs = new Set<() => void>();
    return {
      getState: () => state,
      subscribe: (fn: () => void) => { subs.add(fn); return () => subs.delete(fn); },
      /** How many store subscriptions are currently open. The teardown test
       *  asserts on this rather than on whether a listener fired: a leaked
       *  subscription with no listeners left to notify is invisible to the latter. */
      subCount: () => subs.size,
      setTrees: (treesByTabId: any) => {
        // A NEW object, as Redux Toolkit hands back when the slice changes —
        // the tracker's change detection is reference equality.
        state = { panes: { treesByTabId } };
        subs.forEach(fn => fn());
      },
    };
  };

  beforeEach(() => {
    hiddenAgentTerminals.__resetForTests();
    __setWindowForTests(ME);
  });

  afterEach(() => {
    hiddenAgentTerminals.__resetForTests();
    delete (window as any).__REDUX_STORE__;
    delete (window as any).electronAPI;
  });

  /** One backend round returning a single agent terminal on leaf tm-1. */
  const stubBackend = () => {
    (window as any).electronAPI = {
      getActiveProcesses: async () => [{ id: 'pc-1', agent: 'claude', name: 'Agent' }],
    };
    (globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({ instance: undefined, terminals: [{ id: 'pc-1', terminalId: 'tm-1' }] }),
    });
  };

  it('publishes a newly hidden terminal on the workspace change itself, with no second fetch', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;
    // tm-1 starts VISIBLE, so the first poll finds nothing hidden.
    store.setTrees({ 'tb-a': { id: 'pn-a', type: 'terminal', terminalId: 'tm-1' } });
    stubBackend();

    let fetches = 0;
    const realFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async (...args: any[]) => { fetches++; return realFetch(...args); };

    const seen: number[] = [];
    const unsubscribe = hiddenAgentTerminals.subscribe(h => seen.push(h.length));
    await hiddenAgentTerminals.refresh();
    expect(hiddenAgentTerminals.current).toEqual([]);
    const fetchesAfterPoll = fetches;
    // The backend round really happened. Without this the `toEqual([])` above
    // passes just as well when the fetch threw and the cache stayed empty —
    // which is exactly how the first version of this test fooled itself.
    expect(fetchesAfterPoll).toBeGreaterThan(0);

    // The layout switch: tm-1 is no longer in any pane.
    store.setTrees({ 'tb-b': { id: 'pn-b', type: 'terminal', terminalId: 'tm-other' } });

    // SYNCHRONOUS — no await, no timer. This is the whole point: the answer was
    // already known, only the workspace half had changed.
    expect(hiddenAgentTerminals.current.map(h => h.terminalId)).toEqual(['tm-1']);
    expect(seen).toContain(1);
    // ...and it cost no extra process-table scan.
    expect(fetches).toBe(fetchesAfterPoll);

    unsubscribe();
  });

  it('publishes again when the terminal becomes visible once more', async () => {
    // The paired positive: a recompute that only ever ADDS would satisfy the
    // test above while leaving a stale badge after a restore.
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;
    store.setTrees({});
    stubBackend();

    const unsubscribe = hiddenAgentTerminals.subscribe(() => {});
    await hiddenAgentTerminals.refresh();
    expect(hiddenAgentTerminals.current.map(h => h.terminalId)).toEqual(['tm-1']);

    store.setTrees({ 'tb-a': { id: 'pn-a', type: 'terminal', terminalId: 'tm-1' } });
    expect(hiddenAgentTerminals.current).toEqual([]);

    unsubscribe();
  });

  /**
   * Asserts the SUBSCRIPTION is released, not merely that nobody heard about it.
   *
   * The previous version of this test watched whether an added-then-immediately-
   * removed listener fired, and `notified === 0` is satisfied by a tracker that
   * leaks its store subscription entirely — with no listeners left, a leaked
   * callback recomputes state silently and notifies no one. Counting the store's
   * own subscribers is what distinguishes the two.
   */
  it('releases its store subscription once the last subscriber unmounts', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;
    store.setTrees({ 'tb-a': { id: 'pn-a', type: 'terminal', terminalId: 'tm-1' } });
    stubBackend();

    expect(store.subCount()).toBe(0);

    const unsubscribe = hiddenAgentTerminals.subscribe(() => {});
    await hiddenAgentTerminals.refresh();
    // Present first, absent after — an absence assertion alone would pass
    // against a tracker that never subscribed at all.
    expect(store.subCount()).toBe(1);

    unsubscribe();
    expect(store.subCount()).toBe(0);

    // And a restart re-establishes exactly one, not a second alongside a leak.
    const again = hiddenAgentTerminals.subscribe(() => {});
    expect(store.subCount()).toBe(1);
    again();
    expect(store.subCount()).toBe(0);
  });

  it('refreshes as soon as a hidden window is shown again, not at the next interval', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;
    store.setTrees({});
    stubBackend();

    let fetches = 0;
    const realFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async (...args: any[]) => { fetches++; return realFetch(...args); };

    const unsubscribe = hiddenAgentTerminals.subscribe(() => {});
    await hiddenAgentTerminals.refresh();
    const before = fetches;
    expect(before).toBeGreaterThan(0);

    // `tick()` skips entirely while hidden, so without a visibility listener the
    // badge stays as stale as the moment the window was hidden until the next
    // POLL_MS boundary — and being shown again is exactly when it is looked at.
    //
    // The EVENT must be what causes the fetch. Calling `refresh()` here as well
    // would pass with no listener registered at all.
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetches).toBeGreaterThan(before);

    unsubscribe();
  });
});
