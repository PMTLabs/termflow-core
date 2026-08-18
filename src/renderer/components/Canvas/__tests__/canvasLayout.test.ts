import fs from 'fs';
import path from 'path';
import { NODE_W, NODE_H, Rect, headSlack } from '../canvasGeometry';
import {
  fitGroupFrame, groupAt, arrange, seedNodePosition, framePadScale, drawnFrameRect,
  PAD, PAD_TOP, GAP, GROUP_GAP, PAD_SCREEN_MIN, PAD_SCREEN_MAX, MAX_PAD_OUTSET, GroupBox,
} from '../canvasLayout';
import { readSource } from '../../../utils/readSource';

const at = (x: number, y: number): Rect => ({ x, y, w: NODE_W, h: NODE_H });

describe('fitGroupFrame', () => {
  it('wraps a single node with the configured padding', () => {
    expect(fitGroupFrame([at(100, 100)])).toEqual({
      x: 100 - PAD, y: 100 - PAD_TOP, w: NODE_W + PAD * 2, h: NODE_H + PAD_TOP + PAD,
    });
  });

  it('spans the bounding box of several nodes', () => {
    const f = fitGroupFrame([at(100, 100), at(500, 400)])!;
    expect(f.x).toBe(100 - PAD);
    expect(f.y).toBe(100 - PAD_TOP);
    expect(f.w).toBe(500 + NODE_W - 100 + PAD * 2);
    expect(f.h).toBe(400 + NODE_H - 100 + PAD_TOP + PAD);
  });

  // Node order must not matter — the frame is a bounding box, not a scan.
  it('is independent of the order the nodes arrive in', () => {
    const a = fitGroupFrame([at(100, 100), at(500, 400)]);
    const b = fitGroupFrame([at(500, 400), at(100, 100)]);
    expect(a).toEqual(b);
  });

  it('returns null for an empty group so the caller keeps the last size', () => {
    expect(fitGroupFrame([])).toBeNull();
  });
});

describe('groupAt', () => {
  const groups: GroupBox[] = [
    { id: 'tb-a', x: 0, y: 0, w: 400, h: 300 },
    { id: 'tb-b', x: 500, y: 0, w: 400, h: 300 },
  ];
  it('finds the frame containing a point', () => {
    expect(groupAt(groups, 200, 150)?.id).toBe('tb-a');
    expect(groupAt(groups, 600, 150)?.id).toBe('tb-b');
  });
  it('returns null in open canvas', () => {
    expect(groupAt(groups, 450, 150)).toBeNull();
  });
  it('prefers the last frame when frames overlap', () => {
    const overlapping: GroupBox[] = [
      { id: 'tb-under', x: 0, y: 0, w: 400, h: 300 },
      { id: 'tb-over', x: 100, y: 100, w: 400, h: 300 },
    ];
    expect(groupAt(overlapping, 200, 150)?.id).toBe('tb-over');
  });
  // A drop exactly on the frame edge belongs to the frame, not to open canvas.
  it('is inclusive on every edge', () => {
    expect(groupAt(groups, 0, 0)?.id).toBe('tb-a');
    expect(groupAt(groups, 400, 300)?.id).toBe('tb-a');
    expect(groupAt(groups, 401, 300)).toBeNull();
  });
  it('returns null when there are no frames at all', () => {
    expect(groupAt([], 10, 10)).toBeNull();
  });
});

describe('arrange', () => {
  it('grids two terminals side by side inside their frame', () => {
    const r = arrange({ groups: [{ id: 'tb-a', nodeIds: ['n1', 'n2'] }] });
    const f = r.groups['tb-a'];
    expect(r.nodes['n1']).toEqual({ x: f.x + PAD, y: f.y + PAD_TOP });
    expect(r.nodes['n2']).toEqual({ x: f.x + PAD + NODE_W + GAP, y: f.y + PAD_TOP });
    expect(f.w).toBe(PAD * 2 + NODE_W * 2 + GAP);
    expect(f.h).toBe(PAD_TOP + PAD + NODE_H);
  });

  it('uses a square-ish grid rather than one long row', () => {
    const r = arrange({ groups: [{ id: 'tb-a', nodeIds: ['n1', 'n2', 'n3', 'n4', 'n5'] }] });
    // ceil(sqrt(5)) === 3 columns, 2 rows
    expect(r.groups['tb-a'].w).toBe(PAD * 2 + NODE_W * 3 + GAP * 2);
    expect(r.groups['tb-a'].h).toBe(PAD_TOP + PAD + NODE_H * 2 + GAP);
  });

  it('lays groups out on a grid with even gutters and no overlap', () => {
    const r = arrange({
      groups: [
        { id: 'tb-a', nodeIds: ['a1'] },
        { id: 'tb-b', nodeIds: ['b1'] },
        { id: 'tb-c', nodeIds: ['c1'] },
        { id: 'tb-d', nodeIds: ['d1'] },
      ],
    });
    const a = r.groups['tb-a'], b = r.groups['tb-b'], c = r.groups['tb-c'];
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.w + GROUP_GAP - 1); // same row
    expect(c.y).toBeGreaterThanOrEqual(a.y + a.h + GROUP_GAP - 1); // next row
  });

  // The row/column gutter checks above compare only three of the four frames.
  // Assert the actual property instead: no two frames may intersect.
  it('produces frames that never intersect, whatever their sizes', () => {
    const r = arrange({
      groups: [
        { id: 'tb-a', nodeIds: ['a1', 'a2', 'a3', 'a4', 'a5'] },
        { id: 'tb-b', nodeIds: ['b1'] },
        { id: 'tb-c', nodeIds: ['c1', 'c2'] },
        { id: 'tb-d', nodeIds: [] },
        { id: 'tb-e', nodeIds: ['e1', 'e2', 'e3'] },
      ],
    });
    const boxes = Object.values(r.groups);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const p = boxes[i], q = boxes[j];
        const disjoint =
          p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y;
        expect(disjoint).toBe(true);
      }
    }
  });

  it('keeps every node inside its own frame', () => {
    const r = arrange({
      groups: [
        { id: 'tb-a', nodeIds: ['a1', 'a2', 'a3'] },
        { id: 'tb-b', nodeIds: ['b1'] },
      ],
    });
    for (const g of ['tb-a', 'tb-b']) {
      const f = r.groups[g];
      const ids = g === 'tb-a' ? ['a1', 'a2', 'a3'] : ['b1'];
      for (const id of ids) {
        const n = r.nodes[id];
        expect(n.x).toBeGreaterThanOrEqual(f.x);
        expect(n.y).toBeGreaterThanOrEqual(f.y);
        expect(n.x + NODE_W).toBeLessThanOrEqual(f.x + f.w);
        expect(n.y + NODE_H).toBeLessThanOrEqual(f.y + f.h);
      }
    }
  });

  it('is deterministic', () => {
    const input = { groups: [{ id: 'tb-a', nodeIds: ['n1', 'n2', 'n3'] }] };
    expect(arrange(input)).toEqual(arrange(input));
  });

  it('handles an empty group without crashing', () => {
    const r = arrange({ groups: [{ id: 'tb-empty', nodeIds: [] }] });
    expect(r.groups['tb-empty'].w).toBeGreaterThan(0);
  });

  it('handles no groups at all without crashing', () => {
    expect(arrange({ groups: [] })).toEqual({ groups: {}, nodes: {} });
  });

  it('positions every node it was given, and nothing else', () => {
    const r = arrange({
      groups: [{ id: 'tb-a', nodeIds: ['n1', 'n2'] }, { id: 'tb-b', nodeIds: ['n3'] }],
    });
    expect(Object.keys(r.nodes).sort()).toEqual(['n1', 'n2', 'n3']);
  });
});

describe('seedNodePosition', () => {
  const frame: Rect = { x: 0, y: 0, w: 1000, h: 800 };
  it('places the first node at the frame origin plus padding', () => {
    expect(seedNodePosition(frame, [])).toEqual({ x: PAD, y: PAD_TOP });
  });
  it('does not overlap an occupied slot', () => {
    const p = seedNodePosition(frame, [at(PAD, PAD_TOP)]);
    expect(p).not.toEqual({ x: PAD, y: PAD_TOP });
  });
  it('wraps to the next row when the frame width runs out', () => {
    const narrow: Rect = { x: 0, y: 0, w: NODE_W + PAD * 2, h: 900 };
    const p = seedNodePosition(narrow, [at(PAD, PAD_TOP)]);
    expect(p.y).toBeGreaterThan(PAD_TOP);
  });
  // The frame is not always at the world origin; the slot must be relative to it.
  it('offsets from the frame origin, not the world origin', () => {
    const moved: Rect = { x: 700, y: -250, w: 1000, h: 800 };
    expect(seedNodePosition(moved, [])).toEqual({ x: 700 + PAD, y: -250 + PAD_TOP });
  });
  // Documented fallback: when no candidate slot is free the caller still gets a
  // usable position rather than undefined. Overlapping is the lesser failure.
  it('falls back to the first slot when every candidate is occupied', () => {
    const everything: Rect = { x: -10000, y: -10000, w: 20000, h: 20000 };
    expect(seedNodePosition(frame, [everything])).toEqual({ x: PAD, y: PAD_TOP });
  });
});

/**
 * The frame's top padding only has to clear the part of the label that hangs INSIDE it.
 *
 * `.canvas-glabel` straddles the top border like a fieldset legend — `position: absolute;
 * top: -11px` — so most of it is outside the frame entirely. `PAD_TOP` was 46 against a `PAD`
 * of 30 on the assumption that a whole label-height band had to be reserved, and the extra
 * 16px of empty space read as a group pushed away from its own terminals.
 *
 * The relationship spans a `.ts` file and a `.css` file, so neither can state it alone: the
 * stylesheet does not know what `PAD_TOP` is, and the layout module does not know where the
 * label sits. Restyling the label without revisiting the padding is what this catches.
 */
describe('group frame top padding clears the label, and no more', () => {
  const CSS = readSource(path.resolve(__dirname, '../Canvas.css')).replace(/\/\*[\s\S]*?\*\//g, '');

  const label = (() => {
    const m = CSS.match(/\.canvas-glabel\s*\{([^}]*)\}/);
    if (!m) throw new Error('no .canvas-glabel rule — the label moved or was renamed');
    return m[1];
  })();

  /** A pixel declaration, matched on the WHOLE property name.
   *
   *  Split rather than a built regex: a mis-escaped dynamic pattern matches nothing and the
   *  assertion around it passes while checking nothing, which has now happened three times in
   *  this suite's siblings. A split cannot fail that way — it either finds the property or
   *  returns null, and null is asserted against below. */
  const px = (prop: string) => {
    for (const decl of label.split(';')) {
      const [name, ...rest] = decl.split(':');
      if (name.trim() !== prop) continue;
      const m = rest.join(':').trim().match(/^(-?\d+(?:\.\d+)?)px/);
      return m ? Number(m[1]) : null;
    }
    return null;
  };

  it('reads the label rule it depends on', () => {
    expect(px('top')).not.toBeNull();
    expect(px('font-size')).not.toBeNull();
    // It really is hung on the border, not laid out inside the frame — the whole premise.
    expect(px('top')!).toBeLessThan(0);
  });

  it('reserves enough for the half that hangs inside', () => {
    // Line box ~1.2x the font size, centred on `top`; what intrudes is everything below y=0.
    const overhang = px('font-size')! * 1.2 + px('top')!;
    expect(PAD_TOP - PAD).toBeGreaterThanOrEqual(overhang);
  });

  it('reserves no more than that — the top is not a second, wider margin', () => {
    // The 46-vs-30 case fails here: it reserved 16px for a ~2px overhang.
    expect(PAD_TOP - PAD).toBeLessThanOrEqual(px('font-size')!);
    expect(PAD_TOP).toBeGreaterThan(PAD);
  });
});

/**
 * The frame's padding as it is DRAWN — Tam's report, with three screenshots of one group.
 *
 * At z≈0.62 the gap between the terminal and its frame read as "terminal touch the edge of the
 * group"; at z≈0.78 it "looks good"; at z≈3.56 "the padding between terminal and the group
 * border are too much". Those are the same 16 world units at three zooms, so the numbers below
 * are asserted against THOSE zooms rather than against the constants — a test that recomputed
 * `PAD * framePadScale(z) * z` from the source would agree with any value the source held,
 * including the one that produced the screenshots.
 */
describe('framePadScale', () => {
  /** The side padding actually on screen, in CSS pixels, at a given zoom. */
  const sidePx = (z: number) => PAD * framePadScale(z) * z;

  it('leaves the zoom Tam already called good exactly as it was', () => {
    // The fix must not "improve" the one rung of the ladder that was not broken.
    expect(framePadScale(1)).toBe(1);
    expect(sidePx(1)).toBe(PAD);
    expect(sidePx(0.9)).toBeCloseTo(PAD * 0.9, 6);
  });

  it('opens up the gap that read as touching', () => {
    // z≈0.62 drew 9.9px. Anything at or below what the screenshot showed is not a fix.
    expect(PAD * 0.62).toBeLessThan(PAD_SCREEN_MIN);        // the trap is genuinely present
    expect(sidePx(0.62)).toBeCloseTo(PAD_SCREEN_MIN, 6);
    expect(sidePx(0.62)).toBeGreaterThan(PAD * 0.62);
  });

  it('closes the gap that read as too much', () => {
    // z≈3.56 drew 57px.
    expect(PAD * 3.56).toBeGreaterThan(PAD_SCREEN_MAX);     // the trap is genuinely present
    expect(sidePx(3.56)).toBeCloseTo(PAD_SCREEN_MAX, 6);
    expect(sidePx(3.56)).toBeLessThan(PAD * 3.56 / 2);
  });

  it('holds the drawn padding inside the band across the whole zoom range', () => {
    // Below ~0.28 the workspace has collapsed to group chips and no frame is drawn at all, so
    // the band is only claimed from there up. The cap is allowed to undershoot the minimum —
    // see the next test for why that is the correct trade.
    for (let z = 0.28; z <= 6; z += 0.02) {
      const px = sidePx(z);
      expect({ z: z.toFixed(2), tooBig: px > PAD_SCREEN_MAX + 1e-9 })
        .toEqual({ z: z.toFixed(2), tooBig: false });
    }
  });

  /**
   * The cap, and why it is not negotiable.
   *
   * Two neighbouring frames each grow TOWARDS the other, so an uncapped clamp closes twice the
   * outset out of the `GROUP_GAP` between them — and far enough out, two groups that share no
   * terminals draw one border through the other. The whole point of a frame is to say which
   * terminals are in which tab.
   */
  it('never grows far enough for two neighbouring frames to touch', () => {
    for (let z = 0.05; z <= 6; z += 0.01) {
      const g = framePadScale(z) - 1;
      const worst = Math.max(PAD, PAD_TOP) * g;             // the top band is the larger outset
      expect({ z: z.toFixed(2), closed: worst * 2 >= GROUP_GAP })
        .toEqual({ z: z.toFixed(2), closed: false });
    }
    expect(MAX_PAD_OUTSET * 2).toBeLessThan(GROUP_GAP);
  });

  it('is a no-op for a zoom that cannot happen', () => {
    // Guards a division, not a real viewport: `clampZoom` never returns these. A NaN here would
    // reach `left`/`width` and take the whole frame off the screen.
    for (const z of [0, -1, Number.NaN]) expect(framePadScale(z)).toBe(1);
  });
});

describe('drawnFrameRect', () => {
  const layout = { x: 100, y: 200, w: 400, h: 300 };

  /**
   * The frame's four gaps, measured against what the terminals DRAW rather than the slots the
   * layout gave them.
   *
   * This is the assertion Tam's second report broke. `fitGroupFrame` wraps rects; a node draws
   * `headSlack(z)` shorter than its rect above zoom 1 — so a version of this test written
   * against the rect passes while the frame carries a dead band under its bottom row, which is
   * exactly what shipped.
   *
   * Per edge, never as a width and a height: a height that is wrong only at the bottom still
   * grows when it should grow and shrinks when it should shrink.
   */
  it('leaves the same gap on the left, right and bottom, and more only at the top', () => {
    for (const z of [0.35, 0.5, 0.7, 1, 2, 4]) {
      const box = drawnFrameRect(layout, z);
      const k = framePadScale(z);
      // What the terminals inside occupy on screen: `fitGroupFrame` put them `PAD`/`PAD_TOP`
      // inside the layout rect, and the bottom row draws `headSlack` above its own rect.
      const content = {
        left: layout.x + PAD,
        right: layout.x + layout.w - PAD,
        top: layout.y + PAD_TOP,
        bottom: layout.y + layout.h - PAD - headSlack(z),
      };
      const gap = {
        left: (content.left - box.x).toFixed(6),
        right: (box.x + box.w - content.right).toFixed(6),
        bottom: (box.y + box.h - content.bottom).toFixed(6),
        top: (content.top - box.y).toFixed(6),
      };
      expect({ z, ...gap }).toEqual({
        z,
        left: (PAD * k).toFixed(6),
        right: (PAD * k).toFixed(6),
        bottom: (PAD * k).toFixed(6),
        top: (PAD_TOP * k).toFixed(6),
      });
    }
  });

  /**
   * The bottom gap must not grow with the zoom — the whole of the second report.
   *
   * Stated as a comparison against the sides rather than as a number, because the failure was
   * never that the bottom was some particular size. It was that the bottom alone kept a term
   * the other three edges did not have.
   */
  it('never leaves more room under the last row than beside it', () => {
    for (let z = 0.3; z <= 6; z += 0.02) {
      const box = drawnFrameRect(layout, z);
      const side = (layout.x + PAD) - box.x;
      const under = (box.y + box.h) - (layout.y + layout.h - PAD - headSlack(z));
      expect({ z: z.toFixed(2), same: Math.abs(under - side) < 1e-9 })
        .toEqual({ z: z.toFixed(2), same: true });
    }
  });

  /** At zoom 1 nothing applies: the padding is already in band and a node draws exactly its
   *  rect. Both terms have to be zero for the identity return above to be correct. */
  it('is the identity exactly where both corrections vanish', () => {
    expect(headSlack(1)).toBe(0);
    expect(framePadScale(1)).toBe(1);
    expect(drawnFrameRect(layout, 1)).toBe(layout);
  });

  it('shrinks by the same rule when the zoom is high', () => {
    const box = drawnFrameRect(layout, 4);
    expect(box.x).toBeGreaterThan(layout.x);
    expect(box.y).toBeGreaterThan(layout.y);
    expect(box.w).toBeLessThan(layout.w);
    expect(box.h).toBeLessThan(layout.h);
  });

  /**
   * The top band keeps its proportion to the sides at every zoom.
   *
   * `PAD_TOP` is `PAD` plus exactly the label overhang it has to clear. Clamping the two
   * separately would let that difference drift, and the label straddling the border would end
   * up printed over the terminal below it at one end of the range or floating in space at the
   * other.
   */
  it('keeps the top band in proportion with the sides', () => {
    for (const z of [0.3, 0.5, 1, 2, 4]) {
      const box = drawnFrameRect(layout, z);
      const side = layout.x - box.x;
      const top = layout.y - box.y;
      expect({ z, ratio: ((top + PAD_TOP) / (side + PAD)).toFixed(6) })
        .toEqual({ z, ratio: (PAD_TOP / PAD).toFixed(6) });
    }
  });
});

/**
 * Layout is NOT zoom-dependent, and this is the assertion that keeps it that way.
 *
 * The clamp is a rendering rule. If it ever leaked into `fitGroupFrame` or `arrange`, three
 * things break at once: nodes would slide as you zoom, `arrange` would stop being deterministic,
 * and the fit-to-bounds path would feed its own output back into itself — bounds derived from a
 * zoom that is derived from those bounds.
 */
describe('the clamp stays out of the layout', () => {
  it('shrink-wraps on PAD alone, whatever the zoom is', () => {
    const nodes = [at(0, 0), at(NODE_W + GAP, 0)];
    expect(fitGroupFrame(nodes)).toEqual({
      x: -PAD, y: -PAD_TOP, w: NODE_W * 2 + GAP + PAD * 2, h: NODE_H + PAD_TOP + PAD,
    });
  });

  it('does not let the drawn rule reach arrange or the seed', () => {
    const src = readSource(path.join(__dirname, '..', 'canvasLayout.ts'));
    const body = (name: string) => {
      const i = src.indexOf(`export function ${name}(`);
      return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i));
    };
    for (const name of ['fitGroupFrame', 'arrange', 'seedNodePosition']) {
      expect({ name, found: body(name).length > 0 }).toEqual({ name, found: true });
      expect({ name, zoomAware: /framePadScale|drawnFrameRect/.test(body(name)) })
        .toEqual({ name, zoomAware: false });
    }
  });
});
