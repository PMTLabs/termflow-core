import { terminalCache } from '@termflow/terminal-core';

/**
 * Per-terminal host boxes for a canvas session — `plan/017`.
 *
 * ## What this replaces, and why it is the whole fix
 *
 * The canvas used to give every terminal ONE session-wide host box (`canvasMetrics`, 1100-2400
 * CSS px). A terminal's pane is not that size, so entering the canvas re-fitted it, and leaving
 * re-fitted it back: two `term.resize()` calls and two SIGWINCHes per round trip, and a TUI
 * answers a SIGWINCH by repainting its whole frame. The previous frame stays in scrollback, so
 * the user sees the same content twice. That was reported three times in three disguises.
 *
 * The fix is not to suppress the fit. It is to make the fit find nothing to do.
 *
 * `FitAddon.proposeDimensions()` reads exactly four things:
 *
 *   1. `getComputedStyle(term.element.parentElement).width`  — the host's content box
 *   2. `getComputedStyle(term.element.parentElement).height` — likewise
 *   3. `getComputedStyle(term.element)` padding              — travels WITH the element
 *   4. `renderService.dimensions.css.cell` + the scrollbar   — a function of the font
 *
 * Move the element between two containers whose computed box is identical and (3) and (4) are
 * unchanged by construction, so the proposal is identical, so `fit()` takes its early return
 * (`FitAddon.fit()`: `if (rows !== dims.rows || cols !== dims.cols)`) and never calls
 * `terminal.resize()`. No resize, no SIGWINCH, no repaint.
 *
 * So the canvas host is a **pixel replica of the pane's measuring box**, per terminal, and the
 * existing machinery is left completely alone. Nothing in `terminal-core` changes: `relocateTo`
 * still arms its fit, the FT rule (`012` §5.3) and D10 still hold as written, R3 still raises
 * eligibility, and R7's ResizeObserver still fires. All of them now run to a no-op. That is a
 * far smaller change than the `freezeGeometry` flag `plan/017` first sketched, and it does not
 * touch the D10-vs-transition-table seam that two external reviews already fought over.
 *
 * ## Why the box is FROZEN for the session (`012` §6.5 RC2, unchanged)
 *
 * It is measured once, on the terminal's first appearance on the canvas, and reused until the
 * canvas closes. If the window is resized mid-session the PANE reflows and this box does not —
 * the terminal keeps the grid it had, and picks the new one up on the return trip, where the
 * fit is a real fit again because the pane genuinely changed. Re-measuring mid-session would
 * reintroduce exactly the resize this module exists to remove.
 */

export interface HostBox {
  /** CSS px, BORDER box — `.canvas-surface` has no padding or border of its own, and its
   *  `.terminal-display` child is `width:100%; height:100%`, so this lands on the child as an
   *  identical border box and therefore an identical content box (same class, same padding). */
  w: number;
  h: number;
}

/**
 * Frozen for the canvas session. Module-level rather than React state because the measurement
 * has to happen during `CanvasMode`'s RENDER — see `measureHostBox` — and a render must not
 * write to state.
 */
const boxes = new Map<string, HostBox>();

/** Called when Canvas Mode unmounts. A stale box from a previous session would be measured
 *  against a window size, split layout and font that may all have changed since. */
export function clearHostBoxes(): void {
  boxes.clear();
}

/** Test seam only. */
export function _hostBoxCount(): number {
  return boxes.size;
}

/**
 * A box we created is not evidence of anything.
 *
 * `measureHostBox` reads `term.element.parentElement`, which is the PANE only until the
 * relocation layout effect runs. Called again afterwards it would find the canvas host — our own
 * replica — and "measure" the number we just wrote. That is harmless while the cache hits, but
 * it would silently become the source of truth the moment the cache were cleared at the wrong
 * time, and a self-referential measurement is the kind of thing that reads as correct forever
 * and then drifts. Refusing outright means the fallback is taken instead, which is at least a
 * number with a stated provenance.
 */
function isOurOwnReplica(el: Element): boolean {
  return !!el.closest('.canvas-surface');
}

/**
 * The box `FitAddon` will measure for this terminal, captured before the canvas takes it.
 *
 * MUST be called while the terminal is still in its pane. `CanvasMode`'s render body is that
 * moment and there is no other: React renders a parent before its children, children register
 * their hosts in ref callbacks during the commit, and `useSurfaceRelocation`'s layout effect
 * moves `term.element` after that. By the time any effect runs, the answer has changed.
 *
 * Reading layout during render is a side effect, and a deliberate one: it is idempotent, it is
 * cached on the first call, and it is the only point in the lifecycle where the question still
 * has the right answer.
 *
 * `getBoundingClientRect` rather than `getComputedStyle`, and the fractional value rather than a
 * rounded one: `proposeDimensions` divides by the cell width and FLOORS, so a value rounded to
 * the wrong side of a cell boundary changes the column count by one — which is a resize, which
 * is the entire thing being avoided. The pane is never inside a transformed ancestor, so the
 * border box the rect reports is the layout box.
 *
 * @param fallback used when the terminal has no rendered element yet — a tab restored but never
 *   shown. Its grid is whatever the engine defaulted to, so there is no pane box to copy and
 *   the session box is the honest answer. This is `plan/017` §6's second risk, and the terminal
 *   IS refitted on that first entry; it is the one case that still repaints, and it repaints
 *   because it had no correct size to keep.
 */
export function measureHostBox(terminalId: string, fallback: HostBox): HostBox {
  const cached = boxes.get(terminalId);
  if (cached) return cached;

  const parent = terminalCache.get(terminalId)?.terminal?.element?.parentElement ?? null;
  if (!parent || isOurOwnReplica(parent)) return fallback;

  const r = parent.getBoundingClientRect();
  // A pane inside a hidden tab still has layout — inactive tabs are `opacity: 0`, never
  // `display: none` (`012` §6.5 RC3) — so a zero here means something genuinely wrong (an
  // unmounted pane, a collapsed split) and the fallback is right. Storing it would freeze a
  // zero-width host for the session and the terminal would be fitted to 2 columns.
  if (r.width < 1 || r.height < 1) return fallback;

  const box: HostBox = { w: r.width, h: r.height };
  boxes.set(terminalId, box);
  return box;
}
