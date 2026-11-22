/**
 * How a canvas NODE says "a process inside me is producing output" — the user's
 * `canvasBusyCue` setting (`plan/023`).
 *
 *  - `'pulse'` (default): the header band, bright for 1s and dim for 1s — the canvas twin of
 *    the tab strip's default `pulse` (`tabRunningCue.ts`), so a busy terminal looks the same in
 *    both places. One change a second; like the sweep, it survives the chip tier, where the
 *    header IS the node, so a busy chip lights up as a whole tile.
 *  - `'sweep'`: a gradient band crosses the node's header, stepped (5 moves a second). Easier
 *    to spot across a canvas, ~5x the redraws of the pulse.
 *  - `'dot'`: a small status light in the title area — muted while idle, accent-coloured and
 *    blinking while busy. Renders nothing at the chip tier, which has room for a title and
 *    nothing else.
 *  - `'static'`: the header band, parked and lit. Nothing moves anywhere on the canvas —
 *    the sidebar's busy icon stops blinking too.
 *  - `'off'`: no busy cue on nodes, and no blinking sidebar icon.
 *
 * `pulse`, `sweep` and `static` are the node's `running` class (the header band); `CanvasNode`
 * publishes the cue as `data-busy-cue` and `Canvas.css` picks the band's animation from it.
 * The sidebar publishes the same attribute, so `static` and `off` reach its icon as well —
 * otherwise "Off" would leave the one cue still blinking.
 *
 * This union lives in its own module rather than in `settingsSlice` because BOTH the setting
 * and the renderer read it; a second copy in the slice is how the two drift into a value the
 * canvas cannot render. Same arrangement `CanvasWheelMode` has in `canvasGestures.ts`.
 *
 * The SIDEBAR keeps its own cue shape: its rows blink the shell-profile icon (`plan/020`
 * Req 6) under every animated setting — a list is already scannable in a way nodes scattered
 * across a canvas are not. Only `static` and `off` reach it, and both stop the blink.
 */
export type CanvasBusyCue = 'pulse' | 'sweep' | 'dot' | 'static' | 'off';

export const CANVAS_BUSY_CUES: readonly CanvasBusyCue[] = ['pulse', 'sweep', 'dot', 'static', 'off'];

/** The cues drawn as the header band — the node's `running` class. */
export function isBandCue(cue: CanvasBusyCue): boolean {
  return cue === 'pulse' || cue === 'sweep' || cue === 'static';
}

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
