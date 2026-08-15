import { buildApiCreatedTab, resolveApiCreateIds } from '../apiCreatedTab';

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
