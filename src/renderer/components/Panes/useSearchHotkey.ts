import { useEffect, RefObject } from 'react';
import { isFindShortcut } from '@termflow/terminal-core';

/**
 * <kbd>Ctrl</kbd>+<kbd>F</kbd> / <kbd>Cmd</kbd>+<kbd>F</kbd> opens the in-terminal find bar, on a
 * surface the ENGINE's own listener does not cover (`plan/027` §1.2).
 *
 * WHY THIS EXISTS AT ALL. The engine wires its Ctrl+F intercept only while `paneChrome` is true
 * (`TerminalEngine.ts`), and a Canvas host is relocated with `{ paneChrome: !host }` — false. So
 * on the overlay no listener exists and `^F` (0x06) goes straight to the PTY. Fixing that inside
 * the engine would mean re-wiring on `setChromeHostActive` or reading a mutable flag from a
 * listener wired in both modes, and both change behaviour for every future chromeless host —
 * while only the OVERLAY can actually draw a bar. The overlay knows it is the overlay, so the
 * trigger is bound there.
 *
 * **Bound to an ELEMENT, not the document, and that is what makes two homes safe** — the same
 * shape, and the same sentence, as `useRestartHotkey`. The listener lives on whichever surface
 * is currently showing the terminal, so a document-level binding never has to work out which
 * terminal it meant.
 *
 * **Capture phase**, so it runs before xterm's own handler on the element inside, and
 * `preventDefault()` AND `stopPropagation()` are both required: without the first the WebView
 * opens its native find dialog, and without the second the key descends into `term.element` and
 * `^F` reaches the shell.
 *
 * The predicate is IMPORTED, not rewritten. A second "is this the find shortcut" — Ctrl on
 * Windows/Linux, Cmd on macOS, and plain Ctrl+F deliberately not search on macOS — is exactly
 * the two-implementations-one-fix defect the extraction was made to prevent.
 */
export function useSearchHotkey(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onOpenSearch: () => void,
): void {
  useEffect(() => {
    if (!active) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    const isMac = typeof navigator !== 'undefined' && !!navigator.platform?.includes('Mac');
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isFindShortcut(e, isMac)) return;
      e.preventDefault();
      e.stopPropagation();
      onOpenSearch();
    };
    el.addEventListener('keydown', onKeyDown, true);
    return () => el.removeEventListener('keydown', onKeyDown, true);
  }, [ref, active, onOpenSearch]);
}
