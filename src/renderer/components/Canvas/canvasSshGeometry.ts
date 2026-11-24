/**
 * The two boxes of an SSH canvas node (plan 070 §4.1 B). Pure: no DOM, no store.
 *
 * An SSH leaf has a terminal MEASURING box — the `.terminal-display` FitAddon reads, which stays
 * the meaning of `HostBox` — inside a larger content ENVELOPE: browser column + terminal slot +
 * bottom status row, plus the shell's own chrome row above the body (when visible, in
 * flow) and the launch strip's row reserved at the top of the terminal slot (066's
 * strip sits above the shell in a pane, inside the slot here), no pane or node title. Canvas sizes the outer surface to the envelope and
 * gives the registered host the remainder, so the terminal keeps the exact box it had in its pane
 * and the relocation fit finds nothing to do.
 *
 *   envelope.w = terminal.w + browserAllocation + columnGap
 *   envelope.h = terminal.h + stripH + chromeH + statusH
 *
 * The envelope is frozen for the Canvas mount. An explicit browser collapse/expand keeps it and
 * moves the difference into that one terminal's slot width; notice rows may also change the live slot height.
 */

import { SSH_METRICS_BAR_HEIGHT_PX } from '../Ssh/sshPaneLayout';

import { SSH_BROWSER_DEFAULT_WIDTH, SSH_BROWSER_MAX_FRACTION } from '../../types/sshBrowserWidth';

export interface Box { w: number; h: number }

/** Canvas-only and ephemeral: keyed by terminalId, cleared with `clearHostBoxes`, never persisted. */
export interface SshSurfaceBox {
  /** browser + terminal + bottom bar, no pane/node title. */
  envelope: Box;
  /** The actual pre-relocation FitAddon parent (border box). */
  initialTerminal: Box;
  /** The browser column expanded, including its border, as capped by the shell CSS. */
  expandedBrowserW: number;
  preferredBrowserWidth?: number;
  /** 068's collapsed rail, including its border. */
  collapsedBrowserW: number;
  /** The single fixed status row, including its border. */
  statusH: number;
  /** 066's launch strip row, reserved at the top of the terminal slot (`Canvas.css`). */
  stripH: number;
  /** The shell's chrome row (`SshPaneShell` `SSH_PANE_CHROME_H`), in flow when visible. */
  chromeH: number;
  columnGap: number;
  /** `measured` from the rendered pane, or an honest `fallback` for a never-rendered leaf. */
  source: 'measured' | 'fallback';
}

/**
 * The shell's own allocations, as declared in `Ssh/SshPaneShell.css` (068 browser/rail, 067/069
 * status row). They are the CSS values, not new ones: `sshCanvasGeometry.test.ts` reads that file
 * and fails if either side changes alone. A measured source always wins; these only size the
 * state that was not on screen at capture and the never-rendered fallback.
 *
 *   .ssh-browser            { flex:0 1 260px; width:260px; max-width:40%; box-sizing:border-box }
 *   .ssh-browser.collapsed  { width:30px; max-width:min(30px, 40%) }
 *   .ssh-status             { box-sizing:border-box; height:26px }   (= SSH_METRICS_BAR_HEIGHT_PX, D66)
 *   .ssh-launch-strip       { box-sizing:border-box; height:36px }   (Ssh/SshLaunchNotice.css)
 *   .ssh-pane-chrome        { flex:none; box-sizing:border-box; height:36px }   (= SSH_PANE_CHROME_H)
 */
export const SSH_CSS_BROWSER_W = SSH_BROWSER_DEFAULT_WIDTH;
export const SSH_CSS_RAIL_W = 30;
export const SSH_CSS_BROWSER_MAX_FRACTION = SSH_BROWSER_MAX_FRACTION;
/** D66: the one bottom row (shell status + 069 metrics bar), `.ssh-status` in SshPaneShell.css. */
export const SSH_CSS_STATUS_H = SSH_METRICS_BAR_HEIGHT_PX;
export const SSH_CSS_LAUNCH_STRIP_H = 36;
/** Mirrors `SSH_PANE_CHROME_H` (kept out of this pure module to avoid importing the component). */
export const SSH_CSS_CHROME_H = 36;

/** `min(cssW, 40% of the body)`: the CSS cap, with the body as wide as the envelope. */
export function cappedBrowserW(cssW: number, bodyW: number): number {
  return Math.min(cssW, SSH_CSS_BROWSER_MAX_FRACTION * bodyW);
}

export function sshBrowserAllocation(box: SshSurfaceBox, collapsed: boolean, preferredBrowserWidth = box.preferredBrowserWidth): number {
  return collapsed ? box.collapsedBrowserW : preferredBrowserWidth === box.preferredBrowserWidth
    ? box.expandedBrowserW : cappedBrowserW(preferredBrowserWidth ?? SSH_CSS_BROWSER_W, box.envelope.w);
}

/** The terminal slot: the remainder of the frozen envelope for the CURRENT collapse state. */
export function sshTerminalBox(box: SshSurfaceBox, collapsed: boolean): Box {
  return {
    w: box.envelope.w - sshBrowserAllocation(box, collapsed) - box.columnGap,
    h: box.envelope.h - box.stripH - box.chromeH - box.statusH,
  };
}

/** Builds the descriptor from a measured source: terminal border box plus the rendered allocations. */
export function sshSurfaceBoxFrom(m: {
  terminal: Box; browserW: number; collapsed: boolean; statusH: number; columnGap: number; preferredBrowserWidth?: number;
  hasStrip?: boolean; hasChrome?: boolean;
}): SshSurfaceBox {
  const stripH = m.hasStrip ? SSH_CSS_LAUNCH_STRIP_H : 0;
  const chromeH = m.hasChrome ? SSH_CSS_CHROME_H : 0;
  const envelope = { w: m.terminal.w + m.browserW + m.columnGap, h: m.terminal.h + stripH + chromeH + m.statusH };
  return {
    envelope,
    initialTerminal: { ...m.terminal },
    expandedBrowserW: m.collapsed ? cappedBrowserW(m.preferredBrowserWidth ?? SSH_CSS_BROWSER_W, envelope.w) : m.browserW,
    ...(m.preferredBrowserWidth !== undefined ? { preferredBrowserWidth: m.preferredBrowserWidth } : {}),
    collapsedBrowserW: m.collapsed ? m.browserW : cappedBrowserW(SSH_CSS_RAIL_W, envelope.w),
    statusH: m.statusH,
    stripH,
    chromeH,
    columnGap: m.columnGap,
    source: 'measured',
  };
}

/**
 * For a leaf with no rendered pane to copy: the session fallback terminal box plus the shared
 * allocations. Its first real fit is expected (it had no correct size to keep). The capped width
 * solves `a = min(cssW, 0.4 * (terminal.w + a))`, i.e. the cap binds below `terminal.w = 1.5 cssW`.
 */
export function sshFallbackSurfaceBox(terminal: Box, collapsed: boolean, preferredBrowserWidth?: number): SshSurfaceBox {
  const solve = (cssW: number) => Math.min(cssW, (SSH_CSS_BROWSER_MAX_FRACTION * terminal.w) / (1 - SSH_CSS_BROWSER_MAX_FRACTION));
  const browserW = solve(collapsed ? SSH_CSS_RAIL_W : preferredBrowserWidth ?? SSH_CSS_BROWSER_W);
  return { ...sshSurfaceBoxFrom({ terminal, browserW, collapsed, preferredBrowserWidth, statusH: SSH_CSS_STATUS_H, columnGap: 0 }), source: 'fallback' };
}

/**
 * Full-content visibility for an SSH node: CONTAIN, not width-only fit, then bottom-align.
 *
 * `scale = min(nodeW / envW, bodyH / envH)`, `shift = bodyH - envH * scale` (never negative), so
 * the browser toolbar, every terminal row and the status row stay inside the node body; a
 * letterbox is preferable to losing toolbar or status. `bodyH` is invariant across zoom
 * (`paintedNodeH`), so neither value depends on the viewport. The overlay's rect is built from the
 * same envelope, which makes `scale * z` its screen scale and `shift` zero.
 */
export function sshContain(envelope: Box, nodeW: number, bodyH: number): { scale: number; shift: number } {
  if (envelope.w <= 0 || envelope.h <= 0) return { scale: 1, shift: 0 };
  const scale = Math.min(nodeW / envelope.w, bodyH / envelope.h);
  return { scale, shift: Math.max(0, bodyH - envelope.h * scale) };
}
