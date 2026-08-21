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
 * The FIXED canvas keys — Tam, 2026-08-21: *"just list out but not allow to change for now"*.
 *
 * These are the ones he could not find: View All and the fit keys. A shortcut nobody can discover
 * may as well not exist, so the point of the row is discoverability, and the point of these tests
 * is that it stays honest — shown, clearly marked unassignable, and genuinely protected.
 */
describe('the fixed canvas keys', () => {
  const FIXED_BLOCK = SETTINGS.slice(SETTINGS.indexOf('CANVAS_FIXED_SHORTCUTS.map('));

  it('renders the whole table', () => {
    expect(SETTINGS).toContain('CANVAS_FIXED_SHORTCUTS.map(');
    // Every row, from the table — not a hand-picked subset that could silently fall behind it.
    expect(FIXED_BLOCK).toContain('{s.label}');
    expect(FIXED_BLOCK).toContain('{s.display}');
  });

  /**
   * Shows `display`, never `reserve`.
   *
   * `reserve` carries spellings that exist only to be blocked — `Shift+!`, `Ctrl+Plus`,
   * `ArrowUp` — and rendering those would tell the user to press keys nobody calls by those
   * names. The two fields are both strings on the same object, so nothing but this stops the
   * wrong one being wired.
   */
  it('shows the display spelling, not the reserved one', () => {
    const row = FIXED_BLOCK.slice(0, FIXED_BLOCK.indexOf('</div>'));
    expect(row).not.toContain('s.reserve');
  });

  /**
   * NO record or reset button on these rows.
   *
   * Not a disabled one: a greyed-out control reads as "broken here", where an absent control plus
   * the note reads as "not yet". It is also the only thing that makes these rows distinguishable
   * from the assignable ones at a glance.
   */
  it('gives them no record or reset control', () => {
    const rows = FIXED_BLOCK.slice(0, FIXED_BLOCK.indexOf('</div>\n            </div>'));
    expect(rows).not.toContain('shortcut-record-btn');
    expect(rows).not.toContain('shortcut-reset-btn');
    expect(rows).not.toContain('setRecordingActionId');
  });

  it('says they are not reassignable yet', () => {
    const note = SETTINGS.slice(SETTINGS.lastIndexOf('help-text', SETTINGS.indexOf('CANVAS_FIXED_SHORTCUTS.map(')));
    expect(note).toContain('not yet reassignable');
  });

  /** Styled as informational rather than as a disabled control — see the CSS note. */
  it('marks them with their own class', () => {
    expect(FIXED_BLOCK).toContain('shortcut-combo-fixed');
    expect(readSource(path.resolve(__dirname, '..', 'SettingsPage.css')))
      .toContain('.shortcut-combo-fixed');
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
