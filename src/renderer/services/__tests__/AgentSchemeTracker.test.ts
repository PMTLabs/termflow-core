/**
 * @jest-environment jsdom
 */
// Verifies the detected-vs-effective split: a DETECTED but UNMAPPED agent is
// offered to the context menus (getDetectedAgentForTerminal) yet does NOT theme
// the pane (getAgentForTerminal / effective) until the user assigns it a color.
const mockMappings: { value: Record<string, string> } = { value: {} };
const mockProcs: { value: any[] } = { value: [] };

jest.mock('../../store', () => ({
  store: {
    getState: () => ({
      settings: { agentColorSchemes: mockMappings.value, colorSchemaId: 'default' },
      panes: { treesByTabId: {}, activePaneByTabId: {} },
      tabs: { tabs: [], activeTabId: null },
    }),
  },
}));
jest.mock('../TerminalService', () => ({
  terminalService: { getTerminalIdForProcess: (pid: string) => (pid === 'p1' ? 'tm-1' : undefined) },
}));
jest.mock('../../store/terminalTheme', () => ({
  applyEffectiveThemes: jest.fn(),
  applyActivePaneBackground: jest.fn(),
}));

import { agentSchemeTracker } from '../AgentSchemeTracker';

beforeEach(() => {
  mockMappings.value = {};
  mockProcs.value = [];
  (window as any).electronAPI = { getActiveProcesses: async () => mockProcs.value };
});
afterEach(() => agentSchemeTracker.stop());

it('offers an UNMAPPED detected agent to the menu but does not theme it', async () => {
  mockProcs.value = [{ id: 'p1', agent: 'agy', lastInputSource: 'user', lastInputAt: 1 }];
  agentSchemeTracker.start();
  await agentSchemeTracker.refreshNow();
  // Menu path sees the raw detected agent...
  expect(agentSchemeTracker.getDetectedAgentForTerminal('tm-1')).toBe('agy');
  // ...but the theming path (effective) does not, since it is unmapped.
  expect(agentSchemeTracker.getAgentForTerminal('tm-1')).toBeNull();
});

it('once mapped, the agent appears in BOTH detected and effective', async () => {
  mockMappings.value = { agy: 'ocean' };
  mockProcs.value = [{ id: 'p1', agent: 'agy', lastInputSource: 'user', lastInputAt: 1 }];
  agentSchemeTracker.start();
  await agentSchemeTracker.refreshNow();
  expect(agentSchemeTracker.getDetectedAgentForTerminal('tm-1')).toBe('agy');
  expect(agentSchemeTracker.getAgentForTerminal('tm-1')).toBe('agy');
});

it('notifies subscribers when the DETECTED agent changes, and stops after unsubscribe', async () => {
  let calls = 0;
  const unsub = agentSchemeTracker.subscribe(() => { calls++; });
  mockProcs.value = [{ id: 'p1', agent: 'agy', lastInputSource: 'user', lastInputAt: 1 }];
  agentSchemeTracker.start();
  await agentSchemeTracker.refreshNow();
  expect(calls).toBe(1); // agy appeared → one notify

  await agentSchemeTracker.refreshNow(); // same agent → no change → no notify
  expect(calls).toBe(1);

  mockProcs.value = []; // agent exits → detected changes → notify (drives chip hide)
  await agentSchemeTracker.refreshNow();
  expect(calls).toBe(2);

  unsub();
  mockProcs.value = [{ id: 'p1', agent: 'codex', lastInputSource: 'user', lastInputAt: 2 }];
  await agentSchemeTracker.refreshNow();
  expect(calls).toBe(2); // unsubscribed → no further notifications
});

it('exposes the detected foreground exe path for the chip icon', async () => {
  mockProcs.value = [
    { id: 'p1', agent: 'codex', agentExe: 'C:\\tools\\codex.exe', lastInputSource: 'user', lastInputAt: 1 },
  ];
  agentSchemeTracker.start();
  await agentSchemeTracker.refreshNow();
  expect(agentSchemeTracker.getDetectedAgentExeForTerminal('tm-1')).toBe('C:\\tools\\codex.exe');
  // No exe reported → getter returns null (chip falls back to the dot).
  expect(agentSchemeTracker.getDetectedAgentExeForTerminal('tm-unknown')).toBeNull();
});

it('notifies subscribers when only the exe changes (same agent label)', async () => {
  let calls = 0;
  const unsub = agentSchemeTracker.subscribe(() => { calls++; });
  mockProcs.value = [
    { id: 'p1', agent: 'codex', agentExe: '/usr/bin/codex', lastInputSource: 'user', lastInputAt: 1 },
  ];
  agentSchemeTracker.start();
  await agentSchemeTracker.refreshNow();
  expect(calls).toBe(1);

  // Same label, different exe path → still a detected change → notify.
  mockProcs.value = [
    { id: 'p1', agent: 'codex', agentExe: '/opt/codex/bin/codex', lastInputSource: 'user', lastInputAt: 2 },
  ];
  await agentSchemeTracker.refreshNow();
  expect(calls).toBe(2);
  expect(agentSchemeTracker.getDetectedAgentExeForTerminal('tm-1')).toBe('/opt/codex/bin/codex');
  unsub();
});

it('idle fast-path holds: no mappings, nothing themed, NO chip subscriber → tick does not poll', async () => {
  mockMappings.value = {}; // no agent colors assigned
  mockProcs.value = [{ id: 'p1', agent: 'agy', agentExe: '/x/agy', lastInputSource: 'user', lastInputAt: 1 }];
  const getActiveProcesses = jest.fn(async () => mockProcs.value);
  (window as any).electronAPI = { getActiveProcesses };

  agentSchemeTracker.start(); // fires an immediate tick — must be gated out
  await new Promise((r) => setTimeout(r, 0));

  expect(getActiveProcesses).not.toHaveBeenCalled(); // zero background cost preserved
  expect(agentSchemeTracker.getDetectedAgentForTerminal('tm-1')).toBeNull();
});

it('tick polls when a chip subscriber is mounted even with NO color mappings (release chip fix)', async () => {
  mockMappings.value = {}; // fresh config, like a release build with no colors assigned
  mockProcs.value = [{ id: 'p1', agent: 'agy', agentExe: '/x/agy', lastInputSource: 'user', lastInputAt: 1 }];
  const getActiveProcesses = jest.fn(async () => mockProcs.value);
  (window as any).electronAPI = { getActiveProcesses };

  const unsub = agentSchemeTracker.subscribe(() => {}); // a mounted AgentChip wants detection
  agentSchemeTracker.start(); // immediate tick — must poll now, not wait for a right-click
  await new Promise((r) => setTimeout(r, 0));

  expect(getActiveProcesses).toHaveBeenCalled();
  expect(agentSchemeTracker.getDetectedAgentForTerminal('tm-1')).toBe('agy');
  unsub();
});
