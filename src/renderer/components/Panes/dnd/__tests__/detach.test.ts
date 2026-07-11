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
