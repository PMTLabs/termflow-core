import {
  pickSides, portPoint, wirePath, wireMidpoint, neighbourhood, edgeHeat,
  oppositeSide, linkTargetId, MIN_REACH,
} from '../wireGeometry';
import type { Side } from '../wireGeometry';
import { NODE_W, NODE_H, Rect } from '../canvasGeometry';
import { CanvasEdge } from '../../../store/slices/canvasSlice';

const at = (x: number, y: number): Rect => ({ x, y, w: NODE_W, h: NODE_H });
const edge = (id: string, from: string, to: string): CanvasEdge =>
  ({ id, from, to, label: null, origin: 'user', createdAt: 1 });

/** `M x,y C c1x,c1y c2x,c2y x2,y2` → the six numbers, in order. */
const numbers = (d: string): number[] =>
  (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

describe('pickSides', () => {
  it('goes east→west when the target is mostly to the right', () => {
    expect(pickSides(at(0, 0), at(900, 0))).toEqual(['e', 'w']);
  });
  it('goes west→east when the target is mostly to the left', () => {
    expect(pickSides(at(900, 0), at(0, 0))).toEqual(['w', 'e']);
  });
  it('goes south→north when the target is mostly below', () => {
    expect(pickSides(at(0, 0), at(0, 900))).toEqual(['s', 'n']);
  });
  it('goes north→south when the target is mostly above', () => {
    expect(pickSides(at(0, 900), at(0, 0))).toEqual(['n', 's']);
  });

  it('is antisymmetric: swapping the nodes swaps and mirrors the faces', () => {
    const opposite: Record<Side, Side> = { n: 's', s: 'n', e: 'w', w: 'e' };
    const pairs: Array<[Rect, Rect]> = [
      [at(0, 0), at(900, 40)],
      [at(0, 0), at(40, 900)],
      [at(500, 620), at(120, 90)],
      [at(-300, -80), at(260, 15)],
    ];
    for (const [a, b] of pairs) {
      const [s1, s2] = pickSides(a, b);
      const [t1, t2] = pickSides(b, a);
      // The face `a` leaves by is the face `b` arrives at, seen from the other end.
      expect(t1).toBe(opposite[s1]);
      expect(t2).toBe(opposite[s2]);
    }
  });
});

describe('portPoint', () => {
  const r = at(100, 200);
  it('sits on the correct edge, centred', () => {
    expect(portPoint(r, 'e')).toEqual([100 + NODE_W, 200 + NODE_H / 2]);
    expect(portPoint(r, 'w')).toEqual([100, 200 + NODE_H / 2]);
    expect(portPoint(r, 'n')).toEqual([100 + NODE_W / 2, 200]);
    expect(portPoint(r, 's')).toEqual([100 + NODE_W / 2, 200 + NODE_H]);
  });

  it('puts every port ON the rect boundary, never inside it', () => {
    for (const side of ['n', 'e', 's', 'w'] as Side[]) {
      const [x, y] = portPoint(r, side);
      const onVertical = x === r.x || x === r.x + r.w;
      const onHorizontal = y === r.y || y === r.y + r.h;
      expect(onVertical || onHorizontal).toBe(true);
      expect(x).toBeGreaterThanOrEqual(r.x);
      expect(x).toBeLessThanOrEqual(r.x + r.w);
      expect(y).toBeGreaterThanOrEqual(r.y);
      expect(y).toBeLessThanOrEqual(r.y + r.h);
    }
  });
});

describe('wirePath', () => {
  it('emits a cubic bezier starting and ending exactly at the given points', () => {
    const d = wirePath([0, 0], [100, 50], 'e', 'w');
    expect(d.startsWith('M0,0 C')).toBe(true);
    expect(d.endsWith('100,50')).toBe(true);
  });

  it('keeps a minimum control-point reach so short wires still curve', () => {
    const d = wirePath([0, 0], [4, 0], 'e', 'w');
    const [, , c1x] = numbers(d);
    expect(c1x).toBeGreaterThanOrEqual(40);
  });

  it('leaves and arrives perpendicular to each named face', () => {
    // e → w, well separated: c1 is east of p1, c2 is west of p2, both on their own row.
    const [x1, y1, c1x, c1y, c2x, c2y, x2, y2] = numbers(wirePath([0, 0], [600, 0], 'e', 'w'));
    expect(c1x).toBeGreaterThan(x1);
    expect(c1y).toBe(y1);
    expect(c2x).toBeLessThan(x2);
    expect(c2y).toBe(y2);
  });

  it('honours s2 even when the target sits BEHIND the source', () => {
    // The defect this pins: `plan/013`'s sketch chose the arrival control point from
    // `p2[0] > p1[0]` rather than from the arrival face. Here the west port of the target is
    // to the LEFT of the source's east port — two overlapping / interleaved nodes, which is an
    // ordinary canvas arrangement — so the heuristic reaches EAST of p2 and the curve arrives
    // from the wrong side. Derived from `s2`, it still reaches west.
    const [, , , , c2x] = numbers(wirePath([500, 0], [40, 0], 'e', 'w'));
    expect(c2x).toBeLessThan(40);
  });

  it('reaches along the axis of the face for vertical wires', () => {
    const [x1, y1, c1x, c1y, c2x, c2y, x2, y2] = numbers(wirePath([0, 0], [0, 600], 's', 'n'));
    expect(c1x).toBe(x1);
    expect(c1y).toBeGreaterThan(y1);
    expect(c2x).toBe(x2);
    expect(c2y).toBeLessThan(y2);
  });

  it('scales the reach with distance once past the floor', () => {
    const short = numbers(wirePath([0, 0], [MIN_REACH, 0], 'e', 'w'))[2];
    const long = numbers(wirePath([0, 0], [4000, 0], 'e', 'w'))[2];
    expect(short).toBe(MIN_REACH);
    expect(long).toBeGreaterThan(MIN_REACH * 4);
  });
});

describe('wireMidpoint', () => {
  it('is the cubic at t=0.5, not the midpoint of the chord', () => {
    // Two ports FACING each other across a gap: the curve bulges out on both sides, so the two
    // answers differ. A label pinned to the chord floats off the wire it belongs to.
    const mid = wireMidpoint([0, 0], [40, 0], 'e', 'w');
    // Symmetric case — the x agrees, and that is not what is being tested.
    expect(mid[0]).toBeCloseTo(20, 6);

    // Perpendicular faces: here the chord and the curve genuinely part company.
    const [mx, my] = wireMidpoint([0, 0], [400, 400], 'e', 'n');
    expect(mx).not.toBeCloseTo(200, 1);
    expect(my).not.toBeCloseTo(200, 1);
  });

  it('stays between the endpoints for an ordinary wire', () => {
    const [mx, my] = wireMidpoint([0, 0], [900, 300], 'e', 'w');
    expect(mx).toBeGreaterThan(0);
    expect(mx).toBeLessThan(900);
    expect(my).toBeGreaterThan(0);
    expect(my).toBeLessThan(300);
  });

  it('shares its control points with wirePath, so the label cannot drift off the curve', () => {
    // Derived rather than restated: read the control points back out of the path string and
    // evaluate the cubic at t=0.5 independently. If the two ever compute `reach` differently
    // this fails, which is the whole point of them sharing one helper.
    const p1: [number, number] = [12, 34];
    const p2: [number, number] = [560, 780];
    const [, , c1x, c1y, c2x, c2y] = numbers(wirePath(p1, p2, 'e', 'n'));
    const expected = [
      (p1[0] + 3 * c1x + 3 * c2x + p2[0]) / 8,
      (p1[1] + 3 * c1y + 3 * c2y + p2[1]) / 8,
    ];
    const got = wireMidpoint(p1, p2, 'e', 'n');
    expect(got[0]).toBeCloseTo(expected[0], 9);
    expect(got[1]).toBeCloseTo(expected[1], 9);
  });
});

describe('oppositeSide', () => {
  it('is an involution', () => {
    for (const s of ['n', 'e', 's', 'w'] as Side[]) {
      expect(oppositeSide(oppositeSide(s))).toBe(s);
      expect(oppositeSide(s)).not.toBe(s);
    }
  });
});

describe('linkTargetId', () => {
  it('is the node under the cursor', () => {
    expect(linkTargetId('tm-2', 'tm-1')).toBe('tm-2');
  });

  it('is null over open canvas', () => {
    expect(linkTargetId(null, 'tm-1')).toBeNull();
    expect(linkTargetId(undefined, 'tm-1')).toBeNull();
  });

  it('is null over the source node itself', () => {
    // Owns the FEEDBACK: the backend also rejects a self-edge, with a 400 after resolving both
    // ids, but that decides whether a row is written. This decides whether the user is shown a
    // highlight promising a connection that cannot be made. One rule drives both the highlight
    // and the create, so the promise and the effect cannot disagree.
    expect(linkTargetId('tm-1', 'tm-1')).toBeNull();
  });
});

describe('neighbourhood', () => {
  const edges = [edge('ce-1', 'a', 'b'), edge('ce-2', 'c', 'a'), edge('ce-3', 'x', 'y')];
  it('returns null when nothing is hovered, meaning "dim nothing"', () => {
    expect(neighbourhood(edges, null)).toBeNull();
  });
  it('includes the node itself and its one-hop neighbours in both directions', () => {
    const n = neighbourhood(edges, 'a')!;
    expect(Array.from(n).sort()).toEqual(['a', 'b', 'c']);
  });
  it('returns just the node when it has no connections', () => {
    expect(Array.from(neighbourhood(edges, 'lonely')!)).toEqual(['lonely']);
  });
  it('does not reach two hops', () => {
    // b-c exists only through a. Hovering b must not pull c in.
    const n = neighbourhood([edge('ce-1', 'a', 'b'), edge('ce-2', 'a', 'c')], 'b')!;
    expect(Array.from(n).sort()).toEqual(['a', 'b']);
  });
});

describe('edgeHeat', () => {
  it('is null for every edge when nothing is hovered', () => {
    expect(edgeHeat({ from: 'a', to: 'b' }, null)).toBeNull();
  });
  it('brightens an edge incident to the hovered node, in either direction', () => {
    expect(edgeHeat({ from: 'a', to: 'b' }, 'a')).toBe('hot');
    expect(edgeHeat({ from: 'c', to: 'a' }, 'a')).toBe('hot');
  });
  it('fades an edge that touches the hovered node nowhere', () => {
    expect(edgeHeat({ from: 'x', to: 'y' }, 'a')).toBe('cold');
  });

  it('fades an edge BETWEEN two neighbours of the hovered node', () => {
    // The triangle. `neighbourhood(edges,'a')` is {a,b,c}, so a "both endpoints are near"
    // predicate calls b-c hot — a wire the hovered node is not on. This is the assertion the
    // sketch's version fails.
    const edges = [edge('ce-1', 'a', 'b'), edge('ce-2', 'a', 'c'), edge('ce-3', 'b', 'c')];
    const near = neighbourhood(edges, 'a')!;
    expect(near.has('b') && near.has('c')).toBe(true);   // the trap is genuinely present
    expect(edgeHeat({ from: 'b', to: 'c' }, 'a')).toBe('cold');
  });

  it('agrees with neighbourhood on which NODES stay lit', () => {
    // The two must not drift: a wire drawn hot to a node that is dimmed reads as a bug.
    const edges = [edge('ce-1', 'a', 'b'), edge('ce-2', 'a', 'c'), edge('ce-3', 'b', 'c')];
    const near = neighbourhood(edges, 'a')!;
    for (const e of edges) {
      if (edgeHeat(e, 'a') === 'hot') {
        expect(near.has(e.from)).toBe(true);
        expect(near.has(e.to)).toBe(true);
      }
    }
  });
});
