import { paneIncarnations, describePanes, accepted, type PaneCapture, type PaneDescriptor } from '../../../services/paneIncarnations';
import { captureWorkspace, isCurrentWorkspace } from '../../../services/workspaceReplacement';
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
import { getCwdSnapshot, setCwdSnapshot } from '../../../services/cwdSnapshot';
import { generateId } from '../../../utils/id';
import { computeZone } from './zone';
import { tabHasNoPanes, getAllTerminalIds } from '../../../store/slices/paneTreeOps';
import { clearSessionClosed } from '../../../store/slices/sessionExitSlice';
import { DetachPayload, DetachTerminal } from './types';

const DETACH_PREFIX = 'detach-';
const sourceReceipts = new Map<string, SourceTransferReceipt>();
const rollbacks = new Map<string, Promise<void>>();
export interface SourceTransferReceipt {
  token: string;
  payload: DetachPayload;
  source: SourceRemoval;
  tabId: string;
  client: typeof paneIncarnations;
  completion: Promise<boolean>;
}
export interface DetachGesture {
  tabId: string;
  source: SourceRemoval;
  client: typeof paneIncarnations;
  current: () => boolean;
}
export interface SourceRemoval {
  workspace: object;
  members: { pane: PaneDescriptor; pi?: PaneCapture; pc?: string }[];
}
export function captureSourceRemoval(tree: PaneNode): SourceRemoval {
  return { workspace: captureWorkspace(), members: describePanes(tree).map(pane => ({
    pane, pi: paneIncarnations.capture(pane.leaf, pane.paneId), pc: terminalService.getProcessId(pane.leaf),
  })) };
}

/** Capture once at pointerdown; payload collection and stash use the same subject. */
export function captureDetachGesture(tabId: string, tree: PaneNode | null): DetachGesture {
  const source = tree ? captureSourceRemoval(tree) : { workspace: captureWorkspace(), members: [] };
  const client = paneIncarnations;
  const tab = store.getState().tabs.tabs.find(tab => tab.id === tabId);
  const current = () => client === paneIncarnations && !client.ended && isCurrentWorkspace(source.workspace)
    && store.getState().tabs.tabs.some(copy => copy.id === tabId && copy.shellType === tab?.shellType)
    && source.members.every(member => sourceMemberCurrent(source, member.pane, member.pi)
      && terminalService.getProcessId(member.pane.leaf) === member.pc
      && describePanes(store.getState().panes.treesByTabId[tabId] ?? null)
        .some(copy => copy.paneId === member.pane.paneId && copy.leaf === member.pane.leaf));
  return { tabId, source, client, current };
}

function sourceMemberCurrent(source: SourceRemoval, pane: PaneDescriptor, pi?: PaneCapture): boolean {
  return isCurrentWorkspace(source.workspace) && !paneIncarnations.ended
    && (!paneIncarnations.enabled || (!!pi && paneIncarnations.capture(pane.leaf, pane.paneId) === pi));
}

/** Remove staged copies, not later siblings or a replacement with the same durable ids. */
function removeQualifiedSource(tabId: string, source: SourceRemoval): void {
  const removed: typeof source.members = [];
  for (const member of source.members) {
    const live = describePanes(store.getState().panes.treesByTabId[tabId] ?? null);
    if (!sourceMemberCurrent(source, member.pane, member.pi)
        || !live.some(pane => pane.paneId === member.pane.paneId && pane.leaf === member.pane.leaf)) continue;
    store.dispatch(removePaneFromTab({ tabId, paneId: member.pane.paneId }));
    removed.push(member);
  }
  if (removed.length && tabHasNoPanes(store.getState().panes.treesByTabId, tabId)) {
    store.dispatch(removeTabTree(tabId));
    store.dispatch(removeTab(tabId));
  }
  const state = store.getState();
  const visible = new Set(state.tabs.tabs.flatMap(tab => getAllTerminalIds(state.panes.treesByTabId[tab.id] ?? null)));
  for (const { pane, pc } of removed) {
    if (visible.has(pane.leaf) || terminalService.getProcessId(pane.leaf) !== pc) continue;
    store.dispatch(clearSessionClosed({ terminalId: pane.leaf }));
    terminalService.detachTerminal(pane.leaf);
  }
}


export async function waitDetachTransfer(token: string): Promise<boolean> {
  return sourceReceipts.get(token)?.completion ?? false;
}

export async function stageDetachPayload(token: string, payload: DetachPayload, gesture?: DetachGesture): Promise<SourceTransferReceipt> {
  if (!paneIncarnations.enabled) throw new Error('transfer requires a desktop page');
  const panes = describePanes(payload.paneTree);
  const tabId = gesture?.tabId ?? store.getState().tabs.tabs.find(tab =>
    describePanes(store.getState().panes.treesByTabId[tab.id] ?? null)
      .some(copy => copy.paneId === panes[0]?.paneId && copy.leaf === panes[0]?.leaf))?.id;
  gesture ??= captureDetachGesture(tabId ?? '', payload.paneTree);
  if (!gesture.current() || panes.length !== gesture.source.members.length
      || !panes.every(pane => gesture.source.members.some(member => member.pane.paneId === pane.paneId && member.pane.leaf === pane.leaf))) {
    throw new Error('transfer gesture replaced');
  }
  const { source, client } = gesture;
  const result = await client.stash(token, panes, payload);
  if (!accepted(result)) throw new Error(`transfer stash ${result.status}`);
  const receipt: SourceTransferReceipt = { token, payload, source, client, tabId: gesture.tabId, completion: Promise.resolve(false) };
  sourceReceipts.set(token, receipt);
  // The successful stash owns a receipt independently of the drag advertisement.
  // Observing the take also covers releases delivered only to another window.
  receipt.completion = client.waitTransfer(token).then(async taken => {
    if (sourceReceipts.get(token) !== receipt) return false;
    if (!taken) { await cancelDetachTransfer(token); return false; }
    sourceReceipts.delete(token);
    if (client === paneIncarnations) removeSourcePane(receipt.tabId, panes[0]?.paneId ?? '', [], source);
    return true;
  }).catch(async error => {
    await cancelDetachTransfer(token);
    throw error;
  });
  void receipt.completion.catch(error => console.warn('Could not observe transfer outcome', error));
  return receipt;
}

export async function cancelDetachTransfer(token: string): Promise<void> {
  const pending = rollbacks.get(token);
  if (pending) return pending;
  const receipt = sourceReceipts.get(token);
  if (!receipt) return;
  const { payload, source, client } = receipt;
  // A build refusal and the expiry notification can race; roll back only once.
  sourceReceipts.delete(token);
  const state = store.getState();
  const present = state.tabs.tabs.flatMap(tab => describePanes(state.panes.treesByTabId[tab.id] ?? null));
  const remaining = describePanes(payload.paneTree).filter(pane => present.some(copy => copy.paneId === pane.paneId && copy.leaf === pane.leaf)
    && source.members.some(member => member.pane.paneId === pane.paneId && sourceMemberCurrent(source, pane, member.pi)));
  const rollback = client.cancel(token, client === paneIncarnations ? remaining : [], new Map(source.members.flatMap(member => member.pc ? [[member.pane.leaf, member.pc] as const] : [])), pane => {
    const current = store.getState();
    return current.tabs.tabs.some(tab => describePanes(current.panes.treesByTabId[tab.id] ?? null)
      .some(copy => copy.paneId === pane.paneId && copy.leaf === pane.leaf));
  });
  rollbacks.set(token, rollback);
  try { await rollback; }
  finally { if (rollbacks.get(token) === rollback) rollbacks.delete(token); }
}

async function installTransferredPayload(token: string, payload: DetachPayload | undefined, install: (payload: DetachPayload) => void): Promise<void> {
  const workspace = captureWorkspace();
  await paneIncarnations.installTransfer(token, (ui, members) => {
    // UI data describes the installation, never the authority to own a shell.
    payload = (ui ?? payload) as DetachPayload | undefined;
    if (!payload?.paneTree || !Array.isArray(payload.terminals)) throw new Error('transfer has no UI payload');
    const leaves = new Set(members.map(member => member.leaf));
    const prune = (node: PaneNode): PaneNode | null => {
      if (node.type === 'terminal') return node.terminalId && leaves.has(node.terminalId) ? node : null;
      const children = node.children?.map(prune).filter((child): child is PaneNode => !!child) ?? [];
      if (children.length === 0) return null;
      if (children.length === 1) return children[0];
      return { ...node, children };
    };
    const tree = prune(payload.paneTree);
    payload = { ...payload, paneTree: tree!, terminals: payload.terminals.filter(terminal => leaves.has(terminal.terminalId)) };
    return describePanes(tree);
  }, async () => {
    install(payload!);
    const members = describePanes(payload!.paneTree).map(pane => ({ pane, pi: paneIncarnations.capture(pane.leaf, pane.paneId) }));
    for (const { pane, pi } of members) {
      const terminal = payload!.terminals.find(t => t.terminalId === pane.leaf);
      if (terminal && pi) {
        if (!isCurrentWorkspace(workspace) || !paneIncarnations.isCurrent(pane.leaf, pane.paneId, pi)) throw new Error('transfer pane replaced');
        const bound = await paneIncarnations.bind(pi, terminal.processId, 'transfer');
        if (!accepted(bound) || !isCurrentWorkspace(workspace) || !paneIncarnations.isCurrent(pane.leaf, pane.paneId, pi)) throw new Error(`transfer bind ${bound.status}`);
      }
    }
  });
}

/** A random transfer token (label-safe: lowercase alphanumerics only). */
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
      const cached = terminalCache.get(node.terminalId);
      const promptGate = cached?.promptGate;
      // Carry the negotiated keyboard-protocol state the same way (see
      // DetachTerminal): a fresh window has no cache entry to adopt it from and
      // no stream will ever replay the handshake.
      const win32InputMode = cached?.win32State?.isActive() === true;
      const keyboardProtocol = cached?.kbState?.serialize();
      const hasKeyboardProtocol = !!keyboardProtocol && (
        keyboardProtocol.mainStack.length > 0
        || keyboardProtocol.altStack.length > 0
        || keyboardProtocol.modifyOtherKeys !== 0
      );
      // Carry the last-known cwd: the snapshot map is module-local to this renderer,
      // so the destination window would otherwise start blind (spec 045 §3.3).
      const cwd = getCwdSnapshot(node.terminalId);
      acc.push({
        terminalId: node.terminalId,
        processId,
        shellType: node.shellType,
        name: node.name,
        ...(zoom !== undefined && zoom !== ZOOM_DEFAULT ? { zoom } : {}),
        ...(promptGate ? { promptGate } : {}),
        ...(win32InputMode ? { win32InputMode: true as const } : {}),
        ...(hasKeyboardProtocol ? { keyboardProtocol } : {}),
        ...(cwd ? { cwd } : {}),
      });
    } else {
      // No live process for this pane — it can't be reattached and will be
      // recreated fresh in the new window. Surface it rather than fail silently.
      console.warn(`Detach: pane ${node.terminalId} has no registered process; it will not carry its session.`);
    }
  }
  node.children?.forEach((c) => collectTerminals(c, acc));
}

async function openWindowWithPayload(payload: DetachPayload, gesture: DetachGesture): Promise<boolean> {
  const api = window.electronAPI;
  if (!api?.createDetachedWindow || !paneIncarnations.enabled) {
    console.warn('Detach: bridge unavailable (not running under Tauri?)');
    return false;
  }
  const token = makeToken();
  try {
    const receipt = await stageDetachPayload(token, payload, gesture);
    await api.createDetachedWindow(token, payload.cursor?.x, payload.cursor?.y);
    return await receipt.completion;
  } catch (error) {
    await cancelDetachTransfer(token);
    throw error;
  }
}

/**
 * Build (but don't stash) a single-pane detach payload from a leaf node.
 *
 * `sourceTabId` is what lets the new tab keep the group's COLOUR. A detached pane becomes a new
 * tab, so it does not inherit the source tab's identity wholesale the way a whole-tab detach
 * does — but the colour is a user-set group appearance, and a pane that changes colour purely by
 * being moved to another window reads as having lost its group rather than as having been moved.
 * Optional so a caller with no source tab (there is none today) still type-checks.
 */
export function buildPaneDetachPayload(
  paneNode: PaneNode,
  cursor?: { x: number; y: number },
  sourceTabId?: string,
): DetachPayload {
  const terminals: DetachTerminal[] = [];
  collectTerminals(paneNode, terminals);
  const sourceTab = sourceTabId
    ? store.getState().tabs.tabs.find((t) => t.id === sourceTabId)
    : undefined;
  return {
    kind: 'pane',
    tabId: generateId('tb'),
    tabTitle: paneNode.name || terminals[0]?.name || 'Terminal',
    paneTree: paneNode,
    terminals,
    cursor,
    titleColor: sourceTab?.titleColor,
    // R8: the pane's OWN elevation, not the source tab's — a pane-only detach
    // gets a new tab identity, and reading it off the node (not a prop passed
    // down separately) is the same "can't disagree" guarantee TerminalPane's
    // two spawn call sites already rely on.
    elevated: paneNode.elevated,
  };
}

/** A fresh transfer token (exposed for the cross-window broker). */
export function newDetachToken(): string {
  return makeToken();
}

/** Remove a just-moved pane from its source tab, closing the tab if it empties. */
export function removeSourcePane(sourceTabId: string, sourcePaneId: string, terminalIds: string[] = [], source?: SourceRemoval): void {
  if (source) {
    removeQualifiedSource(sourceTabId, source);
    return;
  }
  if (paneIncarnations.enabled) return;
  store.dispatch(removePaneFromTab({ tabId: sourceTabId, paneId: sourcePaneId }));
  // Detaching the last pane hands the terminal to another WINDOW, so there is nothing left
  // here to keep the tab open for. `tabHasNoPanes` owns the "is it empty" rule — an emptied
  // tab now keeps its key holding null rather than being deleted.
  if (tabHasNoPanes(store.getState().panes.treesByTabId, sourceTabId)) {
    store.dispatch(removeTab(sourceTabId));
  }
  // Drop this window's mapping for the handed-off terminals (PTY stays alive) — and its
  // session-exit records, by the same rule `removeSourceTab` states: this window no longer has
  // these terminals, so it keeps nothing about them (`plan/024` Req 4).
  //
  terminalIds.forEach((id) => {
    store.dispatch(clearSessionClosed({ terminalId: id }));
    terminalService.detachTerminal(id);
  });
}

/** Detach a single pane (leaf) into a brand-new window, then remove it here. */
export async function detachPaneToNewWindow(opts: {
  sourceTabId: string;
  paneNode: PaneNode;
  cursor?: { x: number; y: number };
  gesture?: DetachGesture;
}): Promise<void> {
  const gesture = opts.gesture ?? captureDetachGesture(opts.sourceTabId, opts.paneNode);
  if (!gesture.current()) return;
  const payload = buildPaneDetachPayload(opts.paneNode, opts.cursor, opts.sourceTabId);
  await openWindowWithPayload(payload, gesture);
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
    notifyMuted: sourceTab?.notifyMuted,
    // R8: same tab, just relocated — the Administrator badge must travel with it.
    elevated: sourceTab?.elevated,
  };
}

/** Remove a handed-off tab from this window (its PTYs live on in the backend). */
export function removeSourceTab(tabId: string, terminalIds: string[], source?: SourceRemoval): void {
  if (source) {
    removeQualifiedSource(tabId, source);
    return;
  }
  if (paneIncarnations.enabled) return;
  // Every terminal that LEAVES this window loses its session-exit record here (`plan/024` Req 4).
  //
  // Detach reaches neither `closePaneNonBlocking` nor `TabManager.closeOneTab`, the two paths
  // that drop a terminal's per-terminal state — and a tab's panes do not all travel:
  // `collectTerminals` carries only those with a live process, so a tab holding one running pane
  // and one whose shell has EXITED hands over the first and simply drops the second. Its record
  // would be stranded in this window with no tab, no pane, and nothing that could ever clear it.
  //
  // ALL of them, carried and stranded alike, rather than only the ones left behind. Today the
  // carried ones are live by construction and so have no record, which makes clearing them a
  // no-op — but "carried implies live" is an invariant of `collectTerminals`, not of this
  // function, and if it ever stopped holding the source window would start leaking again. The
  // rule that needs no invariant is the simpler one: this window no longer has these terminals,
  // so it keeps nothing about them.
  const removed = new Set([
    ...getAllTerminalIds(store.getState().panes.treesByTabId[tabId] ?? null),
    ...terminalIds,
  ]);

  store.dispatch(removeTabTree(tabId));
  store.dispatch(removeTab(tabId));
  removed.forEach((id) => store.dispatch(clearSessionClosed({ terminalId: id })));
  terminalIds.forEach((id) => terminalService.detachTerminal(id));
}

/** Detach an entire tab (its whole pane tree) into a new window. */
export async function detachTabToNewWindow(opts: {
  tabId: string;
  tabTitle: string;
  cursor?: { x: number; y: number };
  gesture?: DetachGesture;
}): Promise<void> {
  const gesture = opts.gesture ?? captureDetachGesture(opts.tabId, store.getState().panes.treesByTabId[opts.tabId] ?? null);
  if (!gesture.current()) return;
  const payload = buildTabDetachPayload(opts.tabId, opts.tabTitle, opts.cursor);
  if (!payload) return;
  await openWindowWithPayload(payload, gesture);
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
  gesture?: DetachGesture;
}): Promise<void> {
  const api = window.electronAPI;
  if (!api?.createDetachedWindow || !paneIncarnations.enabled) {
    console.warn('Tab drop: bridge unavailable (not running under Tauri?)');
    return;
  }
  const gesture = opts.gesture ?? captureDetachGesture(opts.tabId, store.getState().panes.treesByTabId[opts.tabId] ?? null);
  if (!gesture.current()) return;
  const payload = buildTabDetachPayload(opts.tabId, opts.tabTitle, { x: opts.clientX, y: opts.clientY });
  if (!payload) return;
  const isLastTab = store.getState().tabs.tabs.length <= 1;

  const token = newDetachToken();
  const receipt = await stageDetachPayload(token, payload, gesture);

  let reattached = false;
  if (api.resolveTabDrop) {
    try {
      reattached = await api.resolveTabDrop(token, opts.clientX, opts.clientY);
    } catch (e) {
      await cancelDetachTransfer(token);
      throw e;
    }
  }

  if (!reattached) {
    // Released over empty desktop. Detaching the ONLY tab into a fresh window is
    // pointless (it just relocates this window) — snap back and discard.
    if (isLastTab) {
      await cancelDetachTransfer(token);
      return;
    }
    try { await api.createDetachedWindow(token, opts.clientX, opts.clientY); }
    catch (error) { await cancelDetachTransfer(token); throw error; }
  }

  if (!await receipt.completion) return;
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

/**
 * Seed THIS window's single-use keyboard-protocol handoffs for a carried
 * terminal, consumed by its first engine mount here. The PTY negotiated these
 * with the source window and will not announce them again.
 */
function seedKeyboardProtocol(t: DetachTerminal): void {
  if (t.win32InputMode) terminalService.markReattachedSession(t.terminalId);
  if (t.keyboardProtocol) terminalService.stashKeyboardProtocol(t.terminalId, t.keyboardProtocol);
}

/** Target-window handler: take the stashed payload for `token` and add it as a tab. */
export async function applyReattachByToken(token: string): Promise<void> {
  await installTransferredPayload(token, undefined, applyDetachPayload);
}

/**
 * Materialize a detach payload as a new tab in THIS window: attach to the live
 * PTYs first (so panes reuse them), then create the tab + tree and activate it.
 * Shared by detached-window boot and cross-window drops.
 */
export function applyDetachPayload(payload: DetachPayload): void {
  payload.terminals.forEach((t) => {
    terminalService.attachExistingTerminal(t.terminalId, t.processId, t.promptGate);
    seedKeyboardProtocol(t);
    if (typeof t.zoom === 'number') store.dispatch(setZoom({ key: t.terminalId, level: t.zoom }));
    // Seed the last-known cwd into THIS renderer's snapshot map (spec 045 §3.3) —
    // it travelled with the payload because the map doesn't cross windows.
    setCwdSnapshot(t.terminalId, t.cwd);
  });
  store.dispatch(addTab({
    id: payload.tabId,
    title: payload.tabTitle,
    shellType: payload.terminals[0]?.shellType || 'default',
    icon: payload.tabIcon,
    titleIsCustom: payload.titleIsCustom,
    titleColor: payload.titleColor,
    colorSchemaId: payload.colorSchemaId,
    notifyMuted: payload.notifyMuted,
    elevated: payload.elevated,
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
export function applyCrossWindowPayload(payload: DetachPayload, x?: number, y?: number, token?: string): void | Promise<void> {
  if (token) return installTransferredPayload(token, payload, transferred => { applyCrossWindowPayload(transferred, x, y); });
  const target = (typeof x === 'number' && typeof y === 'number') ? resolveLocalTarget(x, y) : null;
  if (!target?.tabId || !target.paneId || payload.kind !== 'pane') {
    applyDetachPayload(payload);
    return;
  }
  payload.terminals.forEach((t) => {
    terminalService.attachExistingTerminal(t.terminalId, t.processId, t.promptGate);
    seedKeyboardProtocol(t);
    if (typeof t.zoom === 'number') store.dispatch(setZoom({ key: t.terminalId, level: t.zoom }));
    // Seed the last-known cwd into THIS renderer's snapshot map (spec 045 §3.3) —
    // it travelled with the payload because the map doesn't cross windows.
    setCwdSnapshot(t.terminalId, t.cwd);
  });

  store.dispatch(insertPaneIntoTab({
    tabId: target.tabId, targetPaneId: target.paneId, zone: target.zone, node: payload.paneTree,
  }));
  store.dispatch(setActiveTab(target.tabId));
  store.dispatch(setActiveTabId(target.tabId));
}

/**
 * On boot of a detached window: fetch the stashed payload, attach to the live
 * PTYs (so panes reuse them instead of spawning), and reconstruct the tab+tree.
 * Returns true if a detached payload was consumed.
 */
export async function reconstructDetachedWindow(): Promise<boolean> {
  const api = window.electronAPI;
  if (!api?.getWindowLabel || !paneIncarnations.enabled) return false;
  const label = api.getWindowLabel();
  if (!label.startsWith(DETACH_PREFIX)) return false;
  const token = label.slice(DETACH_PREFIX.length);
  await installTransferredPayload(token, undefined, applyDetachPayload);
  return true;
}
