import path from 'path';
import { readSource } from '../../../utils/readSource';
import { wheelAction, CanvasWheelMode, WheelContext } from '../canvasGestures';

/**
 * The canvas wheel setting, end to end — Tam, 2026-08-17: *"I want to add new option in
 * setting: allow ctrl+wheel on canvas do zoom in/out, and let the wheel as the scroll the
 * canvas"*.
 *
 * `wheelAction` is unit-tested next door, and passing there proves nothing about whether the
 * user can reach it. A setting is a chain of six links — union, default, reducer, persistence,
 * hydration, control — and **every break in it is silent**:
 *
 *  - no hydration → the dropdown works all session and forgets on restart;
 *  - no revert → "Discard changes" leaves the mode changed while claiming it did not;
 *  - an option value that is not a mode → the dropdown selects a value nothing matches, and the
 *    wheel does nothing at all;
 *  - a mode with no option → a mapping that exists in the code and cannot be chosen.
 *
 * None of those produces an error anywhere, which is why they are asserted from the source
 * rather than trusted to review.
 */

const src = (...p: string[]) => readSource(path.resolve(__dirname, '..', ...p));

const GESTURES = src('canvasGestures.ts');
const VIEWPORT = src('CanvasViewport.tsx');
const APP = src('..', '..', 'App.tsx');
const SETTINGS = src('..', 'Settings', 'SettingsPage.tsx');
const SLICE = src('..', '..', 'store', 'slices', 'settingsSlice.ts');
const DIRTY = src('..', '..', 'services', 'settingsDirty.ts');

/**
 * The modes, read from the type itself rather than listed here.
 *
 * That is the point of the file: a list written in the test is a second copy that agrees with
 * whatever it was written against. Derived, it fails the moment a mode is added to the union
 * without a control to pick it, or a control offers a value the union never had.
 */
const MODES = (/export type CanvasWheelMode =([^;]+);/.exec(GESTURES)?.[1] ?? '')
  .split('|')
  .map((s) => s.trim().replace(/^'|'$/g, ''))
  .filter(Boolean);

describe('the modes the rule accepts', () => {
  it('found the union it is deriving from', () => {
    // Without this the whole file passes vacuously against an empty list.
    expect(MODES).toEqual(expect.arrayContaining(['zoom', 'scroll']));
    expect(MODES).toHaveLength(2);
  });

  it('is what the setting is typed as, with no second copy of the list', () => {
    expect(SLICE).toContain("import type { CanvasWheelMode } from '../../components/Canvas/canvasGestures';");
    expect(SLICE).toContain('canvasWheelMode: CanvasWheelMode;');
    // A literal union re-spelled in the slice would compile and then drift.
    expect(SLICE).not.toMatch(/canvasWheelMode:\s*'zoom'\s*\|/);
  });

  it('every one of them makes a plain wheel do something', () => {
    // Derived from the union, so a third mode added without a branch in `wheelAction` fails
    // here — as a wheel that resolves to `passthrough` on empty canvas, which is a canvas that
    // has stopped responding to the wheel entirely.
    const ctx = (mode: string): WheelContext =>
      ({ overlayId: null, mode: mode as CanvasWheelMode, onFocusedTerminal: false });
    for (const mode of MODES) {
      const plain = wheelAction({ ctrlKey: false, metaKey: false }, ctx(mode));
      expect({ mode, plain }).toEqual({ mode, plain: expect.stringMatching(/^(zoom|pan)$/) });
    }
  });

  /**
   * The wiring answers both actions, and answers them DIFFERENTLY. `'pan'` is an explicit
   * branch; `'zoom'` is the fall-through, so it has no string to grep for and is pinned by the
   * call it ends in instead — a `zoom` that fell into the pan branch would pass a test that
   * only counted branches.
   */
  it('is wired for both actions the rule can return', () => {
    expect(VIEWPORT).toMatch(/if \(action === 'pan'\) \{/);
    expect(VIEWPORT).toContain('dispatch(panViewport({ dx, dy }))');
    const afterPan = VIEWPORT.slice(VIEWPORT.indexOf("if (action === 'pan')"));
    expect(afterPan).toMatch(/dispatch\(setViewport\(\s*\n?\s*zoomAt\(/);
  });
});

describe('the setting survives a restart', () => {
  it('is written to the config file when it changes', () => {
    expect(SLICE).toContain("window.electronAPI.setConfigValue('canvasWheelMode', state.canvasWheelMode);");
  });

  /**
   * The link that is easiest to leave out and hardest to notice: everything works until you
   * relaunch, and by then the change is several sessions old.
   */
  it('is read back at boot', () => {
    expect(APP).toContain('setCanvasWheelMode');
    expect(APP).toMatch(/config\.canvasWheelMode/);
  });

  it('validates what it read, against the modes the rule knows', () => {
    // A stale or hand-edited value would otherwise put the canvas in a mode no branch matches:
    // a wheel that does nothing, and a dropdown showing nothing selected to explain why.
    const guard = /if \(([^)]*config\.canvasWheelMode[^)]*)\)/.exec(APP)?.[1] ?? '';
    expect(guard).not.toBe('');
    for (const mode of MODES) expect(guard).toContain(`'${mode}'`);
  });
});

describe('the control in Settings', () => {
  const select = /<select\s+id="canvas-wheel-mode"[\s\S]*?<\/select>/.exec(SETTINGS)?.[0] ?? '';

  it('found the control it is checking', () => {
    expect(select).not.toBe('');
    expect(SETTINGS).toContain('htmlFor="canvas-wheel-mode"');
  });

  it('is bound to the setting in both directions', () => {
    expect(select).toContain('value={settings.canvasWheelMode}');
    expect(select).toContain('dispatch(setCanvasWheelMode(');
  });

  it('offers exactly the modes that exist — no more, no fewer', () => {
    const offered = [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
    expect(offered.slice().sort()).toEqual(MODES.slice().sort());
  });

  it('says which one is the default, since one of them is', () => {
    // The dropdown is the only place a user can find out that leaving it alone is a choice.
    expect(select).toMatch(/<option value="zoom">[^<]*\(default\)/);
  });

  /**
   * Settings applies live and reverts by re-dispatching the baseline, so a field missing from
   * `revertToBaseline` is a "Discard changes" that discards everything except this one — the
   * user is told their change was thrown away while it is still in effect.
   */
  it('is put back by Discard Changes', () => {
    expect(SETTINGS).toContain('dispatch(setCanvasWheelMode(baseline.canvasWheelMode');
  });

  it('is tracked by the dirty check, so Discard is even offered', () => {
    expect(DIRTY).toContain('canvasWheelMode: s.canvasWheelMode,');
  });
});
