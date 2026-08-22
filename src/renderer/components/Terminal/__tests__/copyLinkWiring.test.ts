/**
 * "Copy Link" on a right-clicked link (Tam, 2026-08-21) — the wiring in the two components.
 *
 * A TRIPWIRE over source, for the reason `terminalDisplayRelocationWiring` already records:
 * `TerminalDisplay` cannot be mounted under the root Jest config (two untransformed CSS imports,
 * `@tauri-apps/api/event`, the store, and a real `Terminal.open()` needing a 2D context jsdom
 * lacks). The DECISIONS this glue makes are covered as pure functions in
 * `terminal-core/__tests__/getLinkAt.test.ts`; what is unprovable there — and what this guards —
 * is that the component still calls them, at the right moment, with the right coordinates.
 *
 * Every match runs against source with comments STRIPPED. Three tests in this repo have been
 * satisfied by their own explanatory prose: to a regex, a comment naming the thing being policed
 * is indistinguishable from the thing itself, and the test then measures the writing.
 */
import * as path from 'path';
import { readSource } from '../../../utils/readSource';

const code = (file: string): string =>
  readSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const DISPLAY = code(path.join(__dirname, '..', 'TerminalDisplay.tsx'));
const NODE_TERMINAL = code(path.join(__dirname, '..', '..', 'Canvas', 'NodeTerminal.tsx'));

describe('the link is resolved when the menu OPENS', () => {
  /**
   * By the time an item is clicked the pointer is on the MENU and the cell it came from is
   * unreachable — so the hit has to be captured at open time, from the click's own coordinates.
   * Resolving it lazily inside the item's `click` would look identical in review and would
   * return whatever sits under the menu itself.
   */
  it('asks the engine at the point the right-click happened', () => {
    expect(DISPLAY).toMatch(/setContextMenu\(\{\s*x,\s*y,\s*link:\s*engineRef\.current\?\.getLinkAt\(x,\s*y\)\s*\?\?\s*null\s*\}\)/);
  });

  /**
   * ONE state slot, not two. A separate `linkHit` would keep the previous right-click's link
   * alive for a menu opened somewhere with no link under it at all — offering Copy Link for
   * something the user is not pointing at, which is worse than not offering it.
   */
  it('holds the hit in the same state as the menu position', () => {
    expect(DISPLAY).toMatch(/useState<\{\s*x:\s*number;\s*y:\s*number;\s*link:\s*TerminalLinkHit\s*\|\s*null\s*\}\s*\|\s*null>/);
    // No second slot for it.
    expect(DISPLAY).not.toMatch(/set(Link|LinkHit|MenuLink)\(/);
  });
});

describe('the item appears only when there is a link', () => {
  const item = (): string => {
    const m = /\.\.\.\(contextMenu\?\.link \? \[\{([\s\S]*?)\}\] : \[\]\)/.exec(DISPLAY);
    expect(m).not.toBeNull();
    return m![1];
  };

  /**
   * Present-or-absent, never always-shown-and-disabled. A greyed "Copy Link" on every
   * right-click teaches people the feature is broken; the menu already varies its shape for the
   * pane-tree items, the agent scheme and selection mode.
   */
  it('is spread in conditionally rather than rendered disabled', () => {
    expect(() => item()).not.toThrow();
    expect(item()).not.toMatch(/enabled:/);
  });

  /** Two labels from one hit: they are different promises, and `kind` is what decides. */
  it('labels a url and a path differently', () => {
    expect(item()).toMatch(/label:\s*contextMenu\.link\.kind === 'url' \? 'Copy Link' : 'Copy Path'/);
    expect(item()).toMatch(/icon:\s*contextMenu\.link\.kind === 'url'/);
  });

  /**
   * Through the engine, never a bespoke `navigator.clipboard` call here. `copyLink` reaches the
   * same `writeClipboard` the Copy item uses, which prefers the host's native Tauri writer — a
   * menu item that wrote the clipboard its own way would be the one place in the app that raised
   * the WebView's permission popup.
   */
  it('copies through the engine, not through navigator.clipboard', () => {
    expect(item()).toMatch(/click:\s*\(\) => engine\?\.copyLink\(contextMenu\.link!\.text\)/);
    expect(item()).not.toMatch(/navigator|writeClipboardText/);
  });

  /**
   * Above Copy. When there IS a link under the pointer it is almost always what the right-click
   * was for — Copy needs a selection made beforehand, this needs only what you are pointing at.
   */
  it('sits above the Copy item', () => {
    const linkAt = DISPLAY.indexOf("'Copy Link'");
    const copyAt = DISPLAY.indexOf("label: 'Copy',");
    expect(linkAt).toBeGreaterThan(-1);
    expect(copyAt).toBeGreaterThan(-1);
    expect(linkAt).toBeLessThan(copyAt);
  });
});

/**
 * THE reason this lives in `TerminalDisplay` rather than in the canvas menu.
 *
 * The canvas overlay routes its right-click through `surfaceChrome.openContextMenu` into this
 * same callback, with the same viewport coordinates — so one implementation serves the pane and
 * the overlaid node, and `getLinkAt` reconciles the node's CSS transform scale itself. Adding
 * the item to `CanvasNodeMenu` instead would have been a second copy that could only ever cover
 * one of the two surfaces.
 */
describe('the canvas overlay reaches the same menu', () => {
  it('routes the node host right-click into the published opener', () => {
    expect(NODE_TERMINAL).toMatch(/chrome\.openContextMenu\(e\.clientX,\s*e\.clientY\)/);
  });

  it('and TerminalDisplay publishes that opener', () => {
    expect(DISPLAY).toMatch(/openContextMenu:\s*openContextMenuAt/);
  });

  /**
   * Same coordinate space on both paths. The pane's own handler must pass the identical pair, or
   * the two surfaces would hit-test differently and the bug would show on exactly one of them.
   */
  it('passes viewport coordinates on the pane path too', () => {
    expect(DISPLAY).toMatch(/openContextMenuAt\(e\.clientX,\s*e\.clientY\)/);
  });
});
