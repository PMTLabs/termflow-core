import { paneIncarnations } from './paneIncarnations';
import { captureWorkspace, isCurrentWorkspace } from './workspaceReplacement';

/** A gesture/continuation acts on the copy it started with, not a reused durable id. */
export function capturePaneEffect(leaf: string, paneId?: string): () => boolean {
  const workspace = captureWorkspace();
  const client = paneIncarnations;
  const pi = client.capture(leaf, paneId);
  return () => isCurrentWorkspace(workspace) && client === paneIncarnations && !client.ended
    && (!client.enabled || client.isCurrent(leaf, paneId, pi));
}
