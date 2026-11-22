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

/**
 * Whether a Canvas node currently SHOWS this terminal (D51): mounted, not culled and not below
 * the chip tier. Written by the Canvas presentation, read by the pane owner to decide whether
 * the one controller is active. Canvas unmounts with its tab, which retracts the entry.
 * Each publisher holds a unique token, so an outgoing node cannot clear its successor.
 */
const canvasVisible = new Map<string, symbol>();

export function publishSshCanvasVisible(terminalId: string, visible: boolean): () => void {
  const token = Symbol(terminalId);
  if (visible) canvasVisible.set(terminalId, token);
  else if (canvasVisible.has(terminalId)) canvasVisible.delete(terminalId);
  notify();
  return () => {
    if (canvasVisible.get(terminalId) !== token) return;
    canvasVisible.delete(terminalId);
    notify();
  };
}

export function useSshCanvasVisible(terminalId: string): boolean {
  const read = useCallback(() => canvasVisible.has(terminalId), [terminalId]);
  return useSyncExternalStore(watchPresentations, read, read);
}

/** Test seam only. */
export function __resetSshPresentationsForTest(): void {
  entries.clear();
  canvasVisible.clear();
  listeners.clear();
}
