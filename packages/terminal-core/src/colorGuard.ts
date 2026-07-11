// Color-control OSC identifiers a program can use to repaint the ANSI palette,
// default foreground/background/cursor (and highlight/special colors), plus their
// reset counterparts. When an agent color-scheme override owns a pane, these are
// blocked so our applied theme wins the race against the program's own theming
// (e.g. Copilot setting its dark theme via OSC 4/10/11 shortly after launch).
//   4  set palette color        104 reset palette color
//   5  set special color        105 reset special color
//   10 set default foreground   110 reset default foreground
//   11 set default background    111 reset default background
//   12 set cursor color         112 reset cursor color
//   17 set highlight background  117 reset highlight background
//   19 set highlight foreground  119 reset highlight foreground
export const COLOR_OSC_CODES = [4, 5, 10, 11, 12, 17, 19, 104, 105, 110, 111, 112, 117, 119] as const;

/**
 * Decide whether a color-control OSC sequence should be BLOCKED (swallowed) so a
 * pane's assigned agent color scheme is not overwritten by the program running in
 * it. Pure (no xterm/DOM deps) so it is unit-tested directly; the engine wires it
 * to xterm's OSC parser and the per-terminal lock flag.
 *
 * - Not locked (no agent override owns this pane) → never block: normal terminal,
 *   programs may set colors as usual.
 * - A color QUERY (payload contains '?', e.g. `11;?` or `4;1;?`) → never block, so
 *   the program still receives a correct color report and renders correctly.
 * - Otherwise a SET or RESET while locked → block, so our theme deterministically
 *   wins regardless of who wrote the color manager last.
 */
export function shouldBlockColorOsc(locked: boolean, data: string): boolean {
  if (!locked) return false;
  if (data.includes('?')) return false; // query — let xterm respond
  return true; // set/reset — swallow so our scheme is preserved
}
