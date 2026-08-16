import React, { useCallback } from 'react';
import { setSurfaceHost, clearSurfaceHost } from '../../services/surfaceHosts';

/**
 * Hosts a live terminal inside a canvas node.
 *
 * This component owns NO terminal machinery. It renders a conforming, empty host and
 * registers it in `surfaceHosts`; TerminalDisplay's relocation effect then calls
 * `engine.relocateTo(host, { paneChrome: false })`, which moves only xterm's own
 * `term.element` (design/012 D1/D2). Do not move DOM nodes here, do not call
 * `relocateTo` here, and do not add a second registrant for the same terminalId.
 *
 * The markup is a CONTRACT, not styling (design/012 D17 / §4.4): `.terminal-display`
 * carries 15 CSS rules, the global Ctrl+C guard (`InputHandler` resolves
 * `activeElement.closest('.terminal-display')`) and the ended-region rail lookup, and it
 * is the box `FitAddon.proposeDimensions()` measures — the HOST, never the wrapper.
 * `pointer-events: none` while unfocused is design/012 D19: xterm binds an always-on
 * `mousedown` to `term.element` itself, and that listener travels with the element, so
 * without the gate a single click on a node body pulls keyboard focus into the PTY.
 *
 * **Render policy is deliberately NOT set here.** It is applied centrally by
 * `CanvasMode` through `reconcileRenderPolicies`, which is the only thing that can
 * order promotions (design/010 D8 puts the focused node first), demote before it
 * promotes, and honour CALLER-DROP. See `canvasRenderPolicy.ts`.
 */
export const NodeTerminal: React.FC<{
  terminalId: string;
  focused: boolean;
}> = ({ terminalId, focused }) => {
  // The ref identity MUST be stable across renders (012 D5). A fresh arrow every render
  // makes React detach and re-attach on every commit — clear + re-register churn, and
  // each churn is a relocation of a live terminal.
  const hostRef = useCallback<React.RefCallback<HTMLDivElement>>(
    (el) => {
      if (el === null) return;          // React 19 calls the cleanup below instead of
                                        // re-invoking with null; this satisfies the TYPE
      setSurfaceHost(terminalId, el);
      return () => clearSurfaceHost(terminalId, el);   // identity-checked against `el`
    },
    [terminalId],
  );

  return (
    <div className="terminal-display-wrapper canvas-surface">
      <div
        className="terminal-display"
        data-terminal-id={terminalId}
        ref={hostRef}
        style={{ pointerEvents: focused ? 'auto' : 'none' }}
      />
    </div>
  );
};

export default NodeTerminal;
