/**
 * Colours for the ended-program marks (the scrollback a program produced before
 * it exited, while the shell keeps running below).
 *
 * xterm's decoration `backgroundColor` accepts `#RRGGBB` only — no alpha — so the
 * wash that the session-level pane overlay gets for free in CSS has to be
 * computed here instead. Same 0.13 toward neutral grey as that overlay
 * (TerminalPane.css `.pane-ended-overlay`), so both scopes read as one feature.
 */

/** Neutral grey — the colour the CSS pane overlay washes toward. */
const NEUTRAL = 0x80;
const WASH_ALPHA = 0.13;
/** The rail is deliberately far stronger than the wash: on some schemes a 13%
 *  wash is nearly invisible, and the rail is what makes the region legible. */
const RAIL_ALPHA = 0.55;

const HEX = /^#([0-9a-f]{6})$/i;

function parse(background: string): number | undefined {
  const m = HEX.exec(background ?? '');
  return m ? parseInt(m[1], 16) : undefined;
}

function blend(rgb: number, target: number, alpha: number): string {
  const mix = (channel: number): number => Math.round(channel + (target - channel) * alpha);
  const hex = (v: number): string => v.toString(16).padStart(2, '0');
  return `#${hex(mix((rgb >> 16) & 0xff))}${hex(mix((rgb >> 8) & 0xff))}${hex(mix(rgb & 0xff))}`;
}

/** Background wash for an ended region. Returns undefined for a background it
 *  cannot parse — a wrong colour is worse than no mark. */
export function blendEndedTint(background: string, alpha: number = WASH_ALPHA): string | undefined {
  const rgb = parse(background);
  return rgb === undefined ? undefined : blend(rgb, NEUTRAL, alpha);
}

/** Left-rail colour for an ended region: the same neutral, pushed far enough from
 *  the background to read as a solid bar on both light and dark schemes. */
export function endedRailColor(background: string, alpha: number = RAIL_ALPHA): string | undefined {
  const rgb = parse(background);
  return rgb === undefined ? undefined : blend(rgb, NEUTRAL, alpha);
}
