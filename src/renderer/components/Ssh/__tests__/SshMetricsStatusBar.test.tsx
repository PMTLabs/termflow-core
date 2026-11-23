/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import panes, { focusPane, movePaneWithinTab, selectSshHiddenMetrics, setActiveTabId, setPaneTree, setSshHiddenMetrics } from '../../../store/slices/panesSlice';
import sshSession, { sshAttachmentResolved, sshLaunchReducer as sshLaunch, sshLaunchObserved, sshMetricsArmed, sshMetricsDisarmed, sshMetricsSampled, sshOwnersChanged, sshSessionObserved } from '../../../store/slices/sshSessionSlice';
import ssh from '../../../store/slices/sshSlice';
import ui from '../../../store/slices/uiSlice';
import { taggedTree } from '../../../__testFixtures__/sshPaneCensus';
import { installSshMetricsWatch, useSshMetricsWatch } from '../../../services/sshMetricsWatch';
import { writeClipboardText } from '../../../utils/clipboard';
import type { SshMetricsAPI, SshMetricsSample, SshMetricsControl, SshState } from '../../../types/ssh';
import { SshMetricsStatusBar } from '../SshMetricsStatusBar';
import { SshBrowserPaneShell } from '../SshBrowserPaneShell';
import type { LaunchSnapshot } from '../../../types/ssh';
import { SSH_METRIC_KEYS, SSH_METRIC_LABELS } from '../sshMetricKeys';
import { SshIcon, type SshIconName } from '../SshIcons';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatSshMetricsCopy } from '../metricFormat';

jest.mock('../../../utils/clipboard', () => ({ writeClipboardText: jest.fn() }));
jest.mock('../../../services/sshLaunch', () => ({ reconnectSshTerminal: jest.fn() }));
// The status-row table renders SshBrowserPaneShell, whose import chain reaches the store's
// TerminalContainer -> tauri-bridge listeners; cut it as the Canvas SSH suites do.
jest.mock('../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
const write = jest.mocked(writeClipboardText);
const A = 'tm-ssh', B = 'tm-other';
const na = (reason: string) => ({ available: false as const, reason });
const sample = (cpu: number | null, terminalId = B, sampledAt = Date.now()): SshMetricsSample => ({ terminalId, sampledAt, metrics: {
  host: { available: true, hostname: 'db-beta', os: { available: true, name: 'Linux' }, architecture: na('arch failed') },
  cpu: { available: true, percent: cpu, cores: { available: true, count: 8 }, load1: na('load failed') },
  ram: na('meminfo failed'), netUp: { available: true, bytesPerSecond: cpu === null ? null : 3200 }, netDown: na('net failed'),
  uptime: { available: true, seconds: 864000 }, users: na('who failed'), partitions: na('df failed'), nfs: na('NFS failed'),
} });
let root: Root, host: HTMLElement, dispose: (() => void) | undefined;
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  write.mockReset().mockResolvedValue(undefined);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => { root.unmount(); dispose?.(); }); dispose = undefined; host.remove(); jest.restoreAllMocks(); });

function setup() {
  const store = configureStore({ reducer: { panes, sshSession, sshLaunch, ssh, ui } });
  const dispatch = store.dispatch;
  dispatch(setActiveTabId('tb-a'));
  dispatch(setPaneTree(taggedTree()));
  dispatch(focusPane('pn-ssh'));
  dispatch(sshOwnersChanged({ [A]: 'saved', [B]: 'other' }));
  let generation = 1, revision = 0;
  const session = (state: SshState, gen = generation, terminalId = B) => {
    generation = gen;
    dispatch(sshSessionObserved({ terminalId, connectionId: terminalId === B ? 'other' : 'saved',
      state, generation, revision: ++revision, gate: 'verified', ...(state === 'error' ? { reason: 'Host unreachable' } : {}) }));
  };
  const publish = (reading: SshMetricsSample, gen = generation) => {
    const now = { wall: Date.now(), mono: performance.now() };
    const sampleFloor = reading.sampledAt - 1;
    dispatch(sshMetricsArmed({ terminalId: reading.terminalId, receipt: { generation: gen, sampleFloor, pauseSeq: 0, pausedReason: null },
      fence: { ...now, consumerId: 'test', generation: gen, sampleFloor, trustWall: true } }));
    dispatch(sshMetricsSampled({ sample: reading, now, consumerId: 'test' }));
  };
  session('connected');
  const render = (children = <SshMetricsStatusBar terminalId={B} />) => act(() => root.render(<Provider store={store}>{children}</Provider>));
  return { store, dispatch, session, publish, render, toasts: () => store.getState().ui.toasts.map(t => t.type) };
}
type RowSession = SshState | 'none' | 'restored';
const rowSessions: RowSession[] = ['none', 'restored', 'connecting', 'needs-secret', 'needs-hostkey', 'connected', 'disconnected', 'error'];
const rowStages: (LaunchSnapshot['stage'] | undefined)[] = [undefined, 'preparing', 'waiting-ready', 'waiting-trust', 'typed', 'running', 'ended', 'blocked', 'cancelled', 'error'];
const rowLabels: Record<RowSession, string> = {
  none: 'Disconnected', restored: 'Disconnected', connecting: 'Connecting', 'needs-secret': 'Waiting for credentials',
  'needs-hostkey': 'Waiting for host key approval', connected: 'Collecting first sample', disconnected: 'Disconnected', error: 'SSH error',
};
const statusSlot = <SshMetricsStatusBar terminalId={A} />;
function renderRow(h: ReturnType<typeof setup>, state: SshState, status?: React.ReactNode) {
  h.render(<SshBrowserPaneShell terminalId={A} sshTag={{ connectionId: 'saved' }} surfaceActive
    browserController={null} onPatchTag={() => {}} terminal={null} sessionPrompts={false} status={status}
    view={{ terminalId: A, connectionId: 'saved', state, generation: 2, gate: 'verified' }}
    onSecret={async () => {}} onTrust={async () => {}} onCancel={() => {}} />);
  return host.querySelector('.ssh-status')!;
}
const markerCount = (row: Element) => [...row.querySelectorAll('.ssh-status-text')]
  .filter(span => span.textContent === '—').length;

describe('SSH status row liveness', () => {
  test.each(rowSessions.flatMap(state => rowStages.flatMap(stage => (['current', 'stale'] as const).map(age => ({ state, stage, age })))))
  ('$state / $stage / $age', ({ state, stage, age }) => {
    const h = setup();
    const viewState = state === 'none' || state === 'restored' ? 'disconnected' : state;
    if (state === 'restored') h.dispatch(sshAttachmentResolved({ terminalId: A, connectionId: 'saved', reattachedProcessId: 'pc-old' }));
    if (state !== 'none' && state !== 'restored') h.session(state, 2, A);
    if (stage) {
      const generation = age === 'current' ? 2 : 1;
      h.dispatch(sshLaunchObserved({ terminalId: A, connectionId: 'saved', stage, revision: 1, launchSeq: 1,
        attempt: { sessionGeneration: generation, processIncarnation: 'pc-test', ownerIncarnation: { pg: 1, seq: 1 },
          attemptReceipt: { generation, gate: 'verified' } } }));
    }

    const row = renderRow(h, viewState, statusSlot);
    // No samples or pauses are seeded: a connected bar always shows the first-sample label here.
    const ended = state !== 'none' && state !== 'restored' && stage === 'ended' && age === 'current';
    const expectedLabel = ended ? 'SSH session ended' : state === 'restored' && !stage ? 'Metrics unavailable' : rowLabels[state];
    const status = row.querySelector('.ssh-metrics-state')?.textContent?.replace(/^○\s*/, '');
    expect(status).toBe(expectedLabel);
    const terminalLive = state === 'connected' && ['preparing', 'waiting-ready', 'waiting-trust', 'typed', 'running'].includes(stage ?? '');
    expect(markerCount(row) + Number(status !== 'Collecting first sample')).toBe(terminalLive ? 0 : 1);
  });

  test('keeps the marker when all metrics are hidden', () => {
    const h = setup();
    h.dispatch(setSshHiddenMetrics({ terminalId: A, hiddenMetrics: SSH_METRIC_KEYS }));
    const row = renderRow(h, 'disconnected', statusSlot);
    expect(row.querySelector('.ssh-metrics-status-bar')).not.toBeNull();
    expect(row.querySelector('.ssh-metrics-state')).toBeNull();
    expect(markerCount(row)).toBe(1);
  });

  test('keeps the marker when there is no status slot', () => {
    const row = renderRow(setup(), 'disconnected');
    expect(row.querySelector('.ssh-metrics-status-bar')).toBeNull();
    expect(markerCount(row)).toBe(1);
  });
});

const bar = () => host.querySelector<HTMLElement>('[aria-label="Remote host metrics"]')!;
// D101: a value is an aria-hidden glyph followed by text, so its textContent is the value alone.
const metric = (key: string) => bar().querySelector<HTMLElement>(`[data-metric="${key}"]`)!.textContent;
const key = (value: string, shiftKey = false) => act(() => bar().dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true })));
const open = () => act(() => bar().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
const row = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.context-menu button')]
  .find(button => button.textContent?.includes(label))!;
const click = async (label: string) => { await act(async () => { row(label).click(); }); };
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

test('Windows samples render as connected and name the NFS slot Network drives', async () => {
  const h = setup();
  const reading = sample(48);
  reading.metrics.platform = 'Windows';
  reading.metrics.host = { available: true, hostname: 'WINHOST', os: { available: true, name: 'Microsoft Windows 11 Pro' }, architecture: { available: true, name: 'AMD64' } };
  reading.metrics.users = { available: true, count: 1, names: ['user1'] };
  reading.metrics.nfs = { available: true, mounts: [] };
  h.publish(reading); h.render(); open();
  expect(bar().querySelector('.ssh-metrics-state')?.textContent).toBe('● Connected');
  const nfs = bar().querySelector('[data-metric="nfs"]');
  expect(bar().querySelector('[data-metric="host"]')?.textContent).toBe('WINHOST');
  expect(bar().querySelector('[data-metric="cpu"]')?.textContent).toBe('48%');
  expect(nfs?.textContent).toBe('none mounted');
  expect(nfs?.getAttribute('title')).toBe('Network drives: none mounted');
  expect(bar().querySelector('[data-metric="users"]')?.getAttribute('title')).toContain('SSH sessions are not listed');
  expect(row('Network drives')).toBeDefined();
  await click('Copy all metrics');
  expect(write).toHaveBeenCalledWith(expect.stringContaining('Network drives: none mounted'));
});

const states = ['connecting', 'needs-secret', 'needs-hostkey', 'disconnected', 'error', 'ended', 'delayed'] as const;
test.each(states)('connected_values_disappear_on_disconnect_before_next_sample (%s)', state => {
  const h = setup(); h.publish(sample(61)); h.render(); open();
  expect(bar().textContent).toContain('61%');
  expect(bar().querySelector('.is-live')).not.toBeNull();
  expect(row('Copy all metrics').disabled).toBe(false);
  act(() => {
    if (state === 'ended') h.dispatch(sshLaunchObserved({ terminalId: B, connectionId: 'other', stage: 'ended', revision: 1, launchSeq: 1,
      attempt: { sessionGeneration: 1, processIncarnation: 'pc-b' } } as Parameters<typeof sshLaunchObserved>[0]));
    else if (state === 'delayed') h.dispatch(sshMetricsDisarmed(B));
    else h.session(state);
  });
  expect(bar().textContent).not.toMatch(/61%|3\.2KB\/s|db-beta/);
  expect(metric('cpu')).toBe('—');
  expect(bar().querySelector('.is-live')).toBeNull();
  expect(row('Copy all metrics').disabled).toBe(true);
  act(() => h.session('connected', 2));
  expect(bar().textContent).toContain('Collecting first sample');
  expect(metric('cpu')).toBe('…');
  act(() => h.publish(sample(29)));
  expect(bar().textContent).toContain('29%');
  expect(row('Copy all metrics').disabled).toBe(false);
});

test('old_menu_copy_after_disconnect_cannot_write_clipboard', async () => {
  const h = setup(); h.publish(sample(61)); h.render(); open();
  const old = row('Copy all metrics');
  // Click before React can commit the disabled state: the handler must read the store.
  act(() => { h.session('disconnected'); old.click(); });
  expect(write).not.toHaveBeenCalled();
  act(() => h.session('connected', 2));
  const fresh = sample(37); act(() => h.publish(fresh));
  open(); await click('Copy all metrics');
  jest.spyOn(Date, 'now').mockReturnValue(fresh.sampledAt + 10);
  const next = sample(48);
  open();
  await act(async () => {
    h.publish(next);
    row('Copy all metrics').click(); // after Redux update, before the already-open menu can commit
  });
  expect(write.mock.calls).toEqual([[formatSshMetricsCopy(fresh)], [formatSshMetricsCopy(next)]]);
});

test('hidden_values_are_copied_and_targeted_checkbox_persists', async () => {
  const h = setup(); h.session('connected', 1, A); h.publish(sample(13, A));
  const b = sample(61); h.publish(b); h.render(); open();
  expect(bar().textContent).not.toContain('10d');
  expect([...document.querySelectorAll('[role="menuitemcheckbox"]')].map(el => el.textContent?.replace('✓', '')))
    .toEqual(SSH_METRIC_KEYS.map(k => SSH_METRIC_LABELS[k]));
  await click('Copy all metrics');
  expect(write).toHaveBeenCalledWith(formatSshMetricsCopy(b));
  expect(write.mock.calls[0][0]).toContain('10d 0h');
  open();
  act(() => h.dispatch(movePaneWithinTab({ tabId: 'tb-a', sourcePaneId: 'pn-other', targetPaneId: 'pn-ssh', zone: 'center' })));
  expect(h.store.getState().panes.treesByTabId['tb-a']?.children?.[0].terminalId).toBe(B);
  await click('RAM');
  expect(selectSshHiddenMetrics(h.store.getState(), A)).toEqual(['nfs', 'cpu']);
  expect(selectSshHiddenMetrics(h.store.getState(), B)).toEqual(['uptime', 'ram']);
  expect(bar().querySelector('[data-metric=ram]')).toBeNull();
});

test('clipboard_rejection_never_shows_copied', async () => {
  const h = setup(); h.publish(sample(61)); h.render(); open();
  write.mockRejectedValueOnce(new Error('denied'));
  await click('Copy all metrics');
  expect(write).toHaveBeenCalledTimes(1);
  expect(h.toasts()).toEqual(['error']);
  let resolve!: () => void;
  write.mockReturnValueOnce(new Promise<void>(r => { resolve = r; }));
  open(); await click('Copy all metrics');
  expect(write).toHaveBeenCalledTimes(2);
  expect(h.toasts()).toEqual(['error']);
  await act(async () => resolve());
  expect(h.toasts()).toEqual(['error', 'success']);
});

test('nonlinux_and_partial_failure_tooltips_explain_na', async () => {
  const h = setup();
  const nonlinux = sample(null);
  for (const k of SSH_METRIC_KEYS) Object.assign(nonlinux.metrics, { [k]: na('Linux-only metrics') });
  h.publish(nonlinux); h.render(); open();
  expect(bar().querySelectorAll('[title$="n/a (Linux-only metrics)"]')).toHaveLength(8);
  await click('Copy all metrics');
  expect(write.mock.calls[0][0].match(/n\/a \(Linux-only metrics\)/g)).toHaveLength(9);
  act(() => h.session('connected', 2));
  act(() => h.publish(sample(34)));
  expect(bar().querySelector('[title="RAM: n/a (meminfo failed)"]')).not.toBeNull();
  expect(bar().querySelector('[title*="n/a (load failed)"]')?.textContent).toBe('34%');
  expect(bar().querySelector('[title*="n/a (arch failed)"]')?.textContent).toBe('db-beta');
  expect(bar().querySelector('[title="Network upload: 3.2 KB/s"]')).not.toBeNull();
  expect(bar().querySelector('[title*="Linux-only metrics"]')).toBeNull();
});

test('all-hidden status bar has a reachable menu hit target that invokes Reset', async () => {
  const h = setup(); h.dispatch(setSshHiddenMetrics({ terminalId: B, hiddenMetrics: SSH_METRIC_KEYS }));
  h.render();
  expect(bar().textContent).toBe('');
  expect(bar().tabIndex).toBe(0);
  open();
  expect(document.querySelectorAll('[role="menuitemcheckbox"][aria-checked="false"]')).toHaveLength(9);
  await click('Reset to defaults');
  expect(selectSshHiddenMetrics(h.store.getState(), B)).toEqual([]);
  expect(bar().querySelectorAll('.ssh-metrics-value')).toHaveLength(9);
  key('F10', true);
  expect(document.querySelectorAll('[role="menuitemcheckbox"][aria-checked="true"]')).toHaveLength(9);
});

test('F3 resumes via the verified lease, starts with a fresh baseline, and never resumes on remount', async () => {
  const h = setup();
  jest.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  let emit!: (s: SshMetricsSample) => void;
  let control!: (c: SshMetricsControl) => void;
  let floor = Date.now() - 20;
  let pauseSeq = 1;
  const reason = "Metrics paused: host didn't answer in 5 s";
  const resume = jest.fn(async () => ({ generation: 1, pauseSeq: 2, sampleFloor: floor }));
  const watch = jest.fn(async (_id: string, _consumer: string, _page?: number) =>
    ({ generation: 1, pauseSeq, pausedReason: reason, sampleFloor: floor }));
  const api: SshMetricsAPI = {
    sshMetricsWatch: watch,
    sshMetricsUnwatch: async () => {}, sshMetricsResume: resume,
    onSshMetricsSample: async cb => { emit = cb; return () => {}; },
    onSshMetricsControl: async cb => { control = cb; return () => {}; },
  };
  dispose = installSshMetricsWatch(h.store, api, { ended: false, pageIdentity: async () => ({ wi: 1, pg: 2 }), subscribe: () => () => {} });
  function Owner({ copy }: { copy: number }) {
    useSshMetricsWatch(B);
    return <SshMetricsStatusBar key={copy} terminalId={B} />;
  }
  h.render(<Owner copy={1} />); await act(flush);
  expect(bar().textContent).toContain(reason);
  expect(metric('cpu')).toBe('—');
  // D93: the Resume action sits right after the status, so overflow drops metric values first.
  expect(bar().querySelector('.ssh-metrics-state')!.nextElementSibling!.tagName).toBe('BUTTON');
  key('ContextMenu'); expect(row('Resume metrics').textContent).toContain('F3');
  expect(row('Copy all metrics').disabled).toBe(true);
  h.render(<></>); await act(flush);
  h.render(<Owner copy={2} />); await act(flush);
  open(); open();
  expect(resume).not.toHaveBeenCalled();
  await click('Resume metrics');
  expect(watch).toHaveBeenCalledTimes(2);
  expect(watch.mock.calls[0][1]).not.toBe(watch.mock.calls[1][1]);
  expect(resume).toHaveBeenCalledWith(B, watch.mock.calls[1][1], 2);
  expect(bar().textContent).not.toContain(reason);
  act(() => emit(sample(99, B, floor)));
  expect(bar().textContent).not.toContain('99%');
  act(() => emit(sample(null, B, floor + 1)));
  expect(metric('cpu')).toBe('…');
  expect(metric('netUp')).toBe('…');
  act(() => emit(sample(35, B, floor + 2)));
  expect(bar().textContent).toContain('35%');
  expect(bar().textContent).toContain('3.2KB/s');
  pauseSeq = 3;
  act(() => control({ terminalId: B, generation: 1, pauseSeq, pausedReason: reason }));
  await act(flush);
  expect(bar().querySelector('.is-live')).toBeNull();
  floor += 2;
  resume.mockResolvedValueOnce({ generation: 1, pauseSeq: 4, sampleFloor: floor });
  key('ContextMenu');
  act(() => row('Resume metrics').dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true, cancelable: true })));
  await act(flush);
  expect(resume).toHaveBeenCalledTimes(2);
  expect(bar().textContent).not.toContain(reason);
});

const visibleValues = () => [...bar().querySelectorAll<HTMLElement>('.ssh-metrics-value')];
test('restored_reattached_pane_reports_metrics_unavailable_not_disconnected', () => {
  const h = setup();
  act(() => h.dispatch(sshAttachmentResolved({ terminalId: A, connectionId: 'saved', reattachedProcessId: 'pc-old' })));
  h.render(<SshMetricsStatusBar terminalId={A} />);
  const state = bar().querySelector<HTMLElement>('.ssh-metrics-state')!;
  expect(state.textContent).toBe('○ Metrics unavailable');
  expect(state.title).toBe('Metrics unavailable — Not available for a session restored from before TermFlow restarted');
  const shown = visibleValues().map(v => v.dataset.metric as typeof SSH_METRIC_KEYS[number]);
  expect(shown.length).toBeGreaterThan(1);
  expect(visibleValues().map(v => [v.dataset.metric, v.textContent, v.title])).toEqual(shown.map(k => [k,
    k === 'host' ? 'saved · n/a' : 'n/a',
    k === 'host' ? `${SSH_METRIC_LABELS[k]}: saved (configured) · n/a` : `${SSH_METRIC_LABELS[k]}: n/a`]));
  expect(bar().textContent).not.toMatch(/…|—|Collecting first sample|Disconnected/);
  open();
  expect(row('Copy all metrics').disabled).toBe(true);
  expect(row('Reconnect')).toBeUndefined();
  expect(row('Resume metrics')).toBeUndefined();
});

test('fresh_unconnected_pane_without_reattach_keeps_disconnected_dashes', () => {
  const h = setup(); h.render(<SshMetricsStatusBar terminalId={A} />);
  expect(bar().querySelector('.ssh-metrics-state')!.textContent).toBe('○ Disconnected');
  expect(metric('ram')).toBe('—');
  expect(bar().textContent).not.toContain('n/a');
});

test('restored_pane_resumes_normal_flow_once_an_app_session_is_observed', () => {
  const h = setup();
  act(() => h.dispatch(sshAttachmentResolved({ terminalId: A, connectionId: 'saved', reattachedProcessId: 'pc-old' })));
  h.render(<SshMetricsStatusBar terminalId={A} />);
  expect(bar().textContent).toContain('Metrics unavailable');
  act(() => h.session('connected', 1, A));
  expect(bar().querySelector('.ssh-metrics-state')!.textContent).toBe('○ Collecting first sample');
  expect(metric('ram')).toBe('…');
  act(() => h.publish(sample(44, A)));
  expect(bar().textContent).toContain('3.2KB/s');
});

test('D93: bar items are compact and value-first; the full label stays in title and aria-label; dividers are CSS-only', () => {
  const css = require('fs').readFileSync(require('path').resolve(__dirname, '../SshMetricsStatusBar.css'), 'utf8').replace(/\s+/g, ' ');
  // The divider is a border on every item after the first, never a DOM node a screen reader could announce.
  expect(css).toContain('.ssh-metrics-status-bar > * + * { border-left: 1px solid');
  // Overflow drops whole items from the end (wrap onto a hidden line) instead of truncating CPU/RAM.
  expect(css).toMatch(/\.ssh-metrics-status-bar \{[^}]*flex-wrap: wrap;[^}]*overflow: hidden;/);
  expect(css).toContain(".ssh-metrics-value[data-metric='cpu'], .ssh-metrics-value[data-metric='ram'], .ssh-metrics-value[data-metric='netUp'], .ssh-metrics-value[data-metric='netDown'] { flex: none; }");
  // Lowest priority last, so it is the first to drop.
  expect(SSH_METRIC_KEYS.slice(-4)).toEqual(['uptime', 'users', 'partitions', 'nfs']);
});

test('D101: every value leads with its own aria-hidden glyph and no text label; the full label stays in title and aria-label', () => {
  const h = setup(); h.dispatch(setSshHiddenMetrics({ terminalId: B, hiddenMetrics: [] })); h.publish(sample(61)); h.render();
  const values = visibleValues();
  expect(values.map(v => v.dataset.metric)).toEqual([...SSH_METRIC_KEYS]);
  // The glyph each metric must draw, by its icon name: a swapped pair (↑/↓) must fail.
  const expected = { host: 'server', cpu: 'chip', ram: 'memory', netUp: 'up', netDown: 'down',
    uptime: 'clock', users: 'user', partitions: 'disk', nfs: 'networkDrive' } as const;
  const pathOf = (name: SshIconName) => /\sd="([^"]+)"/.exec(renderToStaticMarkup(<SshIcon name={name} />))![1];
  for (const v of values) {
    const glyph = v.firstElementChild!;
    expect(glyph.tagName.toLowerCase()).toBe('svg');
    // Icon first, then the value as text: an icon rendered after the value must fail.
    expect(v.firstChild).toBe(glyph);
    expect(v.lastChild!.nodeType).toBe(Node.TEXT_NODE);
    expect(glyph.querySelector('path')!.getAttribute('d')).toBe(pathOf(expected[v.dataset.metric as keyof typeof expected]));
    expect(glyph.getAttribute('aria-hidden')).toBe('true');
    expect(glyph.getAttribute('focusable')).toBe('false');
    expect(v.children).toHaveLength(1);
    const label = SSH_METRIC_LABELS[v.dataset.metric as typeof SSH_METRIC_KEYS[number]];
    expect(v.title.startsWith(`${label}: `)).toBe(true);
    expect(v.getAttribute('aria-label')).toBe(v.title);
    expect(v.textContent!.startsWith(label)).toBe(false);
  }
  // One distinct glyph per metric, so no two values read the same at a glance.
  expect(new Set(values.map(v => v.querySelector('path')!.getAttribute('d'))).size).toBe(values.length);
  expect(metric('cpu')).toBe('61%');
  expect(metric('host')).toBe('db-beta');
});

test('a host with no collector says so instead of Connected, and still shows its measured hostname (D95)', async () => {
  const reason = 'Metrics are supported only on Linux, macOS and Windows (FreeBSD)';
  const freebsd: SshMetricsSample = { terminalId: B, sampledAt: Date.now(), metrics: {
    host: { available: true, hostname: 'bsdbox', os: { available: true, name: 'FreeBSD' }, architecture: { available: true, name: 'amd64' } },
    cpu: na(reason), ram: na(reason), netUp: na(reason), netDown: na(reason), uptime: na(reason),
    users: na(reason), partitions: na(reason), nfs: na(reason), unsupportedPlatform: 'FreeBSD',
  } };
  const h = setup(); h.publish(freebsd); h.render(); open();
  const state = bar().querySelector<HTMLElement>('.ssh-metrics-state')!;
  expect(state.textContent).toBe('○ Metrics not supported on FreeBSD');
  expect(state.title).toBe(`Metrics not supported on FreeBSD — ${reason}`);
  expect(bar().querySelector('.is-live')).toBeNull();
  expect(state.textContent).not.toContain('Connected');
  // D101 value-first items: a glyph then the bare value.
  expect(metric('host')).toBe('bsdbox');
  expect(metric('cpu')).toBe('n/a');
  expect(row('Copy all metrics').disabled).toBe(false);
  await click('Copy all metrics');
  const copied = write.mock.calls[0][0];
  expect(copied).toBe(formatSshMetricsCopy(freebsd));
  expect(copied).toContain('bsdbox (FreeBSD, amd64)');
  expect(copied).toContain(`n/a (${reason})`);
  expect(copied).not.toContain('unsupportedPlatform');
  open();

  // A Linux sample right after goes back to the live, Connected bar.
  act(() => h.publish(sample(12, B, freebsd.sampledAt + 1)));
  expect(bar().querySelector('.ssh-metrics-state')!.textContent).toBe('● Connected');
  expect(bar().querySelector('.is-live')).not.toBeNull();
});

test.each(['Metrics collector unavailable', 'Metrics command failed', 'Metrics exec unavailable'])(
  'whole sample failure is not live: %s', reason => {
    const reading = sample(null);
    for (const key of SSH_METRIC_KEYS) Object.assign(reading.metrics, { [key]: na(reason) });
    reading.metrics.unavailableReason = reason;
    const h = setup(); h.publish(reading); h.render();
    const state = bar().querySelector<HTMLElement>('.ssh-metrics-state')!;
    expect(state.textContent).toBe('○ Metrics unavailable');
    expect(state.title).toBe(`Metrics unavailable — ${reason}`);
    expect(bar().querySelector('.is-live')).toBeNull();
    // Strictly newer than the reading, or the slice drops it as stale within the same millisecond.
    act(() => h.publish(sample(12, B, reading.sampledAt + 1)));
    expect(state.textContent).toBe('● Connected');
    expect(state.title).toBe('Connected');
    expect(bar().querySelector('.is-live')).not.toBeNull();
    expect(bar().querySelector('[data-metric="cpu"]')!.textContent).toContain('12');
  },
);

 test('Darwin measurements render Connected with values', () => {
    const reading = sample(14);
    reading.metrics.host = { available: true, hostname: 'mac-host.local', os: { available: true, name: 'macOS 26.5.2' }, architecture: { available: true, name: 'arm64' } };
    const h = setup(); h.publish(reading); h.render();
    expect(bar().querySelector('.ssh-metrics-state')!.textContent).toBe('● Connected');
    expect(bar().textContent).toContain('14%');
    expect(bar().textContent).toContain('mac-host.local');
 });
