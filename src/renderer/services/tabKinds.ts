/**
 * Tab kinds that own no PTY and no pane tree.
 *
 * Settings and Canvas are both *screens* modelled as tabs: they sit in the strip and
 * activate, reorder and close like any other tab, but nothing inside them is a terminal.
 * Several places have to know that, and each of them fails differently if it does not:
 *
 *  - `TerminalContainer` seeds a pane tree for every tab it renders, and a pane tree
 *    named after the tab spawns a PTY. A virtual tab that reached that path would boot
 *    a shell nobody asked for, named "Canvas".
 *  - `TabManager` asks the backend which processes a tab is about to kill before it
 *    closes one. A virtual tab has none, so the confirmation would be an empty dialog.
 *  - `canvasSelectors` projects tabs into group frames. A virtual tab is not a group.
 *
 * Collected here rather than left as scattered `shellType === 'settings'` comparisons:
 * every one of those predates Canvas Mode, and every one of them is a place the canvas
 * tab would otherwise have been mistaken for a terminal.
 */

export const SETTINGS_SHELL_TYPE = 'settings';
export const CANVAS_SHELL_TYPE = 'canvas';

const VIRTUAL_SHELL_TYPES: ReadonlySet<string> = new Set([
  SETTINGS_SHELL_TYPE,
  CANVAS_SHELL_TYPE,
]);

/** True for a tab that hosts a screen rather than one or more terminals. */
export function isVirtualTab(shellType: string | null | undefined): boolean {
  return !!shellType && VIRTUAL_SHELL_TYPES.has(shellType);
}

/**
 * The same list with the canvas tab moved to the front (`plan/024` Req 3).
 *
 * `openCanvasTab` puts the canvas first on every open, and session restore has to agree or the
 * position lasts exactly until the next restart — which is precisely when a workspace overview
 * is looked for.
 *
 * This is the RESTORE half. Its sibling is `moveCanvasTabFirst` in `openCanvas`, which does the
 * same thing to the live strip through `reorderTabs`; the two cannot share an implementation
 * (one orders a plain list, the other dispatches a move) so they are cross-referenced instead.
 * Change one, read the other.
 *
 * Lives here rather than in `openCanvas` because this is the module that owns "which tab is the
 * canvas", and because `StateManager` must be able to ask without importing the live store.
 *
 * Partitioned rather than sorted: `filter` preserves relative order within each part by
 * construction, so no ordinary tab moves relative to any other — a comparator would need that
 * property argued from `Array.sort`'s stability instead of being obvious. Returns a NEW array;
 * the caller's is untouched.
 */
export function canvasTabFirst<T extends { shellType?: string | null }>(tabs: readonly T[]): T[] {
  return [
    ...tabs.filter((t) => t?.shellType === CANVAS_SHELL_TYPE),
    ...tabs.filter((t) => t?.shellType !== CANVAS_SHELL_TYPE),
  ];
}
