/** The result of replacing the textarea's current selection with inserted text. */
export interface CaretSplice {
    next: string;
    caret: number;
}

/** Splice at the current selection, falling back to the end when the element is unavailable. */
export function spliceAtCaret(
    el: HTMLTextAreaElement | null,
    value: string,
    text: string,
): CaretSplice {
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    return {
        next: value.slice(0, start) + text + value.slice(end),
        caret: start + text.length,
    };
}

/** Restore focus and put the caret after an inserted token or snippet after React paints. */
export function restoreCaret(
    ref: { current: HTMLTextAreaElement | null },
    caret: number,
): void {
    const restore = () => {
        const input = ref.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(caret, caret);
    };
    // Best-effort only: restoring the caret is a convenience for the next keystroke.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
    else restore();
}
