import fs from 'fs';
import path from 'path';
import { readSource } from '../../../utils/readSource';

/**
 * The right-click menu and the DevTools escape hatch — Tam, 2026-09-05: *"there is a
 * default right context menu which has two items, print and inspect. Disable that …
 * Add the item Open DevTools in the Settings somewhere"*.
 *
 * Cancelling the WebView2 menu removes the ONLY route to the inspector, so the two
 * halves are one change: the suppression is what makes the Settings button
 * load-bearing. Both halves fail silently if a link drops — the menu simply reappears,
 * or the button becomes a no-op, because `window.electronAPI?.openDevtools?.()` is
 * optional-chained twice and an unregistered command only complains in a console
 * nobody can now open.
 *
 * Source-derived (the repo's convention for this, cf. `settingsCategories.test.ts`):
 * `SettingsPage` pulls in Tauri plugins at module load, and the Rust half cannot be
 * mounted from Jest at all.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const SETTINGS = readSource(path.resolve(__dirname, '..', 'SettingsPage.tsx'));
const TAURI_BRIDGE = readSource(path.resolve(ROOT, 'src', 'renderer', 'api', 'tauri-bridge.ts'));
const ELECTRON_D_TS = readSource(path.resolve(ROOT, 'src', 'renderer', 'types', 'electron.d.ts'));
const CONTEXT_MENU_RS = readSource(path.resolve(ROOT, 'src-tauri', 'src', 'context_menu.rs'));
const COMMANDS_RS = readSource(path.resolve(ROOT, 'src-tauri', 'src', 'commands.rs'));
const LIB_RS = readSource(path.resolve(ROOT, 'src-tauri', 'src', 'lib.rs'));

describe('the WebView2 context menu is cancelled, not trimmed', () => {
  /** Or every assertion below is about a file this test never found. */
  it('found the filter', () => {
    expect(fs.existsSync(path.resolve(ROOT, 'src-tauri', 'src', 'context_menu.rs'))).toBe(true);
    expect(CONTEXT_MENU_RS).toContain('add_ContextMenuRequested');
  });

  /**
   * `SetHandled(true)` is the cancel. Removing every item instead still pops an empty
   * frame, which is the bug wearing a different hat.
   */
  it('cancels the menu on non-editable targets', () => {
    expect(CONTEXT_MENU_RS).toContain('args.SetHandled(true)');
  });

  /**
   * The keep-list is what put "Print" and "Inspect" on the title bar and the canvas.
   * Asserting its ABSENCE is what stops a future edit reinstating the reported bug by
   * re-adding a "harmless" single entry.
   */
  it('keeps no default item', () => {
    expect(CONTEXT_MENU_RS).not.toContain('const KEEP');
    expect(CONTEXT_MENU_RS).not.toContain('inspectElement');
  });

  /**
   * The editable-target early return is NOT part of what was reported: a text input's
   * native Cut / Copy / Paste is a deliberate earlier fix (right-click → Paste is the
   * workaround for the Settings "Default editor" field). Cancelling there too would
   * trade one regression for another.
   */
  it('still leaves the native menu on editable targets', () => {
    expect(CONTEXT_MENU_RS).toContain('IsEditable');
    const editableAt = CONTEXT_MENU_RS.indexOf('IsEditable');
    const cancelAt = CONTEXT_MENU_RS.indexOf('args.SetHandled(true)');
    // The early return must come FIRST, or the cancel swallows the editable case too.
    expect(editableAt).toBeGreaterThan(-1);
    expect(cancelAt).toBeGreaterThan(editableAt);
  });
});

describe('Settings → Updates reaches the inspector', () => {
  it('renders the button in the Updates screen', () => {
    expect(SETTINGS).toContain('const renderUpdates = ');
    expect(SETTINGS).toContain('data-testid="open-devtools"');
    expect(SETTINGS).toContain('window.electronAPI?.openDevtools?.()');
  });

  /**
   * The four renderer-side links. `openDevtools` missing from the bridge OBJECT (while
   * present on the interface) type-checks and no-ops, which is the whole failure mode.
   */
  it('declares and implements openDevtools on the Tauri bridge', () => {
    expect(ELECTRON_D_TS).toContain('openDevtools?: () => Promise<void>;');
    expect(TAURI_BRIDGE).toContain('openDevtools: () => Promise<void>;');
    expect(TAURI_BRIDGE).toContain('openDevtools: async () => {');
    expect(TAURI_BRIDGE).toContain("invoke('open_devtools')");
  });

  /**
   * The Rust half, by the SAME command name the bridge invokes — a rename on one side
   * only is a runtime rejection with no visible symptom now that Inspect is gone.
   */
  it('defines and registers the open_devtools command', () => {
    expect(COMMANDS_RS).toContain('pub fn open_devtools(window: tauri::WebviewWindow)');
    expect(COMMANDS_RS).toContain('window.open_devtools()');
    expect(LIB_RS).toContain('commands::open_devtools,');
  });
});
