import React, { useCallback } from 'react';
import { setSurfaceHost, clearSurfaceHost } from '../../services/surfaceHosts';
import { useSurfaceChrome } from '../../services/surfaceChrome';
import { ScrollToBottomButton } from '../Terminal/ScrollToBottomButton';
import { CommandSuggestPopup } from '../Terminal/CommandSuggestPopup';

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
const NodeTerminalImpl: React.FC<{
  terminalId: string;
  focused: boolean;
  /** True while this node IS the overlay — the one canvas surface rendered at 1:1, and so the
   *  only one that can carry the pane's floating chrome (`plan/020` §5). */
  overlaid?: boolean;
}> = ({ terminalId, focused, overlaid = false }) => {
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

  /**
   * The pane's floating chrome, published by `TerminalDisplay` (`plan/020` §5).
   *
   * OVERLAY ONLY, and the geometry is the reason. An ordinary node renders its surface through
   * `--node-surface-scale`, well below 1, and `.canvas-surface` clips what leaves its box — a
   * popup there would draw at a fraction of its size and be cut off by the node's own edge. The
   * overlay is the one canvas surface at 1:1, so it is the one where this chrome is both legible
   * and correctly placed: `CommandSuggestPopup` measures against `offsetParent`, which is this
   * wrapper, exactly as it is the pane's wrapper on the other side.
   *
   * Nodes that are not the overlay pass `null` and so never subscribe.
   */
  const chrome = useSurfaceChrome(overlaid ? terminalId : null);

  return (
    <div className="terminal-display-wrapper canvas-surface">
      <div
        className="terminal-display"
        data-terminal-id={terminalId}
        ref={hostRef}
        style={{ pointerEvents: focused ? 'auto' : 'none' }}
      />
      {chrome && (
        <ScrollToBottomButton visible={!chrome.atBottom} onClick={chrome.scrollToBottom} />
      )}
      {chrome?.suggest.open && (
        <CommandSuggestPopup
          suggestions={chrome.suggest.items}
          selectedIndex={chrome.suggest.selectedIndex}
          focused={chrome.suggest.focused}
          anchor={chrome.suggest.anchor}
          onPick={chrome.pickSuggestion}
        />
      )}
    </div>
  );
};

/**
 * Memoised, and the props are why it can be.
 *
 * Canvas Mode re-renders on every frame of a pan or zoom — `setViewport` fires per pointer
 * event — and without this every node's host registration and surface subscription re-ran with it, for the whole workspace
 * including the nodes culled off screen. The props here are primitives, so the equality
 * check is exact and cheap; `CanvasNode` itself is deliberately NOT memoised, because it
 * takes `children` and seven per-node closures that are rebuilt each render, and a memo
 * that never bails is only a slower render.
 */
export const NodeTerminal = React.memo(NodeTerminalImpl);

export default NodeTerminal;
