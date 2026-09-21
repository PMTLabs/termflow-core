import type { PaneNode } from '../../../../store/slices/panesSlice';

const dispatch = jest.fn();
const mockState: {
  tabs: { tabs: Array<Record<string, unknown>> };
  panes: { treesByTabId: Record<string, PaneNode> };
  zoom: { levels: Record<string, number> };
} = {
  tabs: { tabs: [] },
  panes: { treesByTabId: {} },
  zoom: { levels: {} },
};

jest.mock('../../../../store', () => ({
  store: { getState: () => mockState, dispatch: (a: unknown) => dispatch(a) },
}));

jest.mock('../../../../services/TerminalService', () => ({
  terminalService: {
    getProcessId: (terminalId: string) => `proc-${terminalId}`,
    attachExistingTerminal: jest.fn(),
    detachTerminal: jest.fn(),
    markReattachedSession: jest.fn(),
    stashKeyboardProtocol: jest.fn(),
  },
}));

// The source window's live cache entries, keyed by terminalId. Empty = no entry.
const mockCacheEntries: Record<string, Record<string, unknown>> = {};
jest.mock('@termflow/terminal-core', () => ({
  terminalCache: { get: (id: string) => mockCacheEntries[id] },
}));

import {
  buildTabDetachPayload, buildPaneDetachPayload, applyDetachPayload, applyCrossWindowPayload,
  removeSourceTab, removeSourcePane,
} from '../detach';
import { addTab } from '../../../../store/slices/tabsSlice';

describe('whole-tab detach (buildTabDetachPayload / applyDetachPayload)', () => {
  beforeEach(() => {
    dispatch.mockClear();
    mockState.tabs.tabs = [];
    mockState.panes.treesByTabId = {};
    mockState.zoom.levels = {};
  });

  const leaf = (id: string, terminalId: string): PaneNode => ({ id, type: 'terminal', terminalId });

  it('carries the source tab icon, titleIsCustom, titleColor, colorSchemaId, notifyMuted and elevated into the payload', () => {
    mockState.tabs.tabs = [{
      id: 'tab-1',
      title: 'rephlo-main',
      shellType: 'default',
      icon: '🖥️',
      titleIsCustom: true,
      titleColor: '#ff0000',
      colorSchemaId: 'solarized',
      notifyMuted: true,
      elevated: true,
    }];
    mockState.panes.treesByTabId = { 'tab-1': leaf('p1', 'tab-1') };

    const payload = buildTabDetachPayload('tab-1', 'rephlo-main');

    expect(payload).toMatchObject({
      tabIcon: '🖥️',
      titleIsCustom: true,
      titleColor: '#ff0000',
      colorSchemaId: 'solarized',
      notifyMuted: true,
      elevated: true,
    });
  });

  it('reconstructs the tab in the destination window with those fields intact (incl. mute and elevated)', () => {
    mockState.tabs.tabs = [{
      id: 'tab-1',
      title: 'rephlo-main',
      shellType: 'default',
      icon: '🖥️',
      titleIsCustom: true,
      notifyMuted: true,
      elevated: true,
    }];
    mockState.panes.treesByTabId = { 'tab-1': leaf('p1', 'tab-1') };

    const payload = buildTabDetachPayload('tab-1', 'rephlo-main');
    expect(payload).not.toBeNull();

    dispatch.mockClear();
    applyDetachPayload(payload!);

    const addTabCall = dispatch.mock.calls.find((c) => c[0].type === addTab.type);
    expect(addTabCall?.[0].payload).toMatchObject({
      icon: '🖥️',
      titleIsCustom: true,
      notifyMuted: true,
      elevated: true,
    });
  });

  /**
   * Plan 045 R8: dragging a NON-admin tab must not spuriously badge the
   * destination — `elevated` has to travel both ways, not just be forwarded
   * whenever present.
   */
  it('omits elevated when the source tab was never an admin tab', () => {
    mockState.tabs.tabs = [{ id: 'tab-1', title: 'rephlo-main', shellType: 'default' }];
    mockState.panes.treesByTabId = { 'tab-1': leaf('p1', 'tab-1') };

    const payload = buildTabDetachPayload('tab-1', 'rephlo-main');
    expect(payload?.elevated).toBeUndefined();

    dispatch.mockClear();
    applyDetachPayload(payload!);
    const addTabCall = dispatch.mock.calls.find((c) => c[0].type === addTab.type);
    expect(addTabCall?.[0].payload.elevated).toBeUndefined();
  });
});

describe('single-pane detach (buildPaneDetachPayload) carries the pane\'s own elevation', () => {
  beforeEach(() => {
    dispatch.mockClear();
    mockState.tabs.tabs = [];
    mockState.panes.treesByTabId = {};
    mockState.zoom.levels = {};
  });

  it('reads elevated off the dragged pane node itself, not the source tab', () => {
    const payload = buildPaneDetachPayload({ id: 'p1', type: 'terminal', terminalId: 'tm-1', elevated: true });
    expect(payload.elevated).toBe(true);
  });

  it('omits elevated for a non-admin pane', () => {
    const payload = buildPaneDetachPayload({ id: 'p1', type: 'terminal', terminalId: 'tm-1' });
    expect(payload.elevated).toBeUndefined();
  });
});

/**
 * External review (codex), finding 3. The cwd snapshot map is module-local to a
 * renderer, so a terminal moved to another window arrives at a window that has never
 * seen its directory. Only PowerShell reports cwd via OSC, so for cmd/WSL/bash the
 * exit payload carries nothing — meaning a shell that exits in the new window before
 * its first 30s refresh tick would restart at the profile default, even though the
 * source window knew exactly where it was. The payload must carry it across.
 *
 * This is the same class of bug as the detach payload once dropping icon/title/colour
 * fields: anything held outside the pane tree has to be packed explicitly.
 */
describe('detach carries the cwd snapshot across windows (spec 045 §3.3)', () => {
  const { setCwdSnapshot, getCwdSnapshot, __resetCwdSnapshots } = jest.requireActual(
    '../../../../services/cwdSnapshot',
  );

  beforeEach(() => {
    dispatch.mockClear();
    mockState.tabs.tabs = [];
    mockState.panes.treesByTabId = {};
    mockState.zoom.levels = {};
    __resetCwdSnapshots();
  });

  it('packs the source pane cwd into the payload and seeds it in the destination', () => {
    const tree: PaneNode = { id: 'p1', type: 'terminal', terminalId: 'tm-1' } as PaneNode;
    mockState.tabs.tabs = [{ id: 'tb-1', title: 'bash', shellType: 'bash' }];
    mockState.panes.treesByTabId = { 'tb-1': tree };
    setCwdSnapshot('tm-1', 'D:\deep\work');

    const payload = buildTabDetachPayload('tb-1');
    expect(payload?.terminals[0].cwd).toBe('D:\deep\work');

    // The destination window is a different renderer: its map starts empty.
    __resetCwdSnapshots();
    expect(getCwdSnapshot('tm-1')).toBeUndefined();

    applyDetachPayload(payload!);
    expect(getCwdSnapshot('tm-1')).toBe('D:\deep\work');
  });

  it('omits cwd when the source never captured one', () => {
    const tree: PaneNode = { id: 'p1', type: 'terminal', terminalId: 'tm-1' } as PaneNode;
    mockState.tabs.tabs = [{ id: 'tb-1', title: 'bash', shellType: 'bash' }];
    mockState.panes.treesByTabId = { 'tb-1': tree };

    const payload = buildTabDetachPayload('tb-1');
    expect(payload?.terminals[0]).not.toHaveProperty('cwd');
    // Seeding a payload without a cwd must not throw or write a bogus entry.
    expect(() => applyDetachPayload(payload!)).not.toThrow();
    expect(getCwdSnapshot('tm-1')).toBeUndefined();
  });
});

/**
 * The bug this pins: detach a tab running an agent CLI to a new window, press
 * Escape — nothing. The PTY had negotiated Win32-Input-Mode (ConPTY's one-shot
 * `?9001h`) with the SOURCE window; the new window's fresh engine has no cache
 * entry to adopt that from, so it sent a legacy `` to a ConPTY expecting
 * records. A brand-new tab beside it worked because its session announced
 * `?9001h` to THIS window. Same class for the Kitty flags a TUI pushes once.
 */
describe('detach carries the negotiated keyboard-protocol state across windows', () => {
  const { terminalService } = jest.requireMock('../../../../services/TerminalService');
  const tree: PaneNode = { id: 'p1', type: 'terminal', terminalId: 'tm-1' } as PaneNode;

  beforeEach(() => {
    dispatch.mockClear();
    terminalService.markReattachedSession.mockClear();
    terminalService.stashKeyboardProtocol.mockClear();
    mockState.tabs.tabs = [{ id: 'tb-1', title: 'claude', shellType: 'pwsh' }];
    mockState.panes.treesByTabId = { 'tb-1': tree };
    mockState.zoom.levels = {};
    for (const k of Object.keys(mockCacheEntries)) delete mockCacheEntries[k];
  });

  it('packs an active Win32-Input-Mode and re-seeds it for the destination mount', () => {
    mockCacheEntries['tm-1'] = { win32State: { isActive: () => true } };

    const payload = buildTabDetachPayload('tb-1');
    expect(payload?.terminals[0].win32InputMode).toBe(true);

    applyDetachPayload(payload!);
    expect(terminalService.markReattachedSession).toHaveBeenCalledWith('tm-1');
  });

  it('packs the Kitty state as plain data and stashes it for the destination mount', () => {
    const data = { mainStack: [1], altStack: [], modifyOtherKeys: 0 };
    mockCacheEntries['tm-1'] = { kbState: { serialize: () => data } };

    const payload = buildTabDetachPayload('tb-1');
    expect(payload?.terminals[0].keyboardProtocol).toEqual(data);

    applyDetachPayload(payload!);
    expect(terminalService.stashKeyboardProtocol).toHaveBeenCalledWith('tm-1', data);
    expect(terminalService.markReattachedSession).not.toHaveBeenCalled();
  });

  it('omits both when the source negotiated nothing, and seeds nothing', () => {
    mockCacheEntries['tm-1'] = {
      win32State: { isActive: () => false },
      kbState: { serialize: () => ({ mainStack: [], altStack: [], modifyOtherKeys: 0 }) },
    };

    const payload = buildTabDetachPayload('tb-1');
    expect(payload?.terminals[0]).not.toHaveProperty('win32InputMode');
    expect(payload?.terminals[0]).not.toHaveProperty('keyboardProtocol');

    applyDetachPayload(payload!);
    expect(terminalService.markReattachedSession).not.toHaveBeenCalled();
    expect(terminalService.stashKeyboardProtocol).not.toHaveBeenCalled();
  });

  it('copes with a source pane that has no cache entry at all', () => {
    const payload = buildTabDetachPayload('tb-1');
    expect(payload?.terminals[0]).not.toHaveProperty('win32InputMode');
    expect(payload?.terminals[0]).not.toHaveProperty('keyboardProtocol');
    expect(() => applyDetachPayload(payload!)).not.toThrow();
  });

  it('seeds on the cross-window drop path too, not only the new-window path', () => {
    mockCacheEntries['tm-1'] = {
      win32State: { isActive: () => true },
      kbState: { serialize: () => ({ mainStack: [3], altStack: [], modifyOtherKeys: 0 }) },
    };
    const payload = buildTabDetachPayload('tb-1');

    applyCrossWindowPayload(payload!);
    expect(terminalService.markReattachedSession).toHaveBeenCalledWith('tm-1');
    expect(terminalService.stashKeyboardProtocol).toHaveBeenCalledWith(
      'tm-1', { mainStack: [3], altStack: [], modifyOtherKeys: 0 },
    );
  });
});

/**
 * Detach must not strand a session-exit record — `plan/024` Req 4.
 *
 * The round-1 leak fix put the clear in the two paths that close a terminal:
 * `closePaneNonBlocking` and `TabManager.closeOneTab`. Detach goes through NEITHER.
 * `collectTerminals` carries only panes with a live process, so a tab holding one running pane
 * and one whose shell has exited hands the first to the new window and simply drops the second —
 * leaving its record in this window's store with no tab, no pane and no way to ever clear it.
 *
 * The rule is "this window no longer has these terminals, so it keeps nothing about them", and it
 * covers carried and left-behind alike. Clearing a carried one is a no-op today (it is live by
 * construction, so it has no record) — but that is an invariant of `collectTerminals`, not of
 * these functions, and the rule that depends on no invariant is the one worth having.
 */
describe('detach clears the session-exit records of terminals leaving this window', () => {
  const leafOf = (id: string, terminalId: string): PaneNode => ({ id, type: 'terminal', terminalId });
  const cleared = () => dispatch.mock.calls
    .map(([a]) => a)
    .filter((a: any) => a?.type === 'sessionExit/clearSessionClosed')
    .map((a: any) => a.payload.terminalId)
    .sort();

  beforeEach(() => {
    dispatch.mockClear();
    mockState.panes.treesByTabId = {
      'tab-1': {
        id: 'pn-root', type: 'split', direction: 'horizontal',
        children: [leafOf('pn-a', 'tm-live'), leafOf('pn-b', 'tm-exited')],
      } as PaneNode,
    };
  });

  describe('removeSourceTab', () => {
    /**
     * The leak itself: only `tm-live` travels, so `tm-exited` is removed from this window by a
     * path that clears nothing. Its record has to go with it.
     */
    it('clears the pane that did not travel', () => {
      removeSourceTab('tab-1', ['tm-live']);
      expect(cleared()).toContain('tm-exited');
    });

    it('clears the carried pane too — no invariant required', () => {
      removeSourceTab('tab-1', ['tm-live']);
      expect(cleared()).toEqual(['tm-exited', 'tm-live']);
    });

    // A terminal named in the payload but no longer in the tree still counts as leaving.
    it('clears a carried terminal that is not in the tree', () => {
      removeSourceTab('tab-1', ['tm-gone']);
      expect(cleared()).toContain('tm-gone');
    });

    // A tab whose tree has already gone must not throw on the way out.
    it('copes with a tab that has no tree', () => {
      mockState.panes.treesByTabId = {};
      expect(() => removeSourceTab('tab-1', ['tm-live'])).not.toThrow();
      expect(cleared()).toEqual(['tm-live']);
    });
  });

  /**
   * The single-pane path, and it is genuinely reachable for a DEAD pane — unlike
   * `detachPaneToNewWindow`, which `openWindowWithPayload` guards by bailing on an empty terminal
   * list. `buildPaneDetachPayload` has no such guard, so `PaneDragController` can start a
   * cross-window drag of an exited pane and call this on claim or on an orphan drop.
   */
  describe('removeSourcePane', () => {
    it('clears the dragged pane record', () => {
      removeSourcePane('tab-1', 'pn-b', ['tm-exited']);
      expect(cleared()).toEqual(['tm-exited']);
    });

    it('clears nothing when no terminal was handed over', () => {
      removeSourcePane('tab-1', 'pn-b', []);
      expect(cleared()).toEqual([]);
    });

    // Paired with the clear: the handoff itself must still happen, or this would be satisfiable
    // by a function that only cleaned up and never detached.
    it('still detaches the terminal it cleared', () => {
      const { terminalService } = jest.requireMock('../../../../services/TerminalService');
      terminalService.detachTerminal.mockClear();
      removeSourcePane('tab-1', 'pn-b', ['tm-exited']);
      expect(terminalService.detachTerminal).toHaveBeenCalledWith('tm-exited');
    });
  });
});
