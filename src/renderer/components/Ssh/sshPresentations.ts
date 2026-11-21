import { useCallback, useSyncExternalStore } from 'react';
import type { SshBrowserController } from './SshFileBrowser';
import type { SshBrowserTagPatch } from './ssh066Contract';

/**
 * What a terminal's pane OWNER shares with its other presentation (plan 070 §4.1 A).
 *
 * The pane owns the one file controller (listing, epoch, Follow-cd subscription, requests) and
 * the tag-patch route. Canvas renders the same shared components around its own terminal slot
 * and reads this instead of building a second controller. Keyed by terminalId, never pane id,
 * and identity-checked on retraction the way `surfaceHosts` is, so an outgoing owner cannot
 * remove its successor's entry.
 */
export interface SshPresentation {
  browser: SshBrowserController;
  onPatchTag(patch: SshBrowserTagPatch): void;
}

const entries = new Map<string, SshPresentation>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Returns the identity-checked retraction. */
export function publishSshPresentation(terminalId: string, presentation: SshPresentation): () => void {
  entries.set(terminalId, presentation);
  notify();
  return () => {
    if (entries.get(terminalId) !== presentation) return;
    entries.delete(terminalId);
    notify();
  };
}

function watchPresentations(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSshPresentation(terminalId: string): SshPresentation | undefined {
  const read = useCallback(() => entries.get(terminalId), [terminalId]);
  return useSyncExternalStore(watchPresentations, read, read);
}

/** Test seam only. */
export function __resetSshPresentationsForTest(): void {
  entries.clear();
  listeners.clear();
}
