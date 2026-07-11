import { snapshotCategory, isCategoryDirty, TrackedSettings } from '../settingsDirty';

const base: TrackedSettings = {
  fontSize: 14,
  tabSizingMode: 'shrink',
  fixedTabWidth: 100,
  colorSchemaId: 'default',
  agentColorSchemes: {},
  closeTabOnProcessExit: false,
  smartCtrlC: true,
  enhancedKeyboard: true,
  commandSuggestions: true,
  activateTabOnApiCreate: false,
  defaultEditor: '',
  defaultProfile: 'p1',
  shellProfiles: [{ id: 'p1', cwd: 'C:/a' }, { id: 'p2', cwd: undefined }],
  customKeybindings: {},
};

describe('settingsDirty', () => {
  it('appearance clean vs dirty', () => {
    const snap = snapshotCategory('appearance', base);
    expect(isCategoryDirty('appearance', base, snap)).toBe(false);
    expect(isCategoryDirty('appearance', { ...base, fontSize: 16 }, snap)).toBe(true);
    expect(isCategoryDirty('appearance', { ...base, tabSizingMode: 'scroll' }, snap)).toBe(true);
    // changing a non-appearance field does not mark appearance dirty
    expect(isCategoryDirty('appearance', { ...base, smartCtrlC: false }, snap)).toBe(false);
  });

  it('appearance tracks agentColorSchemes (order-independent)', () => {
    const snap = snapshotCategory('appearance', { ...base, agentColorSchemes: { codex: 'dracula', claude: 'nord' } });
    // Same map, different insertion order → still clean.
    expect(isCategoryDirty('appearance', { ...base, agentColorSchemes: { claude: 'nord', codex: 'dracula' } }, snap)).toBe(false);
    // Changed a mapping → dirty.
    expect(isCategoryDirty('appearance', { ...base, agentColorSchemes: { codex: 'nord', claude: 'nord' } }, snap)).toBe(true);
    // Removed a mapping → dirty.
    expect(isCategoryDirty('appearance', { ...base, agentColorSchemes: { codex: 'dracula' } }, snap)).toBe(true);
  });

  it('terminal clean vs dirty', () => {
    const snap = snapshotCategory('terminal', base);
    expect(isCategoryDirty('terminal', base, snap)).toBe(false);
    expect(isCategoryDirty('terminal', { ...base, defaultEditor: 'code' }, snap)).toBe(true);
    expect(isCategoryDirty('terminal', { ...base, smartCtrlC: false }, snap)).toBe(true);
    expect(isCategoryDirty('terminal', { ...base, fontSize: 99 }, snap)).toBe(false);
  });

  it('profiles tracks cwd and defaultProfile, ignores other fields', () => {
    const snap = snapshotCategory('profiles', base);
    expect(isCategoryDirty('profiles', { ...base, fontSize: 99 }, snap)).toBe(false);
    expect(isCategoryDirty('profiles', { ...base, defaultProfile: 'p2' }, snap)).toBe(true);
    const editedCwd = { ...base, shellProfiles: [{ id: 'p1', cwd: 'C:/b' }, { id: 'p2' }] };
    expect(isCategoryDirty('profiles', editedCwd as TrackedSettings, snap)).toBe(true);
  });

  it('treats undefined cwd and empty-string cwd as equal', () => {
    const snap = snapshotCategory('profiles', base); // p2 cwd undefined → ''
    const withEmpty = { ...base, shellProfiles: [{ id: 'p1', cwd: 'C:/a' }, { id: 'p2', cwd: '' }] };
    expect(isCategoryDirty('profiles', withEmpty, snap)).toBe(false);
  });

  it('snapshots customKeybindings as a sorted [id, combo][] array', () => {
    const s = { ...base, customKeybindings: { closeTab: 'Ctrl+Alt+W', newTab: 'Ctrl+Alt+N' } };
    const snap = snapshotCategory('shortcuts', s);
    expect(snap).toEqual({ kind: 'shortcuts', customKeybindings: [['closeTab', 'Ctrl+Alt+W'], ['newTab', 'Ctrl+Alt+N']] });
  });

  it('shortcuts is dirty after a change and clean when reverted', () => {
    const baseline = snapshotCategory('shortcuts', base);
    const changed = { ...base, customKeybindings: { newTab: 'Ctrl+Alt+N' } };
    expect(isCategoryDirty('shortcuts', changed, baseline)).toBe(true);
    expect(isCategoryDirty('shortcuts', base, baseline)).toBe(false);
  });
});
