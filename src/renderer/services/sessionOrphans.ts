/**
 * Drop session blobs for windows that no longer exist (plan 018 Task 9).
 *
 * Sessions are per-window now, so every window ever closed leaves a
 * `localStorage` entry behind — exactly the unbounded growth `pruneCwds` was
 * added to prevent, reintroduced one level up. The backend registry is the
 * authority on which windows are live; this measures the stored keys against it.
 */

import { windowIdFromSessionKey } from './windowScope';
import type { KeyValueStore } from './sessionKeepSet';

export interface MutableKeyValueStore extends KeyValueStore {
  removeItem(key: string): void;
}

export interface SweepResult {
  removed: string[];
  /** Keys examined and kept. Lets a caller assert coverage, not just deletions. */
  kept: string[];
  /** True when the sweep declined to run (see `liveIds` below). */
  skipped: boolean;
}

/**
 * Remove every session key of THIS profile whose window is not in `liveIds`.
 *
 * `liveIds` empty means "do nothing". An empty list cannot be distinguished
 * from a backend that failed to answer, and treating a failed query as "no
 * windows are live" would delete every session the app has — including the one
 * the current window is about to save into.
 *
 * Sibling profiles' keys are invisible here: `windowIdFromSessionKey` returns
 * null for them, so another instance's sessions can never be swept.
 */
export function sweepOrphanSessions(
  storage: MutableKeyValueStore,
  liveIds: readonly string[],
): SweepResult {
  if (!liveIds || liveIds.length === 0) {
    return { removed: [], kept: [], skipped: true };
  }
  const live = new Set(liveIds);

  // Snapshot the keys before mutating: removeItem shifts every later index.
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k !== null) keys.push(k);
  }

  const removed: string[] = [];
  const kept: string[] = [];
  for (const key of keys) {
    const windowId = windowIdFromSessionKey(key);
    if (windowId === null) continue; // not ours — another profile, or not a session
    if (live.has(windowId)) {
      kept.push(key);
      continue;
    }
    storage.removeItem(key);
    removed.push(key);
  }
  if (removed.length > 0) {
    console.log(`sessionOrphans: dropped ${removed.length} session(s) for closed windows`);
  }
  return { removed, kept, skipped: false };
}
