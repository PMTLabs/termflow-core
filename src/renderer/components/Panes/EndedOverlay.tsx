import React from 'react';

/**
 * Spec 045 §3.1 — the ended-session tint.
 *
 * Sits ABOVE xterm's canvas: the canvas paints the character grid itself, so
 * tinting --terminal-display-background would only colour the 4px padding slack
 * (TerminalDisplay.css:15) and leave the content — the thing that must look
 * different — untouched.
 *
 * Rendered inside .terminal-pane-content (already position:relative), which is a
 * SIBLING of SessionClosedBanner, so the Restart banner stays at full contrast.
 */

export interface ClosedInfo {
  exitCode: number | null;
}

/** Decorative tint marking historical output from a terminated session. */
export function EndedOverlay({ closedInfo }: { closedInfo: ClosedInfo | null }): React.ReactElement | null {
  if (!closedInfo) return null;
  // pointer-events inline as well as in CSS: it is load-bearing (selection and
  // scrolling must still reach the terminal underneath), not decorative.
  return <div className="pane-ended-overlay" aria-hidden="true" style={{ pointerEvents: 'none' }} />;
}

/** Class list for the pane root. Extracted so the ended-state rule is testable
 *  without mounting the full terminal stack (xterm needs a real canvas). */
export function paneClassName(opts: {
  isActive: boolean;
  solo: boolean;
  closedInfo: ClosedInfo | null;
}): string {
  return [
    'terminal-pane',
    opts.isActive ? 'active' : '',
    opts.solo ? 'solo' : '',
    opts.closedInfo ? 'is-ended' : '',
  ]
    .filter(Boolean)
    .join(' ');
}
