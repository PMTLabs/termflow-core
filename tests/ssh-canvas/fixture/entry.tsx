import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Provider, useSelector } from 'react-redux';
import { getTerminalRenderPolicy, terminalCache } from '@termflow/terminal-core';
import { store, type RootState } from '../../../src/renderer/store';
import { CanvasMode } from '../../../src/renderer/components/Canvas/CanvasMode';
import { canvasMetrics, HEAD_H, isVisible, Z_MIN, type Viewport } from '../../../src/renderer/components/Canvas/canvasGeometry';
import { TerminalDisplay } from '../../../src/renderer/components/Terminal/TerminalDisplay';
import { SshPaneSlot } from '../../../src/renderer/components/Ssh/SshTerminalComposition';
import { LaunchNoticeProbe } from '../../../src/renderer/__testFixtures__/sshLaunchNoticeProbe';
import { sshTag, sshTree } from '../../../src/renderer/__testFixtures__/sshCanvasFixture';
import { sshTwoWindowBridge } from '../../../src/renderer/__testFixtures__/sshTwoWindowBridge';
import { leaveCanvasTab, openCanvasTab, isCanvasTabActive } from '../../../src/renderer/services/openCanvas';
import { __getSurfaceHostForTest as registryHost } from '../../../src/renderer/services/surfaceHosts';
import { addTabTree, patchSshPaneTag } from '../../../src/renderer/store/slices/panesSlice';
import { addTab } from '../../../src/renderer/store/slices/tabsSlice';
import { setCanvasWheelMode, setDefaultProfile, setShellProfiles } from '../../../src/renderer/store/slices/settingsSlice';
import { hydrateCanvas, setNodeGeom, setOverlayNode, setViewport } from '../../../src/renderer/store/slices/canvasSlice';
import { sshLaunchObserved, sshOwnersChanged, sshSessionObserved } from '../../../src/renderer/store/slices/sshSessionSlice';
import type { LaunchSnapshot, SshSessionView } from '../../../src/renderer/types/ssh';
import '../../../src/renderer/styles/App.css';
import '../../../src/renderer/components/Panes/TerminalPane.css';
import '../../../src/renderer/components/TerminalContainer.css';
import '../../../src/renderer/styles/index.css';
import './scene.css';

const ssh = 'tm-ssh';
const local = 'tm-local';
const matched = 'tm-matched';
const tab = 'tb-layout';
const tag = sshTag({ browserPath: '/home/layout' });
const processId = (id: string) => 'pc-' + id;
const listing = new URLSearchParams(location.search).has('overflow') ? 100 : 1;
const resizeLog: { processId: string; cols: number; rows: number }[] = [];
const bus = sshTwoWindowBridge({ revision: 1, view: { revision: 1, folders: [], connections: [], loadError: null } },
  (id, connectionId) => id === ssh && connectionId === tag.connectionId);
window.electronAPI = {
  ...bus.B.api,
  ssh: {
    ...bus.B.api.ssh,
    fsList: async ({ path, expectedGeneration }) => ({
      path, sessionGeneration: expectedGeneration,
      entries: Array.from({ length: listing }, (_, i) => {
        const name = i ? `fixture-${i}.txt` : 'fixture.txt';
        return { name, path: `${path}/${name}`, kind: 'file', size: '12' };
      }),
    }),
    fsEditList: async () => [],
    onFsEditState: async () => () => {},
    onFsCwd: async () => () => {},
  },
  resizeTerminal: async (pid: string, cols: number, rows: number) => { resizeLog.push({ processId: pid, cols, rows }); },
  getTerminalOutput: async () => '',
  setConfigValue: async () => {},
} as typeof window.electronAPI;

let callbackId = 0;
Object.assign(window, {
  __TAURI_INTERNALS__: {
    transformCallback: () => ++callbackId,
    invoke: async (command: string) => {
      if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return callbackId;
      throw new Error('Unexpected native IPC in browser fixture: ' + command);
    },
  },
});

const state = (session: SshSessionView['state']) => store.dispatch(sshSessionObserved({
  terminalId: ssh, connectionId: tag.connectionId, generation: 1, revision: ++revision,
  state: session, gate: session === 'needs-hostkey' ? 'pending' : 'verified',
  ...(session === 'needs-hostkey' ? {
    promptId: 'layout-key', hostKey: { algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:layout', changed: false },
  } : {}),
}));
let revision = 0;
store.dispatch(addTabTree({ tabId: tab, tree: sshTree([{ terminalId: ssh, ssh: tag }, { terminalId: local }, { terminalId: matched }]) }));
store.dispatch(addTab({ id: tab, title: 'Layout terminals', shellType: 'bash', icon: '' }));
store.dispatch(setShellProfiles([
  { id: 'first', name: 'First', path: '/bin/first', args: [], type: 'custom' },
  { id: 'bash', name: 'Fixture Bash', path: '/bin/bash', args: [], type: 'custom' },
]));
store.dispatch(setDefaultProfile('bash'));
store.dispatch(hydrateCanvas({ viewport: { x: 0, y: 0, z: 1 }, dynamicSpacing: false, sidebarOpen: false }));
store.dispatch(sshOwnersChanged({ [ssh]: tag.connectionId }));
state('connected');
store.dispatch(sshLaunchObserved({
  terminalId: ssh, connectionId: tag.connectionId, launchSeq: 1, revision: 1, stage: 'running',
  attempt: { sessionGeneration: 1, attemptReceipt: { generation: 1, gate: 'verified' },
    processIncarnation: processId(ssh), ownerIncarnation: { pg: 1, seq: 1 } },
}));

const portrait = new URLSearchParams(location.search).get('shape') === 'portrait';
store.dispatch(setNodeGeom({ id: ssh, rect: { x: 60, y: 96, w: portrait ? 300 : 340, h: HEAD_H + (portrait ? 410 : 181) } }));
store.dispatch(setNodeGeom({ id: local, rect: { x: 780, y: 96, w: 340, h: HEAD_H + 181 } }));
// Give the control the same world width and cull band as SSH, independent of
// its measured local host width. Both clear the GPU tier at entry zoom 1.
store.dispatch(setNodeGeom({ id: matched, rect: { x: 60, y: 250, w: portrait ? 300 : 340, h: HEAD_H + 181 } }));

const noop = () => {};
let notice: (stage: LaunchSnapshot['stage']) => void;
function Scene() {
  const active = useSelector((s: RootState) => s.tabs.activeTabId === tab);
  const [stage, setStage] = useState<LaunchSnapshot['stage']>('running');
  notice = setStage;
  return <>
    <main className={`fixture-panes tab-content${active ? ' active' : ''}`} data-portrait={portrait || undefined}>
      {[ssh, local, matched].map(id => <section key={id} className="terminal-pane" data-source={id}
        style={id === ssh && portrait ? { width: 485.53125, height: 715.40625 } : undefined}>
        {id === ssh && <LaunchNoticeProbe terminalId={id} stage={stage} onTrust={async () => {}} />}
        <SshPaneSlot terminalId={id} isTabActive={active}>
          <div className="terminal-pane-content">
            <TerminalDisplay terminalId={id} processId={processId(id)} paneId={'pn-' + id}
              shellType="bash" isActive={active} shouldFocus={false} onData={noop} onResize={noop} onTitleChange={noop} />
          </div>
        </SshPaneSlot>
      </section>)}
    </main>
    {!active && <CanvasMode />}
  </>;
}
const root = createRoot(document.getElementById('root')!);
flushSync(() => root.render(<Provider store={store}><Scene /></Provider>));

const host = (id: string) => terminalCache.get(id)?.terminal.element?.parentElement ?? null;
const hostIds = new WeakMap<HTMLElement, number>();
let nextHost = 0;
function visibility(id: string) {
  const viewport = document.querySelector('.canvas-viewport')?.getBoundingClientRect();
  const node = registryHost(id)?.closest<HTMLElement>('.canvas-node');
  const { viewport: camera, nodes, overlayId } = store.getState().canvas;
  const rect = nodes[id];
  if (!viewport || !node || !rect) return null;
  // Dynamic spacing is off in this scene, so the stored rect is the rect passed
  // to the policy cull in canvasGeometry.ts:664. Keep its production margin;
  // isVisible(..., 0) answers the distinct on-screen parity question (:555–565).
  return {
    culled: !isVisible(camera, rect, viewport.width, viewport.height),
    onScreen: overlayId === id || isVisible(camera, rect, viewport.width, viewport.height, 0),
    tier: node.dataset.lod ?? null,
  };
}
function read(id: string) {
  const entry = terminalCache.get(id);
  const terminal = entry?.terminal as unknown as {
    _core: { _renderService: { dimensions: { css: { cell: { height: number } } } } };
  } | undefined;
  const policy = getTerminalRenderPolicy(id);
  const element = host(id);
  const css = element && getComputedStyle(element);
  if (element && !hostIds.has(element)) hostIds.set(element, ++nextHost);
  return {
    actual: entry ? { cols: entry.terminal.cols, rows: entry.terminal.rows } : null,
    proposal: entry?.fitAddon.proposeDimensions() ?? null,
    policy: policy === 'webgl' ? 'gpu' as const : policy,
    visibility: visibility(id),
    cellHeight: terminal?._core._renderService.dimensions.css.cell.height ?? null,
    content: css ? {
      w: parseFloat(css.width) - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight),
      h: parseFloat(css.height) - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom),
    } : null,
    box: element ? { w: element.getBoundingClientRect().width, h: element.getBoundingClientRect().height } : null,
    hostId: element ? hostIds.get(element) : null,
    registered: !!element && registryHost(id) === element,
    resizes: resizeLog.filter(log => log.processId === processId(id)).map(({ cols, rows }) => ({ cols, rows })),
    text: entry?.terminal.buffer.active.getLine(0)?.translateToString(true) ?? '',
  };
}

let fitCalls = 0;
let resizeCalls = 0;
const hooks = {
  enter: () => flushSync(openCanvasTab),
  leave: () => flushSync(leaveCanvasTab),
  viewport: (vp: Viewport) => flushSync(() => store.dispatch(setViewport(vp))),
  wheelMode: (mode: 'zoom' | 'scroll') => flushSync(() => store.dispatch(setCanvasWheelMode(mode))),
  watchFits: (id: string) => {
    const entry = terminalCache.get(id)!;
    const addon = entry.fitAddon;
    const fit = addon.fit.bind(addon);
    fitCalls = 0;
    addon.fit = () => { fitCalls++; fit(); };
    // `FitAddon.fit` calls `Terminal.resize` only when the proposal differs: a real resize.
    const terminal = entry.terminal;
    const resize = terminal.resize.bind(terminal);
    resizeCalls = 0;
    terminal.resize = (cols: number, rows: number) => { resizeCalls++; resize(cols, rows); };
  },
  fitCalls: () => fitCalls,
  resizeCalls: () => resizeCalls,
  overlay: (id: string | null) => flushSync(() => store.dispatch(setOverlayNode(id))),
  collapse: (value: boolean) => flushSync(() => store.dispatch(patchSshPaneTag({ terminalId: ssh, patch: { browserCollapsed: value } }))),
  localWidth: (width: number | null) => {
    document.querySelector<HTMLElement>('[data-source="tm-local"]')!.style.width = width === null ? '' : width + 'px';
  },
  notice: (kind: 'plain' | 'prompt' | 'reconnect') => flushSync(() => {
    state(kind === 'prompt' ? 'needs-hostkey' : kind === 'reconnect' ? 'disconnected' : 'connected');
    notice(kind === 'prompt' ? 'waiting-trust' : 'running');
  }),
  write: (id: string, data: string) => {
    window.dispatchEvent(new CustomEvent('pty:data', { detail: { processId: processId(id), data } }));
  },
  read, host: registryHost,
  camera: () => ({ ...store.getState().canvas.viewport, active: isCanvasTabActive(), zMin: Z_MIN,
    zMax: canvasMetrics(innerWidth, innerHeight).zMax }),
};
export type SshCanvasHooks = typeof hooks;
declare global { interface Window { __sshCanvas: SshCanvasHooks } }
window.__sshCanvas = hooks;
