import fs from 'fs';
import path from 'path';

/**
 * The two placement decisions Task 23's minimap and beacons depend on, derived from source.
 *
 * `CanvasMode` cannot be mounted under the root Jest config, so anything expressed only in its
 * JSX is untestable by construction — the same reason `useArrange.test.tsx` derives the Arrange
 * button's placement this way. Both decisions below look like formatting in a diff and are wrong
 * on screen.
 */

const dir = path.resolve(__dirname, '..');
const src = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');

const MODE = src('CanvasMode.tsx');
const VIEWPORT = src('CanvasViewport.tsx');
const MINIMAP = src('CanvasMinimap.tsx');
const BEACONS = src('CanvasBeacons.tsx');

describe('the pan bail-out covers every orientation click target', () => {
  /**
   * `CanvasViewport.onPointerDown` starts a pan and clears the selection unless the press
   * landed on something in its `closest(...)` list. That list is the ONLY thing stopping a
   * minimap or beacon click from also grabbing the canvas — neither component calls
   * `stopPropagation`, deliberately, because a second guard would keep them working after the
   * list entry was deleted and make the entry untestable.
   */
  const bailList = /closest\(\s*'([^']+)'/.exec(VIEWPORT)?.[1] ?? '';

  it('found the list it is policing', () => {
    // Without this the two assertions below pass vacuously against an empty string the moment
    // the call is reformatted onto one line or the quotes change.
    expect(bailList).toContain('.canvas-node');
    expect(bailList).toContain('.canvas-port');
  });

  it.each([
    ['.canvas-minimap', MINIMAP],
    ['.canvas-beacon', BEACONS],
  ])('names %s, the class its component actually uses', (selector, component) => {
    // Asserted against the COMPONENT too, so renaming the class in one file and not the other
    // fails here rather than at the next person's pointer.
    expect(component).toContain(`className="${selector.slice(1)}"`);
    expect(bailList).toContain(selector);
  });

  it.each([
    ['CanvasMinimap', MINIMAP],
    ['CanvasBeacons', BEACONS],
  ])('%s hangs exactly one pointerdown, so one entry is enough', (_name, component) => {
    // The check above proves the class it *found* is covered. This proves there is nothing
    // else to cover — a second click target added later would need its own list entry, and
    // absence is precisely what the assertion above cannot see.
    //
    // Counts the JSX ATTRIBUTE, not the bare word: `onPointerDown={onPointerDown}` mentions
    // the identifier twice and its `useCallback` declaration a third time, so a plain
    // `/onPointerDown/g` counts three handlers where there is one. `Capture` is counted too,
    // because a capture-phase handler on a SECOND element is a second click target.
    expect(component.match(/onPointerDown(?:Capture)?=\{/g) ?? []).toHaveLength(1);
  });
});

describe('orientation chrome goes in the viewport slot, not the world', () => {
  /**
   * `overlay` is a prop on `CanvasViewport`, so everything in it precedes the `>` that closes
   * the opening tag; children come after. The distinction is the whole bug this guards:
   * `{children}` lands inside `.canvas-world`, which is pan/zoom transformed, so a beacon
   * placed there would slide away with the world it is supposed to point at from outside.
   *
   * Positioning is the other half — see the `overlay` prop's own note. `.canvas-mode` is a flex
   * row whose first child is the sidebar, so beacons positioned by a computed `left` from
   * `worldToScreen` (which returns VIEWPORT coordinates) land under the sidebar if rendered as
   * a sibling of `<CanvasViewport>` the way `.canvas-toolbar` is.
   */
  const openTagEnd = MODE.indexOf('\n      >\n', MODE.indexOf('<CanvasViewport'));

  it('found the opening tag it is measuring against', () => {
    expect(openTagEnd).toBeGreaterThan(-1);
    expect(MODE).toContain('overlay={');
  });

  it.each(['<CanvasBeacons', '<CanvasMinimap'])('renders %s inside the overlay prop', (tag) => {
    const at = MODE.indexOf(tag);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(openTagEnd);
  });

  it('suppresses both under the full-screen overlay, in one gate', () => {
    // Same reason the toolbar is suppressed: the overlay's backdrop is world-space, so screen
    // chrome paints over it and becomes the one spot where a click fails to dismiss it. One
    // gate covering both, rather than each component filtering itself — see the `beacons` memo.
    expect(MODE).toContain('overlay={!overlayId ? (');
  });
});

/**
 * The tab strip's "you are here" marker (design 010 D9, §5.1).
 *
 * The resolution's load-bearing half is that this is a SECOND marker, not a replacement for the
 * active-tab highlight — the original plan had it take over `activeTabId`, which was right when
 * the canvas was an overlay hiding some other tab and is a new lie now that the canvas IS the
 * active tab. Both wordings produce a working-looking strip, so the difference is invisible in a
 * diff and only shows up on screen, with the canvas tab rendering as inactive while it fills the
 * window.
 */
describe('the nearest-group marker is added to the active highlight, not swapped for it', () => {
  const TABS = path.resolve(__dirname, '../../Tabs');
  const TSX = fs.readFileSync(path.join(TABS, 'TabManager.tsx'), 'utf8');
  const CSS = fs.readFileSync(path.join(TABS, 'TabManager.css'), 'utf8');

  it('keeps both classes on the same element', () => {
    const className = /className=\{`tab-item [^`]*`\}/.exec(TSX)?.[0] ?? '';
    expect(className).toContain("tab.isActive ? 'active' : ''");
    expect(className).toContain("isCanvasHere ? 'canvas-here' : ''");
  });

  it('reads the marker from the store rather than a prop', () => {
    // `TabManager` renders inside `TitleBar` and `CanvasMode` under `.app-body` — two React
    // trees sharing only Redux. Threading it as a prop would also re-render the whole strip on
    // every pan; this selects a BOOLEAN, so a pan between two other groups changes nothing here.
    expect(TSX).toContain('state.canvas.nearestGroupId === tab.id');
  });

  it('is styled, and not as a copy of the active tab', () => {
    // A class that exists only in the JSX is an invisible marker. A class that repaints the tab
    // background is a second active tab.
    const rule = /\.tab-item\.canvas-here::before\s*\{([^}]*)\}/.exec(CSS);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/background:/);
    const plain = /(^|\n)\.tab-item\.canvas-here\s*\{([^}]*)\}/.exec(CSS);
    expect(plain?.[2] ?? '').not.toMatch(/background-color:/);
  });
});
