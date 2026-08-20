/**
 * Creating a terminal FROM the canvas — Tam's items 3 (right-click the background) and 4
 * (click a port).
 *
 * Three things are decided here and each fails differently: where the node lands, whether the
 * new tab takes the screen, and whether a run of spawns from one node fans or stacks.
 */
import { spawnRectAt, spawnRectNear, planCanvasSpawn } from '../canvasSpawn';
import { NODE_W, NODE_H, Rect } from '../canvasGeometry';

describe('spawnRectAt — "put a terminal here"', () => {
  /**
   * Centred, not anchored top-left. The off-by-half-a-node version looks right in isolation
   * (a node does appear near the cursor) and reads as "it ignored me" wherever precision
   * matters — dropping into a gap between two nodes, or just inside a group frame.
   */
  it('centres the node on the point', () => {
    const r = spawnRectAt({ x: 1000, y: 500 });
    expect(r.x + r.w / 2).toBe(1000);
    expect(r.y + r.h / 2).toBe(500);
  });

  it('is a standard-sized node', () => {
    const r = spawnRectAt({ x: 0, y: 0 });
    expect(r.w).toBe(NODE_W);
    expect(r.h).toBe(NODE_H);
  });

  // World coordinates are signed — the workspace extends up and left of the origin, and
  // `worldPoint` returns negatives as soon as the user pans right/down.
  it('works at negative world coordinates', () => {
    const r = spawnRectAt({ x: -600, y: -240 });
    expect(r.x + r.w / 2).toBe(-600);
    expect(r.y + r.h / 2).toBe(-240);
  });
});

describe('spawnRectNear — the port-click placement', () => {
  const source: Rect = { x: 0, y: 0, w: NODE_W, h: NODE_H };

  it('does not land on the node it came from', () => {
    const r = spawnRectNear(source, [source], 0);
    const overlaps =
      r.x < source.x + source.w && source.x < r.x + r.w &&
      r.y < source.y + source.h && source.y < r.y + r.h;
    expect(overlaps).toBe(false);
  });

  it('keeps the source node\'s size', () => {
    const big: Rect = { x: 0, y: 0, w: 500, h: 300 };
    const r = spawnRectNear(big, [big], 0);
    expect(r.w).toBe(500);
    expect(r.h).toBe(300);
  });

  /**
   * `index` is how many edges already leave this node. Without it a second click on the same
   * port puts the new node exactly where the first went — which, since the first is in `taken`
   * by then, only avoids an overlap by luck of the collision search rather than by design.
   */
  it('fans successive spawns instead of stacking them', () => {
    const a = spawnRectNear(source, [source], 0);
    const b = spawnRectNear(source, [source], 1);
    expect(`${b.x},${b.y}`).not.toBe(`${a.x},${a.y}`);
  });

  it('avoids what is already there', () => {
    const first = spawnRectNear(source, [source], 0);
    const second = spawnRectNear(source, [source, first], 0);
    const overlaps =
      second.x < first.x + first.w && first.x < second.x + second.w &&
      second.y < first.y + first.h && first.y < second.y + second.h;
    expect(overlaps).toBe(false);
  });

  // Does not mutate its input: `taken` is `model.nodes.map(n => n.rect)` at the call site, and
  // those ARE the store's rects.
  it('leaves the caller\'s array alone', () => {
    const taken = [source];
    spawnRectNear(source, taken, 0);
    expect(taken).toEqual([source]);
  });
});

describe('planCanvasSpawn', () => {
  const profile = { id: 'pwsh', name: 'PowerShell' };
  const rect: Rect = { x: 10, y: 20, w: NODE_W, h: NODE_H };

  /**
   * **The assertion this module exists for.** `addTab` activates by default, and activating
   * any tab deactivates the canvas — which unmounts `CanvasMode`, hands every relocated
   * terminal back to its pane, and drops the user out of the canvas onto the terminal they
   * just made. The gesture is "add a terminal to this workspace", not "leave for it".
   */
  it('does not activate the new tab', () => {
    expect(planCanvasSpawn(profile, [], rect).tab.isActive).toBe(false);
  });

  it('carries the rect through and gives the tab an id to hang it on', () => {
    const plan = planCanvasSpawn(profile, [], rect);
    expect(plan.rect).toEqual(rect);
    expect(plan.tab.id).toMatch(/^tb-/);
  });

  /**
   * **The node id is the LEAF, and the plan has to mint it.**
   *
   * A canvas node is keyed by `leaf.terminalId` (`canvasSelectors.buildCanvasModel`), and
   * `setNodeGeom` / `selectNode` / `connectWhenReady` all address nodes. Before design 014 a
   * renderer-created tab's root leaf WAS its tab id, so `plan.tab.id` served as the node id and
   * the spawn could run before any pane existed. Every root leaf is a minted `tm-` now, so the
   * tab id addresses no node at all: the geometry lands under a key nothing reads (the node
   * appears in a seeded slot instead of where the user pointed), the selection matches nothing,
   * and `connectWhenReady` waits out its full ten seconds for a terminal id that will never
   * register — losing the wire the port click asked for.
   *
   * Minting here rather than letting `tabTreeSeed` do it is what makes the leaf knowable BEFORE
   * the tab is added, which the geometry-first ordering requires.
   */
  it('mints the root leaf, so the node has an id before any pane exists', () => {
    const plan = planCanvasSpawn(profile, [], rect);
    expect(plan.leafId).toMatch(/^tm-/);
    expect(plan.leafId).not.toBe(plan.tab.id);
  });

  /**
   * ...and ships the tree that carries it, so `planSeeds` finds the tab already initialised
   * rather than manufacturing a second root under a different leaf. `seededForTabId` is what
   * records the ownership the old id equality used to imply (design 014 §A6.0) — without it
   * `planSeeds` Rule 3 cannot tell this tab from one whose terminal was dragged away.
   */
  it('ships a root pane tree that declares its owner', () => {
    const plan = planCanvasSpawn(profile, [], rect);
    expect(plan.tree).toMatchObject({
      type: 'terminal',
      terminalId: plan.leafId,
      seededForTabId: plan.tab.id,
    });
    expect(plan.tree.id).toMatch(/^pn-/);
    expect(plan.tree.name).toBe(plan.tab.title);
    expect(plan.tree.shellType).toBe(plan.tab.shellType);
  });

  it('mints a fresh leaf every time', () => {
    expect(planCanvasSpawn(profile, [], rect).leafId)
      .not.toBe(planCanvasSpawn(profile, [], rect).leafId);
  });

  it('keeps the title unique against the tabs already open', () => {
    expect(planCanvasSpawn(profile, [], rect).tab.title).toBe('PowerShell');
    expect(planCanvasSpawn(profile, ['PowerShell'], rect).tab.title).toBe('PowerShell 1');
    expect(planCanvasSpawn(profile, ['PowerShell', 'PowerShell 1'], rect).tab.title)
      .toBe('PowerShell 2');
  });

  it('launches the profile that was picked', () => {
    expect(planCanvasSpawn({ id: 'wsl-ubuntu', name: 'Ubuntu' }, [], rect).tab.shellType)
      .toBe('wsl-ubuntu');
  });
});
