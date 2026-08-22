import { snapshotCategory, isCategoryDirty, TrackedSettings } from '../settingsDirty';

const base: TrackedSettings = {
  fontSize: 14,
  fontWeight: '400',
  fontWeightBold: '700',
  tabSizingMode: 'shrink',
  fixedTabWidth: 100,
  colorSchemaId: 'default',
  agentColorSchemes: {},
  closeTabOnProcessExit: false,
  smartCtrlC: true,
  enhancedKeyboard: true,
  commandSuggestions: true,
  activateTabOnApiCreate: false,
  canvasWheelMode: 'zoom',
  canvasBusyCue: 'sweep',
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

  it('appearance tracks font weight and bold weight', () => {
    // Same failure mode noted below for canvasBusyCue: an untracked field makes
    // "Discard changes" quietly not discard this one.
    const snap = snapshotCategory('appearance', base);
    expect(isCategoryDirty('appearance', { ...base, fontWeight: '300' }, snap)).toBe(true);
    expect(isCategoryDirty('appearance', { ...base, fontWeightBold: '900' }, snap)).toBe(true);
    expect(isCategoryDirty('appearance', { ...base }, snap)).toBe(false);
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

  it('terminal tracks the canvas wheel mode', () => {
    // A tracked field left out of the snapshot is invisible rather than wrong: the setting
    // still applies and still persists, and the unsaved-changes guard simply never mentions it.
    const snap = snapshotCategory('terminal', base);
    expect(isCategoryDirty('terminal', { ...base, canvasWheelMode: 'scroll' }, snap)).toBe(true);
    expect(isCategoryDirty('terminal', { ...base, canvasWheelMode: 'zoom' }, snap)).toBe(false);
  });

  it('terminal tracks the canvas busy cue', () => {
    // Same failure mode as the wheel mode above, and the same reason it is worth its own test:
    // an untracked field makes "Discard changes" quietly not discard this one.
    const snap = snapshotCategory('terminal', base);
    expect(isCategoryDirty('terminal', { ...base, canvasBusyCue: 'dot' }, snap)).toBe(true);
    expect(isCategoryDirty('terminal', { ...base, canvasBusyCue: 'sweep' }, snap)).toBe(false);
  });

  it('the canvas busy cue survives a snapshot/revert round trip', () => {
    // The snapshot is what "Discard changes" replays, so a field that is DIRTY-tracked but not
    // carried in the snapshot object would flag the change and then fail to undo it.
    const snap = snapshotCategory('terminal', { ...base, canvasBusyCue: 'dot' });
    expect(snap).toMatchObject({ kind: 'terminal', canvasBusyCue: 'dot' });
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
