/**
 * The ordering and the routing around `canvasSpawn` — Tam's items 3 and 4.
 *
 * The placement maths is pinned in `canvasSpawn.test.ts` and the click/drag seam in
 * `useWireDragClick.test.tsx`. What is left is the part that only exists as a sequence of
 * dispatches inside `CanvasMode`, where the failure is a visible jump rather than a wrong
 * number — and where mounting the component for real means mounting every terminal on the
 * canvas.
 *
 * Comment-stripped before matching, same as `canvasCloseWiring.test.ts`: three tests in this
 * plan have been satisfied by their own explanatory prose.
 */
import path from 'path';
import { readSource } from '../../../utils/readSource';

const CANVAS = path.resolve(__dirname, '..');

function code(file: string): string {
  return readSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const MODE = code(path.join(CANVAS, 'CanvasMode.tsx'));
const VIEWPORT = code(path.join(CANVAS, 'CanvasViewport.tsx'));

/** `spawn`'s body alone. Scoped, because `CanvasMode` dispatches `setNodeGeom` from the drag
 *  and arrange paths too — a file-wide search would find those and pass with `spawn` gutted. */
const spawnStart = MODE.indexOf('const spawn = useCallback(');
const spawnBody = MODE.slice(spawnStart, MODE.indexOf('\n  }, [', spawnStart));

describe('creating a terminal from the canvas', () => {
  it('found the handler it is reading', () => {
    // Or every assertion below passes vacuously against an empty string.
    expect(spawnStart).toBeGreaterThan(-1);
    expect(spawnBody).toContain('planCanvasSpawn(');
  });

  /**
   * **Geometry first, tab second, and this is the whole of it.**
   *
   * `buildCanvasModel` reads `canvas.nodes` for a stored rect and seeds a position only when
   * there is none. Write the geometry first and the pane arrives to find its place already
   * chosen; write it second and the seeding has already run, so the node appears in a seeded
   * slot and then jumps to where the user pointed. Both orders "work" — one of them just
   * flickers, which is why no type or test would otherwise notice.
   *
   * `App.tsx` states the same rule for an agent-spawned terminal.
   */
  it('writes the node geometry BEFORE the tab exists', () => {
    const geom = spawnBody.indexOf('dispatch(setNodeGeom(');
    const tab = spawnBody.indexOf('dispatch(addTab(');
    expect(geom).toBeGreaterThan(-1);
    expect(tab).toBeGreaterThan(-1);
    expect(geom).toBeLessThan(tab);
  });

  /**
   * The tab object must be the one `planCanvasSpawn` built, because that is where
   * `isActive: false` comes from — and activating the new tab deactivates the canvas, unmounts
   * `CanvasMode`, and drops the user out of the workspace onto the terminal they just made.
   * An inline `addTab({ ...fields })` would look identical and do exactly that.
   */
  it('adds the planned tab rather than rebuilding one', () => {
    expect(spawnBody).toContain('dispatch(addTab(plan.tab));');
    expect(spawnBody).not.toMatch(/addTab\(\s*\{/);
  });

  /** Both spawns place a node; only the port click draws a wire. An unconditional
   *  `createEdge` would connect a background-spawned terminal to whatever `source` last held. */
  it('draws a wire only when the spawn came from a port', () => {
    expect(spawnBody).toContain('if (source) {');
    const edge = spawnBody.indexOf('connectWhenReady(');
    expect(edge).toBeGreaterThan(spawnBody.indexOf('if (source) {'));
    // Server-minted row only, exactly as the drag path does — an optimistic client id is never
    // replaced, so a later delete would name a row that does not exist.
    expect(spawnBody).toContain('if (edge) dispatch(addEdge(edge));');
  });

  /**
   * **The wire has to wait for the terminal to exist.**
   *
   * `POST /api/canvas/edges` resolves both endpoints through `resolve_renderer_id` and 404s on
   * one it has not registered — and a terminal created here is several async hops from
   * existing (Redux → render → `PaneManager` → `TerminalPane` → invoke → spawn). A bare
   * `createEdge` therefore lost the edge every time, silently, because `createEdge` catches and
   * returns `null` and `null` is also what a legitimate refusal looks like.
   *
   * Reported 2026-08-17 as "it needs to auto setup connection to the new terminal".
   */
  it('waits for the new terminal to register before posting the edge', () => {
    expect(spawnBody).toContain('connectWhenReady(');
    expect(spawnBody).not.toMatch(/void createEdge\(/);
    // Readiness is the renderer's process registry — the same predicate the close path uses,
    // and one that is true only after the backend has registered the terminal.
    expect(spawnBody).toContain('isReady: isTerminalAlive');
  });
});

/**
 * Bringing the new terminal into view — the second half of Tam's requested flow: click port →
 * create → connect → **focus** → interact.
 */
describe('framing what was just created', () => {
  it('selects the new node', () => {
    expect(spawnBody).toContain('dispatch(selectNode(plan.tab.id));');
  });

  /**
   * Containment, not intersection. `isVisible` would call a node clipped by the right edge
   * "visible" and decline to move, leaving the terminal the user asked for half off screen.
   * The two predicates live side by side in `canvasGeometry`; picking the wrong one here is a
   * one-word difference that looks correct in every test that places a node fully on or fully
   * off screen.
   */
  it('flies only when the node is not already framed, and uses the containment test', () => {
    expect(spawnBody).toContain(
      'if (!isFullyVisible(vp, aimedNodeRect(plan.rect, vp.z), size.w, size.h, FRAME_INSET))');
    expect(spawnBody).toContain(
      'flyTo(centreOn(aimedNodeRect(plan.rect, vp.z), size.w, size.h, vp.z, metrics.zMax))');
  });

  /** ...and it frames the box the node DRAWS, not the slot layout reserved for it. Same rule
   *  as every other consumer that points at a node rather than placing one. */
  it('never aims at the reserved rect', () => {
    expect(spawnBody).not.toContain('isFullyVisible(vp, plan.rect');
    expect(spawnBody).not.toContain('centreOn(plan.rect');
  });

  /**
   * Unconditional flight would yank the viewport for a background spawn — a node placed
   * directly under the cursor, which is by construction already in view.
   */
  it('does not fly unconditionally', () => {
    const fly = spawnBody.indexOf('flyTo(');
    const guard = spawnBody.indexOf('if (!isFullyVisible(');
    expect(guard).toBeGreaterThan(-1);
    expect(fly).toBeGreaterThan(guard);
  });

  /** Keeps the zoom the user chose. Framing a new node is not a reason to change their scale —
   *  `fitViewport` would, `centreOn` at `vp.z` does not. */
  it('keeps the current zoom', () => {
    expect(spawnBody).toContain('vp.z');
    expect(spawnBody).not.toContain('fitViewport(');
  });

  /**
   * A port click whose node has gone — its tab closed, its pane re-homed between press and
   * release — must not spawn at all. Half of what was asked for is a terminal connected to
   * nothing, dropped at whatever `spawnRectAt` makes of an undefined point.
   */
  it('abandons a port spawn whose source vanished', () => {
    expect(spawnBody).toContain('if (menu.fromId && !source) return;');
  });

  it('fans from the source for a port click and centres on the point otherwise', () => {
    expect(spawnBody).toContain('spawnRectNear(');
    expect(spawnBody).toContain('spawnRectAt(');
    // The fan index is how many edges already LEAVE the source, so a run of clicks spreads.
    expect(spawnBody).toContain('edges.filter((e) => e.from === source.terminalId).length');
  });
});

describe('the two gestures that open the profile menu', () => {
  it('right-clicking the background carries a WORLD point', () => {
    // Screen coordinates would place the node under the sidebar at any pan or zoom but the
    // identity one — the same class of bug `worldPoint`'s own note describes.
    expect(MODE).toContain('at: worldPoint(e.clientX, e.clientY, box, vp)');
    expect(VIEWPORT).toContain('onBackgroundContextMenu(e);');
  });

  it('clicking a port carries the node, not a point', () => {
    expect(MODE).toContain('setSpawnMenu({ x: click.x, y: click.y, fromId: click.fromId });');
  });

  /** The menu says which of the two it is. They do different things, and the list of profiles
   *  is identical, so the header is the only thing on screen that distinguishes them. */
  it('tells the user which spawn they are about to make', () => {
    expect(MODE).toMatch(/header=\{spawnMenu\.fromId \? '[^']+' : '[^']+'\}/);
  });

  /** One nullable slot, not two booleans: two would have a fourth state in which both a point
   *  and a source are set, and the menu would be asked to be both spawns at once. */
  it('shares one state between them', () => {
    expect(MODE.match(/setSpawnMenu\(\{/g) ?? []).toHaveLength(2);
    expect(MODE.match(/<CanvasProfileMenu/g) ?? []).toHaveLength(1);
  });
});
