import { drawnWires } from '../CanvasWires';
import { worldPoint, worldDelta } from '../canvasMutations';
import { nodeRegistryPayload } from '../canvasSelectors';
import { NODE_W, NODE_H, Rect } from '../canvasGeometry';
import { portPoint } from '../wireGeometry';
import { CanvasEdge } from '../../../store/slices/canvasSlice';
import type { CanvasModel } from '../canvasSelectors';

const at = (x: number, y: number): Rect => ({ x, y, w: NODE_W, h: NODE_H });
const edge = (id: string, from: string, to: string, over: Partial<CanvasEdge> = {}): CanvasEdge =>
  ({ id, from, to, label: null, origin: 'user', createdAt: 1, ...over });

describe('drawnWires', () => {
  const rects = { a: at(0, 0), b: at(900, 0), c: at(0, 900) };

  it('draws one path per edge whose endpoints it knows', () => {
    const wires = drawnWires([edge('ce-1', 'a', 'b'), edge('ce-2', 'a', 'c')], rects, null);
    expect(wires.map((w) => w.key)).toEqual(['ce-1', 'ce-2']);
    for (const w of wires) expect(w.d.startsWith('M')).toBe(true);
  });

  it('skips an edge whose endpoint is not in the rect map at all', () => {
    // A terminal that closed while the graph was in flight. The backend filters these out of
    // `/graph`, but the renderer's own model can be a render behind.
    expect(drawnWires([edge('ce-1', 'a', 'gone')], rects, null)).toEqual([]);
  });

  it('marks agent-created wires so they read as provisional', () => {
    const [w] = drawnWires([edge('ce-1', 'a', 'b', { origin: 'agent' })], rects, null);
    expect(w.cls).toContain('agent');
  });

  it('applies no heat at all when nothing is hovered', () => {
    const [w] = drawnWires([edge('ce-1', 'a', 'b')], rects, null);
    expect(w.cls).not.toContain('hot');
    expect(w.cls).not.toContain('cold');
  });

  it('brightens the hovered node\'s wires and fades the rest', () => {
    const wires = drawnWires([edge('ce-1', 'a', 'b'), edge('ce-2', 'b', 'c')], rects, 'a');
    expect(wires[0].cls).toContain('hot');
    expect(wires[1].cls).toContain('cold');
  });

  it('puts the label midpoint ON the curve, not on the chord', () => {
    // Two nodes side by side: the wire bows east out of `a` and west into `b`, so the curve's
    // midpoint sits on the straight line between the ports here — but its Y must track the
    // curve, not the endpoints, when the ports are on perpendicular faces.
    const [w] = drawnWires([edge('ce-1', 'a', 'c')], rects, null);
    const p1 = [NODE_W / 2, NODE_H];       // a's south port
    const p2 = [NODE_W / 2, 900];          // c's north port
    expect(w.mid[0]).toBeCloseTo(p1[0], 6);
    expect(w.mid[1]).toBeGreaterThan(p1[1]);
    expect(w.mid[1]).toBeLessThan(p2[1]);
  });
});

describe('worldPoint', () => {
  it('is the identity at the origin with no pan and zoom 1', () => {
    expect(worldPoint(100, 50, { left: 0, top: 0 }, { x: 0, y: 0, z: 1 })).toEqual({ x: 100, y: 50 });
  });

  it('subtracts the viewport box, so a sidebar does not shift the world', () => {
    expect(worldPoint(350, 50, { left: 250, top: 0 }, { x: 0, y: 0, z: 1 })).toEqual({ x: 100, y: 50 });
  });

  it('removes the pan BEFORE dividing by the zoom', () => {
    // `translate(x,y) scale(z)` with origin 0,0 applies the scale first, so the translation is
    // in SCREEN units. Dividing first and subtracting after is exact at pan (0,0) and wrong
    // everywhere else — the same shape as multiplying instead of dividing in `worldDelta`.
    const got = worldPoint(300, 300, { left: 0, top: 0 }, { x: 100, y: 100, z: 2 });
    expect(got).toEqual({ x: 100, y: 100 });
    const wrongOrder = { x: 300 / 2 - 100, y: 300 / 2 - 100 };
    expect(got).not.toEqual(wrongOrder);
  });

  it('agrees with worldDelta on the distance between two screen points', () => {
    // The two conversions must not drift: a ghost wire placed by `worldPoint` and a node moved
    // by `worldDelta` have to end up under the same cursor.
    const vp = { x: -420, y: 96, z: 0.35 };
    const rect = { left: 250, top: 40 };
    const p = worldPoint(600, 300, rect, vp);
    const q = worldPoint(740, 380, rect, vp);
    const { dx, dy } = worldDelta(740 - 600, 380 - 300, vp.z);
    expect(q.x - p.x).toBeCloseTo(dx, 9);
    expect(q.y - p.y).toBeCloseTo(dy, 9);
  });

  it('does not divide by zero on a degenerate zoom', () => {
    const got = worldPoint(10, 10, { left: 0, top: 0 }, { x: 0, y: 0, z: 0 });
    expect(Number.isFinite(got.x)).toBe(true);
    expect(Number.isFinite(got.y)).toBe(true);
  });
});

describe('nodeRegistryPayload', () => {
  const model: CanvasModel = {
    nodes: [
      { terminalId: 'tm-1', tabId: 'tb-a', paneId: 'p1', title: 'build', shellType: 'pwsh', rect: at(0, 0), isRunning: false, hasUnseenOutput: false, groupTitle: 'Group' },
      { terminalId: 'tm-2', tabId: 'tb-a', paneId: 'p2', title: 'test', shellType: 'pwsh', rect: at(0, 0), isRunning: false, hasUnseenOutput: false, groupTitle: 'Group' },
      { terminalId: 'tm-3', tabId: 'tb-b', paneId: 'p3', title: 'logs', shellType: 'bash', rect: at(0, 0), isRunning: false, hasUnseenOutput: false, groupTitle: 'Group' },
    ],
    groups: [
      { tabId: 'tb-a', title: 'API', rect: at(0, 0), nodeIds: ['tm-1', 'tm-2'], anyRunning: false },
      { tabId: 'tb-b', title: 'Ops', rect: at(0, 0), nodeIds: ['tm-3'], anyRunning: false },
    ],
  };

  it('carries the titles only the renderer knows', () => {
    // The backend has every id and owning tab after P0-A; `PaneNode.name` and `Tab.title` never
    // leave the renderer. Publishing without them is what makes `/connections` a list of
    // `tm-` ids (design 010 §7.4.1).
    expect(nodeRegistryPayload(model)).toEqual([
      { nodeId: 'tm-1', title: 'build', groupId: 'tb-a', groupTitle: 'API' },
      { nodeId: 'tm-2', title: 'test', groupId: 'tb-a', groupTitle: 'API' },
      { nodeId: 'tm-3', title: 'logs', groupId: 'tb-b', groupTitle: 'Ops' },
    ]);
  });

  it('publishes the LEAF id, never the owning tab', () => {
    // `resolve_renderer_id` accepts both, so sending a tab id would resolve and silently
    // register the wrong node.
    for (const n of nodeRegistryPayload(model)) {
      expect(n.nodeId).toMatch(/^tm-/);
      expect(n.nodeId).not.toBe(n.groupId);
    }
  });

  it('leaves groupTitle null for a node whose group is missing rather than dropping the node', () => {
    const orphan: CanvasModel = { nodes: [model.nodes[0]], groups: [] };
    expect(nodeRegistryPayload(orphan)).toEqual([
      { nodeId: 'tm-1', title: 'build', groupId: 'tb-a', groupTitle: null },
    ]);
  });

  it('publishes every node, including ones the canvas is not painting', () => {
    // Culling is a rendering decision. A node dropped from the registry because it happens to
    // be off screen would make an agent's `/connections` answer depend on where the user
    // scrolled, which is the least explicable failure this endpoint could have.
    expect(nodeRegistryPayload(model)).toHaveLength(model.nodes.length);
  });
});

/**
 * The selected connection — Tam: "user can click on the connection line and then delete it".
 *
 * Selection is the state everything else in the feature hangs off: the class that shows it, the
 * two endpoint handles a re-connect drag grabs, the delete badge, and the key.
 */
describe('drawnWires selection', () => {
  const rects = { a: at(0, 0), b: at(900, 0), c: at(0, 900) };
  const two = [edge('ce-1', 'a', 'b'), edge('ce-2', 'a', 'c')];

  it('marks exactly the selected wire', () => {
    const wires = drawnWires(two, rects, null, 'ce-2');
    expect(wires.map((w) => w.selected)).toEqual([false, true]);
    expect(wires[1].cls).toContain('selected');
    expect(wires[0].cls).not.toContain('selected');
  });

  it('marks nothing when nothing is selected', () => {
    for (const sel of [null, undefined, 'ce-gone']) {
      const wires = drawnWires(two, rects, null, sel as string | null);
      expect(wires.some((w) => w.selected)).toBe(false);
    }
  });

  /**
   * A selected wire that the hover focus would dim.
   *
   * `cold` is 12% opacity — a selection nobody can see is a selection the user thinks they lost,
   * and then Delete removes something they are no longer looking at. The class order here is
   * what lets the stylesheet's later rule win without `!important`.
   */
  it('keeps the selected class after cold, so the dimming cannot hide it', () => {
    // Hovering `a` makes `b→c` cold; select it anyway.
    const wires = drawnWires([...two, edge('ce-3', 'b', 'c')], rects, 'a', 'ce-3');
    const cold = wires.find((w) => w.key === 'ce-3')!;
    expect(cold.cls).toContain('cold');
    expect(cold.cls.indexOf('selected')).toBeGreaterThan(cold.cls.indexOf('cold'));
  });

  /** The handles are drawn at these two points, so they have to be the wire's real ends rather
   *  than a second computation of them. */
  it('carries the endpoints the handles are placed on', () => {
    const [w] = drawnWires([edge('ce-1', 'a', 'b')], rects, null, 'ce-1');
    expect(w.ends.p1).toEqual(portPoint(rects.a, w.ends.s1));
    expect(w.ends.p2).toEqual(portPoint(rects.b, w.ends.s2));
    // ...and the path really starts and ends there.
    expect(w.d.startsWith(`M${w.ends.p1[0]},${w.ends.p1[1]} `)).toBe(true);
    expect(w.d.endsWith(` ${w.ends.p2[0]},${w.ends.p2[1]}`)).toBe(true);
  });
});
