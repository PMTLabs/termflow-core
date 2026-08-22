import { Rect } from './canvasGeometry';

/**
 * Left to right, top to bottom — the order <kbd>Tab</kbd> walks the canvas, and the order the
 * sidebar lists it (Tam, 2026-08-21).
 *
 * **This reverses a documented decision, so the reasoning is worth keeping.** `stepNodeId` used
 * to walk `model.nodes` in its natural order — tab order, then pane order inside each tab — and
 * argued against sorting by position on the grounds that it "would give the keyboard one order
 * and the list another". That objection was right about the hazard and wrong about the fix: the
 * answer is to sort BOTH from one place, which is what `buildModel` now does. Pane order is the
 * order terminals were *created* in; once you have dragged them into an arrangement, that is a
 * history nothing on screen still shows, and Tab appears to jump about at random.
 *
 * ---
 *
 * **Rows are found by vertical OVERLAP, not by a tolerance on `y`.** Two nodes are on the same
 * visual row when they sit side by side, and side-by-side survives a drag that leaves one of them
 * forty pixels lower — a `|y1 - y2| < tol` test calls that a new row and sends Tab down and back
 * up again. Overlap also copes with nodes of different heights, which a tolerance cannot: the
 * threshold is a fraction of the SHORTER one, so a tall node and a short one beside it agree
 * about the row they share.
 *
 * **Each band is measured against its ANCHOR — the topmost member — never against a running
 * union of the band so far.** Accumulating the band's extent lets a staircase creep: every node
 * overlaps its predecessor by 60%, none overlaps the first by anything, and the whole diagonal
 * collapses into a single row. Anchoring costs nothing and cannot creep.
 *
 * ---
 *
 * **KNOWN LIMIT, currently unreachable — read this before adding node RESIZE.**
 *
 * Anchoring makes the banding depend on which node is topmost, and with nodes of very different
 * heights that is unstable. A node three rows tall beside a column of three short ones: if the
 * tall one starts 10px BELOW the first short one, the short one anchors and claims only the tall
 * one, giving row-major order; if it starts 10px ABOVE, the tall one anchors and claims all
 * three, giving column-major. A 20px nudge flips the whole traversal (raised in review of
 * PR #56).
 *
 * It cannot happen today: every canvas node is exactly `NODE_H` tall. Seeding
 * (`canvasSelectors`), Arrange (`canvasArrange`), spawn (`canvasSpawn`) and the sidebar drag all
 * write `h: NODE_H`, node drags preserve `h`, and there is no resize gesture. So the fix is
 * deliberately NOT written — it would be machinery for a case no code path can produce, and the
 * two candidate rules (threshold on the shorter height, which is what `sameRow` does, versus on
 * BOTH heights) disagree only for heights that do not occur.
 *
 * If node resizing is ever added, this is the thing to revisit, and `sameRow` is where.
 */

/**
 * How much of the shorter node's height must lie inside the anchor's rows to count as the same
 * row. Half: "more of it is beside the anchor than is not" is the plainest reading of the rule,
 * and it puts the boundary at the one place a user could predict.
 */
export const ROW_OVERLAP = 0.5;

/** Vertical overlap of two rects, in world units. Negative when they do not overlap at all. */
function overlapY(a: Rect, b: Rect): number {
  return Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
}

/** Whether `b` sits on the same visual row as the band anchored at `a`. */
export function sameRow(a: Rect, b: Rect): boolean {
  const shorter = Math.min(a.h, b.h);
  // A zero-height rect has no row to share. Without this the threshold is 0 and a degenerate
  // rect joins every band it merely touches.
  if (shorter <= 0) return false;
  return overlapY(a, b) >= ROW_OVERLAP * shorter;
}

/**
 * `items` in reading order.
 *
 * Total and deterministic: ties on position fall through to the id, so two exactly coincident
 * nodes keep a fixed order instead of swapping between renders — which would make Tab step
 * forwards into a node it had just come from.
 *
 * `at` and `id` rather than a fixed field name, because both callers need this and they name
 * their identity differently (`terminalId` on a node, `tabId` on a group). A shared wrapper
 * object would be allocated on every model build, and this runs on every model build.
 */
export function readingOrder<T>(
  items: readonly T[],
  at: (item: T) => Rect,
  id: (item: T) => string,
): T[] {
  const cmpId = (a: T, b: T): number => (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);

  // Sorted by top edge first, so the anchor of each band is genuinely its topmost member — the
  // banding below depends on that, and on the tie-breaks being total.
  const byTop = [...items].sort(
    (a, b) => (at(a).y - at(b).y) || (at(a).x - at(b).x) || cmpId(a, b),
  );

  const out: T[] = [];
  const claimed = new Array<boolean>(byTop.length).fill(false);

  for (let i = 0; i < byTop.length; i += 1) {
    if (claimed[i]) continue;
    const anchor = at(byTop[i]);
    const band: T[] = [byTop[i]];
    claimed[i] = true;

    for (let j = i + 1; j < byTop.length; j += 1) {
      // `byTop` is sorted by top edge, so once a candidate starts at or below the anchor's
      // bottom, neither it nor anything after it can overlap the anchor. Bounds the scan
      // without changing the result.
      if (at(byTop[j]).y >= anchor.y + anchor.h) break;
      if (claimed[j]) continue;
      if (sameRow(anchor, at(byTop[j]))) { band.push(byTop[j]); claimed[j] = true; }
    }

    band.sort((a, b) => (at(a).x - at(b).x) || (at(a).y - at(b).y) || cmpId(a, b));
    out.push(...band);
  }

  return out;
}
