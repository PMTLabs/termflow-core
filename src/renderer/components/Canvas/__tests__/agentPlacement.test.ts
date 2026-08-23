import { fanPlacement } from '../agentPlacement';
import { NODE_W, NODE_H, Rect, paintedNodeH, Z_MIN } from '../canvasGeometry';
import { arrange, GAP_X } from '../canvasLayout';
import { planAgentPlacement } from '../agentSpawnPlacement';
import type { CanvasModel } from '../canvasSelectors';
import type { CanvasEdge } from '../../../store/slices/canvasSlice';

const at = (x: number, y: number): Rect => ({ x, y, w: NODE_W, h: NODE_H });
const caller = at(1000, 1000);

const overlaps = (a: { x: number; y: number }, b: Rect) =>
  !(a.x + NODE_W <= b.x || b.x + b.w <= a.x || a.y + NODE_H <= b.y || b.y + b.h <= a.y);

describe('fanPlacement', () => {
  it('places the first spawn to the right of its caller', () => {
    expect(fanPlacement(caller, [caller], 0).x).toBeGreaterThan(caller.x + NODE_W);
  });

  it('never overlaps the caller', () => {
    for (let i = 0; i < 6; i++) {
      expect(overlaps(fanPlacement(caller, [caller], i), caller)).toBe(false);
    }
  });

  it('never overlaps a previously placed sibling', () => {
    const taken: Rect[] = [caller];
    for (let i = 0; i < 6; i++) {
      const p = fanPlacement(caller, taken, i);
      for (const t of taken) expect(overlaps(p, t)).toBe(false);
      taken.push({ ...p, w: NODE_W, h: NODE_H });
    }
  });

  it('is deterministic for the same inputs', () => {
    expect(fanPlacement(caller, [caller], 2)).toEqual(fanPlacement(caller, [caller], 2));
  });

  it('fans vertically as the index grows, not just rightward', () => {
    const a = fanPlacement(caller, [caller], 0);
    const b = fanPlacement(caller, [caller], 3);
    expect(a.y).not.toBe(b.y);
  });

  it('keeps the guarantee once every lattice cell is taken', () => {
    // The case the plan's fallback dropped. Blanket the whole fan region so the cell
    // search cannot succeed, then check the fallback is still collision-free — it is the one
    // branch that never consults `taken`, and it fires exactly when the canvas is crowded
    // enough for that to matter.
    const taken: Rect[] = [caller];
    for (let gx = -3000; gx <= 3000; gx += NODE_W) {
      for (let gy = -3000; gy <= 3000; gy += NODE_H) {
        taken.push(at(caller.x + gx, caller.y + gy));
      }
    }
    const p = fanPlacement(caller, taken, 0);
    for (const t of taken) expect(overlaps(p, t)).toBe(false);
  });

  it('does not stack two crowded spawns on each other', () => {
    // Same blanket, two consecutive placements. The plan's fallback keyed the y offset on
    // `index` alone, so two spawns with the same index landed in the same place — and the
    // index is a count of existing edges, which is equal for two spawns issued before either
    // has been reflected back into the store.
    const taken: Rect[] = [caller];
    for (let gx = -3000; gx <= 3000; gx += NODE_W) {
      for (let gy = -3000; gy <= 3000; gy += NODE_H) {
        taken.push(at(caller.x + gx, caller.y + gy));
      }
    }
    const first = fanPlacement(caller, taken, 0);
    taken.push({ ...first, w: NODE_W, h: NODE_H });
    const second = fanPlacement(caller, taken, 0);
    expect(overlaps(second, { ...first, w: NODE_W, h: NODE_H })).toBe(false);
  });

  it('returns integers, so a node never lands on a fractional pixel', () => {
    for (let i = 0; i < 6; i++) {
      const p = fanPlacement(caller, [caller], i);
      expect(Number.isInteger(p.x)).toBe(true);
      expect(Number.isInteger(p.y)).toBe(true);
    }
  });

  it('works for a caller in negative world space', () => {
    const far = at(-4200, -900);
    const p = fanPlacement(far, [far], 0);
    expect(overlaps(p, far)).toBe(false);
    expect(p.x).toBeGreaterThan(far.x + NODE_W);
  });
});

const node = (terminalId: string, rect: Rect) => ({
  terminalId, tabId: 'tb-a', paneId: `p-${terminalId}`, title: terminalId,
  shellType: 'pwsh', rect, isRunning: false, hasUnseenOutput: false, groupTitle: 'Group', exited: false,
});
const model = (...nodes: ReturnType<typeof node>[]): CanvasModel => ({
  nodes,
  groups: [{ tabId: 'tb-a', title: 'Work', rect: at(0, 0), nodeIds: nodes.map((n) => n.terminalId), anyRunning: false }],
});
const wire = (from: string, to: string): CanvasEdge =>
  ({ id: `ce-${from}-${to}`, from, to, label: null, origin: 'agent', createdAt: 1 });

describe('planAgentPlacement', () => {
  const m = model(node('tm-caller', caller));

  it('places the new node beside its caller', () => {
    const plan = planAgentPlacement(m, [], 'tm-caller', 'tm-new')!;
    expect(plan.terminalId).toBe('tm-new');
    expect(plan.rect.x).toBeGreaterThan(caller.x + NODE_W);
    expect(plan.rect.w).toBe(NODE_W);
    expect(plan.rect.h).toBe(NODE_H);
  });

  it('falls through when no parent was named', () => {
    expect(planAgentPlacement(m, [], undefined, 'tm-new')).toBeNull();
  });

  it('falls through when the parent is not on the canvas', () => {
    // The MCP caller header carries a `pc-*` PROCESS id, which is not a key of the canvas
    // model. Placement is a nicety; the EDGE is created backend-side either way, so a miss
    // here must be an ordinary fall-through to Task 8's seeding rather than a thrown error.
    expect(planAgentPlacement(m, [], 'pc-not-a-leaf', 'tm-new')).toBeNull();
  });

  it('falls through when the parent IS the new node', () => {
    expect(planAgentPlacement(m, [], 'tm-caller', 'tm-caller')).toBeNull();
  });

  it('fans successive spawns from the same caller apart', () => {
    // The index comes from the caller's existing outgoing edges. Two spawns with the same
    // edge count must still not collide, which is what `taken` is for.
    const first = planAgentPlacement(m, [], 'tm-caller', 'tm-1')!;
    const withFirst = model(node('tm-caller', caller), node('tm-1', first.rect));
    const second = planAgentPlacement(withFirst, [wire('tm-caller', 'tm-1')], 'tm-caller', 'tm-2')!;
    expect(overlaps(second.rect, first.rect)).toBe(false);
    expect(overlaps(second.rect, caller)).toBe(false);
  });

  it('counts only the edges leaving THIS caller', () => {
    // An unrelated busy terminal elsewhere must not push this caller's first spawn out to a
    // distant row — the index is per-caller, not a global spawn counter.
    const noise = [wire('tm-other', 'tm-x'), wire('tm-other', 'tm-y'), wire('tm-z', 'tm-caller')];
    expect(planAgentPlacement(m, noise, 'tm-caller', 'tm-new'))
      .toEqual(planAgentPlacement(m, [], 'tm-caller', 'tm-new'));
  });
});

/**
 * The fan is as tight as the grid, and must still clear at every zoom.
 *
 * `fanPlacement` is the placement a user meets most often: it is what BOTH a port drag and an
 * MCP `create_terminal` produce. It has been tightened twice — `NODE_W + 90` centre-to-centre,
 * then `NODE_W + 40` (`plan/024` Req 1), and Tam reported the second still reads as far away.
 * The third time the SHAPE changed rather than the radius, because a circle is only as tight as
 * its widest chord: candidates at ±28° overlapped the caller and were always rejected, so the
 * second spawn was pushed out to ±55° and the fourth onto a ring 234 further out.
 *
 * The catch is the same one that floors `canvasLayout.GAP_Y`: a node drawn below zoom 1 is up to
 * `HEAD_GROWTH_PX` TALLER than its rect, and the fan is a near-vertical stack, so it is exactly
 * the layout that would close that clearance. Asserted through the real placements at `Z_MIN`
 * rather than against the pitch constants, which would agree with themselves whatever they held.
 */
describe('fan placements are grid-tight and clear each other at every zoom', () => {
  const grown = (r: { x: number; y: number }): Rect =>
    ({ x: r.x, y: r.y, w: NODE_W, h: paintedNodeH(NODE_H, Z_MIN, false) });

  it('sets the first spawn exactly one grid gutter from its caller', () => {
    const p = fanPlacement(caller, [caller], 0);
    // A positive gap, not merely "not overlapping" — the point of the change is that they are
    // close, and the point of the floor is that close is not touching.
    expect(p.x - (caller.x + NODE_W)).toBeGreaterThan(0);
    // ...and it is the SAME gutter two terminals in one tab get, which is the whole claim: a
    // spawned terminal is no further from its caller than Arrange would have put it. Compared
    // against what `arrange` actually produces, so the two cannot drift apart.
    const r = arrange({ groups: [{ id: 'tb-a', nodeIds: ['n1', 'n2'] }] });
    const gridGap = r.nodes['n2'].x - (r.nodes['n1'].x + NODE_W);
    expect(p.x - (caller.x + NODE_W)).toBe(gridGap);
    // And it really is on the caller's own row — the first spawn reads side by side with it.
    expect(p.y).toBe(caller.y);
  });

  it('stays beside its caller for a whole run of spawns, not one ring out', () => {
    // The failure the shape change fixes: on the circle the fourth spawn landed on ring 1, more
    // than a node-and-a-half further out than the first. Every spawn in a run must stay within
    // the column beside the caller until that column is genuinely full (7 rows).
    const taken: Rect[] = [caller];
    for (let i = 0; i < 7; i++) {
      const p = fanPlacement(caller, taken, i);
      expect({ i, x: p.x }).toEqual({ i, x: caller.x + NODE_W + GAP_X });
      taken.push({ x: p.x, y: p.y, w: NODE_W, h: NODE_H });
    }
  });

  it('never overlaps once every node is drawn at its zoomed-out height', () => {
    // Fill the fan, which is what pushes placements onto the outer rows and the next column.
    const taken: Rect[] = [caller];
    for (let i = 0; i < 12; i++) {
      const p = fanPlacement(caller, taken, i);
      taken.push({ x: p.x, y: p.y, w: NODE_W, h: NODE_H });
    }
    const drawn = taken.map(grown);
    for (let i = 0; i < drawn.length; i++) {
      for (let j = i + 1; j < drawn.length; j++) {
        const a = drawn[i], b = drawn[j];
        const hit = !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
        expect({ pair: `${i}/${j}`, hit }).toEqual({ pair: `${i}/${j}`, hit: false });
      }
    }
  });
});
