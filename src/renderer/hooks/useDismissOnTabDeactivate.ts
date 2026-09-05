/**
 * Dismiss a terminal's floating surfaces when the tab hosting them stops being the active one.
 *
 * **The defect this closes.** Every menu a terminal owns renders through
 * `createPortal(…, document.body)` at `position: fixed` — `Terminal/ContextMenu` (the right-click
 * menu, the keyboard Snippets flyout, the path picker and the schema picker) and
 * `Panes/PaneContextMenu` (the pane-title menu). `TerminalContainer.css` hides a background tab
 * by putting `visibility: hidden; opacity: 0; content-visibility: hidden` on its `.tab-content`,
 * and a portalled node is not inside that subtree — while background tabs stay MOUNTED, so
 * nothing else takes the menu down either. A menu opened in tab A therefore kept painting over
 * tab B, where it reads as tab B's own menu and acts on tab A's terminal.
 *
 * `ContextMenu` does dismiss itself on an outside `mousedown` and on Escape, which is why
 * clicking a tab in the tab bar happened to look correct. Neither fires for a tab switch by
 * KEYBOARD (`Ctrl+Tab`, `Ctrl+PageUp/Down`, `Ctrl+1…9`) or by any programmatic route — the local
 * API / MCP, a canvas node's "Open as tab", closing the tab beside it, session restore. The
 * owner of the menu is the only party that knows the switch happened, so the dismissal belongs
 * to it.
 *
 * **A hook rather than the five-line effect written twice.** There are two owners
 * (`TerminalDisplay`, holding four surfaces, and `TerminalPane`, holding one), and the reason it
 * is a hook is not the line count: `TerminalDisplay` cannot be mounted under the root Jest config
 * — two untransformed CSS imports, `@tauri-apps/api/event` and a real `Terminal.open()` needing a
 * canvas 2D context — so an effect inlined there is assertable only as a source tripwire. Here,
 * the rule below is exercised for real.
 *
 * @param isTabActive Whether the tab that hosts this surface is the active one — `isActive` in
 *   `TerminalDisplay`, `isTabActive` in `TerminalPane`, both ultimately
 *   `tab.id === activeTabId` from `TerminalContainer`.
 * @param dismiss Close everything this owner has floating. It must NOT restore focus to the
 *   terminal: the tab being left is no longer on screen, and the tab being entered focuses its
 *   own terminal in the same commit. Both call sites pass the raw `setState(null)` calls rather
 *   than their `close*` helpers for exactly that reason.
 */
import { useEffect, useRef } from 'react';

export function useDismissOnTabDeactivate(isTabActive: boolean, dismiss: () => void): void {
  /**
   * The latest `dismiss`, so the effect can depend on `isTabActive` ALONE.
   *
   * Both call sites write the callback inline, so its identity changes every render, and
   * `react-hooks/exhaustive-deps` wants it in the dependency list. Held in a ref (refs are exempt
   * from that rule) the effect body runs on a SWITCH rather than on every render, with no
   * `eslint-disable` to hide the deps behind. Same pattern as `TerminalDisplay`'s
   * `onTitleChangeRef`.
   *
   * **Not a staleness fix, and the assignment below is the load-bearing half.** Calling `dismiss`
   * straight out of the effect would work: the closure is rebuilt every render and React runs the
   * newest one when the deps change — mutation-checked, that variant survives the whole suite.
   * What does NOT work is seeding the ref and never refreshing it, which strands the first
   * render's closure forever; `useDismissOnTabDeactivate.test.tsx`'s last case is the one that
   * catches it.
   */
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  /**
   * The PREVIOUS activity, which is what makes this a transition and not a `!isTabActive` guard.
   *
   * A terminal relocated onto a Canvas node keeps its `TerminalDisplay` mounted in its own (now
   * background) pane tab, so `isTabActive` is false for the whole time it is on the canvas — and
   * `NodeTerminal` opens that component's menu through the published `openContextMenu`. Anything
   * that acted on the VALUE `false` rather than on the edge into it would close that menu on the
   * render that opened it, leaving the overlay with no context menu at all. (The canvas's own
   * exit is already covered: leaving the Canvas tab unmounts `CanvasMode`, which reverses the
   * relocation, and `onRelocated` clears the same four slots.)
   *
   * Seeded with the mount-time value so a mount that is already inactive is not read as a switch.
   */
  const wasTabActive = useRef(isTabActive);

  useEffect(() => {
    const deactivated = wasTabActive.current && !isTabActive;
    wasTabActive.current = isTabActive;
    if (deactivated) dismissRef.current();
  }, [isTabActive]);
}

export default useDismissOnTabDeactivate;
