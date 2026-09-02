/**
 * @jest-environment jsdom
 *
 * Bringing a stranded agent CLI back on screen.
 *
 * The defect this module exists to avoid is not "the tab does not appear" — it
 * is a SECOND PTY. Every terminal handed to `restoreHiddenAgentTerminals` is
 * alive and the host already knows it by its `terminalId`, so two things have to
 * hold, and both fail silently:
 *
 *   - the pane must carry that id UNCHANGED (re-minting spawns a duplicate and
 *     leaves the agent exactly as stranded as before), and
 *   - the bind must happen BEFORE the tab is dispatched (`TerminalPane`'s mount
 *     effect reads `getProcessId(terminalId)` to decide reuse-vs-spawn; a tab
 *     that becomes renderable first races that effect against an unseeded id).
 *
 * And the candidate list is as old as the last poll, so a third thing has to
 * hold: liveness is re-read before anything is bound. Attaching to a process
 * that has since exited registers a mapping the backend does not own, and the
 * pane mounted on it looks alive while being connected to nothing.
 *
 * Both are ORDER-and-identity properties that a "did it dispatch a tab?" oracle
 * cannot see, so the tests below record a single interleaved call log across the
 * service mocks and the dispatch spy, and assert against that.
 */
jest.mock('../../api/apiBase', () => ({ apiBase: async () => 'http://127.0.0.1:65535/api' }));

/** One ordered log across every collaborator, so "attach happened before the
 *  tab was dispatched" is expressible at all. */
const order: string[] = [];

jest.mock('../TerminalService', () => ({
  terminalService: {
    attachExistingTerminal: jest.fn((terminalId: string) => { order.push(`attach:${terminalId}`); }),
    markReattachedSession: jest.fn((terminalId: string) => { order.push(`reattach:${terminalId}`); }),
  },
}));

jest.mock('../reattachGate', () => ({
  reattachPromptGate: jest.fn(() => null),
  markArmProbePending: jest.fn((terminalId: string) => { order.push(`armProbe:${terminalId}`); }),
}));

jest.mock('../hiddenAgentTerminals', () => {
  const actual = jest.requireActual('../hiddenAgentTerminals');
  return {
    ...actual,
    // Only the network calls are stubbed. `visibleTerminalIds` and
    // `liveAgentProcessIds` stay REAL: the skip path prevents a duplicate leaf
    // and the join decides which candidates are still alive, so stubbing either
    // would make those tests assert their own mocks.
    refreshHiddenAgentTerminals: jest.fn(() => Promise.resolve()),
    fetchLiveTerminalRows: jest.fn(),
  };
});

import { restoreHiddenAgentTerminals } from '../restoreHiddenAgentTerminals';
import {
  HiddenAgentTerminal,
  refreshHiddenAgentTerminals,
  fetchLiveTerminalRows,
} from '../hiddenAgentTerminals';
import { terminalService } from '../TerminalService';
import { markArmProbePending } from '../reattachGate';
import { addTab, setActiveTab } from '../../store/slices/tabsSlice';
import { addTabTree, setActiveTabId, focusPane } from '../../store/slices/panesSlice';

const hidden = (
  terminalId: string,
  extra: Partial<HiddenAgentTerminal> = {},
): HiddenAgentTerminal => ({
  terminalId,
  processId: `pc-${terminalId}`,
  agent: 'claude',
  name: `Agent ${terminalId}`,
  ...extra,
});

/** Actions the call dispatched, in order. */
let dispatched: any[];
const dispatch = ((action: any) => {
  dispatched.push(action);
  order.push(action?.type ?? 'thunk');
  return action;
}) as any;

/** Point the module at a workspace showing exactly `terminalIds`. */
const setWorkspace = (terminalIds: string[]) => {
  const trees: Record<string, unknown> = {};
  terminalIds.forEach((tm, i) => {
    trees[`tb-${i}`] = { id: `pn-${i}`, type: 'terminal', terminalId: tm };
  });
  (window as any).__REDUX_STORE__ = { getState: () => ({ panes: { treesByTabId: trees } }) };
};

const payloadsOf = (type: string) => dispatched.filter(a => a?.type === type).map(a => a.payload);

/**
 * Say which terminals the BACKEND currently reports as live agent terminals,
 * as `terminalId -> processId`. Restore re-reads this at click time, so it is
 * what decides `stale`, and the processId here is the one that gets bound.
 */
const setLive = (pairs: Record<string, string>) => {
  (fetchLiveTerminalRows as jest.Mock).mockResolvedValue({
    processes: Object.values(pairs).map(pc => ({ id: pc, agent: 'claude', name: 'Agent' })),
    identities: Object.entries(pairs).map(([tm, pc]) => ({ id: pc, processId: pc, terminalId: tm })),
  });
};

beforeEach(() => {
  order.length = 0;
  dispatched = [];
  jest.clearAllMocks();
  setWorkspace([]);
  // Default: every terminal the tests name is alive at the id its candidate
  // carries. Tests about staleness override this.
  setLive({
    'tm-alive': 'pc-tm-alive',
    'tm-stranded': 'pc-tm-stranded',
    'tm-already': 'pc-tm-already',
    'tm-dup': 'pc-tm-dup',
    'tm-hooked': 'pc-tm-hooked',
    'tm-plain': 'pc-tm-plain',
    'tm-1': 'pc-tm-1',
    'tm-2': 'pc-tm-2',
    'tm-3': 'pc-tm-3',
  });
});

describe('restoreHiddenAgentTerminals — attach, never spawn', () => {
  it('carries the running terminal id into the pane unchanged', async () => {
    const result = await restoreHiddenAgentTerminals([hidden('tm-alive')], dispatch);

    expect(terminalService.attachExistingTerminal).toHaveBeenCalledWith(
      'tm-alive', 'pc-tm-alive', null,
    );
    const [tree] = payloadsOf(addTabTree.type);
    // The whole point: the leaf IS the live terminal. A re-minted id would still
    // produce a perfectly good-looking tab.
    expect(tree.tree.terminalId).toBe('tm-alive');
    expect(result.restored.map(r => r.terminalId)).toEqual(['tm-alive']);
    expect(result.skipped).toEqual([]);
  });

  it('gives the tab a FRESH id rather than reusing the terminal id', async () => {
    await restoreHiddenAgentTerminals([hidden('tm-alive')], dispatch);

    const [tab] = payloadsOf(addTab.type);
    const [tree] = payloadsOf(addTabTree.type);
    expect(tab.id).toMatch(/^tb-/);
    expect(tab.id).not.toBe('tm-alive');
    // Tab and tree must agree, or the tree is orphaned from the tab it describes.
    expect(tree.tabId).toBe(tab.id);
    expect(tree.tree.id).toMatch(/^pn-/);
  });

  it('binds the terminal BEFORE the tab is dispatched', async () => {
    await restoreHiddenAgentTerminals([hidden('tm-alive')], dispatch);

    // Deleting the attach, or moving it below the dispatches, both show up here.
    // A "was attach called?" assertion sees neither.
    expect(order.indexOf('attach:tm-alive')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('attach:tm-alive')).toBeLessThan(order.indexOf(addTab.type));
    expect(order.indexOf('reattach:tm-alive')).toBeLessThan(order.indexOf(addTab.type));
  });

  it('dispatches the tab and its tree with nothing in between', async () => {
    await restoreHiddenAgentTerminals([hidden('tm-alive')], dispatch);

    // A tab that is renderable without its tree makes TerminalContainer's seed
    // effect manufacture a root keyed on the TAB id and spawn a PTY under it.
    const tabAt = order.indexOf(addTab.type);
    expect(order[tabAt + 1]).toBe(addTabTree.type);
  });

  it('re-seeds the reattached session so Win32-Input-Mode is restored', async () => {
    await restoreHiddenAgentTerminals([hidden('tm-alive')], dispatch);
    expect(terminalService.markReattachedSession).toHaveBeenCalledWith('tm-alive');
  });

  it('arms the prompt probe only for a candidate that had a prompt hook', async () => {
    // Presence and absence in one table — an absence-only assertion passes just
    // as happily against a build that never arms anything at all.
    await restoreHiddenAgentTerminals(
      [hidden('tm-hooked', { promptHook: true }), hidden('tm-plain', { promptHook: false })],
      dispatch,
    );

    expect(markArmProbePending).toHaveBeenCalledWith('tm-hooked');
    expect(markArmProbePending).not.toHaveBeenCalledWith('tm-plain');
    expect(markArmProbePending).toHaveBeenCalledTimes(1);
  });
});

describe('restoreHiddenAgentTerminals — liveness is re-read, never assumed', () => {
  it('does not attach a candidate the backend no longer reports as running', async () => {
    // It was alive when the badge was computed; it exited before the click.
    setLive({ 'tm-stranded': 'pc-tm-stranded' });

    const result = await restoreHiddenAgentTerminals(
      [hidden('tm-gone'), hidden('tm-stranded')],
      dispatch,
    );

    expect(result.stale.map(s => s.terminalId)).toEqual(['tm-gone']);
    expect(result.restored.map(r => r.terminalId)).toEqual(['tm-stranded']);
    // Paired positive and negative: a build that attaches NOTHING would satisfy
    // the negative alone.
    expect(terminalService.attachExistingTerminal).toHaveBeenCalledTimes(1);
    expect(terminalService.attachExistingTerminal).not.toHaveBeenCalledWith(
      'tm-gone', expect.anything(), expect.anything(),
    );
    expect(payloadsOf(addTabTree.type)).toHaveLength(1);
  });

  it('binds the FRESHLY READ process id, not the one the candidate carried', async () => {
    // The leaf respawned since the poll: same terminal, new process. Binding the
    // candidate's cached `pc-tm-alive` would attach to a dead process.
    setLive({ 'tm-alive': 'pc-new' });

    await restoreHiddenAgentTerminals([hidden('tm-alive')], dispatch);

    expect(terminalService.attachExistingTerminal).toHaveBeenCalledWith('tm-alive', 'pc-new', null);
  });

  it('attaches nothing at all when the liveness read fails', async () => {
    (fetchLiveTerminalRows as jest.Mock).mockRejectedValue(new Error('backend down'));

    const result = await restoreHiddenAgentTerminals([hidden('tm-alive')], dispatch);

    // "Not proven live" is what we know, so nothing is bound and nothing is
    // dispatched — a half-restore here would be a pane attached on a guess.
    expect(result.restored).toEqual([]);
    expect(result.stale.map(s => s.terminalId)).toEqual(['tm-alive']);
    expect(terminalService.attachExistingTerminal).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
  });

  it('reads the workspace AFTER the liveness round, not before', async () => {
    // A pane can appear while the fetch is in flight. Reading `visible` first
    // would miss it and build a duplicate leaf.
    (fetchLiveTerminalRows as jest.Mock).mockImplementation(async () => {
      setWorkspace(['tm-alive']);
      return {
        processes: [{ id: 'pc-tm-alive', agent: 'claude', name: 'Agent' }],
        identities: [{ id: 'pc-tm-alive', processId: 'pc-tm-alive', terminalId: 'tm-alive' }],
      };
    });

    const result = await restoreHiddenAgentTerminals([hidden('tm-alive')], dispatch);

    expect(result.skipped.map(s => s.terminalId)).toEqual(['tm-alive']);
    expect(result.restored).toEqual([]);
    expect(payloadsOf(addTabTree.type)).toEqual([]);
  });
});

describe('restoreHiddenAgentTerminals — the live workspace overrides the caller list', () => {
  it('skips a terminal a pane already shows, and still restores the rest', async () => {
    setWorkspace(['tm-already']);

    const result = await restoreHiddenAgentTerminals(
      [hidden('tm-already'), hidden('tm-stranded')],
      dispatch,
    );

    expect(result.skipped.map(s => s.terminalId)).toEqual(['tm-already']);
    expect(result.restored.map(r => r.terminalId)).toEqual(['tm-stranded']);
    // The negative that matters: no second leaf for the visible one. Paired with
    // the positive above, so a build that restores NOTHING cannot pass.
    const trees = payloadsOf(addTabTree.type);
    expect(trees).toHaveLength(1);
    expect(trees[0].tree.terminalId).toBe('tm-stranded');
    expect(terminalService.attachExistingTerminal).toHaveBeenCalledTimes(1);
  });

  it('does not build two tabs when the same terminal is listed twice', async () => {
    const twice = hidden('tm-dup');
    const result = await restoreHiddenAgentTerminals([twice, { ...twice }], dispatch);

    expect(result.restored).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(payloadsOf(addTabTree.type)).toHaveLength(1);
  });
});

describe('restoreHiddenAgentTerminals — activation', () => {
  it('activates the FIRST restored tab only, however many were restored', async () => {
    await restoreHiddenAgentTerminals(
      [hidden('tm-1'), hidden('tm-2'), hidden('tm-3')],
      dispatch,
    );

    const tabs = payloadsOf(addTab.type);
    expect(tabs).toHaveLength(3);

    const activations = payloadsOf(setActiveTab.type);
    expect(activations).toEqual([tabs[0].id]);
    expect(payloadsOf(setActiveTabId.type)).toEqual([tabs[0].id]);

    // Focus follows the same tab's pane, not some later one.
    const firstTree = payloadsOf(addTabTree.type)[0];
    expect(payloadsOf(focusPane.type)).toEqual([firstTree.tree.id]);
  });

  it('activates nothing when every candidate was already visible', async () => {
    setWorkspace(['tm-already']);

    const result = await restoreHiddenAgentTerminals([hidden('tm-already')], dispatch);

    expect(result.restored).toEqual([]);
    expect(payloadsOf(setActiveTab.type)).toEqual([]);
    expect(payloadsOf(addTab.type)).toEqual([]);
  });

  it('refreshes the backend answer so the badge stops advertising what is now on screen', async () => {
    await restoreHiddenAgentTerminals([hidden('tm-alive')], dispatch);
    expect(refreshHiddenAgentTerminals).toHaveBeenCalled();
  });
});
