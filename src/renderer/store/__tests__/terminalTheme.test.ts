/**
 * @jest-environment jsdom
 */
// Mock the terminal-core boundary so applyEffectiveThemes can be exercised
// without a live xterm; we only assert what it tells the engine.
jest.mock('@termflow/terminal-core', () => ({
  applyColorSchemaToTerminals: jest.fn(),
  setAgentColorLock: jest.fn(),
}));
import { resolveSchemaId, applyEffectiveThemes } from '../terminalTheme';
import { setAgentColorLock } from '@termflow/terminal-core';

// jsdom lacks CSS.escape in some versions; setPaneBackgroundVar uses it.
beforeAll(() => {
  (global as any).CSS = (global as any).CSS ?? { escape: (s: string) => s };
});

// Minimal RootState-shaped fixture. Only the fields resolveSchemaId reads are
// present; cast through unknown to satisfy the full RootState type.
function makeState(overrides: any = {}): any {
  return {
    settings: {
      colorSchemaId: 'default',
      agentColorSchemes: { codex: 'dracula' },
      ...(overrides.settings ?? {}),
    },
    tabs: { tabs: [{ id: 'tb-1', colorSchemaId: 'nord' }], ...(overrides.tabs ?? {}) },
    panes: {
      treesByTabId: { 'tb-1': { type: 'terminal', terminalId: 'tb-1' } },
      ...(overrides.panes ?? {}),
    },
  };
}

describe('resolveSchemaId precedence', () => {
  it('agent override wins over tab and default', () => {
    expect(resolveSchemaId('tb-1', makeState(), () => 'codex')).toBe('dracula');
  });

  it('falls back to the tab schema when no mapped agent is running', () => {
    expect(resolveSchemaId('tb-1', makeState(), () => null)).toBe('nord');
  });

  it('falls back to the global default when the tab has no override', () => {
    const state = makeState({ tabs: { tabs: [{ id: 'tb-1' }] } });
    expect(resolveSchemaId('tb-1', state, () => null)).toBe('default');
  });

  it('an unmapped running agent falls through to the tab schema', () => {
    expect(resolveSchemaId('tb-1', makeState(), () => 'node')).toBe('nord');
  });

  it('an unresolved terminal (no owning tab) falls back to the global default', () => {
    expect(resolveSchemaId('tb-unknown', makeState(), () => null)).toBe('default');
  });
});

describe('applyEffectiveThemes agent color lock', () => {
  beforeEach(() => (setAgentColorLock as jest.Mock).mockClear());

  it('locks a pane whose ASSIGNED agent is running (so the agent cannot overwrite our scheme)', () => {
    applyEffectiveThemes(['tb-1'], makeState(), () => 'codex'); // codex is mapped → dracula
    expect(setAgentColorLock).toHaveBeenCalledWith(['tb-1'], true);
  });

  it('does NOT lock when an UNMAPPED agent is running (normal terminal behavior)', () => {
    applyEffectiveThemes(['tb-1'], makeState(), () => 'node'); // node has no mapping
    expect(setAgentColorLock).toHaveBeenCalledWith(['tb-1'], false);
  });

  it('does NOT lock a plain-shell pane (no agent)', () => {
    applyEffectiveThemes(['tb-1'], makeState(), () => null);
    expect(setAgentColorLock).toHaveBeenCalledWith(['tb-1'], false);
  });
});
