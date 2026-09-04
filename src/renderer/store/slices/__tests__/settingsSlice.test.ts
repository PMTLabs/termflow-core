import settingsReducer, { setCloseTabOnProcessExit, setSmartCtrlC, setDefaultEditor, setTabSizingMode, setFixedTabWidth, setActivateTabOnApiCreate, setColorSchema, setCommandSuggestions, setAgentColorScheme, removeAgentColorScheme, setAgentColorSchemes, setCustomKeybinding, resetCustomKeybinding, setCustomKeybindings, setLaunchAtLogin, setCanvasWheelMode, setCanvasBusyCue, setSnippets, addSnippet, updateSnippet, removeSnippet, renameSnippetFolder, isValidSnippet, Snippet } from '../settingsSlice';

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

describe('settingsSlice launchAtLogin', () => {
  beforeAll(() => {
    (global as any).window = (global as any).window || {};
  });

  it('defaults to false', () => {
    const state = settingsReducer(undefined, { type: '@@INIT' } as any);
    expect(state.launchAtLogin).toBe(false);
  });

  it('reflects the OS state without persisting to config (no setConfigValue)', () => {
    const setConfigValue = jest.fn();
    (global as any).window.electronAPI = { setConfigValue };
    const state = settingsReducer(undefined, setLaunchAtLogin(true));
    expect(state.launchAtLogin).toBe(true);
    // OS/plugin is the source of truth — the reducer must NOT persist to config.json.
    expect(setConfigValue).not.toHaveBeenCalled();
    delete (global as any).window.electronAPI;
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

/**
 * Canvas Mode's wheel mapping (Tam, 2026-08-17).
 *
 * The DEFAULT is the assertion that matters. Shipping this as `'scroll'` would change what the
 * wheel does for every existing user without them asking, and "the wheel stopped zooming" is
 * indistinguishable from a bug when nobody touched a setting.
 */
describe('settingsSlice canvasWheelMode', () => {
  beforeAll(() => {
    (global as any).window = (global as any).window || {};
  });

  it("defaults to 'zoom' — the behaviour the canvas already had", () => {
    const state = settingsReducer(undefined, { type: '@@INIT' } as any);
    expect(state.canvasWheelMode).toBe('zoom');
  });

  it("can be switched to 'scroll' and back", () => {
    let state = settingsReducer(undefined, setCanvasWheelMode('scroll'));
    expect(state.canvasWheelMode).toBe('scroll');
    state = settingsReducer(state, setCanvasWheelMode('zoom'));
    expect(state.canvasWheelMode).toBe('zoom');
  });

  it('persists the change, so it survives a restart', () => {
    // Every other setter on this slice writes through to config.json; one that forgot would
    // work perfectly all session and revert on the next launch.
    const setConfigValue = jest.fn();
    (global as any).window.electronAPI = { setConfigValue };
    try {
      settingsReducer(undefined, setCanvasWheelMode('scroll'));
      expect(setConfigValue).toHaveBeenCalledWith('canvasWheelMode', 'scroll');
    } finally {
      delete (global as any).window.electronAPI;
    }
  });
});

/**
 * Which busy cue a canvas NODE draws (`plan/023`, Tam 2026-08-20).
 *
 * Unlike `canvasWheelMode` above, the default here deliberately CHANGES the behaviour existing
 * users have: `plan/020` shipped the dot, and this restores the sweep as the out-of-box cue
 * because the dot does not carry at a glance across a canvas. That makes the default the
 * assertion that matters for the opposite reason — it is the decision, so it is the thing a
 * later refactor must not quietly undo.
 */
describe('settingsSlice canvasBusyCue', () => {
  beforeAll(() => {
    (global as any).window = (global as any).window || {};
  });

  it("defaults to 'sweep' — the cue that is readable across a whole canvas", () => {
    const state = settingsReducer(undefined, { type: '@@INIT' } as any);
    expect(state.canvasBusyCue).toBe('sweep');
  });

  it("can be switched to 'dot' and back", () => {
    let state = settingsReducer(undefined, setCanvasBusyCue('dot'));
    expect(state.canvasBusyCue).toBe('dot');
    state = settingsReducer(state, setCanvasBusyCue('sweep'));
    expect(state.canvasBusyCue).toBe('sweep');
  });

  it('persists the change, so it survives a restart', () => {
    // Link 4 of the setting chain, and the one that fails SILENTLY: a setter that forgot to
    // write through works perfectly all session and reverts on the next launch.
    const setConfigValue = jest.fn();
    (global as any).window.electronAPI = { setConfigValue };
    try {
      settingsReducer(undefined, setCanvasBusyCue('dot'));
      expect(setConfigValue).toHaveBeenCalledWith('canvasBusyCue', 'dot');
    } finally {
      delete (global as any).window.electronAPI;
    }
  });
});

describe('settingsSlice snippets (plan/029)', () => {
  beforeAll(() => {
    (global as any).window = (global as any).window || {};
  });

  const mk = (over: Partial<Snippet> = {}): Snippet => ({
    id: 's1',
    text: 'kubectl get pods',
    createdAt: 1000,
    ...over,
  });

  it('defaults to [] — no built-in snippets ship, the list is entirely user-authored', () => {
    const state = settingsReducer(undefined, { type: '@@INIT' } as any);
    expect(state.snippets).toEqual([]);
  });

  it('setSnippets bulk-replaces the list', () => {
    const state = settingsReducer(undefined, setSnippets([mk(), mk({ id: 's2' })]));
    expect(state.snippets.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('addSnippet appends', () => {
    let state = settingsReducer(undefined, setSnippets([mk()]));
    state = settingsReducer(state, addSnippet(mk({ id: 's2', text: 'docker compose up -d' })));
    expect(state.snippets.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('updateSnippet merges a patch into the matching record', () => {
    let state = settingsReducer(undefined, setSnippets([mk()]));
    state = settingsReducer(state, updateSnippet({ id: 's1', patch: { label: 'Pods', folder: 'k8s' } }));
    expect(state.snippets[0]).toEqual(expect.objectContaining({ label: 'Pods', folder: 'k8s', text: 'kubectl get pods' }));
  });

  it('updateSnippet on an unknown id is a no-op', () => {
    const before = settingsReducer(undefined, setSnippets([mk()]));
    const after = settingsReducer(before, updateSnippet({ id: 'nope', patch: { label: 'x' } }));
    expect(after.snippets).toEqual(before.snippets);
  });

  it('removeSnippet drops the matching record', () => {
    let state = settingsReducer(undefined, setSnippets([mk(), mk({ id: 's2' })]));
    state = settingsReducer(state, removeSnippet('s1'));
    expect(state.snippets.map((s) => s.id)).toEqual(['s2']);
  });

  it('renameSnippetFolder moves every snippet in the old folder to the new one', () => {
    let state = settingsReducer(undefined, setSnippets([
      mk({ id: 's1', folder: 'Git' }),
      mk({ id: 's2', folder: 'Git' }),
      mk({ id: 's3', folder: 'Docker' }),
    ]));
    state = settingsReducer(state, renameSnippetFolder({ from: 'Git', to: 'Version Control' }));
    expect(state.snippets.map((s) => s.folder)).toEqual(['Version Control', 'Version Control', 'Docker']);
  });

  it("renameSnippetFolder with to: '' unfiles the matching snippets", () => {
    let state = settingsReducer(undefined, setSnippets([mk({ id: 's1', folder: 'Git' })]));
    state = settingsReducer(state, renameSnippetFolder({ from: 'Git', to: '' }));
    expect(state.snippets[0].folder).toBeUndefined();
  });

  // Regression: same trap as agentColorSchemes — the persistence side-effect must hand the
  // async config writer a PLAIN array snapshot, not the live Immer draft (revoked once the
  // reducer returns), or the write silently never happens.
  describe('persistence', () => {
    let setConfigValue: jest.Mock;

    beforeEach(() => {
      setConfigValue = jest.fn();
      (global as any).window.electronAPI = { setConfigValue };
    });

    afterEach(() => {
      delete (global as any).window.electronAPI;
    });

    const persistedSnippetsArgs = () =>
      setConfigValue.mock.calls.filter(([key]) => key === 'snippets').map(([, value]) => value);

    /**
     * The oracle that matters. `setConfigValue` serialises ASYNCHRONOUSLY, after the
     * reducer has returned and Immer has revoked its drafts — so "is it an array?" is
     * not the question. The question is whether it still serialises at that point.
     *
     * Round-1 review D-01: `state.snippets.map(s => ({ ...s }))` copies `tags` by
     * reference, and that reference is a revoked child draft. `Array.isArray` was true
     * of the broken snapshot too, which is why four green tests never saw it.
     */
    const stringifyError = (v: unknown): string | null => {
      try { JSON.stringify(v); return null; } catch (e) { return String((e as Error).message); }
    };

    // Every fixture here carries `tags`. An EMPTY array is enough to trigger the defect,
    // and a fixture without the key cannot detect it at all.
    const tagged = (over: Partial<Snippet> = {}): Snippet => mk({ tags: ['k8s', 'ops'], ...over });

    it.each([
      ['setSnippets', () => settingsReducer(undefined, setSnippets([tagged()]))],
      ['addSnippet', () => settingsReducer(settingsReducer(undefined, setSnippets([])), addSnippet(tagged()))],
      ['updateSnippet', () => settingsReducer(settingsReducer(undefined, setSnippets([tagged()])), updateSnippet({ id: 's1', patch: { label: 'x' } }))],
      ['removeSnippet', () => settingsReducer(settingsReducer(undefined, setSnippets([tagged()])), removeSnippet('nope'))],
      ['renameSnippetFolder', () => settingsReducer(settingsReducer(undefined, setSnippets([tagged({ folder: 'Git' })])), renameSnippetFolder({ from: 'Git', to: 'VCS' }))],
    ])('%s persists a snapshot that still serialises after the reducer returns', (_name, run) => {
      run();
      const arg = persistedSnippetsArgs().at(-1);
      // Kills: `map(s => ({ ...s }))`, which leaves `tags` as a revoked proxy.
      expect(stringifyError(arg)).toBeNull();
    });

    it('persists the exact contents, not merely something array-shaped', () => {
      settingsReducer(undefined, setSnippets([tagged()]));
      const [arg] = persistedSnippetsArgs();
      // Kills: persisting `[]`, or persisting the pre-change list.
      expect(arg).toEqual([tagged()]);
    });

    it('persists the POST-change list for each mutating reducer', () => {
      const state = settingsReducer(undefined, setSnippets([tagged(), tagged({ id: 's2' })]));
      settingsReducer(state, removeSnippet('s2'));
      // Kills: persisting the unmodified list — the commonest way a "plain array" assertion lies.
      expect(persistedSnippetsArgs().at(-1)).toEqual([tagged()]);
    });

    it('one tagged snippet must not take the untagged ones down with it', () => {
      // The amplification measured in round 1: the list is ONE payload, so a single
      // unserialisable member loses every sibling too.
      const state = settingsReducer(undefined, setSnippets([mk({ id: 'plain' }), tagged({ id: 'withTags' })]));
      settingsReducer(state, removeSnippet('no-such-id'));
      const arg = persistedSnippetsArgs().at(-1);
      expect(stringifyError(arg)).toBeNull();
      expect((arg as Snippet[]).map((x) => x.id)).toEqual(['plain', 'withTags']);
    });

    it('persists a frozen snapshot that cannot be used to reach back into store state', () => {
      const state = settingsReducer(undefined, setSnippets([tagged()]));
      const arg = persistedSnippetsArgs().at(-1) as Snippet[];
      // `current()` returns a deep plain snapshot, and Immer's auto-freeze — which RTK
      // relies on to catch accidental state mutation — freezes it all the way down,
      // the nested `tags` array included. So the snapshot is not a route back into the
      // store, and it holds no proxy that could be revoked before it is serialised.
      //
      // Kills the previous `map(s => ({ ...s }))`: that built fresh, UNFROZEN objects,
      // so every assertion below fails on it.
      expect(Object.isFrozen(arg)).toBe(true);
      expect(Object.isFrozen(arg[0])).toBe(true);
      expect(Object.isFrozen(arg[0].tags)).toBe(true);
      expect(arg).toEqual([tagged()]);
      expect(state.snippets).toEqual([tagged()]);
    });
  });
});

describe('isValidSnippet (plan/029 link 8 — hydration validation)', () => {
  const valid: Snippet = {
    id: 's1',
    label: 'Pods',
    text: 'kubectl get pods',
    folder: 'k8s',
    tags: ['k8s', 'read'],
    createdAt: 1000,
  };

  it('accepts a fully valid record', () => {
    expect(isValidSnippet(valid)).toBe(true);
  });

  it('rejects a record missing id', () => {
    const { id, ...rest } = valid;
    expect(isValidSnippet(rest)).toBe(false);
  });

  it('rejects a record missing text', () => {
    const { text, ...rest } = valid;
    expect(isValidSnippet(rest)).toBe(false);
  });

  it('rejects tags that is not an array', () => {
    expect(isValidSnippet({ ...valid, tags: 'k8s' })).toBe(false);
  });

  it('rejects tags containing a non-string', () => {
    expect(isValidSnippet({ ...valid, tags: ['k8s', 42] })).toBe(false);
  });

  it('accepts an extra unknown key (forward-compat)', () => {
    expect(isValidSnippet({ ...valid, futureField: 'anything' })).toBe(true);
  });
});
