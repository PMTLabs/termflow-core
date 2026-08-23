import { NODE_W, NODE_H, Rect, headSlack } from './canvasGeometry';

/**
 * Padding inside a group frame.
 *
 * `PAD_TOP` used to be 46 against a `PAD` of 30, on the assumption that the frame label sits
 * INSIDE the frame and needs a band cleared for it. It does not: `.canvas-glabel` is
 * `position: absolute; top: -11px`, so it straddles the top border like a fieldset legend and
 * only its lower half hangs into the interior. The extra 16px was reserved for nothing, and it
 * read as a group that had been pushed away from its own terminals.
 *
 * So the top is now the ordinary padding plus exactly the overhang it has to clear, which also
 * means the two numbers can no longer drift apart for no reason.
 */
const LABEL_OVERHANG = 7;
export const PAD = 16;
export const PAD_TOP = PAD + LABEL_OVERHANG;

/**
 * Gutters between terminals inside a frame — one per axis, and they are NOT the same number.
 *
 * They used to be a single `GAP` of 28, which over-constrained the horizontal one to satisfy a
 * floor only the vertical one has.
 *
 * **The vertical floor is `HEAD_GROWTH_PX`, and it is a hard one.** `headScale` grows a node's
 * title bar as you zoom OUT, and `BODY_H` is pinned, so the growth comes out of the node's world
 * HEIGHT: a node drawn below zoom 1 is up to `HEAD_GROWTH_PX` taller than its `rect.h` (see
 * `paintedNodeH`). Two rows laid out `NODE_H + GAP_Y` apart therefore close to `GAP_Y -
 * HEAD_GROWTH_PX` of clearance at the bottom of the zoom range. At 28 that leaves 12px; at 16 it
 * would leave zero, and anything under 16 would OVERLAP — nodes arranged with a comfortable gap
 * at a working zoom would grow into each other as you zoomed out to look at all of them, which
 * is exactly when you would notice.
 *
 * Nothing grows a node's WIDTH, so `GAP_X` has no such floor and is free to be the tighter of
 * the two. That is most of the density win: horizontal pitch is what decides how many terminals
 * fit across the screen at a readable zoom.
 *
 * `canvasLayout.test.ts` asserts `GAP_Y > HEAD_GROWTH_PX` against the imported constant rather
 * than restating it, so tightening either one fails loudly.
 */
export const GAP_X = 16;
export const GAP_Y = 28;
/**
 * Gutter between frames — and the number that decides how dense the canvas actually reads.
 *
 * `GAP_X`/`GAP_Y` get all the attention, but they only separate terminals INSIDE one tab. Most
 * tabs hold one terminal, so most neighbouring pairs on a real canvas are separated by this
 * instead — and by two frame paddings as well, since each terminal sits `PAD` inside its own
 * frame. At 48 that was `16 + 48 + 16 = 80` world units between two terminals in different tabs
 * against 16 between two in the same one: a 5x pitch difference for a distinction the eye
 * already gets from the frame border. At 28 it is 60, which is what Tam's "I want to view more
 * content when I zoom in" is really asking for.
 *
 * **The floor is `MAX_PAD_OUTSET`, which is derived from this.** `framePadScale` grows a frame's
 * DRAWN padding as you zoom out so it never reads as touching its terminals, and two neighbours
 * grow towards each other — so shrinking this shrinks how far that clamp may reach before the
 * gutter closes. At 28 the clamp still delivers the full `PAD_SCREEN_MIN` down to z≈0.58, which
 * covers the zoom Tam measured the "terminal touches the edge of the group" complaint at (0.62).
 * Much below 28 and that complaint comes back at the bottom of the range.
 */
export const GROUP_GAP = 28;

/**
 * How wide a row of group frames may get before it wraps to the next row.
 *
 * Frames used to be laid out on a cursor that only ever moved right, always at `y: 60`, so ten
 * single-terminal tabs made a 4600px strip one frame tall — an aspect ratio no zoom shows
 * usefully, and the real reason the canvas felt sparse.
 *
 * **A width budget, deliberately, and NOT `ceil(sqrt(n))` like `arrange`.** Frame positions are
 * derived on every model build (a rect is stored only for a frame the user dragged), so a column
 * count that depends on the total would re-flow every underived frame the moment the tab count
 * crossed a boundary — 9 tabs to 10 would rearrange the whole canvas. `design/010` §6.4 forbids
 * exactly that: *"Never automatic. A canvas that rearranges itself while the user is looking away
 * destroys the spatial memory that is the entire reason for the feature."* A fixed budget is
 * monotonic in tab order: appending a tab cannot move one already placed.
 *
 * Sized as four default frames and their gutters, which is a shape that fits a normal window at
 * a zoom where the terminals are still readable. Wider frames simply take more of the row and
 * wrap sooner; the budget is a ceiling on where a row STARTS a new frame, never a clip.
 */
export const FRAME_ROW_MAX_W = 4 * (PAD * 2 + NODE_W) + 3 * GROUP_GAP;

/* ---- What the frame DRAWS, as opposed to what it reserves -----------------
 *
 * `PAD` is a WORLD distance, so the gap between a terminal and its frame is `PAD * z` pixels
 * on screen — and Tam reported, with three screenshots of the same group, that this has no
 * good value: at z≈0.62 the 10px gap read as "terminal touches the edge of the group", at
 * z≈0.78 the 12px gap "looks good", and at z≈3.6 the 57px gap was "too much padding".
 *
 * That is not a number tuned wrong. Breathing room is something the eye measures in SCREEN
 * pixels — the same instinct that already counter-scales node headers, wires, labels and
 * chips — so a padding fixed in world units is asking one constant to be right across a 70×
 * zoom range. The whole rest of the canvas chrome gave up on that long ago.
 *
 * So the frame's padding is clamped into a screen band. Inside the band nothing changes: the
 * frame is drawn exactly on its layout rect, which is the zoom Tam already called good.
 * Outside it the DRAWN box grows or shrinks around the terminals, which stay where they are.
 *
 * **Layout is untouched, deliberately.** `fitGroupFrame`, `arrange` and `seedNodePosition`
 * keep using `PAD`, so no node moves when you zoom, `arrange` stays deterministic, and the
 * fit-to-bounds path cannot feed its own output back into itself. This is a rendering rule,
 * and it lives here only because it is expressed in the constants it rescales.
 */

/** The screen band the frame's side padding is kept inside, in CSS pixels. Both ends are
 *  measured from Tam's screenshots — see the note above. */
export const PAD_SCREEN_MIN = 13;
export const PAD_SCREEN_MAX = 24;

/**
 * Ceiling on how far the drawn frame may push OUTSIDE its layout rect, in world units.
 *
 * Two neighbouring frames each grow towards the other, so an uncapped clamp would close
 * `2 × outset` of the `GROUP_GAP` between them and, deep enough out, overlap. The cap is
 * applied to the largest of the four outsets — the top band, which is `PAD_TOP`-sized — so a
 * third of the gutter always survives whatever the zoom is.
 */
export const MAX_PAD_OUTSET = GROUP_GAP / 3;

/**
 * The multiple of its layout padding a frame is DRAWN with at this zoom.
 *
 * `1` means "drawn exactly on the layout rect", which is the answer throughout the band where
 * `PAD * z` is already a comfortable screen distance.
 */
export function framePadScale(z: number): number {
  if (!(z > 0)) return 1;
  const screen = PAD * z;
  const wanted = screen < PAD_SCREEN_MIN ? PAD_SCREEN_MIN / screen
    : screen > PAD_SCREEN_MAX ? PAD_SCREEN_MAX / screen
      : 1;
  return Math.min(wanted, 1 + MAX_PAD_OUTSET / PAD_TOP);
}

/**
 * A frame's rect as it is PAINTED: the layout rect with its padding rescaled about the
 * terminals inside it, and its bottom pulled up onto the last row's DRAWN edge.
 *
 * The two paddings are rescaled by the same factor rather than clamped separately, so the top
 * band keeps the `LABEL_OVERHANG` of extra room it exists to give the label — a band clamped
 * on its own would drift out of proportion with the sides at every zoom but one.
 *
 * **`headSlack` is the second half of the bottom, and it is why the first fix was not enough.**
 * `fitGroupFrame` wraps node RECTS, and a node draws shorter than its rect above zoom 1 (see
 * `paintedNodeH`) — so the frame reserved room for height the bottom row never used, and it
 * showed up as a dead band under it. Tam, on the padding clamp alone: *"the padding between the
 * terminal and the group border is still big at the bottom."* Only the bottom, because that is
 * the only edge the slack is on.
 *
 * The chip tier is deliberately not a parameter. A frame is drawn only while its terminals are
 * at the snapshot tier or better — below that `allCollapsed` replaces every frame with a group
 * chip — so a frame can never be wrapping a node that is drawing as a chip.
 */
export function drawnFrameRect(r: Rect, z: number): Rect {
  const g = framePadScale(z) - 1;
  const slack = headSlack(z);
  if (!g && !slack) return r;
  return {
    x: r.x - PAD * g,
    y: r.y - PAD_TOP * g,
    w: r.w + PAD * 2 * g,
    h: r.h + (PAD_TOP + PAD) * g - slack,
  };
}

export interface GroupBox extends Rect { id: string }

/** Shrink-wrap a frame around its nodes. Null for an empty group — the caller
 *  keeps the frame's last size so it stays a visible drop target. */
export function fitGroupFrame(nodes: Rect[]): Rect | null {
  if (!nodes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h);
  }
  return { x: x0 - PAD, y: y0 - PAD_TOP, w: (x1 - x0) + PAD * 2, h: (y1 - y0) + PAD_TOP + PAD };
}

/** Topmost frame containing a world point. Later entries win, matching paint order. */
export function groupAt(groups: GroupBox[], wx: number, wy: number): GroupBox | null {
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (wx >= g.x && wx <= g.x + g.w && wy >= g.y && wy <= g.y + g.h) return g;
  }
  return null;
}

export interface ArrangeInput { groups: { id: string; nodeIds: string[] }[] }
export interface ArrangeResult {
  groups: Record<string, Rect>;
  nodes: Record<string, { x: number; y: number }>;
}

const cols = (n: number) => Math.max(1, Math.ceil(Math.sqrt(n)));

/**
 * The box `n` terminals occupy once gridded inside a frame, padding included.
 *
 * Shared by `arrange` and by the seeding in `canvasSelectors.buildModel`, which used to
 * disagree: seeding always handed `seedNodePosition` a ONE-COLUMN default box (`PAD * 2 +
 * NODE_W`), so `perRow` came out as 1 and a four-pane tab seeded as a 1x4 vertical column ~1000px
 * tall — while pressing Arrange on the same tab produced a 2x2. Two answers to "where do this
 * tab's terminals go", and the one you got depended on whether you had touched the button.
 *
 * One function now, so a grid seeded on first sight and a grid produced by Arrange are the same
 * grid, and the density is the same either way.
 */
export function groupBoxFor(n: number): { w: number; h: number } {
  if (n <= 0) return { w: PAD * 2 + NODE_W, h: PAD_TOP + PAD + NODE_H };
  const c = cols(n);
  const r = Math.ceil(n / c);
  return {
    w: PAD * 2 + c * NODE_W + (c - 1) * GAP_X,
    h: PAD_TOP + PAD + r * NODE_H + (r - 1) * GAP_Y,
  };
}

/**
 * Distribute everything evenly: terminals gridded inside each frame, frames laid out in rows
 * `ceil(sqrt(n))` frames wide. Deterministic — same input, same output.
 *
 * **Rows are SHELF-PACKED, not gridded into cells.** Frames used to be placed on a true grid:
 * every column was as wide as its widest frame, every row as tall as its tallest, and each frame
 * was centred in its cell "so uneven frame sizes still read as an even arrangement". The even
 * reading was real and so was its cost — a row holding one four-terminal tab gave three
 * single-terminal tabs a 728-wide cell for a 372-wide frame, and centring turned the surplus into
 * dead space on BOTH sides of each of them. On a mixed workspace that is most of the canvas.
 *
 * So a frame now starts where the previous one ended, at its own width, and rows advance by the
 * tallest frame in the row. Nothing overlaps (a row's frames are disjoint in x, and consecutive
 * rows in y), the layout is still a pure function of the input, and the ragged right edge is the
 * price of the density — which is what Tam asked Arrange for. The `ceil(sqrt(n))` frames-per-row
 * cap is kept rather than replaced with `FRAME_ROW_MAX_W`: the seeding cursor needs a fixed
 * budget because appending a tab must not move a frame already placed, but Arrange moves
 * everything by definition, and a square-ish canvas is the one that zoom-to-fit shows best.
 */
export function arrange(input: ArrangeInput): ArrangeResult {
  const size: Record<string, { w: number; h: number }> = {};
  const offset: Record<string, { x: number; y: number }> = {};

  for (const g of input.groups) {
    const n = g.nodeIds.length;
    if (!n) { size[g.id] = groupBoxFor(0); continue; }
    const c = cols(n);
    size[g.id] = groupBoxFor(n);
    g.nodeIds.forEach((id, i) => {
      offset[id] = {
        x: PAD + (i % c) * (NODE_W + GAP_X),
        y: PAD_TOP + Math.floor(i / c) * (NODE_H + GAP_Y),
      };
    });
  }

  const perRow = cols(input.groups.length);
  const out: ArrangeResult = { groups: {}, nodes: {} };
  let gx = 60;
  let gy = 60;
  let rowH = 0;

  input.groups.forEach((g, i) => {
    if (i > 0 && i % perRow === 0) {
      gx = 60;
      gy += rowH + GROUP_GAP;
      rowH = 0;
    }
    const box = size[g.id];
    out.groups[g.id] = { x: gx, y: gy, w: box.w, h: box.h };
    for (const id of g.nodeIds) {
      if (offset[id]) out.nodes[id] = { x: gx + offset[id].x, y: gy + offset[id].y };
    }
    gx += box.w + GROUP_GAP;
    rowH = Math.max(rowH, box.h);
  });

  return out;
}

/** First free grid slot inside a frame — used when a terminal first appears. */
export function seedNodePosition(frame: Rect, taken: Rect[]): { x: number; y: number } {
  const perRow = Math.max(1, Math.floor((frame.w - PAD * 2 + GAP_X) / (NODE_W + GAP_X)));
  const overlaps = (x: number, y: number) =>
    taken.some((t) => !(x + NODE_W <= t.x || t.x + t.w <= x || y + NODE_H <= t.y || t.y + t.h <= y));
  for (let i = 0; i < taken.length + perRow + 1; i++) {
    const x = frame.x + PAD + (i % perRow) * (NODE_W + GAP_X);
    const y = frame.y + PAD_TOP + Math.floor(i / perRow) * (NODE_H + GAP_Y);
    if (!overlaps(x, y)) return { x, y };
  }
  return { x: frame.x + PAD, y: frame.y + PAD_TOP };
}
