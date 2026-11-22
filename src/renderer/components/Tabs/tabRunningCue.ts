/**
 * How a TAB in the strip says "a process inside me is producing output" — the user's
 * `tabRunningCue` setting (Settings › Appearance).
 *
 *  - `'pulse'` (default): the soft band switches between bright and dim once a second. One
 *    change a second is the cheapest cue that still moves — see the note on
 *    `.tab-item.tab-running::after` in `TabManager.css` for why every change costs a frame.
 *  - `'animated'`: the band steps across the tab, 5 moves a second. Easier to spot, ~5x the cost.
 *  - `'static'`: the same band, parked. Nothing moves, so a busy tab costs nothing per frame.
 *  - `'off'`: no running cue on tabs at all.
 *
 * Lives in its own module for the reason `canvasBusyCue.ts` gives: the setting and the renderer
 * both read the union, and one list is what keeps them from drifting apart.
 */
export type TabRunningCue = 'pulse' | 'animated' | 'static' | 'off';

export const TAB_RUNNING_CUES: readonly TabRunningCue[] = ['pulse', 'animated', 'static', 'off'];

/** Narrows an untrusted value (a hand-edited or stale `config.json`) to the union. */
export function isTabRunningCue(v: unknown): v is TabRunningCue {
  return typeof v === 'string' && (TAB_RUNNING_CUES as readonly string[]).includes(v);
}
