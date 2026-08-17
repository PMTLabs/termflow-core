/**
 * The wiring around `canvasClose` — the parts that live in components and have no pure form.
 *
 * These read source. That is a deliberate second-best: the decision itself is pure and tested in
 * `canvasClose.test.ts`, but "which listener did this event reach" and "which glyph is on that
 * button" only exist as code, and mounting `PaneManager` for real means mounting `TerminalPane`,
 * which spawns PTYs.
 *
 * **Every match runs against source with comments stripped.** Three tests in this plan have now
 * been satisfied by their own explanatory prose — a comment mentioning the thing being policed
 * is indistinguishable from the thing itself to a regex, and the test then measures the writing.
 */
import fs from 'fs';
import path from 'path';
import { readSource } from '../../../utils/readSource';

const CANVAS = path.resolve(__dirname, '..');
const PANES = path.resolve(__dirname, '../../Panes');

/** Source with block and line comments removed. Not a parser — but it does not need to be, and
 *  the failure mode it exists to stop is prose, not clever code. */
function code(file: string): string {
  return readSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const NODE = code(path.join(CANVAS, 'CanvasNode.tsx'));
const MODE = code(path.join(CANVAS, 'CanvasMode.tsx'));
const PANE_MANAGER = code(path.join(PANES, 'PaneManager.tsx'));

describe('the node header stops using ✕ for two different things', () => {
  /**
   * Tam: "update the close overlay it is x button which confuse with close terminal."
   *
   * The enlarge/shrink toggle rendered `{overlaid ? '✕' : '⛶'}`, so the control that shrank an
   * overlaid node back to the canvas wore the universal close glyph. It was merely ambiguous
   * while it was the only ✕ on the node; with a real close button beside it, the same character
   * would sit twice in one header meaning two different things.
   */
  it('the enlarge/shrink toggle is not a ✕ in either state', () => {
    const toggle = /className="canvas-node-open"[\s\S]*?\{overlaid \? '(.)' : '(.)'\}/.exec(NODE);
    expect(toggle).not.toBeNull();
    expect(toggle![1]).not.toBe('✕');
    expect(toggle![2]).not.toBe('✕');
  });

  it('the close button exists, is a ✕, and says what it does', () => {
    const btn = /<button[^>]*className="canvas-node-open canvas-node-close"[\s\S]*?<\/button>/.exec(NODE);
    expect(btn).not.toBeNull();
    expect(btn![0]).toContain('✕');
    // A bare glyph in a 18px box is not self-describing, and this is the destructive one.
    expect(btn![0]).toMatch(/title="Close terminal"/);
    expect(btn![0]).toMatch(/aria-label=/);
  });

  /**
   * Every button in this header stops pointerdown, and each stops a DIFFERENT gesture the node
   * owns — here, `onPointerDown` selects the node and `onHeaderPointerDown` starts a drag. A
   * close button that let the press through would begin a drag the click then never ends,
   * leaving the pointer captured after the node it was dragging has gone.
   */
  it('the close button does not also start a drag', () => {
    const btn = /<button[^>]*className="canvas-node-open canvas-node-close"[\s\S]*?<\/button>/.exec(NODE)![0];
    expect(btn).toContain('onPointerDown={(e) => e.stopPropagation()}');
    expect(btn).toContain('e.stopPropagation(); onClose();');
  });
});

describe('PaneManager routes the two pane-close events differently', () => {
  /**
   * The asymmetry IS the feature, and both ways of breaking it are invisible:
   *
   *  - both routed to `handleClose` → the forced close still shows the dialog, so "no process,
   *    no prompt" silently does not happen;
   *  - both routed to `performClose` → every pane close everywhere loses its confirmation,
   *    including Ctrl+Shift+W and the pane's own ✕.
   *
   * Neither shows up as an error, and the second is a data-loss bug reachable from three
   * pre-existing entry points that this change never meant to touch.
   */
  it('asks on ui:requestPaneClose and does not on ui:forcePaneClose', () => {
    expect(PANE_MANAGER).toContain('const onRequest = route(handleClose);');
    expect(PANE_MANAGER).toContain('const onForce = route(performClose);');
    expect(PANE_MANAGER).toContain("window.addEventListener('ui:requestPaneClose', onRequest);");
    expect(PANE_MANAGER).toContain("window.addEventListener('ui:forcePaneClose', onForce);");
  });

  it('removes both listeners it adds', () => {
    // Mounted per tab and re-created whenever the tree changes, so a leaked listener is not a
    // slow leak — it is N listeners answering one event and closing N panes.
    for (const ev of ['ui:requestPaneClose', 'ui:forcePaneClose']) {
      expect(PANE_MANAGER).toContain(`window.removeEventListener('${ev}',`);
    }
  });

  /** The forced path must still be the one that kills the PTY and clears the cwd snapshot —
   *  `performClose` is the only caller of `closePaneNonBlocking`, so routing through it is what
   *  guarantees the forced close is not a UI-only removal that orphans the process. */
  it('forces through performClose, which is still the only PTY teardown', () => {
    expect(PANE_MANAGER.match(/closePaneNonBlocking\(/g) ?? []).toHaveLength(1);
    const perform = /const performClose = useCallback\([\s\S]*?\n  \}, \[/.exec(PANE_MANAGER);
    expect(perform).not.toBeNull();
    expect(perform![0]).toContain('closePaneNonBlocking(');
  });

  /** The guard that stops every other tab's PaneManager acting on an event meant for one pane.
   *  It applies to BOTH handlers because both are built by `route`. */
  it('keeps the in-this-tree guard on both', () => {
    expect(PANE_MANAGER).toContain('if (inThisTree(paneTree, paneId)) act(paneId);');
  });
});

describe('CanvasMode hands the close to the owning surface', () => {
  it('gives every node a close and a context menu', () => {
    expect(MODE).toContain('onClose={() => closeNode(n)}');
    expect(MODE).toContain('setNodeMenu({ node: n, x: e.clientX, y: e.clientY })');
  });

  /**
   * The pane COUNT must come from the pane tree, not from the canvas model.
   *
   * `buildModel` projects through `leaves()`, which drops leaves with no `terminalId` — and a
   * pane that has just been split has none until `TerminalPane` spawns its PTY. Counting the
   * model there sees one node in a two-pane tab, calls it a tab close, and takes the spawning
   * sibling with it.
   */
  it('counts panes from the tree', () => {
    expect(MODE).toContain('getAllLeafIds(treesByTabId[node.tabId] ?? null).length');
  });

  /** Dispatched, never performed here: the confirm dialog, the PTY teardown and the cwd
   *  cleanup all live in the surface that owns the terminal. A canvas-local close would be a
   *  fourth copy of that sequence. */
  it('does not close anything itself', () => {
    expect(MODE).toContain('window.dispatchEvent(new CustomEvent(type, { detail }));');
    expect(MODE).not.toMatch(/closePaneNonBlocking|dispatch\(closePane|dispatch\(removeTab/);
  });
});

/**
 * A rule derived from the real files rather than a list, so the next canvas menu is covered the
 * day it is written.
 *
 * `.canvas-world` sets `will-change: transform`, which makes it a stacking context: a menu
 * rendered inside it cannot paint above an overlaid node at any z-index. Every canvas menu must
 * therefore leave the tree — either through `CanvasMenu`, which portals, or by portalling
 * itself.
 */
describe('every canvas menu escapes the world', () => {
  const menus = fs.readdirSync(CANVAS).filter((n) => /^Canvas.*Menu\.tsx$/.test(n));

  it('found the menus it is meant to police', () => {
    expect(menus).toContain('CanvasMenu.tsx');
    expect(menus).toContain('CanvasWireMenu.tsx');
  });

  /**
   * Matched on the CALL and its target, not on the identifier.
   *
   * The first version of this tested `/createPortal/`, which the `import { createPortal }` line
   * satisfies on its own — deleting the actual `createPortal(...)` call left the test green.
   * `document.body` is checked for the same reason the portal is: portalling into another
   * element inside `.canvas-world` escapes nothing.
   */
  it('renders each through a portal to the body', () => {
    const offenders = menus.filter((n) => {
      const src = code(path.join(CANVAS, n));
      if (/<CanvasMenu\b/.test(src)) return false;            // delegates to the shell above
      return !(/createPortal\(/.test(src) && /document\.body/.test(src));
    });
    expect(offenders).toEqual([]);
  });
});
