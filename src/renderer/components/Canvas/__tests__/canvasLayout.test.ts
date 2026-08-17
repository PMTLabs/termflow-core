import fs from 'fs';
import path from 'path';
import { NODE_W, NODE_H, Rect } from '../canvasGeometry';
import {
  fitGroupFrame, groupAt, arrange, seedNodePosition,
  PAD, PAD_TOP, GAP, GROUP_GAP, GroupBox,
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
