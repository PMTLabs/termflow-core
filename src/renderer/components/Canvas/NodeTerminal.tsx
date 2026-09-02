import React, { useCallback, useRef } from 'react';
import { setSurfaceHost, clearSurfaceHost } from '../../services/surfaceHosts';
import { useSurfaceChrome } from '../../services/surfaceChrome';
import { ScrollToBottomButton } from '../Terminal/ScrollToBottomButton';
import { CommandSuggestPopup } from '../Terminal/CommandSuggestPopup';
import { TerminalSearchBar } from '../Terminal/TerminalSearchBar';
import { SessionClosedBanner } from '../Panes/SessionClosedBanner';
import { useRestartHotkey } from '../Panes/useRestartHotkey';
import { useSearchHotkey } from '../Panes/useSearchHotkey';

/** Stable no-op, so the hotkey hook's dependency list does not churn when there is no chrome. */
const NOOP = (): void => {};

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
  /** This terminal's exit status when its shell has ENDED, else null (`plan/024` Req 4).
   *  From `sessionExit` via the canvas model, NOT from `surfaceChrome`: a node has to know it
   *  whether or not anything is publishing chrome for it. */
  exitInfo?: { exitCode: number | null } | null;
  /** Terminal font size, so the banner scales with the text as it does in a pane. */
  fontSize?: number;
}> = ({ terminalId, focused, overlaid = false, exitInfo = null, fontSize }) => {
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

  /**
   * Ctrl+R restarts, exactly as it does in a pane — the banner prints that hint, and a hint that
   * only works on one of the two surfaces showing the same banner is worse than none.
   *
   * The hook binds to this wrapper, so only the surface actually displaying the banner listens;
   * the pane's own binding is on an element that is off screen while its terminal is here.
   * Gated on `chrome` as well as `exitInfo` for the same reason the banner is: without a
   * publisher there is nothing to call.
   */
  const wrapperRef = useRef<HTMLDivElement>(null);
  const restartCb = chrome?.restartSession;
  useRestartHotkey(
    wrapperRef,
    !!(overlaid && exitInfo && restartCb),
    restartCb ?? NOOP,
  );

  /**
   * Ctrl+F / Cmd+F opens the find bar, exactly as it does in a pane (`plan/027` R1).
   *
   * The engine's own Ctrl+F listener is not wired here: it exists only while `paneChrome` is
   * true, and this host was relocated with `paneChrome: false` (design/012 D16), so without this
   * binding `^F` is forwarded to the shell. The hook is bound to the same wrapper as the restart
   * key for the same reason — only the surface actually showing the terminal listens.
   *
   * Gated on `chrome` as well as `overlaid`: the bar is drawn from the published state, so with
   * no publisher there is nothing to open.
   */
  const openSearchCb = chrome?.openSearch;
  useSearchHotkey(
    wrapperRef,
    !!(overlaid && openSearchCb),
    openSearchCb ?? NOOP,
  );

  /**
   * The pane's TEXT context menu — Copy, Paste, Clear, Selection mode (`plan/021` R2).
   *
   * `TerminalDisplay` binds this on its own `.terminal-display`, but that div no longer holds
   * the terminal once it has been relocated here, so the right-click bubbled to `.canvas-node`
   * and opened the NODE's menu instead: arrange, close, overlay — nothing that touches text.
   * `stopPropagation` is what keeps both from firing, and binding it on the HOST rather than
   * the wrapper is what puts it first: `term.element` lives inside the host, so a right-click
   * on a glyph passes through here on the way up.
   *
   * Present only when `chrome` is — i.e. only on the overlay. An ordinary node renders below
   * 1:1, and the node menu is the right menu there: you are handling a node, not reading text.
   */
  const onTerminalContextMenu = chrome
    ? (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        chrome.openContextMenu(e.clientX, e.clientY);
      }
    : undefined;

  return (
    <div className="terminal-display-wrapper canvas-surface" ref={wrapperRef}>
      <div
        className="terminal-display"
        data-terminal-id={terminalId}
        ref={hostRef}
        style={{ pointerEvents: focused ? 'auto' : 'none' }}
        onContextMenu={onTerminalContextMenu}
      />
      {chrome && (
        <ScrollToBottomButton visible={!chrome.atBottom} onClick={chrome.scrollToBottom} />
      )}
      {/* The find bar (`plan/027` §1.5). Rendered INSIDE this wrapper and never portalled:
          the overlay's backdrop closes the overlay on any `pointerdown` outside the node
          (`CanvasMode.tsx`), so a bar portalled to `document.body` would dismiss the very
          terminal it is searching the moment it was clicked. `createPortal` is closed here
          anyway — design/012 D1 and `terminalDisplayRelocationWiring.test.ts`.
          The component is presentational since `plan/027` §1.3, so this copy and the pane's
          can coexist; the state they both draw has exactly one owner. */}
      {chrome?.search.open && <TerminalSearchBar search={chrome.search} />}
      {chrome?.suggest.open && (
        <CommandSuggestPopup
          suggestions={chrome.suggest.items}
          selectedIndex={chrome.suggest.selectedIndex}
          focused={chrome.suggest.focused}
          anchor={chrome.suggest.anchor}
          onPick={chrome.pickSuggestion}
        />
      )}
      {/* The session-closed banner, on the overlay only (`plan/024` Req 4).
          The SAME component the pane renders — it is pure and props-only, so there is one
          banner in the app rather than a canvas copy that drifts. Its two actions come from
          `surfaceChrome` because only the pane can perform them, while the FACT that the
          session ended comes from the store, because an ordinary node must draw itself muted
          without anything publishing chrome for it.
          `chrome` is required as well as `exitInfo`: without a publisher the buttons would be
          dead, and a banner offering a Restart that does nothing is worse than no banner. */}
      {overlaid && exitInfo && chrome && (
        <SessionClosedBanner
          exitCode={exitInfo.exitCode}
          fontSize={fontSize}
          onRestart={chrome.restartSession}
          onDismiss={chrome.dismissSessionClosed}
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
 * check is exact and cheap — with ONE exception, and it is load-bearing: `exitInfo` is an
 * object, so it must be handed in by REFERENCE from `sessionExit.byTerminalId` rather than
 * built at the call site. `exitInfo={node.exited ? { exitCode } : null}` would allocate a fresh
 * object every render, this memo would never bail, and the whole workspace would re-render on
 * every frame of a pan — the exact regression the memo exists to prevent.
 * `CanvasNode` itself is deliberately NOT memoised, because it
 * takes `children` and seven per-node closures that are rebuilt each render, and a memo
 * that never bails is only a slower render.
 */
export const NodeTerminal = React.memo(NodeTerminalImpl);

export default NodeTerminal;
