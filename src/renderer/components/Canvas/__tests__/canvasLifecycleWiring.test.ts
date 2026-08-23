/**
 * The lifecycle and hot-path rules from review round 2 (reports 161/162 in fabric).
 *
 * Every one of these is a fact about WIRING rather than about a function's output — where a
 * dispatch happens, what a component is wrapped in, which dependency array an effect carries.
 * They are the class of defect that round found: the machinery existed and correct code was
 * simply never reached, or was reached far more often than anyone intended.
 *
 * Source-derived because `CanvasMode` cannot be mounted under the root Jest config, and
 * because "how many actions does one pointer event produce" is not observable from a pure
 * function's return value.
 */
import path from 'path';
import { readSource } from '../../../utils/readSource';

const CANVAS = path.resolve(__dirname, '..');
const COMPONENTS = path.resolve(__dirname, '..', '..');

function code(file: string): string {
  return readSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const DRAG = code(path.join(CANVAS, 'useCanvasDrag.ts'));
const MENU = code(path.join(CANVAS, 'CanvasMenu.tsx'));
const CONTAINER = code(path.join(COMPONENTS, 'TerminalContainer.tsx'));
const TAB_MANAGER = code(path.join(COMPONENTS, 'Tabs', 'TabManager.tsx'));

describe('a group drag is one transition per pointer event', () => {
  /** The group branch of `onMove` alone — the file also dispatches `setNodeGeom` from the
   *  single-node drag, and a file-wide search would find that and pass with this gutted. */
  const start = DRAG.indexOf('const gd = groupDrag.current;');
  const groupMove = DRAG.slice(start, DRAG.indexOf('const onUp =', start));

  it('has a group-move block to assert against', () => {
    expect(start).toBeGreaterThan(-1);
    expect(groupMove).toContain('moveGroupBy(');
  });

  /**
   * The frame and every member in ONE action.
   *
   * This was `setGroupGeom` plus a `setNodeGeom` per member, inside the `pointermove`
   * handler — 101 Redux transitions per event for a group of 100 terminals, each one
   * invalidating the canvas selector and re-running projection and reconciliation while the
   * pointer was still moving. The cost is O(members × events), which is precisely the shape
   * that misses a frame budget on the workspaces big enough to want group drags.
   */
  it('dispatches once, not once per member', () => {
    expect(groupMove).toContain('dispatch(moveGroupGeom({');
    // The regression is a dispatch INSIDE the loop that builds the payload.
    expect(groupMove).not.toMatch(/for \([^)]*\) \{[^}]*dispatch\(/);
    expect(groupMove.match(/dispatch\(/g) ?? []).toHaveLength(1);
  });
});

/**
 * Canvas geometry is pruned against the live TERMINALS, not against tab closure.
 *
 * The prune used to live inside the tab-cleanup effect, gated on a tab having disappeared —
 * but closing one pane of a split tab does not change `tabs` at all, so that pane's rect
 * stayed in `canvas.nodes` forever and `saveState` wrote it to localStorage every 30
 * seconds. Months of splitting and closing leaves a persisted blob that is mostly dead
 * rectangles, and a recycled id inherits a stranger's position.
 */
describe('canvas geometry is pruned when a terminal goes, not when a tab does', () => {
  const start = CONTAINER.indexOf('const leafIds = new Set<string>();');
  // ...to the END of the dependency line, not a fixed offset past it — a short window cuts
  // the array in half and the assertion then measures the slice rather than the source.
  const pruneEffect = CONTAINER.slice(
    start, CONTAINER.indexOf('\n', CONTAINER.indexOf('}, [', start)),
  );

  it('derives the live set from the authoritative pane trees', () => {
    expect(start).toBeGreaterThan(-1);
    // `treesByTabId`, not the window mirror: the mirror is upsert-only by key.
    expect(pruneEffect).toContain('Object.values(treesByTabId)');
    expect(pruneEffect).toContain('getAllTerminalIds(tree)');
  });

  it('re-runs when the trees change, not only when the tab list does', () => {
    expect(pruneEffect).toContain('}, [tabs, treesByTabId, dispatch]);');
  });

  // The regression: putting it back behind a tab-closed flag. Nothing named `closed` should
  // gate it, and the tab-cleanup effect should no longer compute a live set at all.
  it('is not gated on a tab having been closed', () => {
    expect(pruneEffect).not.toContain('if (closed)');
    expect(CONTAINER).not.toContain('let closed = false;');
  });
});

/**
 * A closed tab's `tabPanes` entry must outlive `closeOneTab` itself.
 *
 * The prune effect above reads `treesByTabId` directly and unfiltered, so it only stays
 * accurate if a closed tab's tree is actually removed from it — and that removal happens in
 * exactly one place, `TerminalContainer`'s own cleanup effect, which detects a closed tab by
 * finding its id missing from `tabs` while still present in the `tabPanes` mirror. If
 * `closeOneTab` deletes that mirror entry itself, it erases the only signal the cleanup effect
 * has: `removeTabTree` never fires, `treesByTabId` keeps the dead tab's tree (and terminal id)
 * forever, and an overlay left open on that terminal never clears — `pruneCanvasGeometry` still
 * finds it "live", so `overlayId` stays set and the toolbar/minimap (`!overlayId` in
 * `CanvasMode`) stay hidden after the terminal is gone.
 */
describe('closeOneTab leaves tabPanes cleanup to TerminalContainer', () => {
  const start = TAB_MANAGER.indexOf('const closeOneTab = useCallback((id: string) => {');
  const fn = TAB_MANAGER.slice(start, TAB_MANAGER.indexOf('}, [dispatch]);', start));

  it('has a closeOneTab body to assert against', () => {
    expect(start).toBeGreaterThan(-1);
    expect(fn).toContain('dispatch(removeTab(id));');
  });

  /**
   * Bounded on what the FIXED body actually does — nothing — rather than on the one literal
   * spelling (`delete tabPanes[id]`) the original bug used. A regex keyed to that spelling
   * alone survives a renamed alias (`const tp = window.tabPanes; delete tp[id]`), a direct
   * `window.__TAB_PANES__[id]`, or `Reflect.deleteProperty(...)` — none of which contain that
   * literal, all of which would erase the same cleanup signal. `deleteProperty` is checked
   * separately because `\bdelete\b` has a word boundary on both sides and does not match inside
   * the identifier `deleteProperty`.
   */
  it('does not delete its own tabPanes entry before TerminalContainer can see it go', () => {
    expect(fn).not.toMatch(/\bdelete\b/);
    expect(fn).not.toMatch(/deleteProperty/);
  });
});

/**
 * The three canvas leaves that do real work are memoised.
 *
 * `CanvasMode` re-renders on every frame of a pan or zoom — `setViewport` fires per pointer
 * event — and without this, every node's terminal host, polling snapshot and agent
 * subscription re-ran with it, for the whole workspace including nodes culled off screen.
 * All three take only primitive props, so the equality check is exact.
 *
 * `CanvasNode` itself is deliberately NOT memoised: it takes `children` and seven per-node
 * closures rebuilt each render, so a memo there could never bail and would only add a
 * comparison to every frame. Making it memoisable is a composition change, not a wrapper.
 */
describe.each([
  ['NodeTerminal', 'NodeTerminal.tsx'],
  ['NodeSnapshot', 'NodeSnapshot.tsx'],
  ['CanvasNodeAgent', 'CanvasNodeAgent.tsx'],
])('%s is memoised', (name, file) => {
  const src = code(path.join(CANVAS, file));

  it('wraps its implementation in React.memo', () => {
    expect(src).toContain(`export const ${name} = React.memo(${name}Impl);`);
  });

  it('still exports the same name as its default', () => {
    expect(src).toContain(`export default ${name};`);
  });
});

/**
 * The menu's dismissal listeners survive a re-render of the canvas.
 *
 * Callers pass an inline `onClose`, so its identity changed on every render — and the canvas
 * re-renders on every frame of a pan. Keyed on `onClose`, the effect tore its listeners down
 * and re-armed them behind a fresh `requestAnimationFrame` each time, leaving a window of at
 * least a frame in which clicking outside the menu did not dismiss it. Holding the callback
 * in a ref fixes it here rather than asking every caller for a `useCallback` — which would
 * fix one call site and leave the trap armed for the next.
 */
describe('CanvasMenu arms its dismissal listeners once', () => {
  it('reads onClose through a ref', () => {
    expect(MENU).toContain('const onCloseRef = useRef(onClose);');
    expect(MENU).toContain('onCloseRef.current = onClose;');
  });

  /**
   * BOTH handlers, not just one.
   *
   * `toContain('onCloseRef.current()')` passed with the mouse handler reverted to a direct
   * `onClose()` call, because the key handler still had one — an assertion satisfied by the
   * half of the code that was not broken. The dismissal is two listeners and either one
   * capturing a stale callback is the same bug.
   */
  it('never calls the captured callback directly', () => {
    const start = MENU.indexOf('const onDown = (e: MouseEvent)');
    const effect = MENU.slice(start, MENU.indexOf('}, [', start));
    expect(effect.match(/onCloseRef\.current\(\)/g) ?? []).toHaveLength(2);
    // A bare `onClose()` — the mutant — with the ref reads excluded by the leading dot.
    expect(effect).not.toMatch(/[^.]onClose\(\)/);
  });

  it('does not key the listener effect on the callback identity', () => {
    const start = MENU.indexOf('const onDown = (e: MouseEvent)');
    const effect = MENU.slice(start, MENU.indexOf('}, [', start) + 8);
    expect(effect).toContain('}, []);');
    expect(effect).not.toContain('}, [onClose]);');
  });
});
