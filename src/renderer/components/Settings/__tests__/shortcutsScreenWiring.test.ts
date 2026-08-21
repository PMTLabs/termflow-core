import path from 'path';
import { readSource } from '../../../utils/readSource';
import {
  SHORTCUT_ACTIONS, GLOBAL_SHORTCUT_ACTIONS, CANVAS_SHORTCUT_ACTIONS,
} from '../../../services/shortcutActions';

/**
 * The Shortcuts screen, for the canvas-scoped actions — Tam, 2026-08-21: *"I need all shortcuts
 * can be changed by Settings -> Shortcuts screen"*.
 *
 * `shortcutActions.test.ts` proves the registry splits correctly and `canvasGestures.test.ts`
 * proves a rebound combo is obeyed. Neither proves the user can REACH the rebind, and that gap is
 * invisible in the worst way: a canvas group that failed to render leaves a screen which looks
 * complete, a feature that works on its defaults, and no failing test anywhere. Absence has no
 * symptom, so it is asserted against the source.
 *
 * Source-derived rather than mounted because `SettingsPage` is the app's largest component and
 * pulls in Tauri plugins, the network config and the peers panel at module load.
 */

const SETTINGS = readSource(path.resolve(__dirname, '..', 'SettingsPage.tsx'));

describe('every registered shortcut is rendered somewhere', () => {
  /** Or every assertion below is about a screen this test never found. */
  it('found the shortcuts screen', () => {
    expect(SETTINGS).toContain('const renderShortcuts = ');
    expect(SETTINGS).toContain('shortcut-list');
  });

  /**
   * BOTH groups, by the exported list names.
   *
   * Asserting on the names rather than on row markup is what makes this hold as the registry
   * grows: a canvas action added tomorrow is rendered by the same `.map`, with no test to update.
   */
  it('renders the global group and the canvas group', () => {
    expect(SETTINGS).toContain('GLOBAL_SHORTCUT_ACTIONS.map(renderShortcutRow)');
    expect(SETTINGS).toContain('CANVAS_SHORTCUT_ACTIONS.map(renderShortcutRow)');
  });

  /**
   * The two lists PARTITION the registry, so rendering both renders everything exactly once.
   *
   * Without this the pair above is satisfied by a screen that renders the global group twice, or
   * one that quietly drops an action that is in neither list.
   */
  it('covers the whole registry between them, with no action rendered twice', () => {
    const rendered = [...GLOBAL_SHORTCUT_ACTIONS, ...CANVAS_SHORTCUT_ACTIONS].map(a => a.id);
    expect(new Set(rendered).size).toBe(rendered.length);
    expect(rendered.sort()).toEqual(SHORTCUT_ACTIONS.map(a => a.id).sort());
  });

  /**
   * The flat render is GONE, not merely joined by a second one.
   *
   * A leftover `SHORTCUT_ACTIONS.map` would draw every action a second time — including the bare
   * canvas letters, under the global heading, which is the one place they must not appear.
   */
  it('no longer renders the registry as one flat list', () => {
    expect(SETTINGS).not.toContain('SHORTCUT_ACTIONS.map((action)');
    expect(SETTINGS.match(/\bSHORTCUT_ACTIONS\.map\(/g) ?? []).toHaveLength(0);
  });

  /** One row renderer for both groups. Two copies would be free to drift on the record button,
   *  the reset button or the conflict message — a difference nobody sees until the row that was
   *  not updated stops working. */
  it('draws both groups with one shared row renderer', () => {
    expect(SETTINGS).toContain('const renderShortcutRow = ');
    expect(SETTINGS.match(/renderShortcutRow\)/g) ?? []).toHaveLength(2);
  });

  /** The canvas group has to SAY it is scoped. Its rows show bare letters, and a user who read
   *  them as app-wide bindings would reasonably conclude the app was broken. */
  it('tells the user the canvas keys apply only on the canvas', () => {
    const group = SETTINGS.slice(SETTINGS.indexOf('<h3>Canvas Mode</h3>'));
    expect(group).toContain('only on the canvas tab');
  });
});

/**
 * The recorder's modifier requirement is scoped, not removed.
 *
 * Two canvas actions ship with a bare letter. Applying the global rule to them leaves a row whose
 * current value is `T` and which can never be re-recorded to another bare letter — the same trap
 * the recorder's own Space comment records having already fallen into once.
 */
describe('the combo recorder', () => {
  const RECORDER = SETTINGS.slice(
    SETTINGS.indexOf('const handleRecordKeyDown ='),
    SETTINGS.indexOf('const handleSaveSettings ='),
  );

  it('found the recorder', () => {
    expect(RECORDER).toContain('setCustomKeybinding');
  });

  it('exempts canvas-scoped actions from the modifier requirement', () => {
    expect(RECORDER).toContain('!allowsModifierlessCombo(actionId)');
  });

  /**
   * And the exemption is on the MODIFIER gate only.
   *
   * It must not reach the conflict check: a canvas action bound over a reserved combo or another
   * action's is the same collision as any other, and both listeners share one window.
   */
  it('still runs the conflict check for every action', () => {
    const gate = RECORDER.indexOf('allowsModifierlessCombo');
    const conflict = RECORDER.indexOf('findConflict(actionId');
    expect(gate).toBeGreaterThan(-1);
    expect(conflict).toBeGreaterThan(gate);
    const conflictLine = RECORDER.slice(conflict, RECORDER.indexOf('\n', conflict));
    expect(conflictLine).not.toContain('allowsModifierlessCombo');
  });
});
