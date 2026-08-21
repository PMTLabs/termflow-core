/**
 * How a canvas NODE says "a process inside me is producing output" — the user's
 * `canvasBusyCue` setting (`plan/023`).
 *
 *  - `'sweep'` (default): a gradient band crosses the node's header once per period. Wide,
 *    readable at a glance across a canvas of nodes, and the only cue that survives the chip
 *    tier — where the header IS the node, so a busy chip lights up as a whole tile.
 *  - `'dot'`: a small status light in the title area. Cheaper (nothing moves), and always
 *    present — muted while idle, accent-coloured and blinking while busy. Renders nothing at
 *    the chip tier, which has room for a title and nothing else.
 *
 * This union lives in its own module rather than in `settingsSlice` because BOTH the setting
 * and the renderer read it; a second copy in the slice is how the two drift into a value the
 * canvas cannot render. Same arrangement `CanvasWheelMode` has in `canvasGestures.ts`.
 *
 * The SIDEBAR is deliberately not covered by this. Its rows keep the blinking shell-profile
 * icon (`plan/020` Req 6) under both settings — a list is already scannable in a way nodes
 * scattered across a canvas are not.
 */
export type CanvasBusyCue = 'sweep' | 'dot';

export const CANVAS_BUSY_CUES: readonly CanvasBusyCue[] = ['sweep', 'dot'];

/**
 * Narrows an untrusted value (a hand-edited or stale `config.json`) to the union.
 *
 * Exported so the boot-time hydration in `App.tsx` validates against the SAME list the
 * Settings dropdown offers, rather than restating `x === 'sweep' || x === 'dot'` at the call
 * site — a restatement that silently stops accepting a third cue the day one is added.
 */
export function isCanvasBusyCue(v: unknown): v is CanvasBusyCue {
  return typeof v === 'string' && (CANVAS_BUSY_CUES as readonly string[]).includes(v);
}
