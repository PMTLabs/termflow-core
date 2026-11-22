/**
 * The solo pane's floating header must stop short of the terminal's scrollbar column.
 *
 * With one terminal in a tab the pane header is hidden and floats back in over the terminal's
 * top 30px when the pointer dwells near the top (TerminalPane.css `.solo`). The scrollbar's
 * ▲ button (plan 046) lives in exactly that corner, so a header that reached the pane's right
 * edge covered it: hover to reach the button, the header slides out over it. Reported on the
 * first hands-on test of the arrows.
 *
 * The gap is the sum of two numbers owned elsewhere — the `.terminal-display` padding and
 * xterm's scrollbar width — so this test derives both from their sources rather than repeating
 * `18`: if either changes, the header rule is caught out of step instead of silently drifting
 * back over the button. jsdom has no layout, so the stylesheet text is the only oracle.
 */
import fs from 'fs';
import path from 'path';

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, ...p), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const PANE_CSS = stripComments(read('..', 'TerminalPane.css'));
const DISPLAY_CSS = stripComments(read('..', '..', 'Terminal', 'TerminalDisplay.css'));
const XTERM_CONSTANTS = read('..', '..', '..', '..', '..', 'node_modules', '@xterm', 'xterm', 'src', 'browser', 'shared', 'Constants.ts');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function declarationsOf(css: string, selector: string): string {
  const m = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, sel]) => sel.trim() === selector);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[2];
}

describe('solo pane header vs the scrollbar ▲ button', () => {
  const displayPadding = Number(/padding:\s*(\d+)px/.exec(declarationsOf(DISPLAY_CSS, '.terminal-display'))![1]);
  const scrollbarWidth = Number(/DEFAULT_SCROLL_BAR_WIDTH\s*=\s*(\d+)/.exec(XTERM_CONSTANTS)![1]);

  it('derives its inputs from their owners', () => {
    // Guards the derivation itself: a regex that stopped matching would otherwise turn the
    // real assertion below into `NaN === NaN` and pass.
    expect(displayPadding).toBeGreaterThan(0);
    expect(scrollbarWidth).toBeGreaterThan(0);
  });

  it('leaves exactly the scrollbar column uncovered: display padding + xterm bar width', () => {
    const solo = declarationsOf(PANE_CSS, '.terminal-pane.solo .terminal-pane-header');
    expect(solo).toMatch(/position:\s*absolute/); // the overlap only exists because it floats
    const right = /(?:^|[\s;])right:\s*(\d+)px/.exec(solo);
    expect(right).not.toBeNull();
    expect(Number(right![1])).toBe(displayPadding + scrollbarWidth);
  });

  it('does not narrow a split pane\'s header, which sits above the terminal, not over it', () => {
    const inFlow = declarationsOf(PANE_CSS, '.terminal-pane-header');
    expect(inFlow).not.toMatch(/(?:^|[\s;])right:/);
  });
});
