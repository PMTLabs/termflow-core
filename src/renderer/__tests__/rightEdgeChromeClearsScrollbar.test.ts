/**
 * Nothing that floats over a terminal pane may sit in its scrollbar column.
 *
 * The scrollbar's ▲/▼ buttons (plan 046) occupy the pane's top-right and bottom-right corners:
 * a 14 px column (xterm's DEFAULT_SCROLL_BAR_WIDTH) inset by the 4 px `.terminal-display`
 * padding. Three pieces of pane chrome already floated over those corners with a `right` inside
 * that column — the solo pane header (PR #99), then the agent chip and the scroll-to-bottom
 * button (found running Claude/Codex in a pane: the chip sat on ▲). Each was fixed one at a
 * time; this test is the CENSUS that should have existed first.
 *
 * It scans every stylesheet under components/Terminal and components/Panes for a rule with a
 * `right:` declaration and requires each one to be classified: either it floats over the
 * terminal and must clear the column, or it is exempt for a stated reason. A NEW right-anchored
 * rule fails until someone classifies it — that is the point; "absence is invisible" is exactly
 * how the first three got through. The column width is derived from its owners, not repeated.
 *
 * jsdom has no layout, so the stylesheet text is the only oracle.
 */
import fs from 'fs';
import path from 'path';

const COMPONENTS = path.join(__dirname, '..', 'components');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => path.join(dir, f));
}

/** `[file, selector, declarations]` for every rule in the scanned folders. */
function allRules(): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (const dir of ['Terminal', 'Panes']) {
    for (const file of cssFiles(path.join(COMPONENTS, dir))) {
      const css = stripComments(fs.readFileSync(file, 'utf8'));
      for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        out.push([`${dir}/${path.basename(file)}`, m[1].trim().replace(/\s+/g, ' '), m[2]]);
      }
    }
  }
  return out;
}

/** The `right:` value of a rule (not border-/padding-/margin-right), or null. */
function rightOf(decl: string): string | null {
  const m = /(?:^|[\s;])right\s*:\s*([^;]+);?/.exec(decl);
  return m ? m[1].trim() : null;
}

/** Chrome that floats OVER the terminal at its right edge — must clear the scrollbar column. */
const OVER_THE_TERMINAL = [
  '.agent-chip',
  '.scroll-to-bottom-button',
  '.terminal-search-bar',
  '.terminal-pane.solo .terminal-pane-header',
];

/** Right-anchored rules that do NOT float over the terminal's scrollbar column, and why. */
const EXEMPT: Record<string, string> = {
  '.csp-tooltip': 'anchored to its suggest-popup row, which sits below the terminal, not over it',
  '.context-menu-flyout.flip-left': 'positioned against its parent menu item (right: 100%)',
  '.context-menu-flyout-flash': 'inside the flyout',
  '.session-closed-banner__close': 'inside the in-flow banner rendered BELOW the terminal content',
  '.split-pane-divider.horizontal .split-pane-divider-inner': 'the divider between two panes, outside both',
  '.split-pane-divider.vertical .split-pane-divider-inner': 'the divider between two panes, outside both',
  '.terminal-startup-status': 'shown only before the terminal exists (no processId → no xterm, no scrollbar)',
};

describe('right-edge chrome vs the scrollbar column', () => {
  const displayCss = stripComments(fs.readFileSync(path.join(COMPONENTS, 'Terminal', 'TerminalDisplay.css'), 'utf8'));
  const displayRule = [...displayCss.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, sel]) => sel.trim() === '.terminal-display');
  const displayPadding = Number(/padding:\s*(\d+)px/.exec(displayRule![2])![1]);
  const xtermConstants = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'node_modules', '@xterm', 'xterm', 'src', 'browser', 'shared', 'Constants.ts'),
    'utf8',
  );
  const scrollbarWidth = Number(/DEFAULT_SCROLL_BAR_WIDTH\s*=\s*(\d+)/.exec(xtermConstants)![1]);
  const column = displayPadding + scrollbarWidth;

  const rightAnchored = allRules()
    .map(([file, sel, decl]) => [file, sel, rightOf(decl)] as const)
    .filter((r): r is readonly [string, string, string] => r[2] !== null);

  it('derives the column from its owners', () => {
    expect(displayPadding).toBeGreaterThan(0);
    expect(scrollbarWidth).toBeGreaterThan(0);
  });

  it('finds every rule it is supposed to police', () => {
    // A selector that stopped matching (renamed class, moved file) would otherwise silently
    // drop out of the census and pass.
    const selectors = new Set(rightAnchored.map(([, sel]) => sel));
    for (const sel of OVER_THE_TERMINAL) expect(selectors).toContain(sel);
  });

  it.each(OVER_THE_TERMINAL)('%s keeps its right edge out of the scrollbar column', (sel) => {
    const rule = rightAnchored.find(([, s]) => s === sel)!;
    const px = /^(\d+)px$/.exec(rule[2]);
    expect(px).not.toBeNull(); // a calc()/percentage here needs a human, not a regex
    expect(Number(px![1])).toBeGreaterThanOrEqual(column);
  });

  it('classifies every other right-anchored rule in these folders', () => {
    const unclassified = rightAnchored
      .filter(([, sel]) => !OVER_THE_TERMINAL.includes(sel) && !(sel in EXEMPT))
      .map(([file, sel, right]) => `${file}: ${sel} { right: ${right} }`);
    // New right-anchored chrome must be added to OVER_THE_TERMINAL (and clear the column) or
    // to EXEMPT with a reason — never left to be discovered by a user reaching for ▲.
    expect(unclassified).toEqual([]);
  });

  it('has no stale exemptions', () => {
    const selectors = new Set(rightAnchored.map(([, sel]) => sel));
    for (const sel of Object.keys(EXEMPT)) expect(selectors).toContain(sel);
  });
});
