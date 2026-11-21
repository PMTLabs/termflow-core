/** @jest-environment jsdom */
import fs from 'fs';
import path from 'path';
import { configureStore } from '@reduxjs/toolkit';
import type { SshMetricsSample, SshSessionView } from '../../types/ssh';
import { PaneIncarnations } from '../../services/paneIncarnations';
import { installSshSessionStartup } from '../../services/sshSessionEvents';
import { resumeSshMetrics, retainSshMetrics } from '../../services/sshMetricsWatch';
import reducer, { selectSshMetricsPause, selectSshMetricsSample } from '../../store/slices/sshSessionSlice';

const invokeMock = jest.fn((_cmd: string, _args?: unknown, _options?: unknown): Promise<any> => Promise.resolve({}));
const callbacks = new Map<string, (event: { payload: any }) => void>();
const stops = new Map<string, jest.Mock>();
const listenMock = jest.fn(async (name: string, callback: (event: { payload: any }) => void) => {
  callbacks.set(name, callback);
  const stop = jest.fn(); stops.set(name, stop); return stop;
});
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: Parameters<typeof invokeMock>) => invokeMock(...args) }));
jest.mock('@tauri-apps/api/event', () => ({ listen: (...args: Parameters<typeof listenMock>) => listenMock(...args) }));
jest.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
import bridge, { disposeBridgeListeners } from '../tauri-bridge';

const terminalId = 'tm-a', consumerId = 'b1ec3391-5ff2-47ac-8955-07f4215bd30e';
const connected: SshSessionView = { terminalId, connectionId: 'c-a', state: 'connected', generation: 7, revision: 8, gate: 'verified' };
const unavailable = { available: false, reason: 'sample fixture' } as const;
const reading = (sampledAt: number, percent: number | null = null): SshMetricsSample => ({ terminalId, sampledAt, metrics: {
  host: unavailable, cpu: { available: true, percent, cores: unavailable, load1: unavailable }, ram: unavailable,
  netUp: { available: true, bytesPerSecond: percent === null ? null : 320 }, netDown: { available: true, bytesPerSecond: percent === null ? null : 640 },
  uptime: unavailable, users: unavailable, partitions: unavailable, nfs: unavailable,
} });
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
function startup() {
  const page = new PaneIncarnations(invokeMock);
  const state = configureStore({ reducer: { sshSession: reducer } });
  const trees = { restored: { id: 'pane-a', type: 'terminal' as const, terminalId, ssh: { connectionId: 'c-a' } } };
  const store = { ...state, getState: () => ({ ...state.getState(), panes: { treesByTabId: trees } }) };
  const install = () => installSshSessionStartup(store, bridge, page);
  const stop = install();
  return { install, stop: () => { stop(); page.stop(); }, state: () => state.getState().sshSession, page };
}
let now: number, pageNumber: number;
beforeEach(() => {
  invokeMock.mockReset(); listenMock.mockClear(); callbacks.clear(); stops.clear();
  jest.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  now = 10_000;
  pageNumber = 17;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  invokeMock.mockImplementation(async cmd => {
    switch (cmd) {
      case 'register_page': return { status: 'Registered', wi: 2, pg: pageNumber };
      case 'ssh_session_state': return connected;
      case 'ssh_metrics_watch': return { sampleFloor: now, generation: 7, pauseSeq: 0, pausedReason: null };
      case 'ssh_metrics_resume': return { sampleFloor: now, generation: 7, pauseSeq: 2 };
      default: return null;
    }
  });
});
afterEach(async () => {
  window.dispatchEvent(new Event('pagehide'));
  disposeBridgeListeners(); await flush(); jest.restoreAllMocks();
});

// Mutation: invokeSshMetrics header/body or tauriBridge's command bindings; Rust lib.rs production handler list.
// Run together with actual MockRuntime IPC test retired_page_cannot_watch_or_keep_worker; the source
// list check additionally kills removal in only the production registration, not the mock app.
test('bridge_invokes_exact_metric_commands_and_camelcase_args', async () => {
  const args = { terminalId, consumerId }, options = { headers: { 'x-termflow-page': '17' } };
  expect(await bridge.sshMetricsWatch(terminalId, consumerId, 17)).toEqual({ sampleFloor: now, generation: 7, pauseSeq: 0, pausedReason: null });
  expect(await bridge.sshMetricsResume(terminalId, consumerId, 17)).toEqual({ sampleFloor: now, generation: 7, pauseSeq: 2 });
  await expect(bridge.sshMetricsUnwatch(terminalId, consumerId, 17)).resolves.toBeNull();
  await expect(bridge.sshMetricsWatch(terminalId, consumerId)).rejects.toEqual({ code: 'invalid-page' });
  expect(invokeMock.mock.calls).toEqual([
    ['ssh_metrics_watch', args, options], ['ssh_metrics_resume', args, options], ['ssh_metrics_unwatch', args, options],
  ]);
  const source = fs.readFileSync(path.resolve(__dirname, '../../../../src-tauri/src/lib.rs'), 'utf8');
  const production = source.match(/\.invoke_handler\(crate::ssh_handlers!\[([\s\S]*?)\]\)/)?.[1];
  for (const [command] of invokeMock.mock.calls) expect(production).toContain(`commands::ssh_metrics::${command},`);
});

// Mutation: listenSsh's active flag or payload forwarding; startup idempotence/disposal.
test('bridge_delivers_exact_event_payload_and_unlistens_once', async () => {
  const cb = jest.fn(), controlCb = jest.fn();
  const stopSample = await bridge.onSshMetricsSample(cb);
  const stopControl = await bridge.onSshMetricsControl(controlCb);
  const sample = reading(now), control = { terminalId, generation: 7, pauseSeq: 3, pausedReason: 'watchdog' };
  callbacks.get('ssh-metrics:sample')!({ payload: sample });
  callbacks.get('ssh-metrics:control')!({ payload: control });
  expect(cb.mock.calls).toEqual([[sample]]); expect(controlCb.mock.calls).toEqual([[control]]);
  stopSample(); stopSample(); stopControl();
  callbacks.get('ssh-metrics:sample')!({ payload: sample }); callbacks.get('ssh-metrics:control')!({ payload: control });
  expect(cb).toHaveBeenCalledTimes(1); expect(controlCb).toHaveBeenCalledTimes(1);
  const directStops = [...stops.values()];
  listenMock.mockClear();
  const boot = startup(); const duplicateStop = boot.install(); await flush();
  duplicateStop();
  expect(listenMock.mock.calls.map(c => c[0])).toEqual(['ssh-metrics:sample', 'ssh-metrics:control', 'ssh-session:state']);
  const startupStops = [...stops.values()];
  boot.stop(); boot.stop(); disposeBridgeListeners(); await flush();
  for (const stop of [...directStops, ...startupStops]) expect(stop).toHaveBeenCalledTimes(1);
});

// Mutation: index's installSshSessionStartup call, or missing metrics/session routing in that installer.
test('startup_routes_metric_and_session_events_to_same_slice', async () => {
  const index = fs.readFileSync(path.resolve(__dirname, '../../index.tsx'), 'utf8');
  expect(index).toContain('installSshSessionStartup(store, window.electronAPI)');
  const boot = startup(); boot.install(); await flush();
  const release = retainSshMetrics(terminalId); await flush();
  const calls = invokeMock.mock.calls.filter(([command]) => command === 'ssh_metrics_watch');
  expect(calls).toEqual([['ssh_metrics_watch', { terminalId, consumerId: expect.any(String) }, { headers: { 'x-termflow-page': '17' } }]]);
  const sample = reading(++now);
  callbacks.get('ssh-metrics:sample')!({ payload: sample });
  expect(selectSshMetricsSample(boot.state(), terminalId)).toEqual(sample);
  callbacks.get('ssh-session:state')!({ payload: { ...connected, revision: 9, state: 'disconnected' } });
  expect(selectSshMetricsSample(boot.state(), terminalId)).toBeUndefined();
  expect(boot.state().byTerminal[terminalId].metricsFence).toBeUndefined();
  const late = callbacks.get('ssh-metrics:sample')!;
  const oldStops = [...stops.values()];
  window.dispatchEvent(new Event('pagehide')); boot.stop(); await flush(); release();
  for (const stop of oldStops) expect(stop).toHaveBeenCalledTimes(1);
  listenMock.mockClear();
  const replacement = startup(); retainSshMetrics(terminalId); await flush();
  late({ payload: reading(++now, 900) });
  expect(selectSshMetricsSample(replacement.state(), terminalId)).toBeUndefined();
  callbacks.get('ssh-metrics:sample')!({ payload: reading(++now, 40) });
  expect(selectSshMetricsSample(replacement.state(), terminalId)).toEqual(reading(now, 40));
  expect(listenMock.mock.calls.map(c => c[0])).toEqual(['ssh-metrics:sample', 'ssh-metrics:control', 'ssh-session:state']);
  replacement.stop();
});

// Renderer half of sampler/tests/scheduler.rs::timeout_surviving_remote_child_pauses_automatic_collectors.
// Mutation: startup control routing, Resume invoke or lower-pair rejection.
test('r2_2_watchdog_control_traverses_real_bridge_and_resume', async () => {
  const boot = startup(); await flush(); retainSshMetrics(terminalId); await flush();
  callbacks.get('ssh-metrics:sample')!({ payload: reading(++now, 20) });
  expect(selectSshMetricsSample(boot.state(), terminalId)).toEqual(reading(now, 20));
  const reason = "Metrics paused: host didn't answer in 5 s";
  const signal = { terminalId, generation: 7, pauseSeq: 1, pausedReason: reason };
  const defaults = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation((cmd, ...args) => cmd === 'ssh_metrics_watch'
    ? Promise.resolve({ sampleFloor: now, generation: 7, pauseSeq: 1, pausedReason: reason }) : defaults(cmd, ...args));
  callbacks.get('ssh-metrics:control')!({ payload: signal }); await flush();
  expect(selectSshMetricsPause(boot.state(), terminalId)).toBe(reason);
  expect(boot.state().byTerminal[terminalId].metricsReading).toBeUndefined();
  expect(await resumeSshMetrics(terminalId)).toBe(true);
  callbacks.get('ssh-metrics:control')!({ payload: signal });
  callbacks.get('ssh-metrics:sample')!({ payload: reading(now, 99) });
  expect(selectSshMetricsSample(boot.state(), terminalId)).toBeUndefined();
  expect(selectSshMetricsPause(boot.state(), terminalId)).toBeNull();
  for (const percent of [null, 25]) {
    const sample = reading(++now, percent);
    callbacks.get('ssh-metrics:sample')!({ payload: sample });
    expect(selectSshMetricsSample(boot.state(), terminalId)).toEqual(sample);
  }
  boot.stop();
});

// Mutation: late cleanup resolves the current document's page rather than the retired mount's page.
// The replacement receives the paused receipt without any control/telemetry event on that page.
test('reload_recovers_pause_and_late_cleanup_keeps_original_page_header', async () => {
  let replyOld!: (value: unknown) => void;
  const pending = new Promise(resolve => { replyOld = resolve; });
  const old = startup(); await flush();
  const defaults = invokeMock.getMockImplementation()!;
  const pause = "Metrics paused: host didn't answer in 5 s";
  invokeMock.mockImplementation((cmd, ...args) => cmd === 'ssh_metrics_watch'
    ? (pageNumber === 17 ? pending : Promise.resolve({ sampleFloor: now, generation: 7, pauseSeq: 3, pausedReason: pause }))
    : defaults(cmd, ...args));
  retainSshMetrics(terminalId); await flush();
  const consumers = () => invokeMock.mock.calls.filter(([name]) => name === 'ssh_metrics_watch');
  const [, oldArgs, oldHeader] = consumers()[0];
  window.dispatchEvent(new Event('pagehide')); old.page.stop();
  pageNumber = 18;
  const replacement = startup(); await flush(); retainSshMetrics(terminalId); await flush();
  const [, newArgs, newHeader] = consumers()[1];
  expect(newHeader).toEqual({ headers: { 'x-termflow-page': '18' } });
  expect(newArgs).not.toEqual(oldArgs);
  expect(selectSshMetricsPause(replacement.state(), terminalId)).toBe(pause);
  expect(selectSshMetricsSample(replacement.state(), terminalId)).toBeUndefined();
  replyOld({ sampleFloor: now, generation: 7, pauseSeq: 999, pausedReason: 'abandoned' }); await flush();
  expect(oldHeader).toEqual({ headers: { 'x-termflow-page': '17' } });
  expect(invokeMock.mock.calls.filter(([name]) => name === 'ssh_metrics_unwatch')).toEqual([
    ['ssh_metrics_unwatch', oldArgs, oldHeader],
  ]);
  expect(selectSshMetricsPause(replacement.state(), terminalId)).toBe(pause);
  replacement.stop(); await flush();
  expect(invokeMock.mock.calls.filter(([name]) => name === 'ssh_metrics_unwatch').at(-1)).toEqual(['ssh_metrics_unwatch', newArgs, newHeader]);
});
