import { configureStore } from '@reduxjs/toolkit';
import tabsReducer, { addTab, setActiveTab } from '../../store/slices/tabsSlice';
import panesReducer, { addTabTree, setActiveTabId } from '../../store/slices/panesSlice';
import { terminalTitleColor } from '../../store/titleColor';
import type { RootState } from '../../store';
import { buildApiCreatedTab, resolveApiCreateIds, runApiCreateMode0 } from '../apiCreatedTab';

describe('buildApiCreatedTab', () => {
  it('pins the title (titleIsCustom: true) when the caller supplies a name', () => {
    const tab = buildApiCreatedTab({ targetTabId: 'tb-1', name: 'My Agent' });

    expect(tab.title).toBe('My Agent');
    expect(tab.titleIsCustom).toBe(true);
  });

  it('does not pin the title when no name is supplied', () => {
    const tab = buildApiCreatedTab({ targetTabId: 'tb-1', profile: 'bash' });

    expect(tab.title).toBe('Terminal (bash)');
    expect(tab.titleIsCustom).toBeUndefined();
  });

  it('falls back to "default" in the generated title when neither profile nor defaultProfile is set', () => {
    const tab = buildApiCreatedTab({ targetTabId: 'tb-1' });

    expect(tab.title).toBe('Terminal (default)');
  });

  it('resolves shellType from profile, falling back to defaultProfile, then "default"', () => {
    expect(buildApiCreatedTab({ targetTabId: 'tb-1', profile: 'zsh', defaultProfile: 'bash' }).shellType).toBe('zsh');
    expect(buildApiCreatedTab({ targetTabId: 'tb-1', defaultProfile: 'bash' }).shellType).toBe('bash');
    expect(buildApiCreatedTab({ targetTabId: 'tb-1' }).shellType).toBe('default');
  });

  it('carries the target tab id through unchanged', () => {
    expect(buildApiCreatedTab({ targetTabId: 'tb-42', name: 'x' }).id).toBe('tb-42');
  });

  it('treats an empty-string name as "not supplied" (falls through to fallback title, unpinned)', () => {
    const tab = buildApiCreatedTab({ targetTabId: 'tb-1', name: '', profile: 'bash' });

    expect(tab.title).toBe('Terminal (bash)');
    expect(tab.titleIsCustom).toBeUndefined();
  });

  describe('Mode 3 (fallbackTitle / shellTypeFallback overrides)', () => {
    it('uses fallbackTitle instead of the "Terminal (profile)" convention when no name is supplied', () => {
      const tab = buildApiCreatedTab({ targetTabId: 'tb-1', fallbackTitle: 'API Terminal', shellTypeFallback: 'cmd' });

      expect(tab.title).toBe('API Terminal');
      expect(tab.shellType).toBe('cmd');
    });

    it('still pins the title when a name is supplied, ignoring fallbackTitle', () => {
      const tab = buildApiCreatedTab({
        targetTabId: 'tb-1',
        name: 'My Agent',
        fallbackTitle: 'API Terminal',
        shellTypeFallback: 'cmd',
      });

      expect(tab.title).toBe('My Agent');
      expect(tab.titleIsCustom).toBe(true);
    });
  });

  describe('inherited tab colour', () => {
    it.each(['#22c55e', '#f59e0b'])('carries the inherited colour %s onto the new tab', (colour) => {
      expect(buildApiCreatedTab({ targetTabId: 'tb-1', titleColor: colour }).titleColor).toBe(colour);
    });

    // Not merely `undefined`: the reducers represent an uncoloured tab by
    // DELETING the field (`setTabTitleColor`, `updateTabMeta`), so an own
    // `titleColor: undefined` key is a second spelling of the same state that
    // spreads and `in` checks can still tell apart. Persistence cannot —
    // `durableTab` copies the field either way and JSON drops undefined.
    it('omits the key entirely when nothing is inherited', () => {
      const tab = buildApiCreatedTab({ targetTabId: 'tb-1', name: 'x' });

      expect('titleColor' in tab).toBe(false);
    });

    it('omits the key entirely for an empty inherited colour', () => {
      const tab = buildApiCreatedTab({ targetTabId: 'tb-1', titleColor: '' });

      expect('titleColor' in tab).toBe(false);
    });
  });
});

/**
 * The acceptance case that Mode 1 (a split into an existing tab) already met and
 * Mode 0 did not: an agent living in a coloured tab asks the MCP layer for a new
 * TAB. The tab is brand new, so it has no colour of its own to propagate — it
 * has to inherit one from the terminal whose agent asked for it, which arrives
 * as `parentTerminalId` (already carried for canvas placement).
 */
describe('runApiCreateMode0 — an agent-spawned tab inherits its caller tab colour', () => {
  const PARENT_TAB = 'tb-parent';
  const PARENT_LEAF = 'tm-parent-leaf';

  function makeStore(parentColour?: string) {
    const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } });
    store.dispatch(addTab({
      id: PARENT_TAB, title: 'Parent', shellType: 'bash', icon: '🖥️', isActive: true,
      ...(parentColour ? { titleColor: parentColour } : {}),
    } as never));
    store.dispatch(addTabTree({
      tabId: PARENT_TAB,
      tree: { id: 'pn-parent', type: 'terminal', terminalId: PARENT_LEAF },
    } as never));
    return store;
  }

  function run(
    store: ReturnType<typeof makeStore>,
    detail: Record<string, unknown>,
    titleColorForTerminal: (terminalId?: string) => string | undefined,
  ) {
    return runApiCreateMode0(
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
        titleColorForTerminal,
      },
    );
  }

  const spawnedTab = (store: ReturnType<typeof makeStore>, id: string) =>
    store.getState().tabs.tabs.find((t) => t.id === id);

  // Two DIFFERENT colours: a single-colour oracle is satisfied by a hard-coded
  // constant, which would leave the tab green no matter what the caller wore.
  it.each(['#22c55e', '#f59e0b'])('paints the new tab with the caller tab colour %s', (colour) => {
    const store = makeStore(colour);

    // The REAL selector against a REAL store, so the pane-tree walk from the
    // parent LEAF up to its owning TAB is pinned here too, not stubbed away.
    const result = run(store, { parentTerminalId: PARENT_LEAF }, (id) =>
      terminalTitleColor(store.getState() as unknown as RootState, id));

    expect(spawnedTab(store, result.targetTabId)?.titleColor).toBe(colour);
  });

  // The id App.tsx could plausibly hand over instead — the new tab's own leaf,
  // or the owning tab id — resolves to no colour at all, so a wrong argument
  // shows up as a bare tab rather than as a passing test.
  it('resolves the colour from the caller terminal, not the terminal it is creating', () => {
    const store = makeStore('#22c55e');
    const asked: (string | undefined)[] = [];

    run(store, { parentTerminalId: PARENT_LEAF }, (id) => {
      asked.push(id);
      return terminalTitleColor(store.getState() as unknown as RootState, id);
    });

    expect(asked).toEqual([PARENT_LEAF]);
  });

  // `connectToCaller: false` on the MCP tool, or a REST caller that is not a
  // terminal at all: there is no caller to inherit from.
  it('leaves the tab uncoloured when the create names no caller', () => {
    const store = makeStore('#22c55e');

    const result = run(store, {}, (id) =>
      terminalTitleColor(store.getState() as unknown as RootState, id));

    expect('titleColor' in (spawnedTab(store, result.targetTabId) ?? {})).toBe(false);
  });

  it('leaves the tab uncoloured when the caller tab has no colour', () => {
    const store = makeStore(undefined);

    const result = run(store, { parentTerminalId: PARENT_LEAF }, (id) =>
      terminalTitleColor(store.getState() as unknown as RootState, id));

    expect('titleColor' in (spawnedTab(store, result.targetTabId) ?? {})).toBe(false);
  });

  it.each(['#a855f7', '#06b6d4'])('falls back to transported parent colour %s when this window has no caller leaf', (colour) => {
    const store = makeStore(undefined);

    const result = run(store, {
      parentTerminalId: 'tm-in-other-window',
      parentTitleColor: colour,
    }, () => undefined);

    expect(spawnedTab(store, result.targetTabId)?.titleColor).toBe(colour);
  });

  it.each([
    ['#22c55e', '#ec4899'],
    ['#f59e0b', '#3b82f6'],
  ])('prefers local colour %s over different transported colour %s', (localColour, payloadColour) => {
    const store = makeStore(localColour);

    const result = run(store, {
      parentTerminalId: PARENT_LEAF,
      parentTitleColor: payloadColour,
    }, (id) => terminalTitleColor(store.getState() as unknown as RootState, id));

    expect(spawnedTab(store, result.targetTabId)?.titleColor).toBe(localColour);
  });

  it('treats an empty transported colour as no colour and omits the titleColor key', () => {
    const store = makeStore(undefined);

    const result = run(store, {
      parentTerminalId: 'tm-in-other-window',
      parentTitleColor: '',
    }, () => undefined);

    expect('titleColor' in (spawnedTab(store, result.targetTabId) ?? {})).toBe(false);
  });
});

describe('resolveApiCreateIds', () => {
  it('reads the explicit P0-A keys for a split', () => {
    expect(
      resolveApiCreateIds({
        terminalId: 'pc-abc123def',
        tabId: 'tb-4e8d0c2f1',
        processId: 'pc-abc123def',
        rendererTerminalId: 'tm-9f2c1a4b7',
        owningTabId: 'tb-4e8d0c2f1',
      }),
    ).toEqual({
      processId: 'pc-abc123def',
      leafId: 'tm-9f2c1a4b7',
      owningTabId: 'tb-4e8d0c2f1',
    });
  });

  it('gives a root create the same leaf and owner', () => {
    expect(
      resolveApiCreateIds({
        processId: 'pc-root1',
        rendererTerminalId: 'tb-4e8d0c2f1',
        owningTabId: 'tb-4e8d0c2f1',
      }),
    ).toEqual({ processId: 'pc-root1', leafId: 'tb-4e8d0c2f1', owningTabId: 'tb-4e8d0c2f1' });
  });

  // A payload from a build that predates P0-A: `terminalId` was the process id
  // and `tabId` the owning tab, with no leaf at all. The leaf falls back to the
  // unique process id — NOT the owning tab id — because every caller that reads
  // `leafId` (App.tsx Mode 1/Mode 2) is minting a sibling pane in a tab that may
  // already have an occupied root pane at leaf === owningTabId; reusing that
  // leaf would duplicate the root's pane-tree identity (review 099 T2-F3).
  it('falls back to the legacy process id as the leaf (not the owning tab id)', () => {
    expect(
      resolveApiCreateIds({ terminalId: 'pc-legacy', tabId: 'tb-legacy1' }),
    ).toEqual({ processId: 'pc-legacy', leafId: 'pc-legacy', owningTabId: 'tb-legacy1' });
  });

  it('falls back to the owning tab id as a last resort when even the process id is missing', () => {
    expect(
      resolveApiCreateIds({ tabId: 'tb-legacy1' }),
    ).toEqual({ processId: undefined, leafId: 'tb-legacy1', owningTabId: 'tb-legacy1' });
  });

  it('reports missing ids as undefined rather than inventing them', () => {
    expect(resolveApiCreateIds({})).toEqual({
      processId: undefined, leafId: undefined, owningTabId: undefined,
    });
  });
});
