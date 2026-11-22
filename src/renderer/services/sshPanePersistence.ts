import type { PaneNode } from '../store/slices/panesSlice';
import { normalizeHiddenMetrics, type SshPaneTag } from '../types/ssh';

function readTag(value: unknown): SshPaneTag | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const { connectionId, browserCollapsed, browserPath, followCd, hiddenMetrics } = value as Record<string, unknown>;
  if (typeof connectionId !== 'string' || !connectionId || connectionId !== connectionId.trim()
      || /[\x00-\x1f\x7f]/.test(connectionId)
      || (browserCollapsed !== undefined && typeof browserCollapsed !== 'boolean')
      || (followCd !== undefined && typeof followCd !== 'boolean')
      || (browserPath !== undefined && typeof browserPath !== 'string')) return;

  // Reconstruct the durable fields only. Never admit receipts, credentials or
  // live metrics, and don't discard a reference just because the store changed.
  return {
    connectionId,
    browserCollapsed: browserCollapsed === true,
    ...(typeof browserPath === 'string' ? { browserPath } : {}),
    followCd: followCd === true,
    hiddenMetrics: normalizeHiddenMetrics(hiddenMetrics),
  };
}

/** Clean untrusted persisted SSH fields without projecting the other pane fields. */
export function sanitizePaneSshFields(node: PaneNode): PaneNode {
  const { ssh, sshLaunchConnectionId: _ignored, ...rest } = node as PaneNode & { sshLaunchConnectionId?: unknown };
  if (ssh === undefined) return rest;
  if (rest.type === 'terminal' && rest.terminalId) {
    const tag = readTag(ssh);
    if (tag) return { ...rest, ssh: tag };
  }
  // Never put raw persisted values (possibly credentials) in diagnostics.
  console.warn('Ignoring invalid persisted SSH pane metadata.');
  return rest;
}

export function sanitizePaneTreeSshFields(tree: PaneNode): PaneNode;
export function sanitizePaneTreeSshFields(tree: PaneNode | null): PaneNode | null;
export function sanitizePaneTreeSshFields(tree: PaneNode | null): PaneNode | null {
  if (!tree) return tree;
  const node = sanitizePaneSshFields(tree);
  return Array.isArray(node.children)
    ? { ...node, children: node.children.map(child => sanitizePaneTreeSshFields(child)) }
    : node;
}

export function sanitizePaneTreeMapSshFields(trees: Record<string, PaneNode | null>): Record<string, PaneNode | null> {
  return Object.fromEntries(Object.entries(trees).map(([id, tree]) => [id, sanitizePaneTreeSshFields(tree)]));
}
