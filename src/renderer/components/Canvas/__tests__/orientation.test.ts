import {
  nearestGroupToCentre, minimapTransform, minimapPoint, minimapToWorld, minimapRect,
  minimapPanStep, minimapToScreen, MINIMAP_PAN_STEP, stepNodeId,
  beaconFor, beaconLayout, BEACON_INSET, BEACON_SIZE,
} from '../orientation';
import { MINIMAP_W, MINIMAP_H } from '../CanvasMinimap';
import { PAN_STEP_PX } from '../canvasGestures';
import { GROUP_CHIP_ZOOM } from '../canvasSelectors';
import {
  Viewport, Rect, NODE_W, NODE_H, CULL_MARGIN, isVisible, panBy, screenToWorld,
  aimedNodeRect, headSlack,
} from '../canvasGeometry';
import type { CanvasGroupModel, CanvasNodeModel } from '../canvasSelectors';

const group = (tabId: string, x: number, y: number): CanvasGroupModel =>
  ({ tabId, title: tabId, rect: { x, y, w: 400, h: 300 }, nodeIds: [], anyRunning: false });

const node = (
  terminalId: string, x: number, y: number, isRunning = true,
): CanvasNodeModel => ({
  terminalId,
  tabId: 'tb-1',
  paneId: 'pn-1',
  title: terminalId,
  shellType: 'pwsh',
  rect: { x, y, w: NODE_W, h: NODE_H },
  isRunning,
  hasUnseenOutput: false,
});

describe('nearestGroupToCentre', () => {
  const groups = [group('tb-a', 0, 0), group('tb-b', 2000, 0)];

  it('picks the group nearest the viewport centre', () => {
    const vp: Viewport = { x: -200, y: -150, z: 1 };
    expect(nearestGroupToCentre(groups, vp, 800, 600)).toBe('tb-a');
  });

  /**
   * This is also the WORLD-SPACE test, and it is the only one of the three that is.
   *
   * The centre has to be `screenToWorld(vp, vw/2, vh/2)`, not `(vw/2, vh/2)` — the viewport
   * offset is the entire difference between "which group am I looking at" and "which group is
   * nearest the world origin". Panning is the only thing that separates them, so a case where
   * the viewport has actually been panned is the only case that can fail: here the raw screen
   * centre (400, 300) is still nearest `tb-a`, while the real world centre (2600, 450) is
   * nearest `tb-b`.
   */
  it('follows the viewport as it pans to another group', () => {
    const vp: Viewport = { x: -2200, y: -150, z: 1 };
    expect(nearestGroupToCentre(groups, vp, 800, 600)).toBe('tb-b');
  });

  it('returns null when there are no groups', () => {
    expect(nearestGroupToCentre([], { x: 0, y: 0, z: 1 }, 800, 600)).toBeNull();
  });
});

describe('minimapTransform', () => {
  it('fits the bounds inside the minimap', () => {
    const t = minimapTransform({ x: 0, y: 0, w: 1000, h: 1000 }, 100, 100);
    expect(t.k).toBeGreaterThan(0);
    expect(1000 * t.k).toBeLessThanOrEqual(100);
  });

  it('centres the content', () => {
    const { k, ox, oy } = minimapTransform({ x: 0, y: 0, w: 1000, h: 500 }, 100, 100);
    expect(ox).toBeCloseTo((100 - 1000 * k) / 2, 6);
    expect(oy).toBeCloseTo((100 - 500 * k) / 2, 6);
  });

  it('never magnifies — a workspace smaller than the minimap is drawn at scale', () => {
    // Without the ceiling a degenerate or tiny bounds gets an enormous `k`, and the viewport
    // rectangle drawn through it covers the whole minimap while the content is a speck.
    expect(minimapTransform({ x: 0, y: 0, w: 10, h: 10 }, 168, 112).k).toBe(1);
  });

  it('does not divide by zero on empty bounds', () => {
    expect(Number.isFinite(minimapTransform({ x: 0, y: 0, w: 0, h: 0 }, 100, 100).k)).toBe(true);
  });
});

describe('minimapPoint / minimapToWorld', () => {
  /**
   * The trap `ox`/`oy` set, and the reason the transform carries its own `bounds`.
   *
   * `ox` is a CENTRING offset for a box of size `w x h` sitting at 0,0 — it does not contain
   * the world origin. A caller that maps `wx * k + ox` is correct for exactly one workspace:
   * the one that happens to start at 0,0, which is every workspace a test builds by hand and
   * almost no real one. `minimapPoint` owns the subtraction so it cannot be skipped.
   */
  const bounds: Rect = { x: 1000, y: 500, w: 400, h: 200 };
  const t = minimapTransform(bounds, 100, 100);

  it('maps a bounds rect far from the world origin into the minimap box', () => {
    const tl = minimapPoint(t, bounds.x, bounds.y);
    const br = minimapPoint(t, bounds.x + bounds.w, bounds.y + bounds.h);
    for (const p of [tl, br]) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(100);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(100);
    }
    // And it is the CENTRING offset that positions it, so the two agree.
    expect(tl.x).toBeCloseTo(t.ox, 6);
    expect(tl.y).toBeCloseTo(t.oy, 6);
  });

  it('round-trips through world space', () => {
    // The invariant the click-to-fly path depends on: a click at minimap (mx, my) has to name
    // the world point drawn there, or the minimap flies somewhere other than where you clicked.
    const p = minimapPoint(t, 1234, 567);
    const w = minimapToWorld(t, p.x, p.y);
    expect(w.x).toBeCloseTo(1234, 6);
    expect(w.y).toBeCloseTo(567, 6);
  });

  it('scales a rect by the same k it positions it with', () => {
    const r = minimapRect(t, { x: 1000, y: 500, w: 400, h: 200 });
    expect(r.w).toBeCloseTo(400 * t.k, 6);
    expect(r.h).toBeCloseTo(200 * t.k, 6);
    expect(r.x).toBeCloseTo(t.ox, 6);
  });
});

/**
 * Dragging the view rectangle — Tam, 2026-08-17: *"the blue rectangle is not draggable"*.
 *
 * The promise a drag makes is the strictest one on this surface: the rectangle stays under the
 * cursor. So the assertion is that a pointer moving N minimap pixels moves the DRAWN rectangle
 * by the same N — measured through `minimapPoint`, the projection the component renders with,
 * not against the formula. Recomputing `(d / k) * z` would agree with any sign and with a
 * factor that had drifted away from the drawing.
 */
describe('minimapToScreen', () => {
  const VW = 1200;
  const VH = 800;
  const workspace = (w: number, h: number): Rect => ({ x: 0, y: 0, w, h });
  /** Where the viewport's top-left corner lands on the minimap — the rectangle's own origin. */
  const rectOnMinimap = (t: ReturnType<typeof minimapTransform>, vp: Viewport) => {
    const w = screenToWorld(vp, 0, 0);
    return minimapPoint(t, w.x, w.y);
  };

  it('moves the rectangle exactly as far as the pointer did', () => {
    const t = minimapTransform(workspace(6000, 4000), MINIMAP_W, MINIMAP_H);
    const vp: Viewport = { x: -300, y: 120, z: 0.4 };
    for (const [dmx, dmy] of [[12, 0], [0, -9], [-7, 5], [30, 30]]) {
      const before = rectOnMinimap(t, vp);
      const after = rectOnMinimap(t, panBy(vp, minimapToScreen(t, vp.z, dmx), minimapToScreen(t, vp.z, dmy)));
      expect({
        dx: Number((after.x - before.x).toFixed(6)),
        dy: Number((after.y - before.y).toFixed(6)),
      }).toEqual({ dx: dmx, dy: dmy });
    }
  });

  it('holds at every zoom, and at every workspace size', () => {
    // The conversion is the only thing between a drag that tracks the cursor and one that
    // slowly slides away from it, and both inputs change under a real drag.
    for (const z of [0.06, 0.5, 1, 3.2]) {
      for (const w of [3000, 12000]) {
        const t = minimapTransform(workspace(w, w * 0.66), MINIMAP_W, MINIMAP_H);
        const vp: Viewport = { x: 40, y: -60, z };
        const before = rectOnMinimap(t, vp);
        const after = rectOnMinimap(t, panBy(vp, minimapToScreen(t, z, 14), 0));
        expect({ z, w, moved: Number((after.x - before.x).toFixed(6)) }).toEqual({ z, w, moved: 14 });
      }
    }
  });

  it('is what one arrow press is measured in', () => {
    // Not a tautology restated: it pins that the two gestures share ONE converter, so a drag
    // and an arrow key cannot end up disagreeing about which way the view moves.
    const t = minimapTransform(workspace(6000, 4000), MINIMAP_W, MINIMAP_H);
    for (const z of [0.2, 1, 2.5]) {
      expect(minimapPanStep(t, z)).toBe(minimapToScreen(t, z, MINIMAP_PAN_STEP));
    }
  });
});

/**
 * The minimap's arrow keys move at the WORKSPACE's scale, not the screen's — Tam's item 3.
 *
 * Asserted through the projection rather than against the formula: what the feature promises is
 * "one press slides the view by `MINIMAP_PAN_STEP` minimap pixels", and a test that recomputed
 * `(STEP / k) * z` would pass against any sign, any inversion, and any drift between this and
 * the transform the minimap actually draws with.
 */
describe('minimapPanStep', () => {
  const VW = 1200;
  const VH = 800;

  /** Where the viewport's CENTRE lands on the minimap — the thing a press is supposed to move. */
  const centreOnMinimap = (t: ReturnType<typeof minimapTransform>, vp: Viewport) => {
    const w = screenToWorld(vp, VW / 2, VH / 2);
    return minimapPoint(t, w.x, w.y);
  };

  const workspace = (w: number, h: number): Rect => ({ x: 0, y: 0, w, h });

  it('slides the view by exactly one step of the minimap', () => {
    const t = minimapTransform(workspace(6000, 4000), MINIMAP_W, MINIMAP_H);
    const vp: Viewport = { x: -300, y: 120, z: 0.4 };
    const step = minimapPanStep(t, vp.z);

    const before = centreOnMinimap(t, vp);
    const after = centreOnMinimap(t, panBy(vp, step, 0));
    expect(after.x - before.x).toBeCloseTo(MINIMAP_PAN_STEP, 6);
    expect(after.y - before.y).toBeCloseTo(0, 6);
  });

  it('is the same distance on the minimap at every zoom', () => {
    // The property that makes this a workspace-relative scale: however far you are zoomed in,
    // a press covers the same fraction of the whole map.
    const t = minimapTransform(workspace(6000, 4000), MINIMAP_W, MINIMAP_H);
    for (const z of [0.06, 0.2, 0.8, 2.4]) {
      const vp: Viewport = { x: 0, y: 0, z };
      const before = centreOnMinimap(t, vp);
      const after = centreOnMinimap(t, panBy(vp, minimapPanStep(t, z), 0));
      expect({ z, moved: Number((after.x - before.x).toFixed(6)) })
        .toEqual({ z, moved: MINIMAP_PAN_STEP });
    }
  });

  /**
   * The point of having two scales at all. If this ever failed, the minimap's arrows would be a
   * second, slightly different copy of the canvas's rather than the coarse navigation they are
   * meant to be — and nothing else in the suite would notice, because both would still pan.
   */
  it('covers more ground than a canvas arrow press, at every zoom a node is readable at', () => {
    const t = minimapTransform(workspace(6000, 4000), MINIMAP_W, MINIMAP_H);
    for (const z of [GROUP_CHIP_ZOOM, 0.5, 1, 2, 3]) {
      expect({ z, coarser: minimapPanStep(t, z) > PAN_STEP_PX }).toEqual({ z, coarser: true });
    }
  });

  /**
   * ...and the limit of that, stated rather than left to be discovered.
   *
   * The two strides ARE equal somewhere: the canvas's is constant in screen pixels, so in world
   * units it grows without bound as you zoom out, while the minimap's is constant in world
   * units. Below the crossing the canvas press is the coarser one — which is harmless, because
   * the crossing sits below `GROUP_CHIP_ZOOM`, the zoom clicking a collapsed group flies you to.
   * Everywhere you actually work, the minimap leads.
   */
  it('crosses over below the zoom a collapsed group flies you to', () => {
    const t = minimapTransform(workspace(6000, 4000), MINIMAP_W, MINIMAP_H);
    const crossover = (PAN_STEP_PX * t.k) / MINIMAP_PAN_STEP;
    // Found the crossing it is placing — a value on the wrong side of both would pass a
    // `toBeLessThan` on its own.
    expect(minimapPanStep(t, crossover * 0.9)).toBeLessThan(PAN_STEP_PX);
    expect(minimapPanStep(t, crossover * 1.1)).toBeGreaterThan(PAN_STEP_PX);
    expect(crossover).toBeLessThan(GROUP_CHIP_ZOOM);
  });

  it('strides further as the workspace grows', () => {
    // World units, so the zoom is held constant and only the map changes.
    const small = minimapPanStep(minimapTransform(workspace(3000, 2000), MINIMAP_W, MINIMAP_H), 1);
    const large = minimapPanStep(minimapTransform(workspace(12000, 8000), MINIMAP_W, MINIMAP_H), 1);
    expect(large).toBeGreaterThan(small);
  });

  /** A workspace smaller than the box gets `k` capped at 1 (a minimap never magnifies), and the
   *  step must stay finite and forward there too — that is the degenerate case a fresh session
   *  with one group actually starts in. */
  it('survives a workspace smaller than the minimap', () => {
    const step = minimapPanStep(minimapTransform(workspace(40, 30), MINIMAP_W, MINIMAP_H), 1);
    expect(Number.isFinite(step)).toBe(true);
    expect(step).toBeGreaterThan(0);
  });
});

/** Tab / Shift+Tab walk the terminals — Tam's sixth round. */
describe('stepNodeId', () => {
  const ids = ['a', 'b', 'c'];

  it('goes to the next and the previous', () => {
    expect(stepNodeId(ids, 'a', 1)).toBe('b');
    expect(stepNodeId(ids, 'b', -1)).toBe('a');
  });

  /** A list you can fall off the end of makes the last press do nothing and look broken. */
  it('wraps in both directions', () => {
    expect(stepNodeId(ids, 'c', 1)).toBe('a');
    expect(stepNodeId(ids, 'a', -1)).toBe('c');
  });

  /** Entering from the end you are heading TOWARDS: the first Shift+Tab picks the last
   *  terminal, rather than jumping to the first and then going backwards from there. */
  it('enters at the near end when nothing is selected', () => {
    expect(stepNodeId(ids, null, 1)).toBe('a');
    expect(stepNodeId(ids, null, -1)).toBe('c');
  });

  /** A selection whose terminal has been closed since. `indexOf` gives -1, which must enter the
   *  list rather than throwing the press away — otherwise Tab is dead until you click something,
   *  and closing a node is exactly when you reach for the keyboard. */
  it('enters the list when the selection has gone', () => {
    expect(stepNodeId(ids, 'deleted', 1)).toBe('a');
    expect(stepNodeId(ids, 'deleted', -1)).toBe('c');
  });

  it('has nowhere to go on an empty workspace', () => {
    expect(stepNodeId([], null, 1)).toBeNull();
    expect(stepNodeId([], 'a', -1)).toBeNull();
  });

  it('stays put with a single terminal', () => {
    expect(stepNodeId(['only'], 'only', 1)).toBe('only');
    expect(stepNodeId(['only'], 'only', -1)).toBe('only');
  });

  /** Forward then back returns you to where you started, from every position — including
   *  across the wrap, which is where an off-by-one hides. */
  it('round-trips from every position', () => {
    for (const id of ids) {
      expect({ id, back: stepNodeId(ids, stepNodeId(ids, id, 1), -1) }).toEqual({ id, back: id });
      expect({ id, fwd: stepNodeId(ids, stepNodeId(ids, id, -1), 1) }).toEqual({ id, fwd: id });
    }
  });

  it('visits every terminal exactly once per lap', () => {
    // Tab N times on an N-terminal workspace and you must have seen all of them and be home.
    const seen: string[] = [];
    let at: string | null = ids[0];
    for (let i = 0; i < ids.length; i++) {
      seen.push(at!);
      at = stepNodeId(ids, at, 1);
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(at).toBe(ids[0]);
  });
});

describe('beaconFor', () => {
  const vp: Viewport = { x: 0, y: 0, z: 1 };
  const at = (x: number, y: number): Rect => ({ x, y, w: NODE_W, h: NODE_H });

  it('returns null for a node already on screen', () => {
    expect(beaconFor(vp, at(100, 100), 800, 600)).toBeNull();
  });

  /**
   * The whole point of the rewrite: "is this on screen?" has ONE answer on this canvas.
   *
   * `visibleNodeIds`' doc names Tasks 10, 18 and 23 as the three consumers that have to agree,
   * and `isVisible`'s `CULL_MARGIN` is where that agreement lives. A centre-point test — which
   * is what the plan's original sample used — disagrees for every node whose centre has left
   * the viewport but whose body has not: the node PAINTS, and an edge beacon points at it.
   *
   * Asserted against `isVisible`'s own answer rather than a literal, so the two cannot drift
   * apart later without this failing.
   */
  it('agrees with the shared cull predicate, not with a centre-point test', () => {
    const painted = at(700, 100);   // centre at 870, past the right edge; body still inside the margin
    expect(isVisible(vp, painted, 800, 600)).toBe(true);
    expect(beaconFor(vp, painted, 800, 600)).toBeNull();

    const gone = at(700 + CULL_MARGIN + NODE_W, 100);
    expect(isVisible(vp, gone, 800, 600)).toBe(false);
    expect(beaconFor(vp, gone, 800, 600)).not.toBeNull();
  });

  it('pins an off-screen node to the viewport edge', () => {
    const b = beaconFor(vp, at(5000, 100), 800, 600)!;
    expect(b.x).toBe(800 - BEACON_INSET);
    expect(b.x).toBeGreaterThanOrEqual(0);
  });

  it('keeps the beacon inside the viewport on both axes', () => {
    const b = beaconFor(vp, at(-5000, -5000), 800, 600)!;
    expect(b.x).toBe(BEACON_INSET);
    expect(b.y).toBe(BEACON_INSET);
  });
});

describe('beacon sizing', () => {
  it('insets far enough that a pinned marker is drawn whole', () => {
    // The marker is CENTRED on the clamped point, so it overhangs by half its size. A larger
    // marker or a smaller inset draws it half outside the viewport, taking half its click
    // target with it — and nothing else in the suite looks at a beacon's pixels.
    expect(BEACON_INSET * 2).toBeGreaterThanOrEqual(BEACON_SIZE);
  });
});

describe('beaconLayout', () => {
  const vp: Viewport = { x: 0, y: 0, z: 1 };

  it('beacons only nodes that are both running and off screen', () => {
    const out = beaconLayout([
      node('tm-here', 100, 100),               // running, on screen
      node('tm-idle', 5000, 100, false),       // off screen, not running
      node('tm-gone', 5000, 400),              // off screen, running
    ], vp, 800, 600);
    expect(out.map((b) => b.terminalId)).toEqual(['tm-gone']);
  });

  it('returns nothing when the workspace is idle', () => {
    expect(beaconLayout([node('tm-1', 5000, 100, false)], vp, 800, 600)).toEqual([]);
  });

  /**
   * `isRunning` is a TAB-level fact (see `CanvasNodeModel`), so every pane of a running tab is
   * "running". Four panes side by side off the same edge clamp to nearly the same point and
   * would stack four identical markers, three of them unreachable. They collapse to one — and
   * it carries a `count`, because a beacon that silently represented four terminals would be
   * a cap pretending to be a single result.
   */
  it('collapses co-located beacons into one that reports how many it stands for', () => {
    const out = beaconLayout([
      node('tm-a', 5000, 100),
      node('tm-b', 5010, 104),
      node('tm-c', 5020, 108),
    ], vp, 800, 600);
    expect(out).toHaveLength(1);
    expect(out[0].terminalId).toBe('tm-a');
    expect(out[0].count).toBe(3);
  });

  /**
   * A beacon answers "there is a running terminal you cannot see, this way", so the question
   * it asks has to be about the box the node DRAWS, not the slot layout reserved for it.
   *
   * Above zoom 1 the header shrinks and hands height back, so the drawn box is shorter than
   * its rect by `headSlack(z)`. That leaves a band where the slot still overlaps the viewport
   * and the node itself does not — and in that band the old test said "visible", so the user
   * got no marker for a terminal that was genuinely off screen. The node is placed above the
   * viewport here so its bottom edge is what decides.
   */
  it('beacons a node whose DRAWN box has left the screen, though its slot has not', () => {
    const z = 2;
    const zoomed: Viewport = { x: 0, y: 0, z };
    const slack = headSlack(z);
    expect(slack).toBeGreaterThan(0);

    // Sit the drawn bottom exactly one pixel past the cull margin. The reserved bottom is
    // then `slack * z` pixels inside it — the whole band this test exists for.
    const y = (-CULL_MARGIN - 1) / z - (NODE_H - slack);
    const n = node('tm-above', 100, y);

    expect(isVisible(zoomed, n.rect, 800, 600)).toBe(true);                     // the slot
    expect(isVisible(zoomed, aimedNodeRect(n.rect, z), 800, 600)).toBe(false);  // the node
    expect(beaconLayout([n], zoomed, 800, 600).map((b) => b.terminalId)).toEqual(['tm-above']);
  });

  // The other side of the same rule: a node that is genuinely on screen still gets no
  // beacon, so "use the drawn box" cannot be satisfied by beaconing everything.
  it('still stays quiet for a node that is fully in view', () => {
    const zoomed: Viewport = { x: 0, y: 0, z: 2 };
    expect(beaconLayout([node('tm-here', 50, 50)], zoomed, 800, 600)).toEqual([]);
  });

  it('keeps beacons that point in genuinely different directions', () => {
    const out = beaconLayout([
      node('tm-right', 5000, 100),
      node('tm-left', -5000, 100),
    ], vp, 800, 600);
    expect(out).toHaveLength(2);
    expect(out.every((b) => b.count === 1)).toBe(true);
  });
});
