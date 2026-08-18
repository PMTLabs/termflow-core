import { Rect } from './canvasGeometry';

/**
 * Keeping collapsed group chips off each other — reported 2026-08-17 with a screenshot of two
 * chips printed on top of one another.
 *
 * **The cause is structural, not a stray offset.** A group chip counter-scales, so it holds a
 * constant size ON SCREEN however far the canvas is zoomed out — that is the whole point, and
 * it is why a chip is the one thing still legible down there. Its anchor, though, is its
 * group's world position, and the screen distance between two groups shrinks with the zoom.
 * Measured on the real constants: a chip is ~190px wide on screen at every zoom, while two
 * adjacent groups are 46px apart on screen at z=0.1 and 23px at z=0.05. They cannot not
 * overlap.
 *
 * Nothing in the layout could have prevented it either: `GROUP_GAP` is a world distance, and
 * no world distance is enough when the thing you are spacing has a fixed screen size.
 */

/**
 * The chip's box on screen, in CSS pixels — fixed, and that is what makes this exact.
 *
 * A chip sized by its own title would need measuring, and a layout that guesses widths
 * resolves collisions it can only estimate. Fixing the width moves the compromise somewhere
 * visible and honest instead: a long tab name ellipsises (see `.canvas-gchip-title`), and every
 * chip is the same size, which is also what lets them line up rather than stagger.
 */
export const CHIP_W = 190;
export const CHIP_H = 36;
/** Breathing room between two chips. Below about 8px they read as one control. */
export const CHIP_GAP = 10;

export interface ChipPlacement {
  tabId: string;
  /** Offset from the group's own anchor, in WORLD units — the chip stays a world-positioned
   *  element, so this is what `CanvasGroupFrame` adds to `group.rect`. */
  dx: number;
  dy: number;
}

const overlaps = (
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean =>
  a.x < b.x + CHIP_W + CHIP_GAP && b.x < a.x + CHIP_W + CHIP_GAP
  && a.y < b.y + CHIP_H + CHIP_GAP && b.y < a.y + CHIP_H + CHIP_GAP;

/**
 * Where each group's chip should sit so that no two collide.
 *
 * Works in SCREEN space, because that is the space the collision happens in, and converts the
 * result back to a world offset at the end (`/ z`) — the chips stay world-positioned elements,
 * so this is a nudge rather than a re-parenting.
 *
 * The pan is deliberately not an input: translating every group by the same amount cannot
 * change which pairs overlap, so folding it in would add a term that must cancel and an
 * opportunity for it not to.
 *
 * Placement is greedy in reading order — a chip that collides with one already placed drops
 * below it and tries again. That keeps the arrangement STABLE (the first chip never moves, so
 * the workspace does not reshuffle as you pan) and roughly preserves relative position, which
 * is the only reason a chip is anchored to its group at all.
 */
export function groupChipLayout(
  groups: { tabId: string; rect: Rect }[],
  z: number,
): ChipPlacement[] {
  const k = 1 / Math.max(z, Number.EPSILON);
  // Sorted top-to-bottom, then left-to-right: the order the eye reads them in, and the order
  // that makes "push the later one down" produce a tidy column rather than a diagonal.
  const order = [...groups].sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));

  const placed: Array<{ x: number; y: number }> = [];
  const out: ChipPlacement[] = [];

  for (const g of order) {
    const anchor = { x: g.rect.x * z, y: g.rect.y * z };
    const pos = { ...anchor };
    // Bounded: a workspace cannot have more groups than it has, so at worst every chip stacks
    // into a single column. No `while (true)`.
    for (let i = 0; i < placed.length && placed.some((p) => overlaps(pos, p)); i++) {
      pos.y += CHIP_H + CHIP_GAP;
    }
    placed.push(pos);
    out.push({ tabId: g.tabId, dx: (pos.x - anchor.x) * k, dy: (pos.y - anchor.y) * k });
  }
  return out;
}

/** The offsets as a lookup, for the render path. Groups absent from `groups` get no entry;
 *  the caller falls back to a zero offset rather than this inventing one. */
export function chipOffsets(
  groups: { tabId: string; rect: Rect }[],
  z: number,
): Record<string, { dx: number; dy: number }> {
  const out: Record<string, { dx: number; dy: number }> = {};
  for (const p of groupChipLayout(groups, z)) out[p.tabId] = { dx: p.dx, dy: p.dy };
  return out;
}
