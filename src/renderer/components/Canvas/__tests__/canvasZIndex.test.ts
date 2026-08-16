import fs from 'fs';
import path from 'path';

/**
 * Canvas Mode overlays the tab-mode DOM WITHOUT unmounting it, so its z-index is a
 * cross-file invariant rather than a local style choice: every floating widget the
 * terminal subtree owns competes with the overlay directly.
 *
 * `.terminal-display` has `isolation: isolate`, but that contains nothing here —
 * ScrollToBottomButton, TerminalSearchBar and CommandSuggestPopup are SIBLINGS of it
 * inside `.terminal-display-wrapper`, which is `position: relative` with no z-index,
 * as is `.terminal-pane-content`. At the original z-index 5, a scroll-to-bottom
 * button left over from tab mode painted on top of the canvas and stayed clickable.
 *
 * Both bounds are DERIVED from the real stylesheets, not restated here. A hand-written
 * list would go stale the first time someone adds a widget, which is exactly the
 * failure mode this guards.
 */

const RENDERER = path.resolve(__dirname, '../../..');

/** Every `z-index: N` DECLARATION in a file. Prose mentions of z-index in comments
 *  have no colon and are correctly ignored. */
function zIndexesIn(file: string): number[] {
  const css = fs.readFileSync(file, 'utf8');
  return [...css.matchAll(/z-index:\s*(-?\d+)/g)].map((m) => Number(m[1]));
}

function cssFilesUnder(...dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    const abs = path.join(RENDERER, dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.css')) out.push(path.join(abs, entry.name));
    }
  }
  return out;
}

/** The z-index of `.canvas-mode` specifically. Read out of that rule's own block
 *  rather than taken as the first declaration in the file — Canvas.css now also
 *  styles nodes, ports and frames, and "first in the file" would silently start
 *  measuring one of those the moment a rule is inserted above. */
const canvasZ = (() => {
  const css = fs.readFileSync(path.join(RENDERER, 'components/Canvas/Canvas.css'), 'utf8');
  const block = css.match(/\.canvas-mode\s*\{([^}]*)\}/);
  const z = block?.[1].match(/z-index:\s*(-?\d+)/);
  return z ? Number(z[1]) : NaN;
})();

describe('.canvas-mode z-index', () => {
  it('is declared at all', () => {
    expect(Number.isFinite(canvasZ)).toBe(true);
  });

  // The lower bound. Derived by scanning the whole terminal + pane stylesheet set,
  // so a widget added to either directory is covered without touching this test.
  it('sits above every floating widget the terminal subtree owns', () => {
    const files = cssFilesUnder('components/Terminal', 'components/Panes');
    expect(files.length).toBeGreaterThan(3); // the scan actually found the stylesheets

    const offenders: string[] = [];
    for (const f of files) {
      for (const z of zIndexesIn(f)) {
        // The 1000-level menu tier is deliberately ABOVE the canvas — see the upper
        // bound below. Everything else in these directories must lose to it.
        if (z >= 1000) continue;
        if (z >= canvasZ) offenders.push(`${path.basename(f)}: ${z}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The upper bound. The tab strip stays live in Canvas Mode (design 010 D9), and
  // its menus and popups open into the body area the canvas covers, so the canvas
  // must lose to them. Same for every app-level dialog and toast.
  it('sits below the app-level menu, dialog and toast tier', () => {
    const files = [
      'components/TitleBar/TitleBar.css',
      'components/Tabs/TabContextMenu.css',
      'components/Tabs/TabRenamePopup.css',
      'components/UI/ConfirmDialog.css',
      'components/UI/GlobalDialog.css',
      'components/UI/ToastContainer.css',
      'components/LayoutManager.css',
    ].map((f) => path.join(RENDERER, f)).filter((f) => fs.existsSync(f));
    expect(files.length).toBeGreaterThan(4);

    const tooLow: string[] = [];
    for (const f of files) {
      for (const z of zIndexesIn(f)) {
        // Only the 1000+ popup/overlay tier is in scope. These files also style in-flow
        // chrome — `.title-bar-tabs` is z-index 100 — which lives inside the title bar's
        // own box and does not itself overlap the canvas.
        //
        // That exemption is about the CHROME ONLY, and reading it as "sub-1000 rules here
        // are harmless" is what let a real bug through: `.title-bar-tabs` is
        // `position: relative; z-index: 100`, so it is a STACKING CONTEXT, and a modal
        // rendered inside it is capped at an effective 100 no matter what its own z-index
        // says. Closing a tab from the canvas showed no confirmation at all. The z-index
        // comparison below cannot see that class of bug — the suite that follows can.
        if (z < 1000) continue;
        if (z <= canvasZ) tooLow.push(`${path.basename(f)}: ${z}`);
      }
    }
    expect(tooLow).toEqual([]);
  });
});

/**
 * A modal cannot escape an ancestor stacking context, so its z-index is only worth what its
 * ancestors allow. `ConfirmDialog` declares `z-index: 9999` and still painted behind Canvas
 * Mode's overlay at 900, because `TabManager` renders it inside `.title-bar-tabs`
 * (`position: relative; z-index: 100`).
 *
 * The fix is structural, not numeric: an app-level modal must be a child of `<body>`. This
 * derives the rule from the real files rather than listing the components by hand — a new
 * dialog is covered the day its stylesheet is written.
 */
describe('app-level modals escape their caller', () => {
  const UI = path.join(RENDERER, 'components/UI');

  /** Stylesheets declaring a full-viewport overlay in the 1000+ tier. */
  function overlayStylesheets(): string[] {
    return fs.readdirSync(UI)
      .filter((n) => n.endsWith('.css'))
      .filter((n) => {
        const css = fs.readFileSync(path.join(UI, n), 'utf8');
        return /position:\s*fixed/.test(css) && zIndexesIn(path.join(UI, n)).some((z) => z >= 1000);
      });
  }

  it('found the overlay stylesheets it is meant to police', () => {
    const found = overlayStylesheets();
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain('ConfirmDialog.css');
  });

  it('renders every one of them through a portal', () => {
    const offenders: string[] = [];
    for (const css of overlayStylesheets()) {
      const tsx = path.join(UI, css.replace(/\.css$/, '.tsx'));
      if (!fs.existsSync(tsx)) continue;
      if (!/createPortal/.test(fs.readFileSync(tsx, 'utf8'))) offenders.push(path.basename(tsx));
    }
    expect(offenders).toEqual([]);
  });
});
