import { NODE_W, NODE_H, Rect } from './canvasGeometry';

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
/** Gutter between terminals inside a frame. */
export const GAP = 28;
/** Gutter between frames. */
export const GROUP_GAP = 90;

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
 * Distribute everything evenly: terminals gridded inside each frame, frames
 * gridded across the canvas, each frame centred in its cell so uneven frame
 * sizes still read as an even arrangement. Deterministic — same input, same output.
 */
export function arrange(input: ArrangeInput): ArrangeResult {
  const size: Record<string, { w: number; h: number }> = {};
  const offset: Record<string, { x: number; y: number }> = {};

  for (const g of input.groups) {
    const n = g.nodeIds.length;
    if (!n) { size[g.id] = { w: NODE_W + PAD * 2, h: NODE_H + PAD_TOP + PAD }; continue; }
    const c = cols(n);
    const r = Math.ceil(n / c);
    size[g.id] = {
      w: PAD * 2 + c * NODE_W + (c - 1) * GAP,
      h: PAD_TOP + PAD + r * NODE_H + (r - 1) * GAP,
    };
    g.nodeIds.forEach((id, i) => {
      offset[id] = {
        x: PAD + (i % c) * (NODE_W + GAP),
        y: PAD_TOP + Math.floor(i / c) * (NODE_H + GAP),
      };
    });
  }

  const gc = cols(input.groups.length);
  const colW: number[] = [];
  const rowH: number[] = [];
  input.groups.forEach((g, i) => {
    const c = i % gc, r = Math.floor(i / gc);
    colW[c] = Math.max(colW[c] ?? 0, size[g.id].w);
    rowH[r] = Math.max(rowH[r] ?? 0, size[g.id].h);
  });

  const xs: number[] = [];
  const ys: number[] = [];
  let acc = 60;
  for (let i = 0; i < colW.length; i++) { xs[i] = acc; acc += colW[i] + GROUP_GAP; }
  acc = 60;
  for (let i = 0; i < rowH.length; i++) { ys[i] = acc; acc += rowH[i] + GROUP_GAP; }

  const out: ArrangeResult = { groups: {}, nodes: {} };
  input.groups.forEach((g, i) => {
    const c = i % gc, r = Math.floor(i / gc);
    const gx = Math.round(xs[c] + (colW[c] - size[g.id].w) / 2);
    const gy = Math.round(ys[r] + (rowH[r] - size[g.id].h) / 2);
    out.groups[g.id] = { x: gx, y: gy, w: size[g.id].w, h: size[g.id].h };
    for (const id of g.nodeIds) {
      if (offset[id]) out.nodes[id] = { x: gx + offset[id].x, y: gy + offset[id].y };
    }
  });
  return out;
}

/** First free grid slot inside a frame — used when a terminal first appears. */
export function seedNodePosition(frame: Rect, taken: Rect[]): { x: number; y: number } {
  const perRow = Math.max(1, Math.floor((frame.w - PAD * 2 + GAP) / (NODE_W + GAP)));
  const overlaps = (x: number, y: number) =>
    taken.some((t) => !(x + NODE_W <= t.x || t.x + t.w <= x || y + NODE_H <= t.y || t.y + t.h <= y));
  for (let i = 0; i < taken.length + perRow + 1; i++) {
    const x = frame.x + PAD + (i % perRow) * (NODE_W + GAP);
    const y = frame.y + PAD_TOP + Math.floor(i / perRow) * (NODE_H + GAP);
    if (!overlaps(x, y)) return { x, y };
  }
  return { x: frame.x + PAD, y: frame.y + PAD_TOP };
}
