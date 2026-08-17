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
import fs from 'fs';
import path from 'path';

const CANVAS = path.resolve(__dirname, '..');

function code(file: string): string {
  return fs.readFileSync(file, 'utf8')
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
    const edge = spawnBody.indexOf('createEdge(');
    expect(edge).toBeGreaterThan(spawnBody.indexOf('if (source) {'));
    // Server-minted row only, exactly as the drag path does — an optimistic client id is never
    // replaced, so a later delete would name a row that does not exist.
    expect(spawnBody).toContain('if (edge) dispatch(addEdge(edge));');
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
