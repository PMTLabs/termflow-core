import type { CanvasEdge } from '../store/slices/canvasSlice';
import { capturePaneEffect } from './paneEffect';
import { captureWorkspace, isCurrentWorkspace } from './workspaceReplacement';

/** Graph edits remain leaf intent, but their local completion belongs to this workspace. */
export function captureCanvasEffect(leaves: string[], edge?: CanvasEdge, edges: () => readonly CanvasEdge[] = () => (window as any).__REDUX_STORE__?.getState().canvas.edges ?? []): () => boolean {
  const workspace = captureWorkspace();
  const endpoints = leaves.map(leaf => capturePaneEffect(leaf));
  return () => isCurrentWorkspace(workspace) && endpoints.every(current => current())
    && (!edge || edges().some(current => current === edge));
}
