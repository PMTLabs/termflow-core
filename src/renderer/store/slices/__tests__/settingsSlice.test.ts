import settingsReducer, { setCloseTabOnProcessExit, setSmartCtrlC, setDefaultEditor, setTabSizingMode, setFixedTabWidth, setActivateTabOnApiCreate, setColorSchema, setCommandSuggestions, setAgentColorScheme, removeAgentColorScheme, setAgentColorSchemes, setCustomKeybinding, resetCustomKeybinding, setCustomKeybindings } from '../settingsSlice';

describe('settingsSlice closeTabOnProcessExit', () => {
  beforeAll(() => {
    // Settings reducers reference window.electronAPI (guarded for persistence).
    // Provide a stub so the guard short-circuits in the node test environment.
    (global as any).window = (global as any).window || {};
  });

  it('defaults to false (tabs are kept for review by default)', () => {
    const state = settingsReducer(undefined, { type: '@@INIT' } as any);
    expect(state.closeTabOnProcessExit).toBe(false);
  });

  it('can be enabled', () => {
    const state = settingsReducer(undefined, setCloseTabOnProcessExit(true));
    expect(state.closeTabOnProcessExit).toBe(true);
  });
});

describe('settingsSlice smartCtrlC', () => {
  beforeAll(() => {
    (global as any).window = (global as any).window || {};
  });

  it('defaults to true (smart Ctrl+C on out of the box)', () => {
    const state = settingsReducer(undefined, { type: '@@INIT' } as any);
    expect(state.smartCtrlC).toBe(true);
  });

  it('can be disabled', () => {
    const state = settingsReducer(undefined, setSmartCtrlC(false));
    expect(state.smartCtrlC).toBe(false);
  });
});

describe('settingsSlice defaultEditor', () => {
  beforeAll(() => {
    (global as any).window = (global as any).window || {};
  });

  it('defaults to an empty string (OS default association)', () => {
    const state = settingsReducer(undefined, { type: '@@INIT' } as any);
    expect(state.defaultEditor).toBe('');
  });

  it('can be set to an editor command', () => {
    const state = settingsReducer(undefined, setDefaultEditor('code'));
    expect(state.defaultEditor).toBe('code');
  });
});

describe('settingsSlice tabSizingMode', () => {
  beforeAll(() => {
    (global as any).window = (global as any).window || {};
  });

  it('defaults to "fixed" (equal-width tabs out of the box)', () => {
    const state = settingsReducer(undefined, { type: '@@INIT' } as any);
    expect(state.tabSizingMode).toBe('fixed');
  });

  it('can switch to scroll mode', () => {
    const state = settingsReducer(undefined, setTabSizingMode('scroll'));
    expect(state.tabSizingMode).toBe('scroll');
  });

  it('can switch to shrink mode', () => {
    const state = settingsReducer(undefined, setTabSizingMode('shrink'));
    expect(state.tabSizingMode).toBe('shrink');
  });
});

describe('settingsSlice fixedTabWidth', () => {
  beforeAll(() => {
    (global as any).window = (global as any).window || {};
  });

  it('defaults to 150', () => {
    const state = settingsReducer(undefined, { type: '@@INIT' } as any);
    expect(state.fixedTabWidth).toBe(150);
  });

  it('can be set within range', () => {
    const state = settingsReducer(undefined, setFixedTabWidth(150));
    expect(state.fixedTabWidth).toBe(150);
  });

  it('clamps below the minimum to 60', () => {
    const state = settingsReducer(undefined, setFixedTabWidth(10));
    expect(state.fixedTabWidth).toBe(60);
  });

  it('clamps above the maximum to 300', () => {
    const state = settingsReducer(undefined, setFixedTabWidth(1000));
    expect(state.fixedTabWidth).toBe(300);
  });
});

describe('settingsSlice activateTabOnApiCreate', () => {
  beforeAll(() => {
    (global as any).window = (global as any).window || {};
  });

  it('defaults to false (API/MCP tabs do not steal focus out of the box)', () => {
    const state = settingsReducer(undefined, { type: '@@INIT' } as any);
    expect(state.activateTabOnApiCreate).toBe(false);
  });

  it('can be enabled', () => {
    const state = settingsReducer(undefined, setActivateTabOnApiCreate(true));
    expect(state.activateTabOnApiCreate).toBe(true);
  });
});

describe('settingsSlice colorSchemaId', () => {
  beforeAll(() => {
    (global as any).window = (global as any).window || {};
  });

  it('defaults to "default"', () => {
    const state = settingsReducer(undefined, { type: '@@INIT' } as any);
    expect(state.colorSchemaId).toBe('default');
  });

  it('can switch to another schema', () => {
    const state = settingsReducer(undefined, setColorSchema('dracula'));
    expect(state.colorSchemaId).toBe('dracula');
  });
});

describe('settingsSlice agentColorSchemes', () => {
  beforeAll(() => {
    (global as any).window = (global as any).window || {};
  });

  it('defaults to an empty map', () => {
    const state = settingsReducer(undefined, { type: '@@INIT' } as any);
    expect(state.agentColorSchemes).toEqual({});
  });

  it('sets an agent color scheme', () => {
    const state = settingsReducer(undefined, setAgentColorScheme({ agent: 'codex', colorSchemaId: 'dracula' }));
    expect(state.agentColorSchemes.codex).toBe('dracula');
  });

  it('removes an agent color scheme', () => {
    let state = settingsReducer(undefined, setAgentColorScheme({ agent: 'codex', colorSchemaId: 'dracula' }));
    state = settingsReducer(state, removeAgentColorScheme({ agent: 'codex' }));
    expect(state.agentColorSchemes.codex).toBeUndefined();
  });

  it('bulk-replaces the map on load', () => {
    const state = settingsReducer(undefined, setAgentColorSchemes({ codex: 'nord', claude: 'dracula' }));
    expect(state.agentColorSchemes).toEqual({ codex: 'nord', claude: 'dracula' });
  });

  // Regression: the persistence side-effect must hand the async config writer a
  // PLAIN snapshot, not the live Immer draft. The draft is revoked once the
  // reducer returns, so updateConfig's later JSON.stringify threw "Cannot perform
  // 'get' on a proxy that has been revoked", which its try/catch swallowed — so
  // the mapping was silently never saved and vanished on restart.
  it('persists a plain snapshot that survives Immer draft revocation', () => {
    const persisted: Array<{ key: string; value: unknown }> = [];
    (global as any).window.electronAPI = {
      setConfigValue: (key: string, value: unknown) => { persisted.push({ key, value }); },
    };
    try {
      // set / remove / bulk all go through the same persistence path.
      settingsReducer(undefined, setAgentColorScheme({ agent: 'codex', colorSchemaId: 'ocean' }));
      settingsReducer(undefined, setAgentColorSchemes({ codex: 'nord' }));
      const saved = persisted.filter((p) => p.key === 'agentColorSchemes');
      expect(saved.length).toBeGreaterThanOrEqual(2);
      for (const rec of saved) {
        // Buggy code leaks the revoked draft → this stringify throws.
        expect(() => JSON.stringify(rec.value)).not.toThrow();
      }
      expect(JSON.parse(JSON.stringify(saved[0].value))).toEqual({ codex: 'ocean' });
    } finally {
      delete (global as any).window.electronAPI;
    }
  });
});

describe('settingsSlice commandSuggestions (backlog 011)', () => {
  beforeAll(() => {
    (global as any).window = (global as any).window || {};
  });

  it('defaults to true (suggestions on out of the box)', () => {
    const state = settingsReducer(undefined, { type: '@@INIT' } as any);
    expect(state.commandSuggestions).toBe(true);
  });

  it('can be disabled', () => {
    const state = settingsReducer(undefined, setCommandSuggestions(false));
    expect(state.commandSuggestions).toBe(false);
  });
});

describe('customKeybindings', () => {
  beforeAll(() => {
    (global as any).window = (global as any).window || {};
  });

  it('defaults to an empty map', () => {
    const state = settingsReducer(undefined, { type: '@@INIT' } as any);
    expect(state.customKeybindings).toEqual({});
  });

  it('setCustomKeybinding adds/overwrites a single override', () => {
    let state = settingsReducer(undefined, { type: '@@INIT' } as any);
    state = settingsReducer(state, setCustomKeybinding({ actionId: 'newTab', combo: 'Ctrl+Alt+N' }));
    expect(state.customKeybindings).toEqual({ newTab: 'Ctrl+Alt+N' });
  });

  it('resetCustomKeybinding removes just that one override', () => {
    let state = settingsReducer(undefined, { type: '@@INIT' } as any);
    state = settingsReducer(state, setCustomKeybinding({ actionId: 'newTab', combo: 'Ctrl+Alt+N' }));
    state = settingsReducer(state, setCustomKeybinding({ actionId: 'closeTab', combo: 'Ctrl+Alt+W' }));
    state = settingsReducer(state, resetCustomKeybinding('newTab'));
    expect(state.customKeybindings).toEqual({ closeTab: 'Ctrl+Alt+W' });
  });

  it('setCustomKeybindings bulk-replaces the whole map', () => {
    let state = settingsReducer(undefined, { type: '@@INIT' } as any);
    state = settingsReducer(state, setCustomKeybinding({ actionId: 'newTab', combo: 'Ctrl+Alt+N' }));
    state = settingsReducer(state, setCustomKeybindings({ closeTab: 'Ctrl+Alt+W' }));
    expect(state.customKeybindings).toEqual({ closeTab: 'Ctrl+Alt+W' });
  });
});
