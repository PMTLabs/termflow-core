/**
 * Shared harness for the plan 070 T4 tests (`sshCanvasInteractions`, `sshCanvasFailures`).
 *
 * The importing test file MUST mock, before importing this module, exactly what
 * `sshCanvasLayout.test.tsx` mocks: `@termflow/terminal-core`, `TerminalContainer`,
 * `services/TerminalService`, `Terminal/useDetectedAgent`, `utils/clipboard`, and
 * `Ssh/ssh066Contract` with `readSshLaunchState` / `readReconnectCoordinator` as jest.fn.
 *
 * It mounts the REAL production pieces: the pane owner (`SshPaneSlot`), `CanvasNode` +
 * `NodeTerminal` + `SshCanvasPresentation` (the wiring `CanvasMode` computes for one SSH node),
 * inside the real `CanvasViewport` with its native capture wheel listener, plus a world-space
 * overlay backdrop shaped like `CanvasMode`'s. Node handlers are spies standing in for
 * `CanvasMode`'s select / drag / enlarge / node-menu / overlay-dismiss callbacks.
 *
 * JSDOM IS NOT A LAYOUT ENGINE. Scroll extents are fixtures (`makeScrollable`); real scrolling is
 * plan 070 T8's engine oracle.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider, useSelector } from 'react-redux';
import { store, type RootState } from '../store';
import { addTabTree, resetPanes } from '../store/slices/panesSlice';
import { sshOwnersChanged, sshSessionObserved } from '../store/slices/sshSessionSlice';
import { CanvasNode } from '../components/Canvas/CanvasNode';
import { NodeTerminal } from '../components/Canvas/NodeTerminal';
import { CanvasViewport } from '../components/Canvas/CanvasViewport';
import { CanvasMetricsContext } from '../components/Canvas/canvasMetricsContext';
import { DEFAULT_METRICS, NODE_H, NODE_W } from '../components/Canvas/canvasGeometry';
import { sshTagsByTerminal, type CanvasNodeModel } from '../components/Canvas/canvasSelectors';
import { SSH_CSS_STATUS_H, sshBrowserAllocation, sshSurfaceBoxFrom } from '../components/Canvas/canvasSshGeometry';
import { SshCanvasPresentation, SshPaneSlot } from '../components/Ssh/SshTerminalComposition';
import { readSshLaunchState } from '../components/Ssh/ssh066Contract';
import { __resetSshPresentationsForTest } from '../components/Ssh/sshPresentations';
import { __resetSurfaceHostsForTest } from '../services/surfaceHosts';
import type { SshSessionView } from '../types/ssh';
import type { RemoteEntry, RemoteListing } from '../components/Ssh/sshFileTypes';
import { sshTag, sshTree } from './sshCanvasFixture';

export const TAB = 'tb-ssh';
export const COMBOS = { enlarge: 'Q', openTab: 'G', leaveTerminal: 'Ctrl+Alt+Q', openTabFromOverlay: 'Ctrl+Alt+G' };
export const BOX = sshSurfaceBoxFrom({ terminal: { w: 1001.53125, h: 603.40625 }, browserW: 260, collapsed: false, statusH: SSH_CSS_STATUS_H, columnGap: 0 });

export const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

export function entry(path: string, kind: RemoteEntry['kind'] = 'file'): RemoteEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, kind, size: '12', mtime: 1_700_000_000, mode: 0o644, uid: 1000, gid: 1000 };
}

/** A deferred reply, so a test can hold an IPC answer across a session change. */
export function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export interface Listings { [terminalId: string]: Record<string, RemoteEntry[]> }

/** The renderer bridge. Every SSH file call is a spy; listings answer from `listings`. */
export function makeBridge(listings: Listings) {
  const ssh = {
    fsList: jest.fn(async (req: { terminalId: string; path: string; expectedGeneration: number }): Promise<RemoteListing> => {
      const entries = listings[req.terminalId]?.[req.path];
      if (!entries) throw { code: 'notFound', operation: 'list', path: req.path, message: 'No such directory', outcome: 'unchanged' };
      return { path: req.path, entries, sessionGeneration: req.expectedGeneration };
    }),
    fsStat: jest.fn(async (req: { path: string }) => ({ ...entry(req.path) })),
    fsInsertPath: jest.fn(async (_req: unknown) => ({ written: true })),
    fsDownload: jest.fn(async (_req: unknown) => ({ status: 'done' as const, localPath: 'C:/dl/x', files: 1, dirs: 0 })),
    fsOpen: jest.fn(), fsOpenWith: jest.fn(),
    fsMkdir: jest.fn(async () => {}), fsCreate: jest.fn(async () => {}),
    fsRename: jest.fn(async () => {}), fsDelete: jest.fn(async () => {}),
    fsChmod: jest.fn(async () => {}), fsChown: jest.fn(async () => {}),
    fsEditList: jest.fn(async () => []),
    onFsEditState: jest.fn(async () => () => {}),
    onFsCwd: jest.fn(async () => () => {}),
  };
  return {
    ssh,
    sshSessionTrustHost: jest.fn(async () => {}),
    sshSessionSubmitSecret: jest.fn(async () => {}),
    sshSessionOpen: jest.fn(), sshSessionClose: jest.fn(), sshSessionReconnect: jest.fn(),
    setConfigValue: jest.fn(),
    // The GENERIC renderer PTY write. SSH insertion must never use it.
    writeToTerminal: jest.fn(),
  };
}
export type Bridge = ReturnType<typeof makeBridge>;

const originalBridge = Object.getOwnPropertyDescriptor(window, 'electronAPI');
export function installBridge(bridge: Bridge) {
  Object.defineProperty(window, 'electronAPI', { value: bridge, configurable: true });
}
function restoreBridge() {
  if (originalBridge) Object.defineProperty(window, 'electronAPI', originalBridge);
  else Reflect.deleteProperty(window, 'electronAPI');
}

/** Launch seam per terminal: `{ id: generation }` means typed+running on that generation. */
export function setLaunch(byTerminal: Record<string, number | undefined>) {
  jest.mocked(readSshLaunchState).mockImplementation((_state, id) => {
    const generation = byTerminal[id];
    return generation === undefined ? undefined
      : { stage: 'running', sessionGeneration: generation, launchSeq: generation, revision: 1 };
  });
}

export function observe(view: Partial<SshSessionView> & { terminalId: string; state: SshSessionView['state']; generation: number; revision: number }) {
  act(() => { store.dispatch(sshSessionObserved({ connectionId: 'conn-shared', gate: 'verified', ...view })); });
}

/** Tags the leaves (066 shape, read through the seam) and registers them as session owners. */
export function seedTerminals(tags: Record<string, Partial<ReturnType<typeof sshTag>>>) {
  const ids = Object.keys(tags);
  act(() => {
    store.dispatch(addTabTree({ tabId: TAB, tree: sshTree(ids.map(terminalId => ({ terminalId, ssh: sshTag(tags[terminalId]) }))) }));
    store.dispatch(sshOwnersChanged(Object.fromEntries(ids.map(id => [id, 'conn-shared']))));
  });
}

export interface NodeSpies {
  select: jest.Mock; drag: jest.Mock; enlarge: jest.Mock; nodeMenu: jest.Mock;
  dismissOverlay: jest.Mock; background: jest.Mock; backgroundMenu: jest.Mock;
}
export function nodeSpies(): NodeSpies {
  return {
    select: jest.fn(), drag: jest.fn(), enlarge: jest.fn(), nodeMenu: jest.fn(),
    dismissOverlay: jest.fn(), background: jest.fn(), backgroundMenu: jest.fn(),
  };
}

const nodeModel = (terminalId: string): CanvasNodeModel => ({
  terminalId, tabId: TAB, paneId: `pn-${terminalId}`, title: terminalId, groupTitle: 'ssh', shellType: 'bash',
  rect: { x: 0, y: 0, w: NODE_W, h: NODE_H }, isRunning: false, hasUnseenOutput: false, exited: false, hidden: false,
});

/** `CanvasMode`'s SSH node wiring, with spies for the callbacks it would dispatch. */
function SshCanvasNode({ id, spies, focused }: { id: string; spies: NodeSpies; focused: boolean }) {
  const tag = useSelector((s: RootState) => sshTagsByTerminal(s.panes.treesByTabId)[id]);
  return <CanvasNode node={nodeModel(id)} tier="live" zoom={1} selected={false} focused={focused}
    dimmed={false} hidden={false} nodeHidden={false} busyCue="pulse" overlaid={false} combos={COMBOS}
    hostBox={BOX.initialTerminal} sshEnvelope={tag ? BOX.envelope : undefined}
    onPointerDown={() => spies.select(id)} onHeaderPointerDown={() => spies.drag(id)}
    onDoubleClick={() => spies.enlarge(id)}
    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); spies.nodeMenu(id); }}>
    <NodeTerminal terminalId={id} focused={focused}
      sshTag={tag} sshBrowserWidth={tag ? sshBrowserAllocation(BOX, tag.browserCollapsed) : undefined}
      SshShell={tag ? SshCanvasPresentation : undefined} />
  </CanvasNode>;
}

/**
 * Pane owners for `ids` (always mounted, one stable tree) and, when `canvas`, the Canvas viewport
 * with one SSH node per id and the overlay backdrop.
 */
export function SshScene({ ids, canvas, spies, focusedId = null }: {
  ids: string[]; canvas: boolean; spies: NodeSpies; focusedId?: string | null;
}) {
  return <>
    {ids.map(id => <div key={id} className="pane-probe" data-pane={id}>
      <SshPaneSlot terminalId={id} isTabActive={!canvas}>
        <div className="terminal-pane-content"><div className="terminal-display" data-probe={`pane-host-${id}`} /></div>
      </SshPaneSlot>
    </div>)}
    {canvas ? <CanvasViewport zoomAtAnchor={(vp, factor) => ({ ...vp, z: vp.z * factor })}
      onBackgroundPointerDown={spies.background} onBackgroundContextMenu={spies.backgroundMenu}>
      {/* `CanvasMode`'s overlay backdrop: a world-space SIBLING with its own pointer handler. */}
      <div className="canvas-overlay-backdrop" onPointerDown={(e) => { e.stopPropagation(); spies.dismissOverlay(); }} />
      {ids.map(id => <SshCanvasNode key={id} id={id} spies={spies} focused={focusedId === id} />)}
    </CanvasViewport> : null}
  </>;
}

export interface Harness { container: HTMLDivElement; root: Root; render(ui: React.ReactNode): Promise<void> }

export function setupHarness(): Harness {
  const h = {} as Harness;
  beforeAll(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    __resetSurfaceHostsForTest();
    __resetSshPresentationsForTest();
    store.dispatch(resetPanes());
    store.dispatch(sshOwnersChanged({}));
    jest.mocked(readSshLaunchState).mockReset();
    document.body.innerHTML = '';
    h.container = document.createElement('div');
    document.body.appendChild(h.container);
    h.root = createRoot(h.container);
    h.render = async (ui) => {
      await act(async () => {
        h.root.render(<Provider store={store}><CanvasMetricsContext.Provider value={DEFAULT_METRICS}>{ui}</CanvasMetricsContext.Provider></Provider>);
        await flush();
      });
    };
  });
  afterEach(() => {
    act(() => h.root.unmount());
    h.container.remove();
    store.dispatch(resetPanes());
    store.dispatch(sshOwnersChanged({}));
    restoreBridge();
  });
  return h;
}

/** Elements of one presentation of `id`. */
export function canvasNode(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`.canvas-node[data-terminal-id="${id}"]`)!;
}
export function paneShell(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-pane="${id}"] .ssh-pane-shell`)!;
}
export function rowButton(scope: ParentNode, path: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('.ssh-file-name')].find(b => b.title === path);
  if (!button) throw new Error(`no row for ${path}`);
  return button;
}
export function rowOf(scope: ParentNode, path: string): HTMLElement {
  return rowButton(scope, path).closest<HTMLElement>('.ssh-file-row')!;
}
export function menuItem(label: string): HTMLButtonElement {
  const item = [...document.querySelectorAll<HTMLButtonElement>('.context-menu .context-menu-item')]
    .find(b => b.querySelector('.context-menu-label')?.textContent === label);
  if (!item) throw new Error(`no menu item ${label}`);
  return item;
}

export function mouse(target: Element, type: string, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 40, clientY: 50, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}

export async function openRowMenu(scope: ParentNode, path: string) {
  await act(async () => {
    rowOf(scope, path).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 123, clientY: 77 }));
    await flush();
  });
}

export async function clickAsync(target: HTMLElement) {
  await act(async () => { target.click(); await flush(); });
}

/** Fixture scroll extents: jsdom computes none. */
export function makeScrollable(el: HTMLElement, o: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  for (const [key, value] of Object.entries(o)) Object.defineProperty(el, key, { value, configurable: true, writable: true });
  for (const key of ['scrollWidth', 'clientWidth', 'scrollLeft']) Object.defineProperty(el, key, { value: 0, configurable: true, writable: true });
}

export function successToasts(): string[] {
  return store.getState().ui.toasts.filter(t => t.type === 'success').map(t => t.message);
}
export function errorToasts(): string[] {
  return store.getState().ui.toasts.filter(t => t.type === 'error').map(t => t.message);
}

export { store };
