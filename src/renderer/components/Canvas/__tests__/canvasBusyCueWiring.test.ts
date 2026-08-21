/**
 * The busy cue setting is actually CONNECTED at both ends (`plan/023`).
 *
 * `plan/023` §2 lists a setting as an eight-link chain and every link has a test — union,
 * default, reducer, persist, hydrate, control, dirty-tracking, revert. A review of PR #50 found
 * all eight present and passed the PR clean. The chain was still dead-endable, because it was
 * missing the link nobody writes down: **something has to READ it.**
 *
 * Mutation that proved it — replacing `busyCue={busyCue}` with `busyCue="sweep"` in `CanvasMode`
 * passed all 2285 tests AND `tsc --noEmit`. The dropdown would move, `config.json` would update,
 * `isCategoryDirty` would report the change, "Discard changes" would revert it — and nothing on
 * screen would ever differ. Every test in the suite watched a different link.
 *
 * Making `busyCue` a REQUIRED prop only catches it being DROPPED (`tsc` sees that). It cannot
 * catch it being hard-coded, because a literal of the right type is a legal argument. Only the
 * binding itself can be pinned, so that is what this file does — at both ends:
 *
 *   store --(A)--> CanvasMode --(B)--> CanvasNode        the read path
 *   SettingsPage --(C)--> store                          the write path
 *
 * Source-derived rather than restated: the tests find the identifier `CanvasMode` bound the
 * selector to and then look for THAT, so renaming the local is free and hard-coding is not.
 *
 * Matched against source with comments stripped, for the reason `canvasCloseWiring` records:
 * three tests in this plan have now been satisfied by their own explanatory prose.
 */
import path from 'path';
import { readSource } from '../../../utils/readSource';

function code(file: string): string {
  return readSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const MODE = code(path.resolve(__dirname, '../CanvasMode.tsx'));
const SETTINGS = code(path.resolve(__dirname, '../../Settings/SettingsPage.tsx'));

/**
 * The opening tag of the `<CanvasNode ...>` element, props only.
 *
 * Brace-COUNTED rather than sliced to the first `>`: props hold arrow callbacks
 * (`onClick={() => …}`), so the first `>` in the text belongs to a `=>` several props early and
 * a naive slice would cut the tag off before reaching `busyCue`. Same reason `canvasNodeChrome`
 * counts braces to read a `@keyframes` block.
 */
const NODE_PROPS = (() => {
  const at = MODE.indexOf('<CanvasNode');
  if (at < 0) return '';
  let depth = 0;
  for (let i = at; i < MODE.length; i += 1) {
    const c = MODE[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return MODE.slice(at, i);
  }
  return '';
})();

describe('the busy cue setting reaches the canvas', () => {
  // Guard on the guard. Every assertion below reads `NODE_PROPS`, so a parser that returned ''
  // would make each one fail for the wrong reason — or, for the `not.toMatch` cases, PASS
  // vacuously. Checked once here rather than repeated per test.
  it('finds the CanvasNode element it is going to inspect', () => {
    expect(NODE_PROPS).toMatch(/^<CanvasNode\b/);
    expect(NODE_PROPS).toMatch(/\bnode=\{/);
    // ...and it reached the far side of at least one arrow-callback prop, which is the thing a
    // slice-to-first-`>` gets wrong.
    expect(NODE_PROPS.length).toBeGreaterThan(MODE.slice(MODE.indexOf('<CanvasNode')).indexOf('=>'));
  });

  /** Link A — the identifier `CanvasMode` binds the store value to. */
  const bound = /const\s+(\w+)\s*=\s*useSelector\(\s*\([^)]*\)\s*=>\s*s\.settings\.canvasBusyCue\s*\)/
    .exec(MODE)?.[1];

  it('CanvasMode subscribes to the setting in the store', () => {
    // Not `toBeDefined()` — naming the identifier in the failure is what tells the next reader
    // whether the selector moved or was deleted.
    expect({ boundTo: bound }).toEqual({ boundTo: expect.any(String) });
  });

  it('CanvasNode is handed that subscription, not a literal', () => {
    // The mutation this exists for. `busyCue="sweep"` and `busyCue={'dot'}` both typecheck and
    // both leave the setting inert.
    expect(NODE_PROPS).toContain(`busyCue={${bound}}`);
    expect(NODE_PROPS).not.toMatch(/busyCue=("|'|\{\s*['"])/);
  });

  // One subscription for the whole surface, not one per node — `CanvasNode` renders inside a
  // `.map` over every node on the canvas, so a `useSelector` moved into it would be N store
  // subscriptions on a surface whose entire design is "many nodes at once".
  it('reads the setting once for the surface, not once per node', () => {
    const NODE = code(path.resolve(__dirname, '../CanvasNode.tsx'));
    expect(NODE).not.toMatch(/useSelector/);
    expect(MODE.match(/s\.settings\.canvasBusyCue/g)).toHaveLength(1);
  });

  /** Link C — the write path. A dropdown bound to nothing is the same dead setting, mirrored. */
  it('the Settings control is bound to the setting in both directions', () => {
    const at = SETTINGS.indexOf('id="canvas-busy-cue"');
    expect(at).toBeGreaterThan(-1);
    // The whole `<select>`, from its id to the closing tag — `value=` and `onChange=` both live
    // in it, and pinning them together is what makes "reads it" and "writes it" one assertion.
    const select = SETTINGS.slice(at, SETTINGS.indexOf('</select>', at));
    expect(select).toContain('value={settings.canvasBusyCue}');
    expect(select).toMatch(/dispatch\(setCanvasBusyCue\(/);
    // Both cues are offered, or the setting is only half-reachable however well it is bound.
    expect(select).toMatch(/<option value="sweep"/);
    expect(select).toMatch(/<option value="dot"/);
  });
});
