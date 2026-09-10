/**
 * Keeps the backend's `Terminal.title_color` in step with the owning tab's user-set title colour.
 *
 * A colour belongs to the tab, while an API/MCP caller is a durable renderer leaf. Mirroring the
 * leaf -> tab colour association lets the backend include it when a spawn is routed to another
 * window, where the receiving renderer cannot walk the caller's pane tree.
 */
import type { PaneNode } from '../store/slices/panesSlice';
import { diffLeafValues, type LeafValues } from './leafValueDiff';

/** renderer leaf id -> the owning tab's title colour, or '' to clear it. */
export type LeafTitleColors = LeafValues<string>;

interface TabTitleColors {
  id: string;
  titleColor?: string;
}

/**
 * Flatten every tab's pane tree into leaf -> title colour.
 *
 * An uncoloured tab is mapped to the EMPTY STRING rather than omitted: omission means that the
 * leaf left this window, and `diffLeafValues` deliberately does not emit a change for that case.
 */
export function collectLeafTitleColors(
  treesByTabId: Record<string, PaneNode | null>,
  tabs: TabTitleColors[],
): LeafTitleColors {
  const colorByTabId = new Map(tabs.map((tab) => [tab.id, tab.titleColor]));
  const colors: LeafTitleColors = new Map();
  const walk = (node: PaneNode | null | undefined, tabId: string): void => {
    if (!node) return;
    if (node.type === 'terminal' && node.terminalId) {
      colors.set(node.terminalId, colorByTabId.get(tabId) || '');
    }
    node.children?.forEach((child) => walk(child, tabId));
  };
  for (const tabId of Object.keys(treesByTabId)) walk(treesByTabId[tabId], tabId);
  return colors;
}

/**
 * The title-colour pushes this window owes the backend.
 *
 * A leaf seen for the FIRST time with no colour is not worth an invoke — the backend's default
 * is already "no colour", so pushing the clear would fire once per pane at every startup and
 * change nothing. This is the same call `terminalLabelSync` makes with the same predicate.
 * Clearing a colour LATER is a change rather than a first sight, so it still reaches the
 * backend, which is the half that must not be lost.
 */
export function diffTitleColorChanges(
  previous: LeafTitleColors | null,
  next: LeafTitleColors,
): Array<{ rendererTerminalId: string; titleColor: string }> {
  const worthAFirstPush = (id: string): boolean => (next.get(id) ?? '') !== '';
  return diffLeafValues(previous, next, worthAFirstPush).map(({ rendererTerminalId, value }) => ({
    rendererTerminalId,
    titleColor: value,
  }));
}

interface TitleColorSyncStore {
  getState: () => {
    panes: { treesByTabId: Record<string, PaneNode | null> };
    tabs: { tabs: TabTitleColors[] };
  };
  subscribe: (listener: () => void) => () => void;
}

let titleColorStore: TitleColorSyncStore | null = null;
let lastTitleColors: LeafTitleColors | null = null;

function push(rendererTerminalId: string, titleColor: string): void {
  window.electronAPI
    ?.setTerminalTitleColor?.(rendererTerminalId, titleColor)
    ?.catch((e: unknown) => {
      console.warn(`Failed to push title colour ${titleColor} for terminal ${rendererTerminalId}`, e);
    });
}

/** Re-send a leaf's current colour once its PTY is registered. */
export function reassertTitleColorAfterSpawn(rendererTerminalId: string): void {
  if (!titleColorStore) return;
  const state = titleColorStore.getState();
  const titleColor = collectLeafTitleColors(state.panes.treesByTabId, state.tabs.tabs).get(
    rendererTerminalId,
  );
  if (titleColor === undefined) return;
  push(rendererTerminalId, titleColor);
}

/** Watch pane trees and tab colours, pushing only title-colour changes. */
export function attachTerminalTitleColorSync(store: TitleColorSyncStore): () => void {
  titleColorStore = store;
  lastTitleColors = null;
  let lastTrees: Record<string, PaneNode | null> | null = null;
  let lastTabs: TabTitleColors[] | null = null;

  return store.subscribe(() => {
    const { panes, tabs } = store.getState();
    if (panes.treesByTabId === lastTrees && tabs.tabs === lastTabs) return;
    lastTrees = panes.treesByTabId;
    lastTabs = tabs.tabs;

    const next = collectLeafTitleColors(panes.treesByTabId, tabs.tabs);
    const changes = diffTitleColorChanges(lastTitleColors, next);
    lastTitleColors = next;
    for (const change of changes) push(change.rendererTerminalId, change.titleColor);
  });
}
