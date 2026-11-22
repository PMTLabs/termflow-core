/**
 * The tab busy cue setting is connected at both ends, and the busy cues stay cheap.
 *
 * Same shape as `canvasBusyCueWiring`: a setting whose dropdown moves and whose reducer persists
 * is still dead if nothing reads it, and a literal of the right type typechecks. So the binding
 * itself is pinned, source-derived and with comments stripped:
 *
 *   store --> TabManager --> `.tabs-list[data-running-cue]` --> TabManager.css     read path
 *   SettingsPage --> store                                                         write path
 *
 * The last block guards the reason the setting exists. A busy cue that animates every frame
 * (`linear`/`ease` on an infinite animation) keeps DWM compositing the whole window at 60 Hz for
 * as long as an agent runs — measured at +15–20 points of DWM GPU for the old linear tab sweep.
 */
import path from 'path';
import { readSource } from '../../../utils/readSource';
import { TAB_RUNNING_CUES } from '../tabRunningCue';

function code(file: string): string {
  return readSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
function css(file: string): string {
  return readSource(file).replace(/\/\*[\s\S]*?\*\//g, '');
}

const MANAGER = code(path.resolve(__dirname, '../TabManager.tsx'));
const SETTINGS = code(path.resolve(__dirname, '../../Settings/SettingsPage.tsx'));
const TAB_CSS = css(path.resolve(__dirname, '../TabManager.css'));
const CANVAS_CSS = css(path.resolve(__dirname, '../../Canvas/Canvas.css'));

describe('the tab busy cue setting reaches the tab strip', () => {
  const bound = /const\s+(\w+)\s*=\s*useSelector\(\s*\([^)]*\)\s*=>\s*\w+\.settings\.tabRunningCue\s*\)/
    .exec(MANAGER)?.[1];

  it('TabManager subscribes to the setting once', () => {
    expect({ boundTo: bound }).toEqual({ boundTo: expect.any(String) });
    expect(MANAGER.match(/\.settings\.tabRunningCue/g)).toHaveLength(1);
  });

  it('the strip carries that subscription, not a literal', () => {
    const at = MANAGER.indexOf('className={`tabs-list');
    expect(at).toBeGreaterThan(-1);
    const tag = MANAGER.slice(at, MANAGER.indexOf('onWheel=', at));
    expect(tag).toContain(`data-running-cue={${bound}}`);
  });

  it('the stylesheet has a rule for every cue the base rule does not draw, keyed on that attribute', () => {
    // The unqualified `.tab-item.tab-running::after` rule IS the animated sweep; every other cue
    // — including the default, `pulse` — must override it, or it silently renders as the sweep.
    for (const cue of TAB_RUNNING_CUES.filter((c) => c !== 'animated')) {
      expect(TAB_CSS).toMatch(new RegExp(`\\.tabs-list\\[data-running-cue="${cue}"\\]\\s+\\.tab-item\\.tab-running::after\\s*\\{`));
    }
    // Pulse blinks the shell icon only: the tab's band is hidden, the icon carries the animation.
    const pulseBand = /\[data-running-cue="pulse"\]\s+\.tab-item\.tab-running::after\s*\{([^}]*)\}/.exec(TAB_CSS)?.[1] ?? '';
    expect(pulseBand).toMatch(/display:\s*none/);
    // ...and never on the active tab, whose output the user is already watching.
    expect(TAB_CSS).toMatch(/\[data-running-cue="pulse"\]\s+\.tab-item\.tab-running:not\(\.active\)\s+\.shell-profile-icon\s*\{[^}]*animation:\s*tab-running-pulse\s+2s\s+steps\(1,\s*end\)/);
    expect(TAB_CSS).toMatch(/@keyframes\s+tab-running-pulse\s*\{/);
    // Static has no motion to be noticed by, so it owns a full-tab wash at full opacity.
    // Inheriting the sweep's narrow 0.18 band read as a smudge.
    const stat = /\[data-running-cue="static"\]\s+\.tab-item\.tab-running::after\s*\{([^}]*)\}/.exec(TAB_CSS)?.[1] ?? '';
    expect(stat).toMatch(/animation:\s*none/);
    expect(stat).toMatch(/background-size:\s*100%\s+100%/);
    expect(Number(/opacity:\s*([\d.]+)/.exec(stat)?.[1])).toBe(1);
    // The busy line is 1px: a 2px line along the tab's bottom edge read as the active-tab marker.
    expect(stat).toMatch(/box-shadow:\s*inset\s+0\s+-1px\s+0\s/);
    // Only the static cue draws that line; the other busy rules must not, or they would all show it.
    const otherBusyRules = (TAB_CSS.match(/[^{}]*\.tab-running[^{}]*\{[^}]*\}/g) ?? [])
      .filter((rule) => !/data-running-cue="static"/.test(rule));
    expect(otherBusyRules.length).toBeGreaterThan(3);
    for (const rule of otherBusyRules) expect(rule).not.toMatch(/box-shadow|border(-bottom)?\s*:/);
    expect(TAB_CSS).toMatch(/\[data-running-cue="off"\][^{]*\{[^}]*display:\s*none/);
  });

  it('the tab icon carries the class the pulse rule targets', () => {
    const icon = code(path.resolve(__dirname, '../../Terminal/ShellProfileIcon.tsx'));
    expect(icon.match(/className="shell-profile-icon\b/g)).toHaveLength(2); // <img> and emoji
    expect(MANAGER).toMatch(/<ShellProfileIcon\b/);
  });

  it('the Settings control is bound to the setting in both directions and offers every cue', () => {
    const at = SETTINGS.indexOf('id="tab-running-cue"');
    expect(at).toBeGreaterThan(-1);
    const select = SETTINGS.slice(at, SETTINGS.indexOf('</select>', at));
    expect(select).toContain('value={settings.tabRunningCue}');
    expect(select).toMatch(/dispatch\(setTabRunningCue\(/);
    for (const cue of TAB_RUNNING_CUES) expect(select).toContain(`<option value="${cue}"`);
  });
});

describe('busy cues animate in steps, never every frame', () => {
  const infinite = (sheet: string) =>
    (sheet.match(/animation\s*:[^;]*\binfinite\b[^;]*;/g) ?? []);

  it('finds the busy cue animations it is going to check', () => {
    // Guard on the guard: an empty list would pass the next test vacuously.
    expect(infinite(TAB_CSS).join('\n')).toMatch(/tab-running-sweep/);
    expect(infinite(TAB_CSS).join('\n')).toMatch(/tab-running-pulse/);
    expect(infinite(CANVAS_CSS).join('\n')).toMatch(/canvas-node-sweep/);
    expect(infinite(CANVAS_CSS).join('\n')).toMatch(/canvas-node-pulse/);
    // The canvas pulse is keyed on the attribute CanvasNode publishes, not on a class.
    expect(CANVAS_CSS).toMatch(/\.canvas-node\.running\[data-busy-cue="pulse"\]\s+\.canvas-node-head::after\s*\{[^}]*animation:\s*canvas-node-pulse\s+2s\s+steps\(1,\s*end\)/);
    expect(infinite(CANVAS_CSS).join('\n')).toMatch(/canvas-busy-blink/);
  });

  it.each([['TabManager.css', TAB_CSS], ['Canvas.css', CANVAS_CSS]])(
    'every infinite animation in %s uses a steps() timing function',
    (_name, sheet) => {
      for (const decl of infinite(sheet)) expect(decl).toMatch(/steps\(/);
    },
  );
});
