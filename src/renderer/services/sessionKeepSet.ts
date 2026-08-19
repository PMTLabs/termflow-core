/**
 * Which terminals' persisted scrollback must survive the restore sweep.
 *
 * `StateManager.restoreState` prunes `history.db` down to the terminals present
 * in the layout it just restored. That was correct while exactly one window
 * ever restored. With per-window sessions (plan 018) it is destructive: N
 * windows boot concurrently, and whichever restores first would delete every
 * OTHER window's scrollback before those windows had read their own session.
 *
 * So the keep-set is the UNION over every window's saved session, not just this
 * window's — which is what `StateManager`'s own comment already required:
 * "must union all windows' live terminals ... first".
 */

import { windowIdFromSessionKey } from './windowScope';

/** The minimum storage surface this module needs; `localStorage` satisfies it. */
export interface KeyValueStore {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

export interface KeepSet {
  ids: Set<string>;
  /**
   * Did EVERY session blob parse?
   *
   * A blob we cannot read is a window whose terminals we cannot name. Pruning
   * on a partial union deletes scrollback that is irrecoverable, so the caller
   * must skip the sweep entirely rather than sweep with a keep-set that is
   * silently missing a window. Absence is invisible — this makes it visible.
   */
  complete: boolean;
  /** How many window sessions contributed. Diagnostics, and testable. */
  windows: number;
}

/**
 * Every terminal id a saved session refers to: each tab's root id, plus every
 * terminal node in every saved pane tree.
 *
 * Leaf ids come in two FORMS naming who minted them — `tb-*` for a renderer
 * tab root, `tm-*` for split panes and API-created terminals — so this walks
 * the trees rather than filtering on a prefix.
 */
export function collectTerminalIds(appState: any, into: Set<string> = new Set()): Set<string> {
  if (!appState || typeof appState !== 'object') return into;
  const tabs = Array.isArray(appState.tabs) ? appState.tabs : [];
  tabs.forEach((t: any) => {
    if (t?.id) into.add(t.id);
  });
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'terminal' && node.terminalId) into.add(node.terminalId);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  Object.values(appState.tabPanes || {}).forEach(walk);
  return into;
}

/**
 * Union the keep-set across every window session belonging to THIS profile.
 *
 * Sibling profiles' keys are excluded by `windowIdFromSessionKey` — sweeping
 * against another instance's terminals would delete live shells' history.
 */
export function unionKeepSet(storage: KeyValueStore): KeepSet {
  const ids = new Set<string>();
  let complete = true;
  let windows = 0;

  // Snapshot the key list first: reading is safe, but callers may delete
  // orphaned keys around this, and indices shift under mutation.
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k !== null) keys.push(k);
  }

  for (const key of keys) {
    if (windowIdFromSessionKey(key) === null) continue;
    windows++;
    const raw = storage.getItem(key);
    if (raw === null) {
      complete = false;
      continue;
    }
    try {
      collectTerminalIds(JSON.parse(raw), ids);
    } catch {
      // A window whose session we cannot read is a window whose terminals we
      // cannot name. Say so; do not quietly contribute nothing.
      console.warn(`sessionKeepSet: could not parse the session at "${key}"; skipping the prune`);
      complete = false;
    }
  }

  return { ids, complete, windows };
}
