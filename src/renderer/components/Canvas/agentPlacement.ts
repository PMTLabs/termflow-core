import { NODE_W, NODE_H, Rect } from './canvasGeometry';
import { GAP_X, GAP_Y } from './canvasLayout';

/**
 * The lattice a spawned terminal is placed on — the SAME pitch `arrange` grids a group at.
 *
 * This used to be a circle: candidates at `NODE_W + 40` centre-to-centre, fanned across
 * `[0, ±28, ±55, ±80]°`, with each exhausted ring stepping out by another `NODE_H + 24`. It was
 * tightened once already (`plan/024` Req 1, from `NODE_W + 90`) and Tam reported it still reads
 * as far away, which is a property of the SHAPE rather than of the radius:
 *
 *  - A circle is only as tight as its widest chord. At 0° the gap was a comfortable 40px, but a
 *    node at ±28° on that same circle OVERLAPS the caller (dx 336 against a 340-wide node), so
 *    those angles were always rejected and the second spawn was pushed out to ±55° — 218px
 *    across and 311px up, for a relationship that wanted to read side by side.
 *  - Rings compounded it. Once the seven angles were used the radius grew by 234, so the eighth
 *    spawn landed 614px out with the space between the rings unusable by anything.
 *
 * A lattice has no widest chord: every cell is exactly one node plus one gutter from its
 * neighbours in both axes, so the *tightest* placement is also the *general* one. And because the
 * pitch is `arrange`'s own pitch, a fan and a pressed Arrange button now agree about how far
 * apart two terminals belong — the same reason `groupBoxFor` is shared between `arrange` and the
 * seeding in `canvasSelectors`.
 *
 * **The vertical pitch keeps the `GAP_Y` floor, and that is not incidental.** `headScale` grows
 * a node's title bar as you zoom out, so a node draws up to `HEAD_GROWTH_PX` taller than its
 * rect; a fan is very nearly a vertical stack, so it is exactly the layout that would close that
 * clearance. Deriving the pitch from `GAP_Y` rather than restating a number means it cannot
 * drift below the floor `canvasLayout` already proves.
 */
const PITCH_X = NODE_W + GAP_X;
const PITCH_Y = NODE_H + GAP_Y;

/**
 * Row offsets, in lattice steps, in the order they are tried — out from the caller's own row,
 * alternating sides so a run of spawns balances instead of drifting one way.
 */
const ROWS = [0, -1, 1, -2, 2, -3, 3];
/** How many columns to the caller's right the search may reach before it gives up. */
const COLS = 4;

const hits = (p: { x: number; y: number }, r: Rect) =>
  !(p.x + NODE_W <= r.x || r.x + r.w <= p.x || p.y + NODE_H <= r.y || r.y + r.h <= p.y);

/**
 * Place a terminal an agent just spawned, on the lattice immediately to the right of its
 * caller — `plan/013` Task 20.
 *
 * An agent that opens three terminals should get a readable fan rather than a pile, and the
 * result must be deterministic: this runs on an event, and a placement that moved on replay
 * would make the canvas reshuffle itself for reasons the user cannot see.
 *
 * `index` rotates the starting ROW so consecutive spawns from the same caller spread out even
 * when nothing is in the way; `taken` is what makes the no-overlap guarantee hard.
 *
 * Columns are searched before rows are exhausted only in the sense that the whole column is
 * tried first — the fan grows DOWN the column beside the caller and only steps right when that
 * column is full, which is what keeps a spawned terminal beside the one that spawned it.
 */
export function fanPlacement(
  caller: Rect,
  taken: Rect[],
  index: number,
): { x: number; y: number } {
  for (let col = 1; col <= COLS; col++) {
    for (let a = 0; a < ROWS.length; a++) {
      const row = ROWS[(index + a) % ROWS.length];
      const p = {
        x: Math.round(caller.x + col * PITCH_X),
        y: Math.round(caller.y + row * PITCH_Y),
      };
      if (!taken.some((t) => hits(p, t))) return p;
    }
  }

  // Every lattice cell is occupied. `plan/013`'s fallback was
  // `{ x: caller.x + RADIUS, y: caller.y + index * (NODE_H + GAP) }`, which is the one path
  // here that never consults `taken` — so the "never overlaps" property it is supposed to
  // uphold silently stops holding at exactly the moment the canvas is crowded enough to need
  // it, and two spawns with the same index land on top of each other.
  //
  // Below the lowest edge of everything already placed cannot overlap any of it, whatever the
  // x works out to. Still deterministic, and still to the caller's right.
  const bottom = taken.reduce((low, t) => Math.max(low, t.y + t.h), caller.y + caller.h);
  return { x: Math.round(caller.x + PITCH_X), y: Math.round(bottom + GAP_Y) };
}
