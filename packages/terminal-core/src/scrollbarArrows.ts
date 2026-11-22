/**
 * Scrollbar ▲/▼ buttons → one row per click (plan 046).
 *
 * xterm 6's vendored VS Code scrollbar can draw end buttons but xterm disables them;
 * `patches/xterm-scrollbar-arrows-patch.js` re-enables the widgets and has each button dispatch
 * a bubbling `CustomEvent(SCROLLBAR_ARROW_EVENT, { detail: -1 | 1 })` from the scrollbar node.
 * The patch owns PLACEMENT only — what a click does is decided here, through the public API,
 * so it is testable and exact: `scrollLines(±1)` goes through xterm's Viewport, which moves the
 * scrollable by exactly one cell height (smooth, row-aligned) and feeds the normal `onScroll`
 * path that the scroll-to-bottom button already listens to. VS Code's own arrows scroll a wheel
 * notch (50 px × sensitivity) instead, which rounds to 2–3 rows and drifts off row alignment.
 *
 * Press-and-hold repeat (24 Hz after 200 ms) is the vendored widget's; it simply fires this
 * event repeatedly.
 */

/** The DOM event the patched arrows emit. Must equal `ARROW_EVENT` in the patch (test-pinned). */
export const SCROLLBAR_ARROW_EVENT = 'xterm-scrollbar-arrow';

/** The slice of xterm's `Terminal` this needs — the mock in tests provides the same. */
export interface ScrollbarArrowTerminal {
  /** The `.xterm` element; the event bubbles up to it from the scrollbar inside. */
  element: HTMLElement | undefined;
  scrollLines(amount: number): void;
}

/**
 * Listen on `term.element` for arrow activations and scroll one row per event.
 *
 * Returns the remover. The listener is bound to the ELEMENT, which is the thing that moves as
 * a unit on surface relocation (design 012), so a host that relocates the terminal has nothing
 * to re-wire; a host that unmounts must call the remover (the engine registers it with its
 * per-mount disposables). A terminal that has not been opened has no element and gets a no-op.
 */
export function wireScrollbarArrows(term: ScrollbarArrowTerminal): () => void {
  const el = term.element;
  if (!el) return () => {};

  const onArrow = (ev: Event): void => {
    const dir = (ev as CustomEvent<unknown>).detail;
    // The patch only ever sends ±1; anything else is not ours (a foreign dispatcher, or a
    // future patch revision that changed the contract) and must not scroll by a stray amount.
    if (dir !== 1 && dir !== -1) return;
    term.scrollLines(dir);
  };

  el.addEventListener(SCROLLBAR_ARROW_EVENT, onArrow);
  return () => el.removeEventListener(SCROLLBAR_ARROW_EVENT, onArrow);
}
