import type { SshAPI, SshMetricsAPI } from '../types/ssh';
import type { PaneNode } from '../store/slices/panesSlice';
import { installSshMetricsWatch } from './sshMetricsWatch';
import { sshOwnersChanged, sshSessionObserved } from '../store/slices/sshSessionSlice';

// Ownership follows the authoritative tagged leaves, not the active tab.
export function sshOwnersFromTrees(trees: Record<string, PaneNode | null>): Record<string, string> {
  const owners: Record<string, string> = {};
  const visit = (node: PaneNode | null) => {
    if (!node) return;
    if (node.type === 'terminal' && node.terminalId && node.ssh?.connectionId) owners[node.terminalId] = node.ssh.connectionId;
    node.children?.forEach(visit);
  };
  Object.values(trees).forEach(visit); return owners;
}
interface StoreLike {
  getState(): { panes: { treesByTabId: Record<string, PaneNode | null> } };
  dispatch(action: ReturnType<typeof sshOwnersChanged> | ReturnType<typeof sshSessionObserved>): unknown;
  subscribe(listener: () => void): () => void;
}
// Bootstrap only: React's effect replay must not duplicate native subscriptions.
let activeStartup: (() => void) | undefined;
export function installSshSessionStartup(
  store: StoreLike & Parameters<typeof installSshMetricsWatch>[0],
  api: (SshAPI & SshMetricsAPI) | undefined,
  page?: Parameters<typeof installSshMetricsWatch>[2],
): () => void {
  if (activeStartup) return () => {};
  const stopMetrics = installSshMetricsWatch(store, api, page);
  const stopSession = installSshSessionEvents(store, api);
  const stop = () => {
    if (activeStartup !== stop) return;
    activeStartup = undefined;
    window.removeEventListener('pagehide', stop);
    stopSession();
    stopMetrics();
  };
  activeStartup = stop;
  window.addEventListener('pagehide', stop);
  return stop;
}

export function installSshSessionEvents(store: StoreLike, api: SshAPI | undefined): () => void {
  if (!api || typeof api.onSshSessionState !== 'function') return () => {};
  let disposed = false, unlisten: (() => void) | undefined, unsubscribe: (() => void) | undefined;
  let previous: Record<string, string> = {};
  const hydrate = (id: string) => { void api.sshSessionState(id).then(view => { if (!disposed) store.dispatch(sshSessionObserved(view)); }).catch(() => { /* absent is not connected */ }); };
  const sync = () => {
    const next = sshOwnersFromTrees(store.getState().panes.treesByTabId);
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    const old = previous; previous = next;
    store.dispatch(sshOwnersChanged(next));
    for (const id of Object.keys(next)) if (old[id] !== next[id]) hydrate(id);
  };
  // Listener MUST be ready before snapshots. Reducer identity/order checks also
  // fence delayed snapshots and unknown-terminal/cross-window events.
  void api.onSshSessionState(view => { if (!disposed) store.dispatch(sshSessionObserved(view)); }).then(stop => {
    if (disposed) { stop(); return; }
    unlisten = stop; unsubscribe = store.subscribe(sync); sync();
  }).catch(() => { /* browser bridge is explicitly desktop-only */ });
  return () => { if (disposed) return; disposed = true; unsubscribe?.(); unlisten?.(); };
}
