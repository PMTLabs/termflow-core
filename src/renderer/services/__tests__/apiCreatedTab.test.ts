import { buildApiCreatedTab } from '../apiCreatedTab';

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
