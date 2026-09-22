/**
 * Plan 048 — `PaneNode.apiCreated`, the marker Canvas Mode's Main only filter reads.
 *
 * Every link that can lose it silently is pinned here: the writers (each API create path, and
 * NOT the user's own create paths or orphan recovery), and the carriers (split, swap). A path
 * that forgets the flag fails OPEN — its terminal just reads as "main" — so nothing else would
 * ever notice.
 */
import path from 'path';
import { configureStore } from '@reduxjs/toolkit';
import reducer, {
  PaneNode, addTabTree, initializePane, setActiveTabId, splitPane, splitPaneInTab, splitPaneWithTab,
} from '../panesSlice';
import tabsReducer, { addTab, setActiveTab } from '../tabsSlice';
import { swapLeaves, findLeaf } from '../paneTreeOps';
import { runApiCreateMode0 } from '../../../services/apiCreatedTab';
import { readSource } from '../../../utils/readSource';

const init = () => reducer(undefined, { type: '@@INIT' } as any);
const leafByTerminal = (tree: PaneNode | null | undefined, terminalId: string): PaneNode | undefined => {
  if (!tree) return undefined;
  if (tree.type === 'terminal') return tree.terminalId === terminalId ? tree : undefined;
  for (const c of tree.children ?? []) {
    const hit = leafByTerminal(c, terminalId);
    if (hit) return hit;
  }
  return undefined;
};

describe('splitPaneInTab — the API split reducer', () => {
  const withTab = () => reducer(init(), addTabTree({
    tabId: 'tb-1',
    tree: { id: 'pn-1', type: 'terminal', terminalId: 'tm-user' },
  }));

  it('marks ONLY the new pane when asked; the surviving pane and the split container stay unmarked', () => {
    const s = reducer(withTab(), splitPaneInTab({
      tabId: 'tb-1', paneId: 'pn-1', direction: 'vertical', terminalId: 'tm-api', apiCreated: true,
    }));
    const tree = s.treesByTabId['tb-1']!;
    expect(tree.type).toBe('split');
    expect(tree.apiCreated).toBeUndefined();
    expect(leafByTerminal(tree, 'tm-api')!.apiCreated).toBe(true);
    expect(leafByTerminal(tree, 'tm-user')!.apiCreated).toBeUndefined();
  });

  it('marks the seeded pane of an empty tab', () => {
    const s = reducer(init(), splitPaneInTab({
      tabId: 'tb-empty', direction: 'vertical', terminalId: 'tm-api', apiCreated: true,
    }));
    expect(s.treesByTabId['tb-empty']!.apiCreated).toBe(true);
  });

  it('does not mark anything when the flag is absent', () => {
    const s = reducer(withTab(), splitPaneInTab({
      tabId: 'tb-1', paneId: 'pn-1', direction: 'vertical', terminalId: 'tm-2',
    }));
    expect(leafByTerminal(s.treesByTabId['tb-1'], 'tm-2')!.apiCreated).toBeUndefined();
  });
});

describe('origin belongs to the pane, not the tab (G1 decision)', () => {
  /** An API-created root pane, active, then split by the USER through `mode`. */
  const apiRoot = () => {
    let s = reducer(init(), setActiveTabId('tb-1'));
    s = reducer(s, initializePane({ terminalId: 'tm-api' }));
    const root = s.paneTree!;
    // Stamp the root the way an API create path leaves it.
    return { s: reducer(s, addTabTree({ tabId: 'tb-1', tree: { ...root, apiCreated: true } })), rootId: root.id };
  };

  it.each([
    ['splitPane (active-tab reducer)', (rootId: string) => splitPane({ paneId: rootId, direction: 'vertical', terminalId: 'tm-user' })],
    ['splitPaneWithTab (the UI split button)', (rootId: string) => ({
      type: splitPaneWithTab.fulfilled.type,
      payload: {
        paneId: rootId, direction: 'vertical', position: 'after', shellType: 'default',
        newTerminalId: 'tm-user', uniqueTitle: 'Right', uniqueOriginalTitle: 'Left',
      },
    })],
  ])('a user split of an API pane via %s: new pane main, API pane still API, container clean', (_name, action) => {
    const { s, rootId } = apiRoot();
    const after = reducer(s, action(rootId) as any);
    const tree = after.treesByTabId['tb-1']!;
    expect(tree.type).toBe('split');
    expect(tree.apiCreated).toBeUndefined();
    expect(leafByTerminal(tree, 'tm-api')!.apiCreated).toBe(true);
    expect(leafByTerminal(tree, 'tm-user')!.apiCreated).toBeUndefined();
  });

  it('swapLeaves moves the marker WITH its terminal', () => {
    const tree: PaneNode = {
      id: 'pn-s', type: 'split', direction: 'vertical', size: 50, children: [
        { id: 'pn-a', type: 'terminal', terminalId: 'tm-api', apiCreated: true },
        { id: 'pn-b', type: 'terminal', terminalId: 'tm-user' },
      ],
    };
    const swapped = swapLeaves(tree, 'pn-a', 'pn-b');
    // The terminals changed places; each one's origin came with it.
    expect(findLeaf(swapped, 'pn-a')!.terminalId).toBe('tm-user');
    expect(findLeaf(swapped, 'pn-a')!.apiCreated).toBeUndefined();
    expect(findLeaf(swapped, 'pn-b')!.terminalId).toBe('tm-api');
    expect(findLeaf(swapped, 'pn-b')!.apiCreated).toBe(true);
  });
});

describe('runApiCreateMode0 — the MCP/API new-tab path', () => {
  function run(detail: Record<string, unknown>) {
    const store = configureStore({ reducer: { tabs: tabsReducer, panes: reducer } });
    const result = runApiCreateMode0(
      { name: 'Spawned', profile: 'bash', processId: 'pc-new', rendererTerminalId: 'tm-new', ...detail },
      {
        dispatch: store.dispatch,
        generateId: (prefix: string) => `${prefix}-generated`,
        defaultProfile: 'default',
        registerExistingTerminal: jest.fn(),
        tabPanes: {},
        tabExists: () => false,
        activateOnApiCreate: false,
        tabCount: 1,
        addTab,
        addTabTree,
        setActiveTab,
        setActiveTabId,
        titleColorForTerminal: () => undefined,
      },
    );
    return store.getState().panes.treesByTabId[result.targetTabId];
  }

  it('marks the pane it creates', () => {
    expect(run({})!.apiCreated).toBe(true);
  });

  it('does NOT mark an orphan recovery (surface_host_orphans carries a sessionKey)', () => {
    // Recovery re-homes a live session whose tab was lost — its origin is unknown, which the
    // G1 decision says reads as main.
    expect(run({ sessionKey: 'tb-old-session' })!.apiCreated).toBeUndefined();
  });
});

/**
 * Census: every tree write inside `handleAPICreateTerminalTab` carries the marker.
 *
 * The handler cannot be mounted here (it is a closure inside `App`), and the failure it guards
 * against is a NEW branch that forgets the flag — so the census is taken over the source, and
 * sized so an empty or mis-sliced handler fails rather than passing vacuously.
 */
describe('handleAPICreateTerminalTab census', () => {
  const APP = readSource(path.resolve(__dirname, '../../../App.tsx'));
  const start = APP.indexOf('const handleAPICreateTerminalTab = async');
  const end = APP.indexOf('\n  };\n', start);
  const HANDLER = start < 0 || end < 0 ? '' : APP.slice(start, end);

  it('found the handler', () => {
    expect(HANDLER.length).toBeGreaterThan(1000);
  });

  it('every splitPaneInTab dispatch passes apiCreated: true', () => {
    const calls = HANDLER.match(/dispatch\(splitPaneInTab\(\{[\s\S]*?\}\)\)/g) ?? [];
    expect(calls.length).toBe(3); // Mode 1, Mode 2, auto-split
    for (const call of calls) expect(call).toContain('apiCreated: true');
  });

  it('every tree handed to addTabTree directly is marked, and Mode 0 goes through runApiCreateMode0', () => {
    const direct = HANDLER.match(/dispatch\(addTabTree\(/g) ?? [];
    expect(direct.length).toBe(1); // Mode 3
    const mode3 = HANDLER.slice(HANDLER.indexOf('// Mode 3'));
    expect(mode3.slice(0, mode3.indexOf('dispatch(addTabTree(')))
      .toContain('apiCreated: true as const');
    expect(HANDLER).toContain('runApiCreateMode0(options, {');
  });
});
