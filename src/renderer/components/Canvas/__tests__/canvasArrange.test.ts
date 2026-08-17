/**
 * Arrange as a GRAPH layout — Tam's seventh round: "optimize to let the connection lines have
 * them less crossed over on the terminals or on each other".
 *
 * Every assertion here scores the REAL output of `arrange`, through the same `pickSides` /
 * `portPoint` the wires are drawn with. Nothing re-derives the layout: a test that modelled where
 * the nodes "should" land would agree with itself forever and say nothing about what is on screen.
 */
import {
  optimiseArrangeOrder, scoreArrange, arrangedRects, isBetter,
  NODE_PENALTY, MAX_EVALS, ArrangeEdge, ArrangeScore,
} from '../canvasArrange';
import { arrange, ArrangeInput } from '../canvasLayout';
import { arrangeTarget } from '../animateLayout';

const group = (id: string, ...nodeIds: string[]) => ({ id, nodeIds });
const edge = (from: string, to: string): ArrangeEdge => ({ from, to });

/** The score a given ORDER actually produces once `arrange` has laid it out. */
const scoreOf = (input: ArrangeInput, edges: ArrangeEdge[]): ArrangeScore =>
  scoreArrange(arrangedRects(arrange(input)), edges);

const costOf = (s: ArrangeScore) => s.hits * NODE_PENALTY + s.crossings;

/**
 * `arrange` grids each group at `ceil(sqrt(n))` columns, so six terminals land three across and
 * two down: `a b c` over `d e f`. Measured, not assumed — a four-node group is a 2x2 with no node
 * BETWEEN any two others, which is why these fixtures use six.
 */
describe('scoreArrange', () => {
  const ROW = { groups: [group('g', 'a', 'b', 'c', 'd', 'e', 'f')] };

  it('counts a wire drawn across a node it does not belong to', () => {
    // `a` and `c` are the ends of the top row; `b` sits between them and the wire goes over it.
    const s = scoreOf(ROW, [edge('a', 'c')]);
    expect(s.hits).toBeGreaterThan(0);
  });

  it('counts one hit per node obstructed', () => {
    // `a` to `f` is the long diagonal: it crosses two of the four nodes it does not own.
    expect(scoreOf(ROW, [edge('a', 'f')]).hits).toBeGreaterThan(scoreOf(ROW, [edge('a', 'c')]).hits);
    // ...and a wire to its own neighbour obstructs nothing at all.
    expect(scoreOf(ROW, [edge('a', 'd')]).hits).toBe(0);
  });

  it('does not count a wire against its own endpoints', () => {
    // Every wire starts and ends ON a node's border, so counting endpoints would make the score
    // a function of how many wires there are and nothing else.
    const s = scoreOf({ groups: [group('g', 'a', 'b')] }, [edge('a', 'b')]);
    expect(s.hits).toBe(0);
  });

  it('counts wires that cross each other', () => {
    // A 2x2 grid wired diagonally both ways: the two wires must cross in the middle.
    const s = scoreOf({ groups: [group('g', 'a', 'b', 'c', 'd')] }, [edge('a', 'd'), edge('b', 'c')]);
    expect(s.crossings).toBeGreaterThan(0);
  });

  /**
   * A hub is not charged for existing.
   *
   * Wires out of one terminal on the same side leave from the SAME port, and the strict sign
   * test gives that for free — sharing an endpoint zeroes two of the four determinants and the
   * other two are exact negations, so they can never both be positive. There was a
   * shared-terminal skip here; it was unreachable AND wrong (two wires leaving one node from
   * different sides and then crossing IS a crossing), so it went.
   */
  it('does not count a hub\'s own wires as crossing each other', () => {
    const s = scoreOf(
      { groups: [group('g', 'hub', 'x', 'y', 'z')] },
      [edge('hub', 'x'), edge('hub', 'y'), edge('hub', 'z')],
    );
    expect(s.crossings).toBe(0);
  });

  /**
   * Touching is not crossing, and this is the only shape that can tell the two apart.
   *
   * A wire that ENDS exactly on another wire — a T-junction — is a degenerate case the grid
   * happens to make likely, because every port sits on a round coordinate. It must not count:
   * the obstruction term already charges for that wire passing over the node whose port it is,
   * and counting it here as well would price one situation twice.
   *
   * Built from hand-made rects rather than from `arrange`, deliberately. `scoreArrange` takes
   * rects, and no grid the layout produces puts one wire's endpoint in the middle of another —
   * so relaxing the crossing test from `>` to `>=` changed nothing anywhere else in this file,
   * and survived a whole mutation pass until this existed.
   */
  it('does not count a wire that merely ends on another wire', () => {
    const rects = {
      // `p`→`q` runs horizontally at y = 50, from x = 100 to x = 300.
      p: { x: 0, y: 0, w: 100, h: 100 },
      q: { x: 300, y: 0, w: 100, h: 100 },
      // `r`'s TOP port is (200, 50) — exactly on that line — and `s` is straight above it.
      r: { x: 150, y: 50, w: 100, h: 100 },
      s: { x: 150, y: -200, w: 100, h: 100 },
    };
    const s = scoreArrange(rects, [edge('p', 'q'), edge('r', 's')]);
    expect(s.crossings).toBe(0);
    // ...and the situation is not going unnoticed: the horizontal wire does run over `r`.
    expect(s.hits).toBeGreaterThan(0);
  });

  it('ignores an edge whose terminal is not in the layout', () => {
    // A wire to a terminal closed since, or in a group with no frame, has no geometry to score.
    const s = scoreOf(ROW, [edge('a', 'gone'), edge('nowhere', 'elsewhere')]);
    expect(s).toEqual({ hits: 0, crossings: 0, length: 0 });
  });

  it('ignores a self-link, which draws nothing', () => {
    expect(scoreOf(ROW, [edge('a', 'a')])).toEqual({ hits: 0, crossings: 0, length: 0 });
  });

  it('measures length between the ports a wire is actually drawn from', () => {
    // Not centre to centre: that would be short by half a node at each end, and on a horizontal
    // pair it would be wrong by a whole node width.
    const rects = arrangedRects(arrange({ groups: [group('g', 'a', 'b')] }));
    const gap = rects['b'].x - (rects['a'].x + rects['a'].w);
    expect(scoreOf({ groups: [group('g', 'a', 'b')] }, [edge('a', 'b')]).length).toBeCloseTo(gap, 6);
  });
});

describe('isBetter', () => {
  const s = (hits: number, crossings: number, length = 0): ArrangeScore => ({ hits, crossings, length });

  /**
   * The trade the whole feature exists to make, stated in CONCRETE numbers.
   *
   * Written as `isBetter(s(0, NODE_PENALTY - 1), s(1, 0))` first, which is a copy of the
   * implementation wearing a test's clothes: it passes for every value of NODE_PENALTY including
   * 1, so it said nothing about the one thing it was there to pin.
   */
  it('trades two extra crossings to clear one obstructed node', () => {
    expect(isBetter(s(0, 2), s(1, 0))).toBe(true);
    // ...and the constant really is what makes that true, rather than some other term.
    expect(NODE_PENALTY).toBeGreaterThan(2);
  });

  it('does not trade an unlimited number of crossings for it', () => {
    // A penalty large enough to dominate would clear one node by tangling everything else.
    expect(isBetter(s(0, 99), s(1, 0))).toBe(false);
  });

  it('prefers fewer crossings when nothing is obstructed', () => {
    expect(isBetter(s(0, 1), s(0, 4))).toBe(true);
    expect(isBetter(s(0, 4), s(0, 1))).toBe(false);
  });

  /** Length breaks ties and NOTHING else: any weight small enough not to outvote a crossing is
   *  arbitrary, and any weight large enough to matter trades a readable graph for a shorter one. */
  it('uses length only to separate layouts the cost cannot', () => {
    expect(isBetter(s(0, 2, 100), s(0, 2, 500))).toBe(true);
    // ...and never to overturn one. A far shorter layout with an extra crossing still loses.
    expect(isBetter(s(0, 3, 1), s(0, 2, 99999))).toBe(false);
  });

  it('is strict, so an equal layout never replaces the incumbent', () => {
    // What makes the search terminate: only strict improvements are accepted.
    expect(isBetter(s(1, 1, 5), s(1, 1, 5))).toBe(false);
  });
});

describe('optimiseArrangeOrder', () => {
  it('returns the input untouched when nothing is connected', () => {
    // The property that keeps Arrange exactly what it was on a workspace with no wires.
    const input = { groups: [group('g1', 'a', 'b'), group('g2', 'c')] };
    expect(optimiseArrangeOrder(input, [])).toBe(input);
    expect(optimiseArrangeOrder(input, [edge('a', 'a')])).toBe(input);
  });

  /**
   * THE test for the obstruction half. Six terminals, three across; the wire joins the two ends
   * of the top row and is drawn straight over the one in the middle. Any swap that puts the pair
   * side by side clears it.
   */
  it('clears a wire that was drawn across the node between its ends', () => {
    const input = { groups: [group('g', 'a', 'b', 'c', 'd', 'e', 'f')] };
    const edges = [edge('a', 'c')];
    const before = scoreOf(input, edges);
    expect(before.hits).toBeGreaterThan(0);             // found a layout worth improving
    expect(scoreOf(optimiseArrangeOrder(input, edges), edges).hits).toBe(0);
  });

  /**
   * The candidate filter must accept a swap with only ONE wired side.
   *
   * This shipped as "both ends must be wired", which is the tempting filter and is wrong in
   * exactly the case above: `a` and `c` are the only wired nodes, so the only swap it allowed was
   * `a`↔`c` — which reverses the pair and leaves `b` between them. The move that fixes it trades
   * a wired terminal with an UNWIRED one. Written separately from the test above because that one
   * would also pass if the search got there some other way, and this is the rule.
   */
  it('will trade a connected terminal with an unconnected one', () => {
    const input = { groups: [group('g', 'a', 'b', 'c', 'd', 'e', 'f')] };
    const edges = [edge('a', 'c')];
    const out = optimiseArrangeOrder(input, edges);
    // `b` — which has no wire at all — must have moved out from between them.
    expect(out.groups[0].nodeIds.indexOf('b')).not.toBe(1);
  });

  /** And the crossing half. Two wires on the diagonals of a 2x2 cross in the middle; reordering
   *  turns them into two parallel verticals. */
  it('uncrosses two wires that crossed', () => {
    const input = { groups: [group('g', 'a', 'b', 'c', 'd')] };
    const edges = [edge('a', 'd'), edge('b', 'c')];
    const before = scoreOf(input, edges);
    expect(before.crossings).toBeGreaterThan(0);
    expect(scoreOf(optimiseArrangeOrder(input, edges), edges).crossings).toBe(0);
  });

  /**
   * Groups move too, and that is the bigger lever — a group carries all its terminals.
   *
   * Six single-terminal groups grid three across, so a wire between the first and third is drawn
   * over the second. Swapping two group CELLS is the only move that can fix it; no amount of
   * reordering inside a one-terminal group does anything.
   */
  it('brings connected groups together', () => {
    const input = {
      groups: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'].map((id, i) => group(id, `n${i}`)),
    };
    const edges = [edge('n0', 'n2')];
    const before = scoreOf(input, edges);
    expect(before.hits).toBeGreaterThan(0);
    expect(scoreOf(optimiseArrangeOrder(input, edges), edges).hits).toBe(0);
  });

  /**
   * The guarantee that makes this safe to ship: every accepted move is a strict improvement, so
   * the answer can never be worse than the order it started from. A heuristic that could make
   * things worse would be one the user has to undo — and Arrange has no undo.
   */
  it('is never worse than doing nothing, on any of these workspaces', () => {
    const cases: Array<[string, ArrangeInput, ArrangeEdge[]]> = [
      ['a row', { groups: [group('g', 'a', 'b', 'c', 'd')] }, [edge('a', 'd'), edge('b', 'c')]],
      ['a hub', { groups: [group('g', 'h', 'x', 'y', 'z', 'w')] },
        [edge('h', 'x'), edge('h', 'y'), edge('h', 'z'), edge('h', 'w')]],
      ['two groups', { groups: [group('g1', 'a', 'b', 'c'), group('g2', 'd', 'e', 'f')] },
        [edge('a', 'f'), edge('c', 'd'), edge('b', 'e')]],
      ['a chain across four groups',
        { groups: [group('g1', 'a'), group('g2', 'b'), group('g3', 'c'), group('g4', 'd')] },
        [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')]],
      ['one wire, one group', { groups: [group('g', 'a', 'b')] }, [edge('a', 'b')]],
      ['a wire to nothing', { groups: [group('g', 'a', 'b')] }, [edge('a', 'ghost')]],
    ];
    for (const [name, input, edges] of cases) {
      const before = scoreOf(input, edges);
      const after = scoreOf(optimiseArrangeOrder(input, edges), edges);
      expect({ name, worse: isBetter(before, after) }).toEqual({ name, worse: false });
    }
  });

  it('keeps every terminal and every group', () => {
    // A permutation, not a filter. Losing one would delete a node from the canvas.
    const input = { groups: [group('g1', 'a', 'b', 'c'), group('g2', 'd', 'e')] };
    const out = optimiseArrangeOrder(input, [edge('a', 'e'), edge('c', 'd')]);
    expect(out.groups.map((g) => g.id).sort()).toEqual(['g1', 'g2']);
    expect(out.groups.flatMap((g) => g.nodeIds).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    // ...and no terminal changed GROUP. Arrange re-orders; re-homing is a drag gesture.
    const g1 = out.groups.find((g) => g.id === 'g1')!;
    expect([...g1.nodeIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input it was given', () => {
    // `arrangeTarget` builds this from `model.groups`, whose `nodeIds` arrays are memoised
    // store-derived state — mutating them would corrupt the model itself.
    const input = { groups: [group('g1', 'a', 'b', 'c', 'd')] };
    const snapshot = JSON.stringify(input);
    optimiseArrangeOrder(input, [edge('a', 'd'), edge('b', 'c')]);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('is deterministic — the same workspace always arranges the same way', () => {
    // Arrange exists to build spatial memory (design 010 D10). One that answered differently on
    // the second press would destroy the thing it is for.
    const input = { groups: [group('g1', 'a', 'b', 'c'), group('g2', 'd', 'e', 'f')] };
    const edges = [edge('a', 'f'), edge('c', 'd')];
    const first = JSON.stringify(optimiseArrangeOrder(input, edges));
    for (let i = 0; i < 3; i++) {
      expect(JSON.stringify(optimiseArrangeOrder(input, edges))).toBe(first);
    }
  });

  it('does not depend on the order the edges arrive in', () => {
    // `canvas.edges` is a backend mirror; its order is not something the user chose.
    const input = { groups: [group('g', 'a', 'b', 'c', 'd')] };
    const edges = [edge('a', 'd'), edge('b', 'c')];
    expect(JSON.stringify(optimiseArrangeOrder(input, [...edges].reverse())))
      .toBe(JSON.stringify(optimiseArrangeOrder(input, edges)));
  });

  /**
   * Bounded, and provably so — Arrange runs on a click and then animates for 260ms.
   *
   * The pathological case is a fully-connected workspace, where every candidate swap changes
   * the score and the search never runs out of improvements before it runs out of budget.
   */
  it('terminates on a dense workspace', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const edges: ArrangeEdge[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) edges.push(edge(ids[i], ids[j]));
    }
    const input = { groups: [group('g', ...ids)] };
    const t0 = Date.now();
    const out = optimiseArrangeOrder(input, edges);
    // The budget caps evaluations, not wall time; this only asserts the cap is doing its job.
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(out.groups[0].nodeIds).toHaveLength(ids.length);
    expect(isBetter(scoreOf(input, edges), scoreOf(out, edges))).toBe(false);
  });

  it('has a budget that allows more than a single move', () => {
    // A cap of 0 or 1 would make every test above pass by never trying anything.
    expect(MAX_EVALS).toBeGreaterThan(10);
  });
});

/**
 * The handoff into Arrange itself — the half every test above is blind to.
 *
 * `optimiseArrangeOrder` can be perfect and the button still lay out the old grid, if the edges
 * never reach it. That is not hypothetical: two mutants dropping `edges` on the way through
 * `arrangeTarget` and `useArrange` survived a full pass with the whole suite above already
 * written, because nothing asserted the connection.
 */
describe('arrangeTarget uses the connections', () => {
  const model = {
    groups: [{
      tabId: 'g', title: 'g',
      rect: { x: 0, y: 0, w: 0, h: 0 },
      nodeIds: ['a', 'b', 'c', 'd', 'e', 'f'],
      anyRunning: false,
    }],
    nodes: [],
  } as unknown as Parameters<typeof arrangeTarget>[0];

  const edges = [edge('a', 'c')];

  it('lays out a connected workspace differently from an unconnected one', () => {
    const blind = arrangeTarget(model);
    const aware = arrangeTarget(model, edges);
    expect(JSON.stringify(aware)).not.toBe(JSON.stringify(blind));
  });

  it('and the difference is an improvement, not just a difference', () => {
    const blind = scoreArrange(arrangedRects(arrangeTarget(model)), edges);
    const aware = scoreArrange(arrangedRects(arrangeTarget(model, edges)), edges);
    expect(blind.hits).toBeGreaterThan(0);
    expect(aware.hits).toBe(0);
  });

  it('is unchanged when there is nothing to optimise', () => {
    // The default is "no edges", so every existing caller keeps the layout it had.
    expect(arrangeTarget(model, [])).toEqual(arrangeTarget(model));
  });
});
