/**
 * @jest-environment jsdom
 *
 * Plan 070 T2/T3 — SSH node composition, per-terminal browser collapse, LOD/overlay/cull, and
 * one controller / one visible challenge across the pane and Canvas presentations.
 *
 * JSDOM IS NOT A LAYOUT ENGINE. Rectangles and FitAddon inputs are explicit fixtures derived from
 * what the production components RENDER (the `--node-host-w/h` they emit, the browser width they
 * set); they are not engine evidence. Real WebView geometry is plan 070 T8.
 *
 * The 066 PaneNode `ssh` tag is not merged on this branch: the trees below carry an `ssh` field
 * structurally, which is exactly what the `readSshPaneTag` seam reads.
 */
const fakeCache = new Map<string, any>();
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: fakeCache, isFindShortcut: () => false }));
jest.mock('../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
jest.mock('../../../services/TerminalService', () => ({
  terminalService: { writeToTerminal: jest.fn(), getProcessIdForTerminal: () => undefined },
}));
jest.mock('../../Terminal/useDetectedAgent', () => ({ useDetectedAgent: () => ({ agent: null, icon: null }) }));
jest.mock('../../../utils/clipboard', () => ({ writeClipboardText: jest.fn() }));
jest.mock('../../Ssh/ssh066Contract', () => ({
  ...jest.requireActual('../../Ssh/ssh066Contract'), readSshLaunchState: jest.fn(), readReconnectCoordinator: jest.fn(),
}));

/* eslint-disable import/first */
import path from 'path';
import React, { act, useEffect } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider, useSelector } from 'react-redux';
import { store, type RootState } from '../../../store';
import { addTabTree, resetPanes } from '../../../store/slices/panesSlice';
import { sshOwnersChanged, sshSessionObserved } from '../../../store/slices/sshSessionSlice';
import type { PaneNode } from '../../../store/slices/panesSlice';
import { CanvasNode } from '../CanvasNode';
import { NodeTerminal } from '../NodeTerminal';
import { CanvasMetricsContext } from '../canvasMetricsContext';
import { DEFAULT_METRICS, HEAD_H, NODE_H, NODE_W, type LodTier, type Rect } from '../canvasGeometry';
import { sshTagsByTerminal, type CanvasNodeModel } from '../canvasSelectors';
import { SSH_CSS_RAIL_W, SSH_CSS_STATUS_H, sshBrowserAllocation, sshSurfaceBoxFrom, type SshSurfaceBox } from '../canvasSshGeometry';
import { SSH_SURFACE_HIDE_GRACE_MS, SshCanvasPresentation, SshPaneSlot } from '../../Ssh/SshTerminalComposition';
import { LaunchNoticeProbe } from '../../../__testFixtures__/sshLaunchNoticeProbe';
import { readSshLaunchState } from '../../Ssh/ssh066Contract';
import { __resetSshPresentationsForTest } from '../../Ssh/sshPresentations';
import {
  __getSurfaceHostForTest, __resetSurfaceHostsForTest, subscribeSurfaceHosts,
} from '../../../services/surfaceHosts';
import { readSource } from '../../../utils/readSource';
import {
  fitTerminal, relocateAndFit, seedSshPane, sizeHostContent, sshTag, sshTree,
} from '../../../__testFixtures__/sshCanvasFixture';

const COMBOS = { enlarge: 'Q', openTab: 'G', leaveTerminal: 'Ctrl+Alt+Q', openTabFromOverlay: 'Ctrl+Alt+G' };
const TAB = 'tb-ssh';

const BOX_A = sshSurfaceBoxFrom({ terminal: { w: 1001.53125, h: 603.40625 }, browserW: 260, collapsed: false, statusH: SSH_CSS_STATUS_H, columnGap: 0 });
const BOX_B = sshSurfaceBoxFrom({ terminal: { w: 820.25, h: 500.5 }, browserW: 260, collapsed: false, statusH: SSH_CSS_STATUS_H, columnGap: 0 });

const nodeModel = (terminalId: string, rect: Rect): CanvasNodeModel => ({
  terminalId, tabId: TAB, paneId: `pn-${terminalId}`, title: terminalId, groupTitle: 'ssh', shellType: 'bash',
  rect, isRunning: false, hasUnseenOutput: false, exited: false, hidden: false,
});

const snapshotMounts: string[] = [];
function FakeSnapshot({ terminalId }: { terminalId: string }) {
  // Stands in for NodeSnapshot's timer owner; only its placement and mount count matter here.
  useEffect(() => { snapshotMounts.push(terminalId); }, [terminalId]);
  return <div className="canvas-node-snapshot" data-snapshot={terminalId} />;
}

interface NodeProps { id: string; box: SshSurfaceBox; tier?: LodTier; hidden?: boolean; overlaid?: boolean; snapshot?: boolean }

/** CanvasMode's SSH wiring for one node, reduced to the props it computes. */
function SshNode({ id, box, tier = 'live', hidden = false, overlaid = false, snapshot = false }: NodeProps) {
  const tag = useSelector((s: RootState) => sshTagsByTerminal(s.panes.treesByTabId)[id]);
  const rect = overlaid ? { x: 0, y: 0, w: box.envelope.w, h: box.envelope.h + HEAD_H } : { x: 0, y: 0, w: NODE_W, h: NODE_H };
  return <CanvasNode node={nodeModel(id, rect)} tier={overlaid ? 'gpu' : tier} zoom={1} selected={false} focused={false}
    dimmed={false} hidden={hidden} nodeHidden={false} busyCue="pulse" overlaid={overlaid} combos={COMBOS}
    hostBox={box.initialTerminal} sshEnvelope={tag ? box.envelope : undefined}>
    <NodeTerminal terminalId={id} focused={false} overlaid={overlaid}
      sshTag={tag} sshBrowserWidth={tag ? sshBrowserAllocation(box, tag.browserCollapsed) : undefined}
      sshVisible={overlaid || !hidden}
      SshShell={tag ? SshCanvasPresentation : undefined} Snapshot={tag && snapshot ? FakeSnapshot : undefined} />
  </CanvasNode>;
}

let container: HTMLDivElement;
let root: Root;
let notifications = 0;
let stopWatching: () => void = () => {};
const originalBridge = Object.getOwnPropertyDescriptor(window, 'electronAPI');

const render = (ui: React.ReactNode) => act(() => root.render(
  <Provider store={store}><CanvasMetricsContext.Provider value={DEFAULT_METRICS}>{ui}</CanvasMetricsContext.Provider></Provider>,
));
const nodeEl = (id: string) => container.querySelector<HTMLElement>(`.canvas-node[data-terminal-id="${id}"]`)!;
const hostOf = (id: string) => __getSurfaceHostForTest(id)!;

/** The slot the RENDERED node gives its terminal: emitted envelope minus the browser width it set. */
function renderedSlot(id: string, box: SshSurfaceBox) {
  const node = nodeEl(id);
  const aside = node.querySelector<HTMLElement>('.ssh-browser')!;
  return {
    w: parseFloat(node.style.getPropertyValue('--node-host-w')) - parseFloat(aside.style.width) - box.columnGap,
    h: parseFloat(node.style.getPropertyValue('--node-host-h')) - box.stripH - box.chromeH - box.statusH,
  };
}

/** A real FitAddon terminal seeded in its source pane, so `relocateAndFit` has a grid to keep. */
function paneTerminal(id: string, box: SshSurfaceBox) {
  const pane = seedSshPane(fakeCache, id, { terminal: box.initialTerminal, browserW: box.expandedBrowserW, statusH: box.statusH });
  return fitTerminal(pane.element);
}

function fitInRenderedHost(id: string, box: SshSurfaceBox, t: ReturnType<typeof fitTerminal>) {
  const slot = renderedSlot(id, box);
  sizeHostContent(hostOf(id), slot.w, slot.h);
  return relocateAndFit(t, hostOf(id));
}

function setTree(tree: PaneNode) {
  act(() => { store.dispatch(addTabTree({ tabId: TAB, tree })); });
}

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  fakeCache.clear();
  snapshotMounts.length = 0;
  __resetSurfaceHostsForTest();
  __resetSshPresentationsForTest();
  store.dispatch(resetPanes());
  store.dispatch(sshOwnersChanged({}));
  jest.mocked(readSshLaunchState).mockReset();
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  notifications = 0;
  stopWatching = subscribeSurfaceHosts(() => { notifications++; });
});

afterEach(() => {
  stopWatching();
  act(() => root.unmount());
  container.remove();
  store.dispatch(resetPanes());
  store.dispatch(sshOwnersChanged({}));
  if (originalBridge) Object.defineProperty(window, 'electronAPI', originalBridge);
  else Reflect.deleteProperty(window, 'electronAPI');
});

describe('local control', () => {
  it('a leaf without a tag renders today\'s local DOM in the pane slot and the node', () => {
    setTree(sshTree([{ terminalId: 'tm-local' }]));
    const pane = <div className="terminal-pane-content" data-probe="pane" />;
    render(<SshPaneSlot terminalId="tm-local" isTabActive>{pane}</SshPaneSlot>);
    expect(container.innerHTML).toBe('<div class="terminal-pane-content" data-probe="pane"></div>');

    render(<SshNode id="tm-local" box={BOX_A} />);
    const host = hostOf('tm-local');
    expect(host.parentElement!.className).toBe('terminal-display-wrapper canvas-surface');
    expect(host.parentElement!.parentElement!.className).toBe('canvas-node-body');
    expect(container.querySelector('.ssh-pane-shell, .canvas-ssh-surface')).toBeNull();
    // Local scale stays width-only from the terminal box; no envelope.
    expect(nodeEl('tm-local').style.getPropertyValue('--node-host-w')).toBe(`${BOX_A.initialTerminal.w}px`);
    expect(Number(nodeEl('tm-local').style.getPropertyValue('--node-surface-scale'))).toBeCloseTo(NODE_W / BOX_A.initialTerminal.w, 12);
  });
});

describe('SSH node layout', () => {
  it('sshCanvas_collapseIsPerTerminal_evenForSameConnection', () => {
    // Two terminals launched from the SAME connection, with independent tags.
    setTree(sshTree([{ terminalId: 'tm-a', ssh: sshTag() }, { terminalId: 'tm-b', ssh: sshTag() }]));
    const termA = paneTerminal('tm-a', BOX_A);
    const termB = paneTerminal('tm-b', BOX_B);
    render(<><SshNode id="tm-a" box={BOX_A} /><SshNode id="tm-b" box={BOX_B} /></>);
    const hostA = hostOf('tm-a'), hostB = hostOf('tm-b');
    const tagB = sshTagsByTerminal(store.getState().panes.treesByTabId)['tm-b'];
    const registrations = notifications;

    // Entry: both slots are their source boxes, so neither terminal resizes.
    const colsA = termA.term.cols;
    expect(renderedSlot('tm-a', BOX_A)).toEqual(BOX_A.initialTerminal);
    expect(renderedSlot('tm-b', BOX_B)).toEqual(BOX_B.initialTerminal);
    expect(fitInRenderedHost('tm-a', BOX_A, termA).resized).toBe(0);
    expect(fitInRenderedHost('tm-b', BOX_B, termB).resized).toBe(0);

    // Collapse A through its canonical leaf (066's reducer is not merged: the tree is replaced
    // with A's tag patched and B's leaf object carried over untouched, as an immer patch would).
    const tree = store.getState().panes.treesByTabId[TAB]!;
    const [leafA, leafB] = tree.children!;
    const patchA = (collapsed: boolean) => setTree({ ...tree, children: [
      { ...leafA, ssh: { ...(leafA as PaneNode & { ssh: ReturnType<typeof sshTag> }).ssh, browserCollapsed: collapsed } } as PaneNode,
      leafB,
    ] });
    patchA(true);

    expect(nodeEl('tm-a').querySelector('.ssh-browser')!.classList.contains('collapsed')).toBe(true);
    expect(nodeEl('tm-b').querySelector('.ssh-browser')!.classList.contains('collapsed')).toBe(false);
    // A's terminal grows by exactly the capped browser delta; its envelope and height are frozen.
    const slotA = renderedSlot('tm-a', BOX_A);
    expect(BOX_A.expandedBrowserW - BOX_A.collapsedBrowserW).toBe(260 - SSH_CSS_RAIL_W);
    expect(slotA.w - BOX_A.initialTerminal.w).toBe(BOX_A.expandedBrowserW - BOX_A.collapsedBrowserW);
    expect(slotA.h).toBe(BOX_A.initialTerminal.h);
    expect(nodeEl('tm-a').style.getPropertyValue('--node-host-w')).toBe(`${BOX_A.envelope.w}px`);
    const grownA = fitInRenderedHost('tm-a', BOX_A, termA);
    expect(grownA.resized).toBe(1);                 // the one legitimate fit, on A only
    expect(termA.term.cols).toBeGreaterThan(colsA);
    // B: same tag object, same host, same slot, no resize.
    expect(sshTagsByTerminal(store.getState().panes.treesByTabId)['tm-b']).toBe(tagB);
    expect(hostOf('tm-b')).toBe(hostB);
    expect(renderedSlot('tm-b', BOX_B)).toEqual(BOX_B.initialTerminal);
    expect(fitInRenderedHost('tm-b', BOX_B, termB).resized).toBe(0);

    // Toggle back: A returns to its original grid.
    patchA(false);
    expect(renderedSlot('tm-a', BOX_A)).toEqual(BOX_A.initialTerminal);
    fitInRenderedHost('tm-a', BOX_A, termA);
    expect(termA.term.cols).toBe(colsA);
    // No host was re-registered by any of it.
    expect(hostOf('tm-a')).toBe(hostA);
    expect(notifications).toBe(registrations);
  });

  it('sshCanvas_lodOverlayAndCull_keepHostIdentityAndFitInputs', () => {
    setTree(sshTree([{ terminalId: 'tm-lod', ssh: sshTag() }]));
    const term = paneTerminal('tm-lod', BOX_A);
    render(<SshNode id="tm-lod" box={BOX_A} tier="live" />);
    const host = hostOf('tm-lod');
    const registrations = notifications;
    const surface = container.querySelector<HTMLElement>('.canvas-ssh-surface')!;
    expect(surface.classList.contains('canvas-surface')).toBe(true); // raster cancellation applies
    expect(fitInRenderedHost('tm-lod', BOX_A, term).resized).toBe(0);
    const cols = term.term.cols, rows = term.term.rows;

    const steps: Array<{ label: string; props: Partial<NodeProps>; lod: string }> = [
      { label: 'gpu', props: { tier: 'gpu' }, lod: 'gpu' },
      { label: 'snapshot', props: { tier: 'snapshot', snapshot: true }, lod: 'snapshot' },
      { label: 'chip', props: { tier: 'chip' }, lod: 'chip' },
      { label: 'group', props: { tier: 'group' }, lod: 'group' },
      { label: 'culled', props: { tier: 'live', hidden: true }, lod: 'live' },
      { label: 'overlay', props: { overlaid: true }, lod: 'gpu' },
      { label: 'back to live', props: { tier: 'live' }, lod: 'live' },
    ];
    for (const step of steps) {
      render(<SshNode id="tm-lod" box={BOX_A} {...step.props} />);
      const node = nodeEl('tm-lod');
      // Positive control: the tier/cull/overlay really changed.
      expect([step.label, node.getAttribute('data-lod')]).toEqual([step.label, step.lod]);
      expect([step.label, node.classList.contains('overlaid')]).toEqual([step.label, !!step.props.overlaid]);
      expect([step.label, node.style.visibility]).toEqual([step.label, step.props.hidden ? 'hidden' : '']);
      // Invariants: same registered host, frozen envelope, same browser allocation, same grid.
      expect([step.label, hostOf('tm-lod') === host, node.contains(host)]).toEqual([step.label, true, true]);
      expect(node.style.getPropertyValue('--node-host-w')).toBe(`${BOX_A.envelope.w}px`);
      expect(node.style.getPropertyValue('--node-host-h')).toBe(`${BOX_A.envelope.h}px`);
      expect(node.querySelector<HTMLElement>('.ssh-browser')!.style.width).toBe(`${BOX_A.expandedBrowserW}px`);
      const fit = fitInRenderedHost('tm-lod', BOX_A, term);
      expect([step.label, fit.resized, term.term.cols, term.term.rows]).toEqual([step.label, 0, cols, rows]);
      // The browser and status row are present at every tier (paint policy is CSS, below).
      expect(node.querySelector('.ssh-status')).not.toBeNull();
      // Snapshot only at its tier, and only inside the terminal slot.
      const snap = node.querySelector('.canvas-node-snapshot');
      if (step.label === 'snapshot') {
        expect(snap).not.toBeNull();
        expect(snap!.closest('.ssh-terminal-host')).not.toBeNull();
        expect(snap!.contains(node.querySelector('.ssh-browser'))).toBe(false);
        expect(snap!.contains(node.querySelector('.ssh-status'))).toBe(false);
        expect(host.contains(snap)).toBe(false);
      } else {
        expect([step.label, snap]).toEqual([step.label, null]);
      }
      if (step.label === 'overlay') {
        // The overlay is contain-at-1:1 with no shift, built from the same envelope.
        expect(Number(node.style.getPropertyValue('--node-surface-scale'))).toBeCloseTo(1, 12);
        expect(node.style.getPropertyValue('--node-surface-shift')).toBe('0px');
      }
    }
    expect(snapshotMounts).toEqual(['tm-lod']);       // no extra timer owner at any other tier
    expect(notifications).toBe(registrations);         // zero registration churn

    // Paint policy, from the stylesheet (supplementary; T8 checks a real engine): the snapshot
    // tier keeps the SSH surface (inherit) and hides only the terminal host; chip/group hide the
    // whole `.canvas-surface`, which the SSH envelope is; never `display:none`.
    const css = readSource(path.resolve(__dirname, '../Canvas.css')).replace(/\/\*[\s\S]*?\*\//g, '');
    const decl = (selector: string) => {
      const at = css.indexOf(selector);
      expect([selector, at >= 0]).toEqual([selector, true]);
      return css.slice(css.indexOf('{', at), css.indexOf('}', at));
    };
    expect(decl('.canvas-node[data-lod="snapshot"] .canvas-surface.canvas-ssh-surface')).toMatch(/visibility:\s*inherit/);
    expect(decl('.canvas-node[data-lod="snapshot"] .canvas-ssh-surface .terminal-display')).toMatch(/visibility:\s*hidden/);
    expect(decl('.canvas-node[data-lod="group"] .canvas-surface')).toMatch(/content-visibility:\s*hidden/);
    expect(css).toContain('.canvas-node[data-lod="chip"] .canvas-surface,');
    expect(css).not.toMatch(/canvas-ssh-surface[^{]*\{[^}]*display:\s*none/);
  });
});

describe('two presentations, one owner', () => {
  it('sshCanvas_presentationDoesNotAcquireSecondSession', async () => {
    const id = 'tm-owner';
    type EditNotice = import('../../Ssh/sshFileTypes').EditNotice;
    let editEvent: ((notice: EditNotice) => void) | undefined;
    setTree(sshTree([{ terminalId: id, ssh: sshTag({ followCd: true, browserPath: '/home' }) }]));
    let cwd: ((event: { terminalId: string; path: string; host: string; sessionGeneration: number }) => void) | undefined;
    const ssh = {
      fsList: jest.fn(async ({ path: p }: { path: string }) => ({ path: p, entries: [], sessionGeneration: 1 })),
      fsEditList: jest.fn(async () => []),
      onFsEditState: jest.fn(async (listener: typeof editEvent) => { editEvent = listener; return () => {}; }),
      onFsCwd: jest.fn(async (listener: typeof cwd) => { cwd = listener; return () => {}; }),
    };
    const bridge = {
      ssh,
      sshSessionTrustHost: jest.fn(async () => {}),
      sshSessionSubmitSecret: jest.fn(async () => {}),
      sshSessionOpen: jest.fn(),
      sshSessionClose: jest.fn(),
      sshSessionReconnect: jest.fn(),
    };
    Object.defineProperty(window, 'electronAPI', { value: bridge, configurable: true });
    jest.mocked(readSshLaunchState).mockReturnValue({ sessionGeneration: 1, stage: 'running', launchSeq: 1, revision: 1 });
    store.dispatch(sshOwnersChanged({ [id]: 'conn-shared' }));
    store.dispatch(sshSessionObserved({ terminalId: id, connectionId: 'conn-shared', state: 'connected', generation: 1, revision: 1, gate: 'verified' }));
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    // One stable tree shape, so entering and leaving Canvas never remounts the pane owner.
    const ui = (canvas: boolean) => <>
      <SshPaneSlot terminalId={id} isTabActive={!canvas}>
        <div className="terminal-pane-content"><div className="terminal-display" data-probe="pane-host" /></div>
      </SshPaneSlot>
      {canvas ? <SshNode id={id} box={BOX_A} /> : null}
      {/* 066's notice, placed as TerminalPane's OwnedSshLaunchNotice places it (D51). */}
      <LaunchNoticeProbe terminalId={id} onTrust={receipt => bridge.sshSessionTrustHost(id, true, receipt)} />
    </>;

    // Positive control: the pane owner alone lists once and subscribes Follow-cd once.
    await act(async () => { render(ui(false)); await flush(); });
    expect(ssh.fsList.mock.calls).toEqual([[{ terminalId: id, path: '/home', expectedGeneration: 1 }]]);
    expect(ssh.onFsCwd).toHaveBeenCalledTimes(1);

    // Canvas enters: both presentations mounted, the pane tab in the background.
    await act(async () => { render(ui(true)); await flush(); });
    expect(container.querySelectorAll('.ssh-pane-shell')).toHaveLength(2);
    const canvasShell = container.querySelector('.canvas-ssh-surface .ssh-pane-shell')!;
    expect(canvasShell.querySelector('.ssh-file-browser')).not.toBeNull();      // shared controller shown
    expect(ssh.fsList).toHaveBeenCalledTimes(1);                                // ...not a second one
    expect(ssh.onFsCwd).toHaveBeenCalledTimes(1);
    expect(canvasShell.textContent).toContain('Current directory: /home');
    await act(async () => { editEvent!({ terminalId: id, path: '/home/.viminfo', editId: 'watch-1',
      sessionGeneration: 1, state: 'watching' }); await flush(); });
    expect(canvasShell.querySelector('.ssh-status .ssh-watch-item button')?.textContent).toContain('.viminfo · watching');
    expect(container.querySelectorAll('.ssh-watch-item')).toHaveLength(1);
    expect(canvasShell.querySelector('.ssh-pane-chrome')).toBeNull();

    // One Follow-cd report produces exactly one navigation, whichever surface shows it.
    await act(async () => { cwd!({ terminalId: id, path: '/srv', host: 'h', sessionGeneration: 1 }); await new Promise(r => setTimeout(r, 120)); await flush(); });
    expect(ssh.fsList.mock.calls.map(([request]) => request.path)).toEqual(['/home', '/srv']);

    // D51: a host-key challenge appears ONCE, from 066's notice, inside the Canvas node's terminal
    // slot while Canvas hosts the terminal. Neither SSH shell renders a second copy.
    await act(async () => {
      store.dispatch(sshSessionObserved({
        terminalId: id, connectionId: 'conn-shared', state: 'needs-hostkey', generation: 1, revision: 2, gate: 'pending',
        promptId: 'p-1', hostKey: { algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:fixture', changed: false },
      }));
      await flush();
    });
    const prompts = container.querySelectorAll('.ssh-prompt');
    expect(prompts).toHaveLength(1);
    // Owned by the notice (portalled into the slot wrapper inside the shell), not by the shell.
    expect(prompts[0].closest('.ssh-launch-notice')!.parentElement)
      .toBe(container.querySelector('.canvas-ssh-surface .ssh-terminal-host > .terminal-display-wrapper'));
    const trust = [...prompts[0].querySelectorAll('button')].find(b => b.textContent === 'Trust')!;
    await act(async () => { trust.click(); await flush(); });
    expect(bridge.sshSessionTrustHost.mock.calls).toEqual([[id, true, { generation: 1, promptId: 'p-1' }]]);

    // Canvas exits: a presentation change, not a session close. The pane owns the prompt again.
    await act(async () => { render(ui(false)); await flush(); });
    expect(__getSurfaceHostForTest(id)).toBeNull();
    expect(bridge.sshSessionClose).not.toHaveBeenCalled();
    expect(bridge.sshSessionOpen).not.toHaveBeenCalled();
    expect(container.querySelectorAll('.ssh-prompt')).toHaveLength(1);
    expect(container.querySelector('.ssh-prompt')!.closest('.canvas-ssh-surface')).toBeNull();
    expect(container.querySelector('.ssh-prompt')!.closest('.ssh-pane-shell')).toBeNull();
  });
});

describe('D51: the one controller is active while any surface showing it is visible', () => {
  const id = 'tm-visible';
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const pastGrace = () => act(async () => { await new Promise(r => setTimeout(r, SSH_SURFACE_HIDE_GRACE_MS + 60)); await settle(); });
  const setup = () => {
    setTree(sshTree([{ terminalId: id, ssh: sshTag({ browserPath: '/home' }) }]));
    const ssh = {
      fsList: jest.fn(async ({ path: p }: { path: string }) => ({ path: p, entries: [], sessionGeneration: 1 })),
      fsEditList: jest.fn(async () => []),
      onFsEditState: jest.fn(async () => () => {}),
      onFsCwd: jest.fn(async () => () => {}),
    };
    Object.defineProperty(window, 'electronAPI', { value: { ssh }, configurable: true });
    jest.mocked(readSshLaunchState).mockReturnValue({ sessionGeneration: 1, stage: 'running', launchSeq: 1, revision: 1 });
    store.dispatch(sshOwnersChanged({ [id]: 'conn-v' }));
    store.dispatch(sshSessionObserved({ terminalId: id, connectionId: 'conn-v', state: 'connected', generation: 1, revision: 1, gate: 'verified' }));
    return ssh;
  };
  const ui = ({ tab, canvas = false, culled = false }: { tab: boolean; canvas?: boolean; culled?: boolean }) => <>
    <SshPaneSlot terminalId={id} isTabActive={tab}>
      <div className="terminal-pane-content"><div className="terminal-display" data-probe="pane-host" /></div>
    </SshPaneSlot>
    {canvas ? <SshNode id={id} box={BOX_A} hidden={culled} /> : null}
  </>;

  it('sshBrowser_hiddenTabWithNoCanvasView_dropsAndRelistsOnReturn', async () => {
    const ssh = setup();
    await act(async () => { render(ui({ tab: true })); await settle(); });
    expect(ssh.fsList).toHaveBeenCalledTimes(1);
    // A flip shorter than the grace is not "no visible surface": no re-list.
    await act(async () => { render(ui({ tab: false })); await settle(); });
    await act(async () => { render(ui({ tab: true })); await settle(); });
    await pastGrace();
    expect(ssh.fsList).toHaveBeenCalledTimes(1);
    // Hidden past the grace with no Canvas view: dropped, and the return re-lists (068 C1).
    await act(async () => { render(ui({ tab: false })); await settle(); });
    await pastGrace();
    expect(ssh.fsList).toHaveBeenCalledTimes(1);
    await act(async () => { render(ui({ tab: true })); await settle(); });
    expect(ssh.fsList).toHaveBeenCalledTimes(2);
  });

  it('sshBrowser_visibleCanvasNodeKeepsHiddenTabLive_culledNodeDoesNot', async () => {
    const ssh = setup();
    await act(async () => { render(ui({ tab: true })); await settle(); });
    expect(ssh.fsList).toHaveBeenCalledTimes(1);
    // Entering Canvas hides the tab but shows a node: one hand-over, no re-list, still live.
    await act(async () => { render(ui({ tab: false, canvas: true })); await settle(); });
    await pastGrace();
    expect(ssh.fsList).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.canvas-ssh-surface .ssh-file-browser')).not.toBeNull();
    // The node is culled: no visible surface remains, so it drops; showing it again re-lists.
    await act(async () => { render(ui({ tab: false, canvas: true, culled: true })); await settle(); });
    await pastGrace();
    expect(ssh.fsList).toHaveBeenCalledTimes(1);
    await act(async () => { render(ui({ tab: false, canvas: true })); await settle(); });
    expect(ssh.fsList).toHaveBeenCalledTimes(2);
  });
});
