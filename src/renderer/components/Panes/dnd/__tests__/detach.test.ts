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
  },
}));

jest.mock('@termflow/terminal-core', () => ({
  terminalCache: { get: () => undefined },
}));

import { buildTabDetachPayload, applyDetachPayload } from '../detach';
import { addTab } from '../../../../store/slices/tabsSlice';

describe('whole-tab detach (buildTabDetachPayload / applyDetachPayload)', () => {
  beforeEach(() => {
    dispatch.mockClear();
    mockState.tabs.tabs = [];
    mockState.panes.treesByTabId = {};
    mockState.zoom.levels = {};
  });

  const leaf = (id: string, terminalId: string): PaneNode => ({ id, type: 'terminal', terminalId });

  it('carries the source tab icon, titleIsCustom, titleColor and colorSchemaId into the payload', () => {
    mockState.tabs.tabs = [{
      id: 'tab-1',
      title: 'rephlo-main',
      shellType: 'default',
      icon: '🖥️',
      titleIsCustom: true,
      titleColor: '#ff0000',
      colorSchemaId: 'solarized',
    }];
    mockState.panes.treesByTabId = { 'tab-1': leaf('p1', 'tab-1') };

    const payload = buildTabDetachPayload('tab-1', 'rephlo-main');

    expect(payload).toMatchObject({
      tabIcon: '🖥️',
      titleIsCustom: true,
      titleColor: '#ff0000',
      colorSchemaId: 'solarized',
    });
  });

  it('reconstructs the tab in the destination window with those fields intact', () => {
    mockState.tabs.tabs = [{
      id: 'tab-1',
      title: 'rephlo-main',
      shellType: 'default',
      icon: '🖥️',
      titleIsCustom: true,
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
    });
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
