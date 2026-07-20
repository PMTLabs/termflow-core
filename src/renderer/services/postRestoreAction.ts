/**
 * Pure, unit-testable decision logic for what App.tsx's initializeApp() should
 * do right after StateManager.restoreState() resolves. Kept free of
 * React/Redux/store access so the branching itself can be tested in isolation
 * (see __tests__/postRestoreAction.test.ts) without mounting <App /> or
 * mocking the store.
 */

export type PostRestoreAction = 'createDefaultTab' | 'openFolderTab' | 'none';

export interface PostRestoreParams {
  /** Return value of StateManager.restoreState(). */
  restored: boolean;
  /** A folder path pending from an "Open in TermFlow" cold launch, if any. */
  pendingOpenPath: string | undefined;
  /** Tab count in the store right after restoreState() resolved. */
  tabCount: number;
}

/**
 * - No session was restored (fresh install, expired save, or restore
 *   disabled) → open a default-shell tab, rooted at pendingOpenPath if set.
 * - A session was restored AND a folder was requested → open the folder as
 *   an extra tab (openFolderTab always creates one, so this alone guarantees
 *   at least one tab).
 * - A session was "restored" successfully but ended up with zero tabs (e.g.
 *   the user quit with everything closed) and there's no pending folder →
 *   still open a default-shell tab instead of launching into an empty window.
 * - Otherwise, the restored session already has tabs — do nothing.
 */
export function resolvePostRestoreAction({
  restored,
  pendingOpenPath,
  tabCount,
}: PostRestoreParams): PostRestoreAction {
  if (!restored) return 'createDefaultTab';
  if (pendingOpenPath) return 'openFolderTab';
  if (tabCount === 0) return 'createDefaultTab';
  return 'none';
}
