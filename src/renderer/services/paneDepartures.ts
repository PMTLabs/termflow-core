import type { PaneNode } from '../store/slices/panesSlice';

let replacementDepth = 0;
const replacementSettled = new Set<() => void>();
export function beginPaneReplacement(): void { replacementDepth++; }
export function endPaneReplacement(): void {
  replacementDepth--;
  if (replacementDepth === 0) replacementSettled.forEach(schedule => schedule());
}

function leaves(trees: Record<string, PaneNode | null>): Set<string> {
  const result = new Set<string>();
  const walk = (node: PaneNode | null): void => {
    if (!node) return;
    if (node.terminalId) result.add(node.terminalId);
    node.children?.forEach(walk);
  };
  Object.values(trees).forEach(walk);
  return result;
}

/** Tree writes share one departure choke point. Coalesce synchronous regrouping
 * so a leaf moved between tabs in this window keeps its binding. */
export function attachPaneDepartureSync(
  store: { getState(): { panes: { treesByTabId: Record<string, PaneNode | null> } }; subscribe(fn: () => void): () => void },
  detach: (leaf: string) => void,
): () => void {
  let previous = leaves(store.getState().panes.treesByTabId);
  let scheduled = false;
  let disposed = false;
  const schedule = () => {
    for (const leaf of leaves(store.getState().panes.treesByTabId)) previous.add(leaf);
    if (scheduled || replacementDepth > 0) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (disposed || replacementDepth > 0) return;
      const current = leaves(store.getState().panes.treesByTabId);
      for (const leaf of previous) if (!current.has(leaf)) detach(leaf);
      previous = current;
    });
  };
  const unsubscribe = store.subscribe(schedule);
  replacementSettled.add(schedule);
  return () => { disposed = true; unsubscribe(); replacementSettled.delete(schedule); };
}
