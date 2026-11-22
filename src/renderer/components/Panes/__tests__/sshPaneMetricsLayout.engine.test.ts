/** @jest-environment jsdom */
import path from 'path';
import { readSource } from '../../../utils/readSource';
import { SSH_LAUNCH_STRIP_HEIGHT_PX, SSH_METRICS_BAR_HEIGHT_PX } from '../../Ssh/sshPaneLayout';
import { act, createElement as h, Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { FitAddon } from '@xterm/addon-fit';
import { store } from '../../../store';
import { addTabTree, resetPanes, setSshHiddenMetrics } from '../../../store/slices/panesSlice';
import { sshLaunchObserved, sshMetricsArmed, sshMetricsControlled, sshMetricsDisarmed, sshMetricsSampled,
  sshMetricsUnavailable, sshOwnersChanged, sshSessionObserved } from '../../../store/slices/sshSessionSlice';
import { METRIC_KEYS, type LaunchSnapshot, type SshMetrics, type SshState } from '../../../types/ssh';
import { pane, sentinel } from '../../../__testFixtures__/sshPaneCensus';
import { TerminalPane } from '../TerminalPane';
import { createMainBridge } from '../../Terminal/MainBridge';
import { TerminalEngine } from '../../../../../packages/terminal-core/src/TerminalEngine';
import { terminalCache } from '../../../../../packages/terminal-core/src/cache';
import type { TerminalBridge } from '../../../../../packages/terminal-core/src/types';

jest.mock('@xterm/xterm', () => require('../../../../../packages/terminal-core/src/__mocks__/xterm'));
jest.mock('@xterm/addon-fit', () => require('../../../../../packages/terminal-core/src/__mocks__/addon-fit'));
jest.mock('@xterm/addon-web-links', () => require('../../../../../packages/terminal-core/src/__mocks__/addon-web-links'));
jest.mock('@xterm/addon-unicode11', () => require('../../../../../packages/terminal-core/src/__mocks__/addon-unicode11'));
jest.mock('@xterm/addon-webgl', () => require('../../../../../packages/terminal-core/src/__mocks__/addon-webgl'));
jest.mock('@xterm/addon-search', () => require('../../../../../packages/terminal-core/src/__mocks__/addon-search'));

jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map(), isBroadcastAvailable: () => true }));
jest.mock('../../../services/paneOwnership', () => ({ attachPaneOwnershipSync: jest.fn() }));
jest.mock('../../../services/terminalLabelSync', () => ({ attachTerminalLabelSync: jest.fn() }));
jest.mock('../../../services/terminalTitleColorSync', () => ({ attachTerminalTitleColorSync: jest.fn() }));
jest.mock('@tauri-apps/api/event', () => ({ listen: jest.fn().mockResolvedValue(() => {}) }));
jest.mock('../../Terminal/TerminalDisplay', () => ({ TerminalDisplay: ({ isActive }: { isActive: boolean }) => h('div', { 'data-engine-active': String(isActive) }) }));
jest.mock('../dnd/usePaneDrag', () => ({ usePaneDrag: () => () => {} }));
jest.mock('../../../services/TerminalService', () => ({ terminalService: {
  attachExistingTerminal: jest.fn(), markReattachedSession: jest.fn(),
  getProcessId: () => 'pc-1', createTerminal: jest.fn(), writeToTerminal: jest.fn().mockResolvedValue(undefined),
  resizeTerminal: jest.fn().mockResolvedValue(undefined), stashPromptGate: jest.fn(),
} }));
jest.mock('../../../services/AgentSchemeTracker', () => ({ agentSchemeTracker: {
  getAgentForTerminal: () => null, getDetectedAgentForTerminal: () => null,
  getDetectedAgentExeForTerminal: () => null, refreshNow: () => Promise.resolve(), subscribe: () => () => {},
} }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

const HOST_HEIGHT = 600, ROW_HEIGHT = 20;
const STRIP_HEIGHT = SSH_LAUNCH_STRIP_HEIGHT_PX, BAR_HEIGHT = SSH_METRICS_BAR_HEIGHT_PX;
const measuredRows = (height: number) => Math.floor(height / ROW_HEIGHT);

test('hidden_pane_defers_refit_until_activation (bar insertion then removal)', async () => {
  jest.useFakeTimers();
  let observer!: ResizeObserverCallback;
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { observer = callback; }
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  const host = document.createElement('div');
  Object.defineProperties(host, {
    offsetWidth: { value: 800 }, offsetHeight: { value: HOST_HEIGHT }, offsetParent: { value: document.body },
  });
  document.body.append(host);
  const resize = jest.fn();
  const listen = () => ({ dispose() {} });
  const bridge: TerminalBridge = { onData: listen, onExit: listen, write() {}, resize };
  const cacheKey = 'hidden-ssh-bar';
  const engine = new TerminalEngine(bridge, { cacheKey });
  const settle = () => jest.runAllTimersAsync();
  const observe = () => observer([], {} as ResizeObserver);
  try {
    engine.mount(host);
    engine.attach('pc');
    await settle();
    const { terminal, fitAddon } = terminalCache.get(cacheKey)!;
    const fit = fitAddon as typeof fitAddon & { setNextFit(cols: number, rows: number): void };
    // Hypothetical measurements exercise the actual engine's observer and
    // activation contract, not pixel geometry (the separate T8 oracle).
    fit.setNextFit(80, measuredRows(HOST_HEIGHT - STRIP_HEIGHT));
    observe(); await settle();
    expect(terminal.rows).toBe(28);
    resize.mockClear();
    const fitSpy = jest.spyOn(fit, 'fit');

    engine.setActive(false);
    fit.setNextFit(80, measuredRows(HOST_HEIGHT - STRIP_HEIGHT - BAR_HEIGHT)); // bar inserted
    observe(); await settle();
    fit.setNextFit(80, measuredRows(HOST_HEIGHT)); // chrome removed and host grew while still hidden
    observe(); await settle();
    expect(terminal.rows).toBe(28);
    expect(fitSpy).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();

    engine.setActive(true);
    await settle();
    expect(fitSpy).toHaveBeenCalledTimes(1);
    expect(terminal.rows).toBe(30);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize.mock.calls).toEqual([['pc', 80, 30]]);
  } finally {
    engine.dispose();
    terminalCache.clear();
    host.remove();
    globalThis.ResizeObserver = originalObserver;
    jest.useRealTimers();
    jest.restoreAllMocks();
  }
});

const terminalId = 'tm-grid', paneId = 'pn-grid', processId = 'pc-1';
const COLS = 80, FULL = 30, TAGGED = 26;

test('SSH row CSS reserves the exported layout heights', () => {
  const rule = (file: string, selector: string) =>
    readSource(path.resolve(__dirname, '../../Ssh', file)).split(`${selector} {`)[1]?.split('}')[0];
  const bar = rule('SshMetricsStatusBar.css', '.ssh-metrics-status-bar');
  expect(bar).toContain(`height: ${BAR_HEIGHT}px;`);
  expect(bar).toContain(`flex: 0 0 ${BAR_HEIGHT}px;`);
  const strip = rule('SshLaunchNotice.css', '.ssh-launch-strip');
  expect(strip).toContain(`height: ${STRIP_HEIGHT}px;`);
  // The strip is inside a non-flexing notice wrapper, not itself a flex item.
  expect(rule('SshLaunchNotice.css', '.ssh-launch-notice')).toContain('flex: none;');
});
type HarnessFit = FitAddon & { setNextFit(cols: number, rows: number): void };

/** Drive real TerminalPane DOM, the production engine and MainBridge. The test
 * observer feeds controlled fit dimensions based on both committed chrome rows;
 * CSS pixels and xterm glyph geometry still require the T8 browser test. */
async function withGrid(tagged: boolean, run: (grid: {
  resize: jest.Mock; bar: () => Element | null; grid: () => number[];
  update: (change?: () => void, visible?: boolean) => Promise<void>;
  tag: (tagged: boolean) => void; firstFit: number[];
}) => Promise<void>) {
  jest.useFakeTimers();
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const oldObserver = globalThis.ResizeObserver;
  const oldApi = window.electronAPI;
  const resize = jest.fn(async () => {});
  window.electronAPI = {
    resizeTerminal: resize, getTerminalOutput: async () => '',
  } as unknown as typeof window.electronAPI;
  let notify!: ResizeObserverCallback;
  let observedHost: Element | undefined;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { notify = callback; }
    observe(target: Element) { observedHost = target; }
    disconnect() {}
    unobserve() {}
  };

  const bar = () => element.querySelector('.terminal-pane > [aria-label="Remote host metrics"]');
  const strip = () => element.querySelector('.terminal-pane > .ssh-launch-notice > .ssh-launch-strip');
  const height = () => HOST_HEIGHT - (strip() ? STRIP_HEIGHT : 0) - (bar() ? BAR_HEIGHT : 0);
  const rows = () => measuredRows(height());
  const chromeCommits: Array<{ actual: boolean[]; expected: boolean[] }> = [];
  const dispatch = store.dispatch;
  let hasTag = tagged;
  const tag = (value: boolean) => {
    hasTag = value;
    dispatch(addTabTree({ tabId: 'tb-grid', tree: pane('grid', value ? sentinel : undefined) }));
  };
  const render = (isTabActive: boolean) => root.render(h(Profiler, {
    id: 'grid', onRender: () => {
      chromeCommits.push({ actual: [!!strip(), !!bar()], expected: [hasTag, hasTag] });
    },
    children: h(Provider, { store, children: h(TerminalPane, {
      paneId, terminalId, isActive: false, isTabActive, onSplit() {}, onClose() {}, onFocus() {},
    }) }),
  }));
  let engine: TerminalEngine | undefined;
  const mount = (host: HTMLElement, active: boolean) => {
    Object.defineProperties(host, {
      offsetWidth: { value: 800 }, offsetHeight: { get: height },
      offsetParent: { value: document.body },
    });
    engine = new TerminalEngine(createMainBridge(), { cacheKey: terminalId, active, autoFocus: false });
    expect(engine.mount(host)).toBe(true);
    engine.attach(processId);
  };
  const firstFit: number[] = [];
  const originalActivate = FitAddon.prototype.activate;
  const originalFit = FitAddon.prototype.fit;
  let fittedTerminal: { cols: number; rows: number };
  jest.spyOn(FitAddon.prototype, 'activate').mockImplementation(function (this: HarnessFit, term) {
    originalActivate.call(this, term);
    fittedTerminal = term;
  });
  // Real FitAddon continues to propose the current dimensions after a fit
  // and emits no resize for an unchanged grid; model both properties here.
  jest.spyOn(FitAddon.prototype, 'proposeDimensions').mockImplementation(() => ({ cols: COLS, rows: rows() }));
  jest.spyOn(FitAddon.prototype, 'fit').mockImplementation(function (this: HarnessFit) {
    const nextRows = rows();
    if (!firstFit.length) firstFit.push(COLS, nextRows);
    if (fittedTerminal.cols !== COLS || fittedTerminal.rows !== nextRows) this.setNextFit(COLS, nextRows);
    originalFit.call(this);
  });

  try {
    dispatch(resetPanes());
    dispatch(sshOwnersChanged({}));
    tag(tagged);
    await act(async () => render(true));
    const findHost = () => element.querySelector<HTMLElement>('[data-engine-active]')!;
    let host = findHost();
    mount(host, true);
    await jest.runAllTimersAsync();
    expect(observedHost).toBe(host);
    const { terminal } = terminalCache.get(terminalId)!;
    let active = true;
    await run({
      resize, bar, firstFit, tag, grid: () => [terminal.cols, terminal.rows],
      update: async (change = () => {}, visible = active) => {
        const priorTag = hasTag;
        await act(async () => { change(); render(visible); });
        const nextHost = findHost();
        const nextActive = nextHost.dataset.engineActive === 'true';
        if (priorTag === hasTag) expect(nextHost).toBe(host);
        // 068's slot changes the host wrapper when the tag changes. Model
        // TerminalDisplay's cleanup and mount, which reuse the cached xterm.
        if (nextHost !== host) {
          engine!.unmount();
          host = nextHost;
          mount(host, nextActive);
          expect(terminalCache.get(terminalId)?.terminal).toBe(terminal);
          expect(observedHost).toBe(host);
        } else if (nextActive !== active) engine!.setActive(nextActive);
        active = nextActive;
        notify([], {} as ResizeObserver);
        await jest.runAllTimersAsync();
      },
    });
    // Check every commit, not just the final DOM observed after act().
    expect(chromeCommits.length).toBeGreaterThan(0);
    for (const { actual, expected } of chromeCommits) expect(actual).toEqual(expected);
  } finally {
    await act(async () => root.unmount());
    engine?.dispose();
    terminalCache.clear();
    element.remove();
    globalThis.ResizeObserver = oldObserver;
    window.electronAPI = oldApi;
    jest.restoreAllMocks();
    jest.useRealTimers();
  }
}

test('tagged_grid_ignores_ssh_state_samples_and_preferences', async () => {
  await withGrid(true, async h => {
    const dispatch = store.dispatch;
    let revision = 0;
    const session = (state: SshState, generation = 1) => dispatch(sshSessionObserved({
      terminalId, connectionId: sentinel.connectionId, state, generation, revision: ++revision, gate: 'verified',
    }));
    const baseline = h.grid();
    h.resize.mockClear();
    const states: Array<{ rendered: string | null; text?: string }> = [];
    const step = async (change: () => void, text?: string) => {
      await h.update(change);
      expect(h.resize).toHaveBeenCalledTimes(0);
      expect(h.grid()).toEqual(baseline);
      states.push({ rendered: h.bar()?.textContent ?? null, text });
    };
    const na = { available: false as const, reason: 'Not sampled in this fixture' };
    const publish = (rate: number | null, generation: number, long = false) => {
      const now = { wall: Date.now(), mono: performance.now() };
      const sampleFloor = now.wall - 1;
      dispatch(sshMetricsArmed({ terminalId, receipt: { generation, sampleFloor, pauseSeq: 0, pausedReason: null },
        fence: { ...now, consumerId: 'grid', generation, sampleFloor, trustWall: true } }));
      const metrics: SshMetrics = {
        host: na, cpu: na, ram: na, netUp: { available: true, bytesPerSecond: rate }, netDown: na, uptime: na, users: na, nfs: na,
        partitions: long ? { available: true, mounts: [{
          source: '/dev/data', mountPoint: '/very-long-mount'.repeat(80), fsType: 'ext4',
          totalBytes: 1024, usedBytes: 512, availableBytes: 512, usedPercent: 50,
        }] } : na,
      };
      dispatch(sshMetricsSampled({ now, consumerId: 'grid', sample: { terminalId, sampledAt: now.wall, metrics } }));
    };
    await step(() => {
      dispatch(sshOwnersChanged({ [terminalId]: sentinel.connectionId }));
      session('connecting');
    }, 'Connecting');
    await step(() => session('connected'), 'Collecting first sample');
    await step(() => publish(null, 1), 'Network upload: …');
    await step(() => publish(3200, 1), 'Network upload: 3.2KB/s');
    await step(() => dispatch(sshMetricsDisarmed(terminalId)), 'Metrics delayed');
    await step(() => dispatch(sshMetricsUnavailable({ terminalId, reason: 'Sampler unavailable' })), 'Metrics unavailable');
    await step(() => dispatch(sshMetricsControlled({ terminalId, generation: 1, pauseSeq: 1, pausedReason: 'Metrics paused' })), 'Metrics paused');
    await step(() => session('disconnected'), 'Disconnected');
    await step(() => {
      session('connected', 2);
      dispatch(sshLaunchObserved({ terminalId, connectionId: sentinel.connectionId, stage: 'ended', revision: 1, launchSeq: 1,
        attempt: { sessionGeneration: 2, processIncarnation: processId } } as LaunchSnapshot));
    }, 'SSH session ended');
    await step(() => session('connected', 3), 'Collecting first sample');
    await step(() => publish(6400, 3, true), '/very-long-mount');
    await step(() => dispatch(setSshHiddenMetrics({ terminalId, hiddenMetrics: METRIC_KEYS })));
    expect(h.bar()?.textContent).toBe('');
    await act(async () => {
      h.bar()!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const reset = [...document.querySelectorAll<HTMLButtonElement>('.context-menu button')]
      .find(button => button.textContent === 'Reset to defaults')!;
    await step(() => reset.click(), '/very-long-mount');
    for (const { rendered, text } of states) {
      expect(rendered).not.toBeNull();
      if (text !== undefined) expect(rendered).toContain(text);
    }
    expect(h.grid()).toEqual([COLS, TAGGED]);
  });
});

test('visible_tagged_pane_first_fit_already_reserves_bar', async () => {
  await withGrid(true, async h => {
    expect(h.resize).toHaveBeenCalledTimes(1);
    expect(h.resize).toHaveBeenLastCalledWith(processId, COLS, TAGGED);
    expect(h.firstFit).toEqual([COLS, TAGGED]);
    expect(h.grid()).toEqual([COLS, TAGGED]);
    await h.update();
    expect(h.resize).toHaveBeenCalledTimes(1);
  });
});

test.each([true, false])('mounted_pane_tag_changes_resize_once_in_each_direction (visible=%s)', async visible => {
  await withGrid(false, async h => {
    expect(h.grid()).toEqual([COLS, FULL]);
    expect(h.resize).toHaveBeenCalledTimes(1);
    h.resize.mockClear();
    for (const [tagged, finalRows] of [[true, TAGGED], [false, FULL]] as const) {
      const before = h.grid();
      await h.update(() => h.tag(tagged), visible);
      if (!visible) {
        expect(h.resize).toHaveBeenCalledTimes(0);
        expect(h.grid()).toEqual(before);
        await h.update(undefined, true);
      }
      expect(h.resize).toHaveBeenCalledTimes(1);
      expect(h.resize).toHaveBeenLastCalledWith(processId, COLS, finalRows);
      expect(h.grid()).toEqual([COLS, finalRows]);
      await h.update();
      expect(h.resize).toHaveBeenCalledTimes(1);
      h.resize.mockClear();
    }
  });
});

test.todo('T8: ssh_bar_reserves_exact_height_without_covering_last_xterm_row (browser + real xterm and resize adapter)');
