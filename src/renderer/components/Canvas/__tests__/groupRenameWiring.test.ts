/**
 * The parts of "rename a group" that exist only as wiring, plus the CSS two of them need.
 *
 * `CanvasMode` cannot be mounted under the root Jest config, so its half of the feature — which
 * gesture opens the menu, and on which elements — is only reachable this way. The behaviour that
 * CAN be driven lives in `canvasSidebar.test.tsx` and `canvasGroupMenu.test.tsx`; nothing here
 * duplicates it.
 *
 * Source-derived, with comments stripped first: this file polices identifiers that its own doc
 * blocks name, and three tests in this plan have already been satisfied by their own prose.
 */
import path from 'path';
import { readSource } from '../../../utils/readSource';

const CANVAS = path.resolve(__dirname, '..');

function code(file: string): string {
  return readSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const CSS = readSource(path.join(CANVAS, 'Canvas.css'));
const MODE = code(path.join(CANVAS, 'CanvasMode.tsx'));
const SIDEBAR = code(path.join(CANVAS, 'CanvasSidebar.tsx'));

/** The props `CanvasMode` hands each group frame, on its own. */
const FRAME_PROPS = (() => {
  const from = MODE.indexOf('<CanvasGroupFrame');
  return MODE.slice(from, MODE.indexOf('/>', from));
})();

describe('CanvasMode opens the group menu', () => {
  it('hangs the gesture on the frame, which forwards it to the handles', () => {
    expect(FRAME_PROPS).toContain('onContextMenu={(e) => {');
  });

  /** At the pointer, and carrying the identity the menu renames — the title is only the seed. */
  it('opens it where you clicked, for that group', () => {
    expect(FRAME_PROPS).toContain(
      'setGroupMenu({ tabId: g.tabId, title: g.title, x: e.clientX, y: e.clientY });',
    );
  });

  /**
   * `preventDefault` because the viewport's own contextmenu handler bails out on `.canvas-glabel`
   * and `.canvas-gchip` WITHOUT preventing anything, so nothing else suppresses the browser's
   * native menu over a group handle. `stopPropagation` for the same reason `CanvasNode` does it:
   * the bail list and the stop are belt and braces, and the node already carries both.
   */
  it('suppresses the browser menu and the canvas background beneath it', () => {
    expect(FRAME_PROPS).toContain('e.preventDefault();');
    expect(FRAME_PROPS).toContain('e.stopPropagation();');
  });

  it('renders the menu against the state slot it just filled', () => {
    expect(MODE).toContain('tabId={groupMenu.tabId}');
    expect(MODE).toContain('title={groupMenu.title}');
    expect(MODE).toContain('onClose={() => setGroupMenu(null)}');
  });
});

/**
 * One chain, three entry points. A rename is the store title AND the backend name of every live
 * pane AND a save; each caller that reaches past the service for a bare `updateTabTitle` drops
 * two of the three, which is what `CanvasSidebar` did before this existed.
 */
describe('every rename goes through the one service', () => {
  it('the sidebar renames tabs through renameTab', () => {
    expect(SIDEBAR).toContain('renameTab(');
    expect(SIDEBAR).not.toContain('updateTabTitle');
  });

  it('the tab strip renames through the same service, not its own copy of the chain', () => {
    const STRIP = code(path.resolve(CANVAS, '..', 'Tabs', 'TabManager.tsx'));
    expect(STRIP).toContain('renameTab(');
    expect(STRIP).not.toContain('renameTabProcesses');
  });
});

/**
 * A rename box inside the sidebar's group header inherits that header's typography.
 *
 * `.canvas-sghead` is `text-transform: uppercase` with `letter-spacing: .13em`, and both apply
 * to an `<input>` nested in it — so you type `gateway`, the box shows `G A T E W A Y`, and the
 * value committed is the one you typed rather than the one you can see. The row's rename box has
 * never had this problem because rows are not uppercased, which is exactly why nothing else in
 * the suite would catch it.
 */
describe('the group-header rename box shows what you typed', () => {
  const rule = CSS.match(/\.canvas-sghead\s+\.canvas-srename\s*\{[^}]*\}/)?.[0] ?? '';

  it('has a rule for the box nested in the header at all', () => {
    expect(rule).not.toBe('');
  });

  it('cancels the header\'s uppercase', () => {
    expect(rule).toMatch(/text-transform:\s*none/);
  });

  it('cancels the header\'s letter-spacing', () => {
    expect(rule).toMatch(/letter-spacing:\s*normal/);
  });
});

/**
 * The group menu's rename box is the wire menu's label box in a different menu — same width,
 * margin and focus ring, and both are the only non-item element their menu contains. Joining the
 * selector keeps them that way; a copied block is two rules to notice when one is restyled.
 */
describe('the group menu\'s rename box', () => {
  it('joins the wire menu\'s rule rather than copying it', () => {
    expect(CSS).toMatch(/\.canvas-wire-label-input,\s*\.canvas-group-name-input\s*\{/);
  });
});
