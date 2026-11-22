/** @jest-environment jsdom */
/** `tauri-bridge` registers listeners at module load and dies outside a Tauri WebView; the tests
 * install their own `window.electronAPI`. TerminalDisplay reads only the Windows build number. */
jest.mock('../../../api/tauri-bridge', () => ({ __esModule: true, default: {}, getWindowsBuildNumber: () => 0 }));
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, useSelector } from 'react-redux';
import { cleanupTerminalCache } from '@termflow/terminal-core';
import { store, type RootState } from '../../../store';
import { addTabTree, movePaneWithinTab, removePaneFromTab, resetPanes, setActiveTabId, splitPane, splitPaneInTab, type PaneNode } from '../../../store/slices/panesSlice';
import { addTab, clearAllTabs, setActiveTab } from '../../../store/slices/tabsSlice';
import { clearSessionClosed } from '../../../store/slices/sessionExitSlice';
import { findLeafByTerminalId, getPaneLeaves } from '../../../store/slices/paneTreeOps';
import { expectPaneTags, pane, sentinel, other, split, tags } from '../../../__testFixtures__/sshPaneCensus';
import { sshTwoWindowBridge } from '../../../__testFixtures__/sshTwoWindowBridge';
import { installRestoreStream } from '../../../__testFixtures__/paneRestoreBridge';
import { buildCanvasModel, sshTagsByTerminal } from '../../Canvas/canvasSelectors';
import { NodeTerminal } from '../../Canvas/NodeTerminal';
import { SshCanvasPresentation, SshPaneSlot } from '../SshTerminalComposition';
import { useSurfaceRelocation } from '../../Terminal/useSurfaceRelocation';
import { forgetRemoteHint } from '../../Terminal/remoteSuggestHint';
import { CANVAS_SHELL_TYPE } from '../../../services/tabKinds';
import { openCanvasTab, leaveCanvasTab } from '../../../services/openCanvas';
import { installSshSessionEvents } from '../../../services/sshSessionEvents';
import { observeOwnedSshLaunch, type OwnedSshLaunchApi } from '../../../services/sshLaunchAttempt';
import { installPaneIncarnations, PaneIncarnations, type PaneBridge, type PaneRequest, type PaneResult } from '../../../services/paneIncarnations';
import { terminalService } from '../../../services/TerminalService';
import { clearCwdSnapshot } from '../../../services/cwdSnapshot';
import { splitPaneById, splitTabPane } from '../../../services/paneActions';
import { closePaneNonBlocking } from '../../../services/paneClose';
import { clearTabPanesInPlace, getTabPanesGlobal } from '../../../services/tabPanesStore';
import { StateManager } from '../../../services/StateManager';
import { __resetApiBaseForTests } from '../../../api/apiBase';
import { sessionStateKey } from '../../../services/windowScope';
import { applyReattachByToken, buildPaneDetachPayload, buildTabDetachPayload, cancelDetachTransfer, stageDetachPayload } from '../../Panes/dnd/detach';
import type { DetachPayload } from '../../Panes/dnd/types';
import type { SshAPI, SshReply, SshSessionView } from '../../../types/ssh';

const TAB = 'tb-owner', BACK = 'tb-background', CANVAS = 'tb-canvas';
const SSH = 'tm-ssh', OTHER = 'tm-other', LOCAL = 'tm-local';
const trees = () => store.getState().panes.treesByTabId;
const leaf = () => findLeafByTerminalId(trees(), SSH)!;
const activate = (id: string) => { store.dispatch(setActiveTab(id)); store.dispatch(setActiveTabId(id)); };
const put = (id: string, tree: PaneNode | null, shellType = 'default') => {
  store.dispatch(addTabTree({ tabId: id, tree }));
  store.dispatch(addTab({ id, title: id, shellType, icon: '' }));
};
function clearWorkspace() {
  store.dispatch(clearAllTabs());
  store.dispatch(resetPanes());
  clearTabPanesInPlace();
}

type Registry = Record<string, Pick<SshSessionView, 'connectionId' | 'state'>>;
const expected: Registry = {
  [SSH]: { connectionId: sentinel.connectionId, state: 'connected' },
  [OTHER]: { connectionId: other.connectionId, state: 'connecting' },
};
function expectRegistry(actual: Registry, wanted: Registry) { expect(actual).toStrictEqual(wanted); }
const registry = (views: Record<string, SshSessionView> | Map<string, SshSessionView>): Registry =>
  Object.fromEntries((views instanceof Map ? [...views] : Object.entries(views))
    .map(([id, { connectionId, state }]) => [id, { connectionId, state }]));
const renderedSessions = () => registry(Object.fromEntries(Object.entries(store.getState().sshSession.byTerminal)
  .flatMap(([id, owner]) => owner.session ? [[id, owner.session] as const] : [])));

// Only the terminal pixels are a DOM fixture. The production hook moves the same element
// between the real pane composition and NodeTerminal's registered host (no xterm layout in jsdom).
function PaneSurface({ active, surface }: { active: boolean; surface: HTMLElement }) {
  const paneRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef({ relocateTo(target: HTMLElement) { target.appendChild(surface); return 'relocated' as const; } });
  useSurfaceRelocation({ terminalId: SSH, paneRef, engineRef, onRelocated() {}, onAborted() {} });
  return <SshPaneSlot terminalId={SSH} isTabActive={active}><div data-home ref={paneRef} /></SshPaneSlot>;
}

function Presentations({ surface }: { surface: HTMLElement }) {
  const state = useSelector((s: RootState) => s);
  const node = buildCanvasModel(state).nodes.find(n => n.terminalId === SSH);
  if (!node) return null;
  const active = state.tabs.activeTabId;
  return <>
    <PaneSurface surface={surface} active={active === node.tabId} />
    {active === CANVAS && <section data-canvas-node={node.terminalId}>
      <NodeTerminal terminalId={node.terminalId} focused={false}
        sshTag={sshTagsByTerminal(state.panes.treesByTabId)[node.terminalId]} SshShell={SshCanvasPresentation} />
    </section>}
  </>;
}

function fixture(presentation: 'tab' | 'Canvas') {
  const backend = sshTwoWindowBridge({ revision: 1, view: {
    revision: 1, connections: [], folders: [], loadError: null,
  } } satisfies SshReply, (id, connectionId) => findLeafByTerminalId(trees(), id)?.ssh?.connectionId === connectionId);
  const wait = backend.held;
  const staged = new Map<string, Extract<PaneResult, { status: 'Taken' }>['payload']>();
  const paneOps: PaneRequest['op'][] = [];
  const fallbackClose = jest.fn(async () => true);
  const directClose = jest.fn(async () => {});
  const { B: { api, emit } } = backend;
  let pg = 40;
  const bridge = (async (command: string, args?: Record<string, unknown>) => {
    if (command === 'register_page') return { status: 'Registered', wi: 2, pg: ++pg };
    if (command === 'wait_transfer_taken') return wait.command(`transfer:${args!.tx}`)();
    if (command === 'pane_op') {
      const op = (args!.request as PaneRequest).op;
      paneOps.push(op);
      const ack = (result: PaneResult) => ({ status: 'Ack', result });
      if (op.kind === 'stash') staged.set(op.tx, JSON.parse(JSON.stringify({ panes: op.pairs, ui: op.ui })));
      if (op.kind === 'cancel') staged.delete(op.tx);
      if (op.kind === 'take') {
        const payload = staged.get(op.tx);
        if (!payload) return ack({ status: 'Rejected', message: 'no transferable owner' });
        staged.delete(op.tx);
        return ack({ status: 'Taken', payload });
      }
    }
    return (api.paneInvoke as (command: string, args?: unknown) => Promise<unknown>)(command, args);
  }) as PaneBridge;
  const desktop = { ...api, paneInvoke: bridge, closeTerminal: fallbackClose, sshSessionClose: directClose };
  const before = Object.getOwnPropertyDescriptor(window, 'electronAPI');
  Object.defineProperty(window, 'electronAPI', { value: desktop, configurable: true });
  const newPage = () => {
    const page = new PaneIncarnations(bridge);
    installPaneIncarnations(page);
    page.attachStore(store);
    return page;
  };
  let page = newPage();
  const stop = installSshSessionEvents(store, desktop as unknown as SshAPI);
  const container = document.body.appendChild(document.createElement('div'));
  const surface = document.createElement('div');
  const root = createRoot(container);
  const settle = async () => { expect(await page.send({ kind: 'settle' })).toEqual({ status: 'Ok' }); };
  const exact = (wanted = expected) => expectRegistry(registry(backend.sessions), wanted);
  const lifecycle = () => backend.invokes.filter(call => ['ssh_session_open', 'ssh_terminal_launch', 'write_to_terminal'].includes(call.command));
  const enterCanvas = () => {
    openCanvasTab();
    expect(store.getState().tabs.activeTabId).toBe(CANVAS);
    store.dispatch(setActiveTabId(CANVAS));
  };
  const show = (owner = TAB) => {
    if (presentation === 'Canvas') enterCanvas();
    else activate(owner);
  };
  const query = async () => terminalService.querySshLaunch(SSH, leaf().id, page.capture(SSH, leaf().id)!,
    terminalService.getProcessId(SSH)!, sentinel.connectionId, () => true);
  const assertSurface = (canvas: boolean) => {
    const host = container.querySelector(canvas ? `[data-canvas-node="${SSH}"] .terminal-display` : '[data-home]');
    expect(host).not.toBeNull();
    expect(surface.parentElement).toBe(host);
  };
  return {
    backend, emit, paneOps, exact, lifecycle, settle, show, enterCanvas, assertSurface, query, fallbackClose, directClose,
    async start() {
      put(TAB, split('group', pane('ssh', sentinel), pane('local')));
      put(BACK, pane('other', other));
      put(CANVAS, null, CANVAS_SHELL_TYPE);
      activate(TAB);
      await settle();
      for (const [id, connectionId] of [[SSH, sentinel.connectionId], [OTHER, other.connectionId]]) {
        const pc = await api.paneInvoke('create_admitted_terminal', { request: { pg: 41, cg: 1, leaf: id, profile: 'default' } });
        terminalService.registerExistingTerminal(id, pc);
        backend.opening({ state: expected[id].state });
        const owner = page.capture(id)!;
        const launch = await observeOwnedSshLaunch(desktop as unknown as OwnedSshLaunchApi, {
          terminalId: id, connectionId, processIncarnation: pc, owner,
          current: () => page.capture(id) === owner && terminalService.getProcessId(id) === pc,
        }, 'open');
        expect(launch?.snapshot?.stage).toBe('typed');
      }
      show();
      root.render(<Provider store={store}><Presentations surface={surface} /></Provider>);
    },
    async transfer(token: string, payload: DetachPayload, owner: string) {
      const receipt = await stageDetachPayload(token, payload);
      exact();
      expectPaneTags(Object.values(trees()), tags, [LOCAL]);
      await settle();
      expect(wait.calls(`transfer:${token}`)).toEqual([[]]);
      // The broker's successful take notification retires the source before the receiving
      // page installs the JSON. Reuse the singleton store serially, not two owners of one id.
      wait.release(`transfer:${token}`, 0, true);
      expect(await receipt.completion).toBe(true);
      expectPaneTags(Object.values(trees()), { [OTHER]: other }, [LOCAL]);
      exact();
      page = newPage();
      const firstOp = paneOps.length;
      await applyReattachByToken(token);
      expect(paneOps.slice(firstOp).filter(op => op.kind === 'adopt').map(op => [op.tx, op.pairs.map(p => p.leaf)])).toEqual([[token, [SSH]]]);
      show(owner);
      await settle();
      expectPaneTags(Object.values(trees()), tags, [LOCAL]);
      exact();
    },
    async refuse(token: string, payload: DetachPayload) {
      const receipt = await stageDetachPayload(token, payload);
      exact();
      expectPaneTags(Object.values(trees()), tags, [LOCAL]);
      await cancelDetachTransfer(token);
      wait.release(`transfer:${token}`, 0, false);
      expect(await receipt.completion).toBe(false);
      await expect(applyReattachByToken(token)).rejects.toThrow(/transfer/i);
      await settle();
      exact();
      expectPaneTags(Object.values(trees()), tags, [LOCAL]);
    },
    async toggleBrowser(expectedCollapsed: boolean) {
      const scope = presentation === 'Canvas' ? container.querySelector(`[data-canvas-node="${SSH}"]`) : container;
      const button = scope?.querySelector<HTMLButtonElement>('.ssh-browser-toggle');
      expect(button?.getAttribute('aria-expanded')).toBe(String(expectedCollapsed));
      await act(async () => button!.click());
      expectPaneTags(Object.values(trees()), { ...tags, [SSH]: { ...sentinel, browserCollapsed: expectedCollapsed } }, [LOCAL]);
      exact();
    },
    async dispose() {
      await act(async () => root.unmount());
      stop();
      installPaneIncarnations(new PaneIncarnations());
      for (const id of [SSH, OTHER, LOCAL]) terminalService.detachTerminal(id);
      clearWorkspace();
      if (before) Object.defineProperty(window, 'electronAPI', before);
      else Reflect.deleteProperty(window, 'electronAPI');
      container.remove();
    },
  };
}

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; clearWorkspace(); localStorage.clear(); });
afterEach(() => { localStorage.clear(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });

describe.each(['tab', 'Canvas'] as const)('%s presentation', presentation => {
  let h: ReturnType<typeof fixture>;
  beforeEach(async () => {
    h = fixture(presentation);
    await act(async () => h.start());
    h.assertSurface(presentation === 'Canvas');
    h.exact();
    expectRegistry(renderedSessions(), expected);
    expect(h.lifecycle().map(({ command, args }) => [command, args?.terminalId])).toEqual([
      ['ssh_session_open', SSH], ['ssh_terminal_launch', SSH],
      ['ssh_session_open', OTHER], ['ssh_terminal_launch', OTHER],
    ]);
  });
  afterEach(async () => h.dispose());

  function noClose() {
    expect(h.paneOps.filter(op => op.kind === 'close')).toEqual([]);
    expect(h.directClose).not.toHaveBeenCalled();
    expect(h.fallbackClose).not.toHaveBeenCalled();
  }

  test('sshIdentity_swapLocalAndSsh_carriesAndClearsTag', async () => {
    const before = h.lifecycle();
    const oldSlot = leaf().id;
    await act(async () => {
      store.dispatch(movePaneWithinTab({ tabId: TAB, sourcePaneId: oldSlot, targetPaneId: 'pn-local', zone: 'center' }));
      await h.settle();
    });
    expect(leaf().id).toBe('pn-local');
    expect(findLeafByTerminalId(trees(), LOCAL)?.id).toBe(oldSlot);
    expectPaneTags(Object.values(trees()), tags, [LOCAL]);
    h.assertSurface(presentation === 'Canvas');
    h.exact();
    expectRegistry(renderedSessions(), expected);
    expect(h.lifecycle()).toEqual(before);
    noClose();
  });

  const uiCases = ['before', 'after', 'tab-menu-before', 'tab-menu-after'];
  const splitCases = presentation === 'Canvas' ? ['scoped', ...uiCases] : ['active', 'scoped', ...uiCases];
  test.each(splitCases.flatMap(route => (['horizontal', 'vertical'] as const).map(direction => ({ route, direction }))))(
    'sshIdentity_splitKeepsOriginalSsh_newLeafLocal ($route $direction)', async ({ route, direction }) => {
      const before = h.lifecycle();
      const args = { paneId: leaf().id, direction };
      const specified = 'tm-sibling';
      const position = route.endsWith('before') ? 'before' : 'after';
      await act(async () => {
        if (route === 'active') store.dispatch(splitPane({ ...args, terminalId: specified }));
        else if (route === 'scoped') store.dispatch(splitPaneInTab({ ...args, tabId: TAB, terminalId: specified }));
        else if (route.startsWith('tab-menu')) splitTabPane(TAB, direction, position);
        else await splitPaneById(args.paneId, direction, position);
        await h.settle();
      });
      const subtree = trees()[TAB]?.children?.[0];
      expect(subtree).toMatchObject({ type: 'split', direction });
      const ids = getPaneLeaves(subtree).map(node => node.terminalId);
      const sibling = ids[position === 'before' ? 0 : 1]!;
      expect(sibling).toMatch(/^tm-/);
      expect(sibling).not.toBe(SSH);
      if (route === 'active' || route === 'scoped') expect(sibling).toBe(specified);
      expect(ids).toEqual(position === 'before' ? [sibling, SSH] : [SSH, sibling]);
      expect(store.getState().panes.paneTree).toEqual(presentation === 'Canvas' ? null : trees()[TAB]);
      expectPaneTags(Object.values(trees()), tags, [LOCAL, sibling]);
      h.assertSurface(presentation === 'Canvas');
      h.exact();
      expectRegistry(renderedSessions(), expected);
      expect(h.lifecycle()).toEqual(before);
      noClose();
    },
  );

  test('sshIdentity_transferAndRestore_keepAllFivePreferences', async () => {
    const before = h.lifecycle();
    const pc = terminalService.getProcessId(SSH)!;
    expect(pc).toMatch(/^pc-/);
    await h.toggleBrowser(false);
    await h.toggleBrowser(true);
    expect(h.lifecycle()).toEqual(before);
    const originalPaneId = leaf().id;
    await act(async () => {
      store.dispatch(movePaneWithinTab({ tabId: TAB, sourcePaneId: originalPaneId, targetPaneId: 'pn-local', zone: 'center' }));
      await h.settle();
    });
    expect(leaf()).toMatchObject({ id: 'pn-local', terminalId: SSH, ssh: sentinel });
    expectPaneTags(Object.values(trees()), tags, [LOCAL]);
    h.exact();
    const panePayload = buildPaneDetachPayload(leaf(), undefined, TAB);
    expectPaneTags([panePayload.paneTree], { [SSH]: sentinel });
    async function assertAttach(work: () => Promise<void>) {
      const calls = h.backend.invokes.length;
      await act(async () => { await work(); expect((await h.query())?.session).toEqual(h.backend.sessions.get(SSH)); });
      expect(terminalService.getProcessId(SSH)).toBe(pc);
      expect(h.backend.invokes.slice(calls)).toContainEqual({ window: 'B', command: 'ssh_session_state', args: { terminalId: SSH } });
      expect(h.lifecycle()).toEqual(before);
      h.exact();
      h.assertSurface(presentation === 'Canvas');
    }
    await assertAttach(() => h.transfer('pane-transfer', panePayload, panePayload.tabId));
    const tabPayload = buildTabDetachPayload(panePayload.tabId, 'Moved')!;
    expectPaneTags([tabPayload.paneTree], { [SSH]: sentinel });
    await assertAttach(() => h.transfer('tab-transfer', tabPayload, tabPayload.tabId));
    await act(async () => h.refuse('rejected-transfer', tabPayload));
    expect(h.lifecycle()).toEqual(before);
    noClose();

    // StateManager gets its process inventory from the desktop's local REST endpoint.
    // Keep real port resolution and reconciliation; fake only their boundary replies.
    const oldFetch = globalThis.fetch;
    const tauri = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {
      invoke: async (command: string) => {
        expect(command).toBe('get_effective_endpoints');
        return { apiPort: 42031 };
      },
    } });
    __resetApiBaseForTests();
    const otherPc = terminalService.getProcessId(OTHER)!;
    const live = new Map(h.backend.sessions);
    let listed: { terminalId: string; id: string }[] = [];
    globalThis.fetch = jest.fn(async (url) => {
      expect(url).toBe('http://localhost:42031/api/terminals');
      return { ok: true, json: async () => ({ terminals: listed }) } as Response;
    });
    try {
      await StateManager.saveState();
      const saved = JSON.parse(localStorage.getItem(sessionStateKey())!);
      if (presentation === 'tab') expectPaneTags([saved.paneTree], { [SSH]: sentinel });
      else expect(saved.paneTree).toBeNull();
      expectPaneTags(Object.values(saved.tabPanes), tags, [LOCAL]);
      const restore = async () => {
        expect(await StateManager.restoreState(store.dispatch)).toBe(true);
        h.show(tabPayload.tabId);
        expectPaneTags(Object.values(trees()), tags, [LOCAL]);
        expectPaneTags(Object.values(getTabPanesGlobal()), tags, [LOCAL]);
      };
      // A separate cold backend has no PTY/session. Keep the live fixture off to the side
      // for the next reload; clearing renderer bindings is not a terminal close.
      await act(async () => {
        clearWorkspace();
        terminalService.detachTerminal(SSH);
        terminalService.detachTerminal(OTHER);
        h.backend.sessions.clear();
        installRestoreStream();
        await restore();
      });
      h.assertSurface(presentation === 'Canvas');
      expect(terminalService.getProcessId(SSH)).toBeUndefined();
      h.exact({});
      expect(h.lifecycle()).toEqual(before);

      listed = [{ terminalId: SSH, id: pc }, { terminalId: OTHER, id: otherPc }];
      for (const [id, view] of live) h.backend.sessions.set(id, view);
      const calls = h.backend.invokes.length;
      await act(async () => { clearWorkspace(); await restore(); });
      h.assertSurface(presentation === 'Canvas');
      expect(terminalService.getProcessId(SSH)).toBe(pc);
      expect(terminalService.getProcessId(OTHER)).toBe(otherPc);
      expect(h.backend.invokes.slice(calls).filter(call => call.command === 'ssh_session_state').map(call => call.args?.terminalId).sort()).toEqual([OTHER, SSH]);
      expect(h.lifecycle()).toEqual(before);
      expectRegistry(renderedSessions(), expected);
      h.exact();
      noClose();
    } finally {
      globalThis.fetch = oldFetch;
      __resetApiBaseForTests();
      if (tauri) Object.defineProperty(window, '__TAURI_INTERNALS__', tauri);
      else Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });

  test('sshOwnership_equalCountWrongIdentity_isRejected', () => {
    const { [SSH]: target, ...survivors } = registry(h.backend.sessions);
    const wrong: Registry[] = [
      { ...survivors, 'tm-substituted': target },
      { ...survivors, [SSH]: { ...target, connectionId: other.connectionId } },
      { ...survivors, [SSH]: { ...target, state: 'disconnected' } },
    ];
    for (const substitute of wrong) expect(() => expectRegistry(substitute, expected)).toThrow();
    h.exact();
  });

  test('sshOwnership_canvasTabSwitchDoesNotClose_butActualCloseDrains', async () => {
    const before = h.lifecycle();
    const initial = h.backend.sessions.get(SSH)!;
    const live = { ...initial, revision: initial.revision! + 1 };
    await act(async () => h.emit('ssh-session:state', live));
    expect(store.getState().sshSession.byTerminal[SSH]?.session).toEqual(live);
    for (const transition of ['enter', 'switch', 'return', 'exit'] as const) {
      await act(async () => {
        if (transition === 'switch') activate(BACK);
        else if (transition === 'exit') {
          leaveCanvasTab();
          const returned = store.getState().tabs.activeTabId;
          expect(returned).toBe(BACK);
          store.dispatch(setActiveTabId(returned));
        } else h.enterCanvas();
        await h.settle();
      });
      h.assertSurface(transition === 'enter' || transition === 'return');
      h.exact();
      expectRegistry(renderedSessions(), expected);
      noClose();
    }
    await act(async () => {
      h.show();
      const paneId = leaf().id;
      closePaneNonBlocking({ paneId, terminalId: SSH,
        removeFromUi: () => store.dispatch(removePaneFromTab({ tabId: TAB, paneId })),
        closeTerminal: (id, pi) => terminalService.closeTerminal(id, pi),
        clearCwdSnapshot, releaseSurface: cleanupTerminalCache, forgetRemoteHint,
        clearSessionExit: id => store.dispatch(clearSessionClosed({ terminalId: id })),
      });
      await h.settle();
    });
    const remaining = { [OTHER]: expected[OTHER] };
    h.exact(remaining);
    expect(Object.fromEntries(h.backend.snapshots)).toStrictEqual({ [OTHER]: expect.objectContaining({ terminalId: OTHER, stage: 'typed' }) });
    expectPaneTags(Object.values(trees()), { [OTHER]: other }, [LOCAL]);
    expect(terminalService.getProcessId(SSH)).toBeUndefined();
    expect(h.paneOps.filter(op => op.kind === 'close')).toEqual([expect.objectContaining({ kind: 'close' })]);
    expect(h.directClose).not.toHaveBeenCalled();
    expect(h.fallbackClose).not.toHaveBeenCalled();
    expect(h.lifecycle()).toEqual(before);
    const survivor = store.getState().sshSession.byTerminal[OTHER];
    expectRegistry(renderedSessions(), remaining);
    await act(async () => { h.emit('ssh-session:state', { ...live, revision: live.revision! + 1 }); });
    expect(store.getState().sshSession.byTerminal).toStrictEqual({ [OTHER]: survivor });
    h.exact(remaining);
  });
});
