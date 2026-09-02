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
 *   - the bind must happen BEFORE the tab is dispatched (`TerminalDisplay`'s
 *     mount effect reads the seeded guards to decide reuse-vs-spawn; a tab that
 *     becomes renderable first races that effect against an unseeded id).
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
    // Only the network call is stubbed. `visibleTerminalIds` stays REAL: the
    // skip path is the one that prevents a duplicate leaf, and stubbing the
    // function that decides it would make that test assert its own mock.
    refreshHiddenAgentTerminals: jest.fn(() => Promise.resolve()),
  };
});

import { restoreHiddenAgentTerminals } from '../restoreHiddenAgentTerminals';
import { HiddenAgentTerminal, refreshHiddenAgentTerminals } from '../hiddenAgentTerminals';
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

beforeEach(() => {
  order.length = 0;
  dispatched = [];
  jest.clearAllMocks();
  setWorkspace([]);
});

describe('restoreHiddenAgentTerminals — attach, never spawn', () => {
  it('carries the running terminal id into the pane unchanged', () => {
    const result = restoreHiddenAgentTerminals([hidden('tm-alive')], dispatch);

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

  it('gives the tab a FRESH id rather than reusing the terminal id', () => {
    restoreHiddenAgentTerminals([hidden('tm-alive')], dispatch);

    const [tab] = payloadsOf(addTab.type);
    const [tree] = payloadsOf(addTabTree.type);
    expect(tab.id).toMatch(/^tb-/);
    expect(tab.id).not.toBe('tm-alive');
    // Tab and tree must agree, or the tree is orphaned from the tab it describes.
    expect(tree.tabId).toBe(tab.id);
    expect(tree.tree.id).toMatch(/^pn-/);
  });

  it('binds the terminal BEFORE the tab is dispatched', () => {
    restoreHiddenAgentTerminals([hidden('tm-alive')], dispatch);

    // Deleting the attach, or moving it below the dispatches, both show up here.
    // A "was attach called?" assertion sees neither.
    expect(order.indexOf('attach:tm-alive')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('attach:tm-alive')).toBeLessThan(order.indexOf(addTab.type));
    expect(order.indexOf('reattach:tm-alive')).toBeLessThan(order.indexOf(addTab.type));
  });

  it('dispatches the tab and its tree with nothing in between', () => {
    restoreHiddenAgentTerminals([hidden('tm-alive')], dispatch);

    // A tab that is renderable without its tree makes TerminalContainer's seed
    // effect manufacture a root keyed on the TAB id and spawn a PTY under it.
    const tabAt = order.indexOf(addTab.type);
    expect(order[tabAt + 1]).toBe(addTabTree.type);
  });

  it('re-seeds the reattached session so Win32-Input-Mode is restored', () => {
    restoreHiddenAgentTerminals([hidden('tm-alive')], dispatch);
    expect(terminalService.markReattachedSession).toHaveBeenCalledWith('tm-alive');
  });

  it('arms the prompt probe only for a candidate that had a prompt hook', () => {
    // Presence and absence in one table — an absence-only assertion passes just
    // as happily against a build that never arms anything at all.
    restoreHiddenAgentTerminals(
      [hidden('tm-hooked', { promptHook: true }), hidden('tm-plain', { promptHook: false })],
      dispatch,
    );

    expect(markArmProbePending).toHaveBeenCalledWith('tm-hooked');
    expect(markArmProbePending).not.toHaveBeenCalledWith('tm-plain');
    expect(markArmProbePending).toHaveBeenCalledTimes(1);
  });
});

describe('restoreHiddenAgentTerminals — the live workspace overrides the caller list', () => {
  it('skips a terminal a pane already shows, and still restores the rest', () => {
    setWorkspace(['tm-already']);

    const result = restoreHiddenAgentTerminals(
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

  it('does not build two tabs when the same terminal is listed twice', () => {
    const twice = hidden('tm-dup');
    const result = restoreHiddenAgentTerminals([twice, { ...twice }], dispatch);

    expect(result.restored).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(payloadsOf(addTabTree.type)).toHaveLength(1);
  });
});

describe('restoreHiddenAgentTerminals — activation', () => {
  it('activates the FIRST restored tab only, however many were restored', () => {
    restoreHiddenAgentTerminals(
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

  it('activates nothing when every candidate was already visible', () => {
    setWorkspace(['tm-already']);

    const result = restoreHiddenAgentTerminals([hidden('tm-already')], dispatch);

    expect(result.restored).toEqual([]);
    expect(payloadsOf(setActiveTab.type)).toEqual([]);
    expect(payloadsOf(addTab.type)).toEqual([]);
  });

  it('refreshes the backend answer so the badge stops advertising what is now on screen', () => {
    restoreHiddenAgentTerminals([hidden('tm-alive')], dispatch);
    expect(refreshHiddenAgentTerminals).toHaveBeenCalled();
  });
});
