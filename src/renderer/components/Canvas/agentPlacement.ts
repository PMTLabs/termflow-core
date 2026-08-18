import { NODE_W, NODE_H, Rect } from './canvasGeometry';

/** How far from the caller's centre the first ring sits. */
const RADIUS = NODE_W + 90;
/** Vertical breathing room between rings and in the fallback column. */
const GAP = 40;
/** Fan across ±80° so a run of spawns stays readable rather than stacking. */
const ANGLES = [0, -28, 28, -55, 55, -80, 80];
const RINGS = 4;

const hits = (p: { x: number; y: number }, r: Rect) =>
  !(p.x + NODE_W <= r.x || r.x + r.w <= p.x || p.y + NODE_H <= r.y || r.y + r.h <= p.y);

/**
 * Place a terminal an agent just spawned, on an arc to the right of its caller —
 * `plan/013` Task 20.
 *
 * An agent that opens three terminals should get a readable fan rather than a pile, and the
 * result must be deterministic: this runs on an event, and a placement that moved on replay
 * would make the canvas reshuffle itself for reasons the user cannot see.
 *
 * `index` rotates the starting angle so consecutive spawns from the same caller spread out
 * even when nothing is in the way; `taken` is what makes the guarantee hard.
 */
export function arcPlacement(
  caller: Rect,
  taken: Rect[],
  index: number,
): { x: number; y: number } {
  const cx = caller.x + caller.w / 2;
  const cy = caller.y + caller.h / 2;

  for (let ring = 0; ring < RINGS; ring++) {
    const radius = RADIUS + ring * (NODE_H + GAP);
    for (let a = 0; a < ANGLES.length; a++) {
      const deg = ANGLES[(index + a) % ANGLES.length];
      const rad = (deg * Math.PI) / 180;
      const p = {
        x: Math.round(cx + Math.cos(rad) * radius - NODE_W / 2),
        y: Math.round(cy + Math.sin(rad) * radius - NODE_H / 2),
      };
      if (!taken.some((t) => hits(p, t))) return p;
    }
  }

  // Every arc slot is occupied. `plan/013`'s fallback was
  // `{ x: caller.x + RADIUS, y: caller.y + index * (NODE_H + GAP) }`, which is the one path
  // here that never consults `taken` — so the "never overlaps" property it is supposed to
  // uphold silently stops holding at exactly the moment the canvas is crowded enough to need
  // it, and two spawns with the same index land on top of each other.
  //
  // Below the lowest edge of everything already placed cannot overlap any of it, whatever the
  // x works out to. Still deterministic, and still to the caller's right.
  const bottom = taken.reduce((low, t) => Math.max(low, t.y + t.h), caller.y + caller.h);
  return { x: Math.round(caller.x + RADIUS), y: Math.round(bottom + GAP) };
}
