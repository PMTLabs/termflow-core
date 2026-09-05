/**
 * `TerminalDisplay`'s half of "a context menu belongs to the tab it was opened in".
 *
 * A TRIPWIRE over the source, for the reason `terminalDisplayRelocationWiring.test.ts` gives at
 * length: this component cannot be mounted under the root Jest config (two CSS imports with no
 * transform, `@tauri-apps/api/event`, the Redux store, and a real `Terminal.open()` that needs a
 * canvas 2D context jsdom lacks). The RULE these lines invoke is exercised for real in
 * `hooks/__tests__/useDismissOnTabDeactivate.test.tsx`, and the identical wiring on the pane is
 * mounted for real in `Panes/__tests__/paneMenuTabScope.test.tsx`; what this file guards is that
 * the four floating surfaces THIS component owns are actually handed to it.
 *
 * The load-bearing case is the last one. Both dismissal paths in this file — the tab switch and
 * the canvas relocation — mean "this menu can no longer be where it thinks it is", and both have
 * to list every surface. A fifth surface added to the component has two places to be registered,
 * and listing it in one is exactly the kind of half-fix that leaves a menu stranded on screen in
 * only one of the two situations. Comparing the two lists to EACH OTHER, rather than each to a
 * hard-coded roster, is what makes the assertion survive the surfaces changing.
 */
import * as path from 'path';
import { readSource } from '../../../utils/readSource';

const SOURCE = readSource(path.join(__dirname, '..', 'TerminalDisplay.tsx'));

/**
 * `SOURCE` with its comments removed.
 *
 * Every assertion here is structural, and raw `toContain` on source counts text inside comments —
 * so a negative would be one explanatory sentence away from being satisfied by the very comment
 * that explains it. Copied from `terminalDisplayRelocationWiring.test.ts`, including its CRLF
 * note: `.` does not match `\r`, so `[^\n]*` and no `$` anchor.
 */
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/[^\n]*/, '$1'))
  .join('\n');

/** The body of the `{ … }` block that opens at or after `from`, found by BRACE MATCHING. */
function blockBodyAt(from: number): string {
  const open = CODE.indexOf('{', from);
  expect(open).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < CODE.length; i += 1) {
    if (CODE[i] === '{') depth += 1;
    else if (CODE[i] === '}') {
      depth -= 1;
      if (depth === 0) return CODE.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces from ${from}`);
}

/** Every `setX(null)` in a block, as a sorted list of the setter names. */
const clearedSlots = (body: string): string[] =>
  Array.from(body.matchAll(/\b(set[A-Za-z]+)\(null\)/g), (m) => m[1]).sort();

const dismissBody = () => blockBodyAt(CODE.indexOf('useDismissOnTabDeactivate(isActive,'));
const relocatedBody = () => blockBodyAt(CODE.indexOf('onRelocated:'));

describe('TerminalDisplay dismisses its menus when its tab is switched away from', () => {
  it('subscribes the tab-deactivation rule, keyed on this tab\'s own activity', () => {
    expect(CODE).toContain(
      "import { useDismissOnTabDeactivate } from '../../hooks/useDismissOnTabDeactivate';",
    );
    // `isActive` is the TAB-level flag (TerminalPane passes `isTabActive` into it). Not
    // `shouldFocus`, which is pane-level: in a split, the unfocused pane of the ACTIVE tab would
    // then lose a menu the user had just opened in it.
    expect(CODE).toContain('useDismissOnTabDeactivate(isActive,');
  });

  it('clears all four floating surfaces', () => {
    expect(clearedSlots(dismissBody())).toEqual([
      'setContextMenu', 'setPathPicker', 'setSchemaPicker', 'setSnippetsMenu',
    ]);
  });

  /**
   * The tab being left is off screen, and the tab being entered focuses its own terminal from
   * `shouldFocus` in the same commit. `closeContextMenu` and friends call `refocusTerminal()`,
   * which under DECSET 1004 focus reporting also writes a focus-in/out pair to a PTY the user is
   * no longer looking at — so the dismissal has to use the raw setters.
   */
  it('does not restore focus to the terminal it is dismissing', () => {
    const body = dismissBody();
    expect(body).not.toContain('refocusTerminal');
    expect(body).not.toContain('closeContextMenu');
    expect(body).not.toContain('.focus()');
  });

  it('clears exactly the surfaces the relocation path clears', () => {
    expect(clearedSlots(dismissBody())).toEqual(clearedSlots(relocatedBody()));
  });
});
