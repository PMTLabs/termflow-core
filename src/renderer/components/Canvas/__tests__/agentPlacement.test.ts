import { arcPlacement } from '../agentPlacement';
import { NODE_W, NODE_H, Rect } from '../canvasGeometry';
import { planAgentPlacement } from '../agentSpawnPlacement';
import type { CanvasModel } from '../canvasSelectors';
import type { CanvasEdge } from '../../../store/slices/canvasSlice';

const at = (x: number, y: number): Rect => ({ x, y, w: NODE_W, h: NODE_H });
const caller = at(1000, 1000);

const overlaps = (a: { x: number; y: number }, b: Rect) =>
  !(a.x + NODE_W <= b.x || b.x + b.w <= a.x || a.y + NODE_H <= b.y || b.y + b.h <= a.y);

describe('arcPlacement', () => {
  it('places the first spawn to the right of its caller', () => {
    expect(arcPlacement(caller, [caller], 0).x).toBeGreaterThan(caller.x + NODE_W);
  });

  it('never overlaps the caller', () => {
    for (let i = 0; i < 6; i++) {
      expect(overlaps(arcPlacement(caller, [caller], i), caller)).toBe(false);
    }
  });

  it('never overlaps a previously placed sibling', () => {
    const taken: Rect[] = [caller];
    for (let i = 0; i < 6; i++) {
      const p = arcPlacement(caller, taken, i);
      for (const t of taken) expect(overlaps(p, t)).toBe(false);
      taken.push({ ...p, w: NODE_W, h: NODE_H });
    }
  });

  it('is deterministic for the same inputs', () => {
    expect(arcPlacement(caller, [caller], 2)).toEqual(arcPlacement(caller, [caller], 2));
  });

  it('fans vertically as the index grows, not just rightward', () => {
    const a = arcPlacement(caller, [caller], 0);
    const b = arcPlacement(caller, [caller], 3);
    expect(a.y).not.toBe(b.y);
  });

  it('keeps the guarantee once every arc slot is taken', () => {
    // The case the plan's fallback dropped. Blanket the whole arc region so the ring/angle
    // search cannot succeed, then check the fallback is still collision-free — it is the one
    // branch that never consults `taken`, and it fires exactly when the canvas is crowded
    // enough for that to matter.
    const taken: Rect[] = [caller];
    for (let gx = -3000; gx <= 3000; gx += NODE_W) {
      for (let gy = -3000; gy <= 3000; gy += NODE_H) {
        taken.push(at(caller.x + gx, caller.y + gy));
      }
    }
    const p = arcPlacement(caller, taken, 0);
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
    const first = arcPlacement(caller, taken, 0);
    taken.push({ ...first, w: NODE_W, h: NODE_H });
    const second = arcPlacement(caller, taken, 0);
    expect(overlaps(second, { ...first, w: NODE_W, h: NODE_H })).toBe(false);
  });

  it('returns integers, so a node never lands on a fractional pixel', () => {
    for (let i = 0; i < 6; i++) {
      const p = arcPlacement(caller, [caller], i);
      expect(Number.isInteger(p.x)).toBe(true);
      expect(Number.isInteger(p.y)).toBe(true);
    }
  });

  it('works for a caller in negative world space', () => {
    const far = at(-4200, -900);
    const p = arcPlacement(far, [far], 0);
    expect(overlaps(p, far)).toBe(false);
    expect(p.x).toBeGreaterThan(far.x + NODE_W);
  });
});

const node = (terminalId: string, rect: Rect) => ({
  terminalId, tabId: 'tb-a', paneId: `p-${terminalId}`, title: terminalId,
  shellType: 'pwsh', rect, isRunning: false, hasUnseenOutput: false,
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
    // wide angle — the index is per-caller, not a global spawn counter.
    const noise = [wire('tm-other', 'tm-x'), wire('tm-other', 'tm-y'), wire('tm-z', 'tm-caller')];
    expect(planAgentPlacement(m, noise, 'tm-caller', 'tm-new'))
      .toEqual(planAgentPlacement(m, [], 'tm-caller', 'tm-new'));
  });
});
