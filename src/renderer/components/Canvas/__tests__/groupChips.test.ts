/**
 * Keeping collapsed group chips off each other — reported 2026-08-17 with a screenshot of two
 * chips printed on top of one another.
 *
 * The cause is structural: a chip counter-scales to a constant SCREEN size, its anchor is a
 * WORLD position, and the screen distance between two groups shrinks with the zoom. Measured
 * on the real constants, two adjacent groups are 46 screen px apart at z=0.1 against a 190px
 * chip. No world-space gutter can fix that, which is why this works in screen space.
 */
import { groupChipLayout, chipOffsets, CHIP_W, CHIP_H, CHIP_GAP } from '../groupChips';
import { Rect } from '../canvasGeometry';
import { PAD, GROUP_GAP } from '../canvasLayout';
import { NODE_W } from '../canvasGeometry';

const g = (tabId: string, x: number, y: number): { tabId: string; rect: Rect } =>
  ({ tabId, rect: { x, y, w: PAD * 2 + NODE_W, h: 240 } });

/** Where each chip actually lands on screen, which is the only space the question means
 *  anything in. Mirrors what `CanvasGroupFrame` renders: world anchor + world offset, times z. */
function screenBoxes(groups: { tabId: string; rect: Rect }[], z: number) {
  const off = chipOffsets(groups, z);
  return groups.map((grp) => ({
    tabId: grp.tabId,
    x: (grp.rect.x + off[grp.tabId].dx) * z,
    y: (grp.rect.y + off[grp.tabId].dy) * z,
  }));
}

const collide = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  a.x < b.x + CHIP_W && b.x < a.x + CHIP_W && a.y < b.y + CHIP_H && b.y < a.y + CHIP_H;

/** Two frames side by side, exactly as `buildModel` seeds them. */
const ADJACENT = [
  g('tb-a', 60, 60),
  g('tb-b', 60 + PAD * 2 + NODE_W + GROUP_GAP, 60),
];

describe('the overlap this exists to stop', () => {
  /** The report, reproduced from the real seeding constants rather than from invented rects.
   *  If this ever fails to collide, the constants moved and the fix may be unnecessary. */
  it('two seeded neighbours really would collide without it', () => {
    const z = 0.1;
    const raw = ADJACENT.map((grp) => ({ x: grp.rect.x * z, y: grp.rect.y * z }));
    expect(collide(raw[0], raw[1])).toBe(true);
  });

  it('separates them', () => {
    const boxes = screenBoxes(ADJACENT, 0.1);
    expect(collide(boxes[0], boxes[1])).toBe(false);
  });

  it('separates them at every zoom the collapsed tier covers', () => {
    for (const z of [0.05, 0.06, 0.08, 0.1, 0.14, 0.18, 0.22, 0.236]) {
      const boxes = screenBoxes(ADJACENT, z);
      expect({ z, hit: collide(boxes[0], boxes[1]) }).toEqual({ z, hit: false });
    }
  });

  it('separates a crowded workspace, every pair', () => {
    // Eight groups seeded in a row — all of them converge to a few screen pixels at z=0.05.
    const many = Array.from({ length: 8 }, (_, i) =>
      g(`tb-${i}`, 60 + i * (PAD * 2 + NODE_W + GROUP_GAP), 60));
    const boxes = screenBoxes(many, 0.05);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect({ i, j, hit: collide(boxes[i], boxes[j]) }).toEqual({ i, j, hit: false });
      }
    }
  });
});

describe('how it separates them', () => {
  it('leaves groups that are already far apart exactly where they are', () => {
    // Zoomed in enough that the chips never touched: a layout that moved them anyway would be
    // shuffling the workspace for no reason, and the chip's whole job is to say where its
    // group IS.
    const far = [g('tb-a', 0, 0), g('tb-b', 20000, 20000)];
    const off = chipOffsets(far, 0.2);
    expect(off['tb-a']).toEqual({ dx: 0, dy: 0 });
    expect(off['tb-b']).toEqual({ dx: 0, dy: 0 });
  });

  /**
   * Separated on EITHER axis alone is separated.
   *
   * Every other assertion here is "they do not overlap", and an over-eager collision test
   * satisfies all of them — it just pushes chips apart that were already fine. Dropping the x
   * comparison entirely survived the whole suite until these two existed, stacking every chip
   * into one column however wide the workspace was. The case above cannot catch it: its two
   * groups are far apart on BOTH axes, so the y check alone still separates them.
   */
  it('does not stack chips that are only far apart horizontally', () => {
    const sameRow = [g('tb-a', 0, 0), g('tb-b', 40000, 0)];
    const off = chipOffsets(sameRow, 0.2);
    expect(off['tb-b']).toEqual({ dx: 0, dy: 0 });
  });

  it('does not nudge chips that are only far apart vertically', () => {
    const sameColumn = [g('tb-a', 0, 0), g('tb-b', 0, 40000)];
    const off = chipOffsets(sameColumn, 0.2);
    expect(off['tb-b']).toEqual({ dx: 0, dy: 0 });
  });

  /** Stability matters more than optimality here: the layout runs on every viewport change,
   *  so a rule that reshuffled as you panned would make the chips crawl. The first chip in
   *  reading order never moves. */
  it('never moves the first chip', () => {
    const off = chipOffsets(ADJACENT, 0.05);
    expect(off['tb-a']).toEqual({ dx: 0, dy: 0 });
  });

  it('is independent of the pan', () => {
    // Translating every group by the same amount cannot change which pairs overlap. Folding
    // the pan in would add a term that has to cancel, and an opportunity for it not to.
    const shifted = ADJACENT.map((grp) => g(grp.tabId, grp.rect.x + 5000, grp.rect.y - 3000));
    const a = groupChipLayout(ADJACENT, 0.1).map((p) => `${p.dx.toFixed(3)},${p.dy.toFixed(3)}`);
    const b = groupChipLayout(shifted, 0.1).map((p) => `${p.dx.toFixed(3)},${p.dy.toFixed(3)}`);
    expect(b).toEqual(a);
  });

  it('is deterministic — the same input twice gives the same answer', () => {
    expect(groupChipLayout(ADJACENT, 0.1)).toEqual(groupChipLayout(ADJACENT, 0.1));
  });

  it('does not depend on the order the groups arrive in', () => {
    // `model.groups` follows tab order, which changes when a tab is dragged. The chips must
    // not jump because of that.
    const a = chipOffsets(ADJACENT, 0.08);
    const b = chipOffsets([...ADJACENT].reverse(), 0.08);
    expect(b).toEqual(a);
  });

  /** The offset is returned in WORLD units because the chip stays a world-positioned element.
   *  Returning screen units would land it `1/z` times too close — invisible at z≈1 and wildly
   *  wrong at the zooms this actually runs at. */
  it('returns world units, not screen units', () => {
    const z = 0.1;
    const off = chipOffsets(ADJACENT, z);
    const moved = Object.values(off).find((o) => o.dy !== 0)!;
    // A world offset at z=0.1 is ten times the screen distance it produces.
    expect(moved.dy).toBeCloseTo((CHIP_H + CHIP_GAP) / z, 6);
  });

  it('gives every group an entry', () => {
    const off = chipOffsets(ADJACENT, 0.1);
    expect(Object.keys(off).sort()).toEqual(['tb-a', 'tb-b']);
  });

  it('copes with an empty workspace and a single group', () => {
    expect(groupChipLayout([], 0.1)).toEqual([]);
    expect(chipOffsets([g('tb-only', 0, 0)], 0.1)).toEqual({ 'tb-only': { dx: 0, dy: 0 } });
  });

  it('does not mutate the caller\'s array', () => {
    // It sorts, and `model.groups` is memoised store-derived state.
    const input = [g('tb-b', 500, 0), g('tb-a', 0, 0)];
    const before = input.map((x) => x.tabId);
    groupChipLayout(input, 0.1);
    expect(input.map((x) => x.tabId)).toEqual(before);
  });
});
