import { Rect } from './canvasGeometry';
import { CanvasEdge } from '../../store/slices/canvasSlice';

/**
 * Wire geometry — `plan/013` Task 18.
 *
 * Everything here is pure and lives outside `CanvasWires` for the reason every canvas task
 * has landed on: nothing in this repo can mount `CanvasMode`, so logic left inside a
 * component is logic no test can reach.
 */

export type Side = 'n' | 'e' | 's' | 'w';

/** Outward unit normal of a node face. The wire leaves and arrives along these. */
const NORMAL: Record<Side, [number, number]> = {
  n: [0, -1],
  e: [1, 0],
  s: [0, 1],
  w: [-1, 0],
};

/** Leave each node by whichever face points most directly at the other. */
export function pickSides(a: Rect, b: Rect): [Side, Side] {
  const dx = (b.x + b.w / 2) - (a.x + a.w / 2);
  const dy = (b.y + b.h / 2) - (a.y + a.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['e', 'w'] : ['w', 'e'];
  return dy >= 0 ? ['s', 'n'] : ['n', 's'];
}

/**
 * The midpoint of one face, in world coordinates.
 *
 * This is also where `.canvas-port` paints: the stylesheet centres each dot on its face's
 * centre LINE (see the `--port-offset` note in `Canvas.css`). Keep the two agreeing — a wire
 * that starts anywhere but under the dot the user grabbed reads as a bug in the drag.
 */
export function portPoint(r: Rect, side: Side): [number, number] {
  switch (side) {
    case 'e': return [r.x + r.w, r.y + r.h / 2];
    case 'w': return [r.x, r.y + r.h / 2];
    case 'n': return [r.x + r.w / 2, r.y];
    default:  return [r.x + r.w / 2, r.y + r.h];
  }
}

/** Short wires still get a visible curve rather than collapsing to a straight line. */
export const MIN_REACH = 46;

/**
 * Cubic bezier leaving `s1` and arriving at `s2`, each perpendicular to its own face.
 *
 * **Both sides are parameters, deliberately.** `plan/013`'s sketch took only the departure
 * side and inferred the arrival control point from `p2[0] > p1[0]` — where the target happens
 * to sit relative to the source. That is the same answer as `s2` for two well-separated nodes
 * and the OPPOSITE answer whenever they overlap or interleave, which on a canvas whose nodes
 * are dragged freely is an ordinary arrangement rather than a corner case: the curve then
 * arrives from the wrong side and loops back through the node it is pointing at. `pickSides`
 * already returns both faces, so the heuristic was reconstructing, badly, something the caller
 * was holding all along.
 */
function controlPoints(
  p1: [number, number],
  p2: [number, number],
  s1: Side,
  s2: Side,
): [[number, number], [number, number]] {
  const reach = Math.max(MIN_REACH, Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) * 0.4);
  const [n1x, n1y] = NORMAL[s1];
  const [n2x, n2y] = NORMAL[s2];
  return [
    [p1[0] + n1x * reach, p1[1] + n1y * reach],
    [p2[0] + n2x * reach, p2[1] + n2y * reach],
  ];
}

export function wirePath(
  p1: [number, number],
  p2: [number, number],
  s1: Side,
  s2: Side,
): string {
  const [c1, c2] = controlPoints(p1, p2, s1, s2);
  return `M${p1[0]},${p1[1]} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
}

/**
 * The point halfway along the curve — where a connection's label sits.
 *
 * `B(0.5) = (p1 + 3c1 + 3c2 + p2) / 8`, the cubic evaluated at t = 0.5, and NOT the midpoint of
 * the straight line between the endpoints: on a wire that bows out to leave two facing ports the
 * two are far apart, and a label pinned to the chord floats off the wire it belongs to. Shares
 * `controlPoints` with `wirePath` so the label cannot drift from the curve it labels.
 */
export function wireMidpoint(
  p1: [number, number],
  p2: [number, number],
  s1: Side,
  s2: Side,
): [number, number] {
  const [c1, c2] = controlPoints(p1, p2, s1, s2);
  return [
    (p1[0] + 3 * c1[0] + 3 * c2[0] + p2[0]) / 8,
    (p1[1] + 3 * c1[1] + 3 * c2[1] + p2[1]) / 8,
  ];
}

/** The hovered node plus everything one hop away. Null means "dim nothing". */
export function neighbourhood(edges: CanvasEdge[], id: string | null): Set<string> | null {
  if (!id) return null;
  const near = new Set<string>([id]);
  for (const e of edges) {
    if (e.from === id) near.add(e.to);
    if (e.to === id) near.add(e.from);
  }
  return near;
}

/** The face opposite `side`. Used for the free end of a ghost wire, which has no node. */
export function oppositeSide(side: Side): Side {
  return ({ n: 's', s: 'n', e: 'w', w: 'e' } as const)[side];
}

/**
 * Which node a link drag would land on, or null.
 *
 * Null for the source node itself: an edge from a terminal to itself is meaningless, and the
 * backend rejects it with a 400 after resolving both ids. This is not a duplicate of that check
 * — it owns the FEEDBACK. The server's guard decides whether a row is written; this one decides
 * whether the user is shown a highlight promising a connection that cannot be made. One function
 * for both the highlight and the create, so the promise and the effect cannot disagree.
 */
export function linkTargetId(
  overTerminalId: string | null | undefined,
  fromId: string,
): string | null {
  if (!overTerminalId || overTerminalId === fromId) return null;
  return overTerminalId;
}

export type Heat = 'hot' | 'cold' | null;

/**
 * How a wire paints while a node is hovered: brightened, faded, or unchanged.
 *
 * **Incidence to the hovered node, not membership of the neighbourhood.** The sketch asked
 * whether BOTH endpoints were in `neighbourhood(...)`, which is a different question: in a
 * triangle a-b, a-c, b-c, hovering `a` puts b and c in the set, so b-c satisfies it and lights
 * up as though it were one of `a`'s connections. Design 010 §5 brightens "its wires" — the ones
 * that answer "what is this node connected to" — and b-c is not one of them. It stays a real
 * connection between two undimmed nodes, drawn cold, which is the honest picture.
 */
export function edgeHeat(edge: { from: string; to: string }, hoveredId: string | null): Heat {
  if (!hoveredId) return null;
  return edge.from === hoveredId || edge.to === hoveredId ? 'hot' : 'cold';
}
