import path from 'path';
import { readSource } from '../../../utils/readSource';

/**
 * The two placement decisions Task 23's minimap and beacons depend on, derived from source.
 *
 * `CanvasMode` cannot be mounted under the root Jest config, so anything expressed only in its
 * JSX is untestable by construction — the same reason `useArrange.test.tsx` derives the Arrange
 * button's placement this way. Both decisions below look like formatting in a diff and are wrong
 * on screen.
 */

const dir = path.resolve(__dirname, '..');
const src = (f: string) => readSource(path.join(dir, f));

const MODE = src('CanvasMode.tsx');
const VIEWPORT = src('CanvasViewport.tsx');
const MINIMAP = src('CanvasMinimap.tsx');
const BEACONS = src('CanvasBeacons.tsx');

describe('the pan bail-out covers every orientation click target', () => {
  /**
   * `CanvasViewport` starts a pan, clears the selection, and now also opens the "new terminal
   * here" menu — each only when the press landed on empty canvas. That list is the ONLY thing
   * stopping a minimap or beacon click from also grabbing the canvas: neither component calls
   * `stopPropagation`, deliberately, because a second guard would keep them working after the
   * list entry was deleted and make the entry untestable.
   *
   * Read from `BACKGROUND_BAIL` rather than from a `closest(...)` literal, which is where it
   * lived until the background context menu (Tam's item 3) needed the same answer. That move
   * is itself the point of `shares one definition` below.
   */
  const bailList = /const BACKGROUND_BAIL\s*=\s*'([^']+)'/.exec(VIEWPORT)?.[1] ?? '';

  it('found the list it is policing', () => {
    // Without this the assertions below pass vacuously against an empty string the moment the
    // constant is reformatted or the quotes change — which is exactly what happened when the
    // literal moved out of `closest(...)`, and this is the check that caught it.
    expect(bailList).toContain('.canvas-node');
    expect(bailList).toContain('.canvas-port');
  });

  /**
   * Both gestures go through the same predicate. Two hand-rolled `closest(...)` calls would
   * drift the day a surface is added, and the copy that was not updated fails silently — as a
   * pan that starts under a new control, or a menu that opens on top of one.
   */
  it('shares one definition between the pan and the context menu', () => {
    expect(VIEWPORT).toContain('const isBackground = (target: EventTarget | null): boolean =>');
    expect(VIEWPORT.match(/isBackground\(e\.target\)/g) ?? []).toHaveLength(2);
  });

  /**
   * The rule the assertion above used to carry as a trailing line, now stated as its own: every
   * selector this file asks the DOM for lives in a named constant at the top.
   *
   * There are two questions here now — "did this land on empty canvas?" and "which terminal is
   * the pointer over?" — and the second was added for the wheel setting. A bare literal passed
   * to `closest` is a class name nothing checks against the component that renders it, and the
   * failure is a gesture that quietly stops recognising a surface after a rename.
   */
  it('asks the DOM only through named selector constants', () => {
    expect(VIEWPORT.match(/closest\(\s*'/g) ?? []).toHaveLength(0);
    expect(VIEWPORT).toMatch(/const NODE = '\.canvas-node';/);
    expect(VIEWPORT).toMatch(/const NODE_TERMINAL_ATTR = 'data-terminal-id';/);
  });

  it('reads the terminal id from the attribute CanvasNode writes', () => {
    // The two halves live in different files, and a rename in one is invisible to the other:
    // `getAttribute` returns null, `onFocusedTerminal` is false forever, and the only symptom
    // is that Ctrl+wheel stops zooming the font of the terminal you are editing.
    expect(readSource(path.join(dir, 'CanvasNode.tsx'))).toContain('data-terminal-id={node.terminalId}');
    expect(VIEWPORT).toContain('.closest(NODE)?.getAttribute(NODE_TERMINAL_ATTR)');
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
  const TSX = readSource(path.join(TABS, 'TabManager.tsx'));
  const CSS = readSource(path.join(TABS, 'TabManager.css'));

  it('leaves the active-tab highlight alone', () => {
    // The half of §5.1 that is invisible in a diff: `active` must still be driven by
    // `tab.isActive` and by nothing else. A marker that swapped itself in here would render the
    // canvas tab — the one filling the window — as inactive.
    const className = /className=\{`tab-item [^`]*`\}/.exec(TSX)?.[0] ?? '';
    expect(className).toContain("tab.isActive ? 'active' : ''");
    expect(className).not.toContain('isCanvasHere');
  });

  it('reads the marker from the store rather than a prop', () => {
    // `TabManager` renders inside `TitleBar` and `CanvasMode` under `.app-body` — two React
    // trees sharing only Redux. Threading it as a prop would also re-render the whole strip on
    // every pan; this selects a BOOLEAN, so a pan between two other groups changes nothing here.
    expect(TSX).toContain('state.canvas.nearestGroupId === tab.id');
  });

  /**
   * REPLACES "is styled, and not as a copy of the active tab", which pinned the marker as a
   * `.tab-item.canvas-here::before` rail.
   *
   * That rail is what shipped, and the first person to see it live asked why the first
   * non-canvas tab had a border. A cue nobody can name is worse than no cue: it costs attention
   * and returns nothing. The rewrite is not cosmetic — it moves the marker onto the channel the
   * rest of this strip already uses for per-tab status (exited, activity, unseen, muted are all
   * an icon plus a `title`), and the `title` is the whole point, because it is the only part
   * that can answer "what is this?" at the moment the question is asked.
   */
  it('renders the marker as an element that can explain itself', () => {
    const marker = /<span className="tab-canvas-here"[^>]*>/.exec(TSX)?.[0] ?? '';
    expect(marker).not.toBe('');
    // A `title` is the requirement, not decoration — and it has to name the canvas, since
    // "centred here" is meaningless without saying centred by what.
    expect(marker).toMatch(/title="[^"]*[Cc]anvas[^"]*"/);
    // Gated on the selector above, so it appears on exactly the one tab and only while the
    // canvas is up.
    expect(TSX).toContain('{isCanvasHere && (');
  });

  it('is styled, and not as a copy of the active tab', () => {
    // A class that exists only in the JSX is an invisible marker; a class that repaints the tab
    // background is a second active tab. Both halves still bind — only the selector moved.
    const rule = /(^|\n)\.tab-canvas-here\s*\{([^}]*)\}/.exec(CSS);
    expect(rule).not.toBeNull();
    expect(rule![2]).toMatch(/color:/);
    expect(rule![2]).not.toMatch(/background/);
  });

  it('leaves no trace of the rail it replaced', () => {
    // A leftover `.canvas-here` rule would still paint the border Tam asked about: the class is
    // gone from the JSX, so nothing here would fail — the stylesheet is the only witness.
    expect(CSS).not.toMatch(/\.tab-item\.canvas-here/);
  });
});
