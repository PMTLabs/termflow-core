/** @jest-environment jsdom */
import fs from 'fs';
import path from 'path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { PaneIncarnations } from '../../../services/paneIncarnations';
import { sanitizePaneTreeSshFields } from '../../../services/sshPanePersistence';
import { installSshSessionStartup } from '../../../services/sshSessionEvents';
import { useSshMetricsWatch } from '../../../services/sshMetricsWatch';
import panes, { selectSshHiddenMetrics, setActiveTabId, setPaneTree, type PaneNode } from '../../../store/slices/panesSlice';
import sshSession, { selectSshMetricsSample, SSH_METRICS_CADENCE_MS, SSH_METRICS_MAX_AGE, sshLaunchReducer as sshLaunch } from '../../../store/slices/sshSessionSlice';
import ssh from '../../../store/slices/sshSlice';
import ui from '../../../store/slices/uiSlice';
import type { SshMetricsSample, SshSessionView } from '../../../types/ssh';
import { writeClipboardText } from '../../../utils/clipboard';
import { SshMetricsStatusBar } from '../SshMetricsStatusBar';

jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: Parameters<typeof mockInvoke>) => mockInvoke(...args) }));
jest.mock('@tauri-apps/api/event', () => ({ listen: (name: string, cb: (event: { payload: unknown }) => void) => {
  mockListeners.set(name, cb);
  return Promise.resolve(() => mockListeners.delete(name));
} }));
jest.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
jest.mock('../../../services/sshLaunch', () => ({ reconnectSshTerminal: jest.fn() }));
jest.mock('../../../utils/clipboard', () => ({ writeClipboardText: jest.fn().mockResolvedValue(undefined) }));

const mockInvoke = jest.fn(async (_cmd: string, _args?: unknown, _options?: unknown): Promise<unknown> => null);
const mockListeners = new Map<string, (event: { payload: unknown }) => void>();
import bridge, { disposeBridgeListeners } from '../../../api/tauri-bridge';

const terminalId = 'tm-a';
const tree: PaneNode = { id: 'pn-a', type: 'terminal', terminalId, ssh: { connectionId: 'c-a', hiddenMetrics: [] } };
const reducer = { panes, sshSession, sshLaunch, ssh, ui };
const snapshots = (): [SshMetricsSample, SshMetricsSample] => JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/sshMetricsSnapshots.json'), 'utf8'));
let wall: number, mono: number, floor: number, session: SshSessionView;
let host: HTMLDivElement, root: Root, stop: (() => void) | undefined;
const emit = (name: string, payload: unknown) => mockListeners.get(name)!({ payload });
const reading = (key: string) => host.querySelector(`[data-metric="${key}"]`)?.textContent;
const advance = (ms: number) => { wall += ms; mono += ms; };
const publish = (sample: SshMetricsSample) => emit('ssh-metrics:sample', sample);
function connect(state: SshSessionView['state'], generation = session.generation) {
  session = { ...session, state, generation, revision: (session.revision ?? 0) + 1 };
  emit('ssh-session:state', session);
}
function Owner() {
  useSshMetricsWatch(terminalId);
  return <SshMetricsStatusBar terminalId={terminalId} />;
}
function restoredStore(pane: PaneNode) {
  const store = configureStore({ reducer });
  store.dispatch(setActiveTabId('tb-a'));
  store.dispatch(setPaneTree(pane));
  return store;
}
async function setup() {
  const store = restoredStore(tree);
  const page = new PaneIncarnations(mockInvoke);
  const uninstall = installSshSessionStartup(store, bridge, page);
  stop = () => { uninstall(); page.stop(); };
  await act(async () => root.render(<Provider store={store}><Owner /></Provider>));
  expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === 'ssh_metrics_watch')).toHaveLength(1);
  return store;
}
async function menuClick(label: string) {
  act(() => host.querySelector('.ssh-metrics-status-bar')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  const button = [...document.querySelectorAll<HTMLButtonElement>('.context-menu button')].find(b => b.textContent?.includes(label))!;
  expect(button.disabled).toBe(false);
  await act(async () => { button.click(); });
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  wall = floor = 123_455;
  mono = 0;
  session = { terminalId, connectionId: 'c-a', state: 'connected', generation: 7, revision: 1, gate: 'verified' };
  jest.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  jest.spyOn(Date, 'now').mockImplementation(() => wall);
  jest.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(0);
  jest.spyOn(performance, 'now').mockImplementation(() => mono);
  mockInvoke.mockReset().mockImplementation(async cmd => {
    if (cmd === 'register_page') return { status: 'Registered', wi: 2, pg: 17 };
    if (cmd === 'ssh_session_state') return session;
    if (cmd === 'ssh_metrics_watch') return { generation: session.generation, sampleFloor: floor, pauseSeq: 0, pausedReason: null };
    return null;
  });
});
afterEach(async () => {
  await act(async () => { root.unmount(); stop?.(); });
  stop = undefined;
  disposeBridgeListeners(); mockListeners.clear();
  host.remove(); jest.restoreAllMocks(); jest.clearAllMocks();
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

test.each([50, 900, 1500].flatMap(duration => [0, 300].map(latency => [duration, latency])))
('steady_cadence_samples_never_blank_across_fence_renewals (%d ms collection, %d ms IPC)', async (duration, latency) => {
  jest.useFakeTimers({ doNotFake: ['performance', 'Date'] });
  try {
    const [baseline, rates] = snapshots();
    const initialWall = wall;
    let completed = 0;
    const started: number[] = [];
    const invoke = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation(async (...args) => {
      if (args[0] !== 'ssh_metrics_watch') return invoke(...args);
      started.push(mono);
      const receipt = { generation: session.generation, sampleFloor: wall, pauseSeq: 0, pausedReason: null };
      if (completed && latency) await new Promise(resolve => setTimeout(resolve, latency));
      completed++;
      return receipt;
    });
    const store = await setup();
    const bar = host.querySelector('.ssh-metrics-status-bar')!;
    act(() => bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    for (let elapsed = 50; elapsed <= 30_000; elapsed += 50) {
      await act(async () => {
        advance(50);
        jest.advanceTimersByTime(50);
        if ((elapsed - duration) % SSH_METRICS_CADENCE_MS === 0 && elapsed >= duration) {
          publish({ ...(elapsed === duration ? baseline : rates), sampledAt: initialWall + elapsed - duration + 1 });
        }
      });
      if (elapsed < SSH_METRICS_CADENCE_MS + duration) continue;
      expect({ elapsed, live: !!selectSshMetricsSample(store.getState().sshSession, terminalId) }).toEqual({ elapsed, live: true });
      expect(bar.textContent).not.toContain('Metrics delayed');
      expect([...host.querySelectorAll('[data-metric]')].map(el => el.textContent).join(' ')).not.toMatch(/[—…]/);
      const copy = [...document.querySelectorAll<HTMLButtonElement>('.context-menu button')]
        .find(button => button.textContent?.includes('Copy all metrics'));
      expect(copy?.disabled).toBe(false);
    }
    expect(completed - 1).toBeGreaterThanOrEqual(3);
    expect(started.slice(1).every((start, i) => start - started[i] >= 1000)).toBe(true);
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd.startsWith('ssh_metrics_')).map(([cmd]) => cmd))
      .toEqual(Array(duration === 1500 ? 30 : 31).fill('ssh_metrics_watch'));
  } finally {
    jest.useRealTimers();
  }
});

test('ssh_metrics_fixture_to_bar_to_clipboard_roundtrip', async () => {
  const [baseline, rates] = snapshots();
  const store = await setup();
  act(() => { advance(1); publish(baseline); });
  expect(reading('host')).toBe('Host: sample-host');
  expect(reading('cpu')).toBe('CPU: …');
  act(() => { advance(1); publish(rates); });
  expect([...host.querySelectorAll('[data-metric]')].map(el => el.textContent)).toEqual([
    'Host: sample-host', 'CPU: 25%', 'RAM: 0.0 / 0.0 GiB', 'Network upload: 30B/s',
    'Network download: 15B/s', 'Uptime: 0m 12s', 'Connected users: 3', 'Partitions: / 22%', 'NFS partitions: none mounted',
  ]);
  await menuClick('Uptime');
  await menuClick('Connected users');
  expect(reading('uptime')).toBeUndefined();
  expect(reading('users')).toBeUndefined();
  await menuClick('Copy all metrics');
  expect(writeClipboardText).toHaveBeenCalledTimes(1);
  expect(writeClipboardText).toHaveBeenCalledWith([
    'Host:        sample-host (Test Linux 12, arm64)',
    'CPU:         25% · 4 cores · load 1.25',
    'RAM:         0.0 / 0.0 GiB (25%)',
    'Upload:      30 B/s',
    'Download:    15 B/s',
    'Uptime:      0m 12s',
    'Users:       3 (alex, zoe)',
    'Partitions:  / 22% of 100 K',
    'NFS:         none mounted',
    'Sampled:     1970-01-01 00:02:03 (+00:00)',
  ].join('\n'));
  const serialized = JSON.stringify(sanitizePaneTreeSshFields(store.getState().panes.treesByTabId['tb-a']!));
  expect(serialized).not.toMatch(/sample-host|sampledAt|metricsReading/);
  const restored = restoredStore(sanitizePaneTreeSshFields(JSON.parse(serialized)));
  expect(selectSshHiddenMetrics(restored.getState(), terminalId)).toEqual(['uptime', 'users']);
  expect(restored.getState().sshSession.byTerminal[terminalId]?.metricsReading).toBeUndefined();
  act(() => root.render(<Provider store={restored}><SshMetricsStatusBar terminalId={terminalId} /></Provider>));
  expect(reading('uptime')).toBeUndefined();
  expect(reading('users')).toBeUndefined();
  expect(reading('cpu')).toBe('CPU: —');
});

test.each([8, 7])('exec_inflight_disconnect_reconnect_flow_never_resurrects_snapshot (generation %d)', async generation => {
  const [baseline, rates] = snapshots();
  const store = await setup();
  act(() => { advance(2); publish(rates); });
  expect(reading('cpu')).toBe('CPU: 25%');
  act(() => connect('disconnected'));
  expect(reading('cpu')).toBe('CPU: —');
  expect(reading('netUp')).toBe('Network upload: —');
  await act(async () => { advance(10); floor = wall; connect('connected', generation); });
  expect(store.getState().sshSession.byTerminal[terminalId].metricsFence).toMatchObject({ generation, sampleFloor: floor });
  // The payload itself has no generation. Both a queued pre-disconnect reply
  // and a reply stamped at the reconnect fence must stay out of the slice.
  act(() => { publish(rates); publish({ ...rates, sampledAt: floor }); });
  expect(store.getState().sshSession.byTerminal[terminalId].metricsReading).toBeUndefined();
  expect(reading('host')).not.toContain('sample-host');
  // F2: even a delayed sample above the floor must not start a new lifetime on receipt.
  await act(async () => { advance(SSH_METRICS_MAX_AGE + 1); publish({ ...rates, sampledAt: floor + 1 }); });
  expect(store.getState().sshSession.byTerminal[terminalId].metricsReading).toBeUndefined();
  act(() => { advance(1); publish({ ...baseline, sampledAt: wall }); });
  expect(reading('host')).toBe('Host: sample-host');
  expect(reading('cpu')).toBe('CPU: …');
  expect(reading('netUp')).toBe('Network upload: …');
  act(() => { advance(1); publish({ ...rates, sampledAt: wall }); });
  expect(reading('cpu')).toBe('CPU: 25%');
  expect(reading('netUp')).toBe('Network upload: 30B/s');
  expect(reading('netDown')).toBe('Network download: 15B/s');
});

test('page_hide_is_a_pause_not_a_delay_and_restore_shows_a_fresh_baseline', async () => {
  jest.useFakeTimers({ doNotFake: ['performance', 'Date'] });
  try {
    const [baseline, rates] = snapshots();
    const store = await setup();
    const status = () => host.querySelector('.ssh-metrics-state')!.textContent;
    // Step the heartbeat like real time; one big jump would look like a suspension.
    const run = async (ms: number) => {
      for (let left = ms; left > 0; left -= 50) await act(async () => { advance(50); jest.advanceTimersByTime(50); });
    };
    await run(50);
    await act(async () => { publish({ ...baseline, sampledAt: wall - 10 }); });
    await run(SSH_METRICS_CADENCE_MS);
    await act(async () => { publish({ ...rates, sampledAt: wall - 10 }); });
    expect(status()).toContain('Connected');
    const hidden = jest.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(selectSshMetricsSample(store.getState().sshSession, terminalId)).toBeUndefined();
    expect(store.getState().sshSession.byTerminal[terminalId].metricsDelayed).toBeUndefined();
    expect(status()).not.toContain('Metrics delayed');
    await run(SSH_METRICS_MAX_AGE);
    expect(status()).not.toContain('Metrics delayed');
    hidden.mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    // The first visible frame after a restore is a fresh baseline, never a stale "delayed".
    expect(status()).toContain('Collecting first sample');
    expect(host.querySelector('.ssh-metrics-status-bar')!.textContent).not.toContain('Metrics delayed');
    await run(100);
    await act(async () => { publish({ ...baseline, sampledAt: wall - 10 }); });
    expect(status()).toContain('Connected');
  } finally {
    jest.useRealTimers();
  }
});

test('renewal_landing_after_the_page_hides_but_before_visibilitychange_is_still_a_pause', async () => {
  jest.useFakeTimers({ doNotFake: ['performance', 'Date'] });
  try {
    const [baseline, rates] = snapshots();
    const store = await setup();
    const status = () => host.querySelector('.ssh-metrics-state')!.textContent;
    const run = async (ms: number) => {
      for (let left = ms; left > 0; left -= 50) await act(async () => { advance(50); jest.advanceTimersByTime(50); });
    };
    await run(50);
    await act(async () => { publish({ ...baseline, sampledAt: wall - 10 }); });
    await run(SSH_METRICS_CADENCE_MS);
    await act(async () => { publish({ ...rates, sampledAt: wall - 10 }); });
    expect(status()).toContain('Connected');
    // Hold the next renewal receipt so it is in flight when the page hides.
    const original = mockInvoke.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let renewals = 0;
    mockInvoke.mockImplementation(async (cmd, ...rest) => {
      if (cmd === 'ssh_metrics_watch') { renewals++; await held; }
      return original(cmd, ...rest);
    });
    for (let i = 0; i < 40 && renewals === 0; i++) await run(50);
    expect(renewals).toBe(1);
    // The page is already hidden when the receipt lands; visibilitychange has not been delivered yet.
    jest.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => { release(); });
    expect(selectSshMetricsSample(store.getState().sshSession, terminalId)).toBeUndefined();
    expect(store.getState().sshSession.byTerminal[terminalId].metricsDelayed).toBeUndefined();
    expect(status()).not.toContain('Metrics delayed');
  } finally {
    jest.useRealTimers();
  }
});
