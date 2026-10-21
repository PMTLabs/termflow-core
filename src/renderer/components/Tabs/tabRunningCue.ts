/**
 * How a TAB in the strip says "a process inside me is producing output" — the user's
 * `tabRunningCue` setting (Settings › Appearance).
 *
 *  - `'animated'` (default): the soft band steps across the tab. It moves in a handful of
 *    discrete steps per period, not continuously — see the note on `.tab-item.tab-running::after`
 *    in `TabManager.css` for why that is the difference between ~5 and ~60 repaints a second.
 *  - `'static'`: the same band, parked. Nothing moves, so a busy tab costs nothing per frame.
 *  - `'off'`: no running cue on tabs at all.
 *
 * Lives in its own module for the reason `canvasBusyCue.ts` gives: the setting and the renderer
 * both read the union, and one list is what keeps them from drifting apart.
 */
export type TabRunningCue = 'animated' | 'static' | 'off';

export const TAB_RUNNING_CUES: readonly TabRunningCue[] = ['animated', 'static', 'off'];

/** Narrows an untrusted value (a hand-edited or stale `config.json`) to the union. */
export function isTabRunningCue(v: unknown): v is TabRunningCue {
  return typeof v === 'string' && (TAB_RUNNING_CUES as readonly string[]).includes(v);
}
