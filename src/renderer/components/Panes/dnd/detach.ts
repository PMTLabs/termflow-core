import { store } from '../../../store';
import { addTab, setActiveTab, removeTab } from '../../../store/slices/tabsSlice';
import {
  addTabTree,
  removePaneFromTab,
  removeTabTree,
  insertPaneIntoTab,
  setActiveTabId,
  PaneNode,
} from '../../../store/slices/panesSlice';
import { terminalService } from '../../../services/TerminalService';
import { terminalCache } from '@termflow/terminal-core';
import { setZoom, ZOOM_DEFAULT } from '../../../store/slices/zoomSlice';
import { generateId } from '../../../utils/id';
import { computeZone } from './zone';
import { DetachPayload, DetachTerminal } from './types';

const DETACH_PREFIX = 'detach-';

/** A random handoff token (label-safe: lowercase alphanumerics only). */
function makeToken(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 16; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/** Gather every live terminal (id + backend processId) under a pane subtree. */
function collectTerminals(node: PaneNode, acc: DetachTerminal[]): void {
  if (node.type === 'terminal' && node.terminalId) {
    const processId = terminalService.getProcessId(node.terminalId);
    if (processId) {
      // Carry the pane's zoom so it survives the move to another window.
      const zoom = store.getState().zoom.levels[node.terminalId];
      // Carry the LIVE prompt-gate state (kept in sync continuously by the engine,
      // not just at unmount — this pane hasn't unmounted yet at collect time) so an
      // agent CLI still running in the pty isn't miscaptured as command history
      // once reattached in a window with no cache entry of its own.
      const promptGate = terminalCache.get(node.terminalId)?.promptGate;
      acc.push({
        terminalId: node.terminalId,
        processId,
        shellType: node.shellType,
        name: node.name,
        ...(zoom !== undefined && zoom !== ZOOM_DEFAULT ? { zoom } : {}),
        ...(promptGate ? { promptGate } : {}),
      });
    } else {
      // No live process for this pane — it can't be reattached and will be
      // recreated fresh in the new window. Surface it rather than fail silently.
      console.warn(`Detach: pane ${node.terminalId} has no registered process; it will not carry its session.`);
    }
  }
  node.children?.forEach((c) => collectTerminals(c, acc));
}

async function openWindowWithPayload(payload: DetachPayload): Promise<boolean> {
  const api = window.electronAPI;
  if (!api?.stashDetachPayload || !api.createDetachedWindow) {
    console.warn('Detach: bridge unavailable (not running under Tauri?)');
    return false;
  }
  if (payload.terminals.length === 0) return false;
  const token = makeToken();
  await api.stashDetachPayload(token, payload);
  await api.createDetachedWindow(token, payload.cursor?.x, payload.cursor?.y);
  return true;
}

/** Build (but don't stash) a single-pane detach payload from a leaf node. */
export function buildPaneDetachPayload(paneNode: PaneNode, cursor?: { x: number; y: number }): DetachPayload {
  const terminals: DetachTerminal[] = [];
  collectTerminals(paneNode, terminals);
  return {
    kind: 'pane',
    tabId: generateId('tb'),
    tabTitle: paneNode.name || terminals[0]?.name || 'Terminal',
    paneTree: paneNode,
    terminals,
    cursor,
  };
}

/** A fresh handoff token (exposed for the cross-window broker). */
export function newDetachToken(): string {
  return makeToken();
}

/** Remove a just-moved pane from its source tab, closing the tab if it empties. */
export function removeSourcePane(sourceTabId: string, sourcePaneId: string, terminalIds: string[] = []): void {
  store.dispatch(removePaneFromTab({ tabId: sourceTabId, paneId: sourcePaneId }));
  if (store.getState().panes.treesByTabId[sourceTabId] === undefined) {
    store.dispatch(removeTab(sourceTabId));
  }
  // Drop this window's mapping for the handed-off terminals (PTY stays alive).
  terminalIds.forEach((id) => terminalService.detachTerminal(id));
}

/** Detach a single pane (leaf) into a brand-new window, then remove it here. */
export async function detachPaneToNewWindow(opts: {
  sourceTabId: string;
  paneNode: PaneNode;
  cursor?: { x: number; y: number };
}): Promise<void> {
  const payload = buildPaneDetachPayload(opts.paneNode, opts.cursor);
  const ok = await openWindowWithPayload(payload);
  if (!ok) return;
  // The PTY keeps running in the shared backend; just drop the pane from here.
  removeSourcePane(opts.sourceTabId, opts.paneNode.id, payload.terminals.map((t) => t.terminalId));
}

/** Build a whole-tab detach payload from a tab's pane tree, or null if missing. */
export function buildTabDetachPayload(
  tabId: string,
  tabTitle: string,
  cursor?: { x: number; y: number },
): DetachPayload | null {
  const tree = store.getState().panes.treesByTabId[tabId];
  if (!tree) return null;
  const terminals: DetachTerminal[] = [];
  collectTerminals(tree, terminals);
  // Carry the source tab's appearance state along — it's the same tab, just
  // moving to a new window/store, so its icon/title-lock/colors must survive.
  const sourceTab = store.getState().tabs.tabs.find((t) => t.id === tabId);
  return {
    kind: 'tab',
    tabId,
    tabTitle,
    paneTree: tree,
    terminals,
    cursor,
    tabIcon: sourceTab?.icon,
    titleIsCustom: sourceTab?.titleIsCustom,
    titleColor: sourceTab?.titleColor,
    colorSchemaId: sourceTab?.colorSchemaId,
  };
}

/** Remove a handed-off tab from this window (its PTYs live on in the backend). */
export function removeSourceTab(tabId: string, terminalIds: string[]): void {
  store.dispatch(removeTabTree(tabId));
  store.dispatch(removeTab(tabId));
  terminalIds.forEach((id) => terminalService.detachTerminal(id));
}

/** Detach an entire tab (its whole pane tree) into a new window. */
export async function detachTabToNewWindow(opts: {
  tabId: string;
  tabTitle: string;
  cursor?: { x: number; y: number };
}): Promise<void> {
  const payload = buildTabDetachPayload(opts.tabId, opts.tabTitle, opts.cursor);
  if (!payload) return;
  const ok = await openWindowWithPayload(payload);
  if (!ok) return;
  removeSourceTab(opts.tabId, payload.terminals.map((t) => t.terminalId));
}

/**
 * Drop a dragged tab across windows. Asks the backend to hit-test the release
 * point (CLIENT coords in the source window) against every other window: if it
 * lands on one, that window reattaches the tab; otherwise a new window opens.
 * Either way the tab is removed from this (source) window.
 */
export async function dropTabAcrossWindows(opts: {
  tabId: string;
  tabTitle: string;
  clientX: number;
  clientY: number;
}): Promise<void> {
  const api = window.electronAPI;
  if (!api?.stashDetachPayload || !api.createDetachedWindow) {
    console.warn('Tab drop: bridge unavailable (not running under Tauri?)');
    return;
  }
  const payload = buildTabDetachPayload(opts.tabId, opts.tabTitle, { x: opts.clientX, y: opts.clientY });
  if (!payload || payload.terminals.length === 0) return;
  const terminalIds = payload.terminals.map((t) => t.terminalId);
  const isLastTab = store.getState().tabs.tabs.length <= 1;

  const token = newDetachToken();
  await api.stashDetachPayload(token, payload);

  let reattached = false;
  if (api.resolveTabDrop) {
    try {
      reattached = await api.resolveTabDrop(token, opts.clientX, opts.clientY);
    } catch (e) {
      console.error('resolveTabDrop failed', e);
    }
  }

  if (!reattached) {
    // Released over empty desktop. Detaching the ONLY tab into a fresh window is
    // pointless (it just relocates this window) — snap back and discard.
    if (isLastTab) {
      try { await api.takeDetachPayload?.(token); } catch { /* discard stash */ }
      return;
    }
    await api.createDetachedWindow(token, opts.clientX, opts.clientY);
  }

  removeSourceTab(opts.tabId, terminalIds);
  // If that was the last tab, this window is now empty — close it.
  await closeWindowIfEmpty();
}

/** Close the current OS window if it no longer has any tabs (silently, no confirm). */
async function closeWindowIfEmpty(): Promise<void> {
  if (store.getState().tabs.tabs.length > 0) return;
  try {
    // Destroy via the backend (avoids needing the window:allow-destroy capability
    // and bypasses the close-confirm dialog).
    await window.electronAPI?.closeCurrentWindow?.();
  } catch (e) {
    console.error('Failed to close emptied window', e);
  }
}

/** Target-window handler: take the stashed payload for `token` and add it as a tab. */
export async function applyReattachByToken(token: string): Promise<void> {
  const api = window.electronAPI;
  if (!api?.takeDetachPayload) return;
  let payload: DetachPayload | null = null;
  try {
    payload = await api.takeDetachPayload(token);
  } catch (e) {
    console.error('Tab reattach: failed to take payload', e);
    return;
  }
  if (payload) applyDetachPayload(payload);
}

/**
 * Materialize a detach payload as a new tab in THIS window: attach to the live
 * PTYs first (so panes reuse them), then create the tab + tree and activate it.
 * Shared by detached-window boot and cross-window drops.
 */
export function applyDetachPayload(payload: DetachPayload): void {
  payload.terminals.forEach((t) => {
    terminalService.attachExistingTerminal(t.terminalId, t.processId, t.promptGate);
    if (typeof t.zoom === 'number') store.dispatch(setZoom({ key: t.terminalId, level: t.zoom }));
  });
  store.dispatch(addTab({
    id: payload.tabId,
    title: payload.tabTitle,
    shellType: payload.terminals[0]?.shellType || 'default',
    icon: payload.tabIcon,
    titleIsCustom: payload.titleIsCustom,
    titleColor: payload.titleColor,
    colorSchemaId: payload.colorSchemaId,
  }));
  store.dispatch(addTabTree({ tabId: payload.tabId, tree: payload.paneTree }));
  store.dispatch(setActiveTab(payload.tabId));
  store.dispatch(setActiveTabId(payload.tabId));
}

/** True when this window was opened to host a detached tab/pane. */
export function isDetachWindow(): boolean {
  const label = window.electronAPI?.getWindowLabel?.() || 'main';
  return label.startsWith(DETACH_PREFIX);
}

/** Resolve the pane/zone under window-local coords, if any. */
function resolveLocalTarget(x: number, y: number): { tabId: string; paneId: string; zone: ReturnType<typeof computeZone> } | null {
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const paneEl = el?.closest('[data-pane-id]') as HTMLElement | null;
  if (!paneEl) return null;
  const tabEl = paneEl.closest('[data-tab-id]') as HTMLElement | null;
  const r = paneEl.getBoundingClientRect();
  return {
    tabId: tabEl?.getAttribute('data-tab-id') || '',
    paneId: paneEl.getAttribute('data-pane-id') || '',
    zone: computeZone({ left: r.left, top: r.top, width: r.width, height: r.height }, x, y),
  };
}

/**
 * Materialize a payload this window CLAIMED during a cross-window drag: attach to
 * its live PTYs, then insert at the pane/zone under the release point (window-LOCAL
 * coords, which are accurate), or fall back to a new tab when released on the tab
 * bar / empty area or for a whole-tab payload.
 */
export function applyCrossWindowPayload(payload: DetachPayload, x?: number, y?: number): void {
  payload.terminals.forEach((t) => {
    terminalService.attachExistingTerminal(t.terminalId, t.processId, t.promptGate);
    if (typeof t.zoom === 'number') store.dispatch(setZoom({ key: t.terminalId, level: t.zoom }));
  });

  const target = (typeof x === 'number' && typeof y === 'number') ? resolveLocalTarget(x, y) : null;
  if (target && target.tabId && target.paneId && payload.kind === 'pane') {
    store.dispatch(insertPaneIntoTab({
      tabId: target.tabId, targetPaneId: target.paneId, zone: target.zone, node: payload.paneTree,
    }));
    store.dispatch(setActiveTab(target.tabId));
    store.dispatch(setActiveTabId(target.tabId));
  } else {
    applyDetachPayload(payload);
  }
}

/**
 * On boot of a detached window: fetch the stashed payload, attach to the live
 * PTYs (so panes reuse them instead of spawning), and reconstruct the tab+tree.
 * Returns true if a detached payload was consumed.
 */
export async function reconstructDetachedWindow(): Promise<boolean> {
  const api = window.electronAPI;
  if (!api?.getWindowLabel || !api.takeDetachPayload) return false;
  const label = api.getWindowLabel();
  if (!label.startsWith(DETACH_PREFIX)) return false;
  const token = label.slice(DETACH_PREFIX.length);
  let payload: DetachPayload | null = null;
  try {
    payload = await api.takeDetachPayload(token);
  } catch (e) {
    console.error('Detach: failed to take payload', e);
    return false;
  }
  if (!payload) return false;
  // Attach BEFORE any pane mounts so the init guard reuses the live process.
  applyDetachPayload(payload);
  return true;
}
