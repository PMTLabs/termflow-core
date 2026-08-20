/**
 * Pure, unit-testable helpers for the browser-style tab close menu.
 *
 * These back the "Close Tab / Close Tabs to the Right / Left / Other Tabs"
 * actions and the smart confirm dialog that lists the *real* foreground
 * processes running in the affected tab(s). Kept free of React/Redux so they
 * can be tested in isolation (see __tests__/closeTabs.test.ts).
 */

import type { PaneNode } from '../store/slices/panesSlice';
import { getAllTerminalIds } from '../store/slices/paneTreeOps';

/** Which set of tabs a close action targets, relative to the clicked tab. */
export type CloseKind = 'single' | 'right' | 'left' | 'others';

/**
 * The terminals closing `tabId` must tear down.
 *
 * A tab's root pane used to be created with `terminalId === tab.id`, and splits
 * preserved it — so the close path also tore down `tabId` as a terminal id
 * unconditionally, as a safety net for a tab whose tree we never saw. That only
 * held while the pane still belonged to the tab: dragging it into another tab
 * (`movePaneToTab`) or another window (detach) carries the terminal away while
 * the source tab keeps its id, so the unconditional teardown killed a pane that
 * is now live somewhere else.
 *
 * The pane tree is authoritative whenever we have one — it lists exactly the
 * terminals the tab still owns. The `tabId` fallback applies ONLY when there is
 * no tree at all.
 *
 * RESIDUAL RISK, now WIDER than when it was written: design 014 gives EVERY root
 * pane a minted `tm-` leaf, so `tabId` is never a live terminal id for any tab —
 * not just for the API-created ones this note originally singled out. If this
 * `[tabId]` fallback ever fired it would close an id that was never live
 * (harmless no-op) while leaking the real `tm-` PTY (not harmless). It fires ONLY
 * when `window.tabPanes` was never populated for that tab, and both creation
 * paths populate it synchronously before the tab is visible to a close action, so
 * it is believed unreachable in practice — but it is a real gap in this
 * fallback's coverage, not a proven-impossible one, so it is called out here
 * rather than silently relied upon. Kept (rather than narrowed to `[]`) because
 * an empty return would leak just as much and lose the audit trail in the log.
 */
export function collectTabCloseTerminalIds(
  paneTree: PaneNode | null,
  tabId: string,
): string[] {
  if (!paneTree) return [tabId];
  return getAllTerminalIds(paneTree);
}

/**
 * Bare shell executable names. The backend's `/api/processes` reports the
 * foreground process of each terminal, but for an idle shell with no child
 * process it reports the shell itself (e.g. `pwsh`, `bash`). We filter these
 * out so an idle terminal shows the plain confirm rather than "Running: pwsh".
 */
const SHELL_NAMES = new Set<string>([
  'pwsh',
  'powershell',
  'bash',
  'sh',
  'zsh',
  'cmd',
  'fish',
  'nu',
  'nushell',
  'dash',
  'ash',
  'ksh',
  'csh',
  'tcsh',
  'wsl',
  'conhost',
]);

/**
 * Normalize a process name for comparison: take the basename (strip any
 * directory), lowercase, and drop a trailing `.exe`. Used only for matching;
 * the original name is preserved for display.
 */
function normalizeName(name: string): string {
  const base = name.trim().toLowerCase().replace(/\\/g, '/').split('/').pop() || '';
  return base.replace(/\.exe$/, '');
}

/**
 * True if `name` is a bare shell (pwsh/powershell/bash/sh/zsh/cmd/...).
 * Case-insensitive and `.exe`-insensitive, tolerant of a full path.
 */
export function isShellName(name: string): boolean {
  if (!name) return false;
  return SHELL_NAMES.has(normalizeName(name));
}

/**
 * Reduce a list of raw foreground-process names to the "meaningful" ones:
 * drop empties, drop bare shells, and de-duplicate (case-insensitively) while
 * preserving first-seen order and original casing.
 */
export function filterMeaningfulProcesses(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    if (!raw) continue;
    const name = raw.trim();
    if (!name) continue;
    if (isShellName(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Given the tabs in display order, the clicked tab id, and a close kind, return
 * the ordered ids of the tabs the action would close. Excludes the clicked tab
 * for `right`/`left`/`others` (browser semantics). Returns `[]` if the clicked
 * tab isn't in the list.
 */
export function computeAffectedTabs(
  orderedTabIds: string[],
  clickedId: string,
  kind: CloseKind,
): string[] {
  const idx = orderedTabIds.indexOf(clickedId);
  if (idx === -1) return [];
  switch (kind) {
    case 'single':
      return [clickedId];
    case 'right':
      return orderedTabIds.slice(idx + 1);
    case 'left':
      return orderedTabIds.slice(0, idx);
    case 'others':
      return orderedTabIds.filter((id) => id !== clickedId);
    default:
      return [];
  }
}
