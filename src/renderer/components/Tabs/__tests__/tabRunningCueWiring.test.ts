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
    expect(TAB_CSS).toMatch(/\[data-running-cue="pulse"\][^{]*\{[^}]*animation:\s*tab-running-pulse\s+2s\s+steps\(1,\s*end\)/);
    expect(TAB_CSS).toMatch(/@keyframes\s+tab-running-pulse\s*\{/);
    expect(TAB_CSS).toMatch(/\[data-running-cue="static"\][^{]*\{[^}]*animation:\s*none/);
    expect(TAB_CSS).toMatch(/\[data-running-cue="off"\][^{]*\{[^}]*display:\s*none/);
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
    expect(infinite(CANVAS_CSS).join('\n')).toMatch(/canvas-node-sweep/);
    expect(infinite(CANVAS_CSS).join('\n')).toMatch(/canvas-busy-blink/);
  });

  it.each([['TabManager.css', TAB_CSS], ['Canvas.css', CANVAS_CSS]])(
    'every infinite animation in %s uses a steps() timing function',
    (_name, sheet) => {
      for (const decl of infinite(sheet)) expect(decl).toMatch(/steps\(/);
    },
  );
});
