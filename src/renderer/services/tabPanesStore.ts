/**
 * Reference-stable access to the per-tab pane-tree map that lives on the window
 * global (`window.__TAB_PANES__`, aliased as `window.tabPanes`).
 *
 * `TerminalContainer.tsx` holds a module-scoped binding to this SAME object and
 * reads/writes it directly. Historically both `clearTabPanes()` (`tabPanes = {}`)
 * and the session-restore path (`window.__TAB_PANES__ = {}`) REPLACED the object,
 * which silently diverged the three references — so restored pane trees became
 * invisible to TerminalContainer and every restored terminal spawned under a fresh
 * id, defeating scrollback restore. These helpers mutate the object IN PLACE so the
 * single shared reference is always preserved.
 */
type TabPaneMap = Record<string, any>;

/** The shared pane map, creating it (and aliasing both globals to it) if needed. */
export function getTabPanesGlobal(): TabPaneMap {
  const w = window as any;
  if (!w.__TAB_PANES__) {
    w.__TAB_PANES__ = {};
  }
  // Keep the `tabPanes` alias pointing at the same object as `__TAB_PANES__`.
  if (w.tabPanes !== w.__TAB_PANES__) {
    w.tabPanes = w.__TAB_PANES__;
  }
  return w.__TAB_PANES__;
}

/** Empty the pane map without replacing its reference. */
export function clearTabPanesInPlace(): void {
  const t = getTabPanesGlobal();
  for (const k of Object.keys(t)) delete t[k];
}

/** Replace the pane map's contents with `saved`, preserving the reference. */
export function restoreTabPanesInPlace(saved: TabPaneMap): void {
  const t = getTabPanesGlobal();
  for (const k of Object.keys(t)) delete t[k];
  Object.assign(t, saved);
}
