import { useEffect, RefObject } from 'react';

/**
 * <kbd>Ctrl</kbd>+<kbd>R</kbd> restarts a shell in place, while — and only while — the
 * session-closed banner is showing.
 *
 * Extracted from `TerminalPane` by `plan/024` Req 4 so the Canvas overlay can bind the same key
 * to the same action. It was already the hint printed on the banner ("Press Ctrl+R to start a new
 * session"), so a banner that showed the hint on the canvas and did nothing there would be
 * worse than one with no hint at all.
 *
 * **Bound to an ELEMENT, not the document, and that is what makes two homes safe.** The listener
 * lives on whichever surface is currently showing the terminal — the pane's root in tab mode, the
 * overlay's wrapper on the canvas — so only one of them has a banner up at a time and only that
 * one is listening. A document-level binding would need to work out which terminal it meant.
 *
 * **Capture phase**, so it runs before xterm's own handler and the key never reaches the PTY,
 * and `preventDefault` because Ctrl+R would otherwise reload the WebView.
 *
 * **Not bound at all when `active` is false**, which is the whole reason this is conditional:
 * with a live shell, Ctrl+R belongs to the shell's reverse-search and must pass straight through.
 */
export function useRestartHotkey(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onRestart: () => void,
): void {
  useEffect(() => {
    if (!active) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        e.stopPropagation();
        onRestart();
      }
    };
    el.addEventListener('keydown', onKeyDown, true);
    return () => el.removeEventListener('keydown', onKeyDown, true);
  }, [ref, active, onRestart]);
}
