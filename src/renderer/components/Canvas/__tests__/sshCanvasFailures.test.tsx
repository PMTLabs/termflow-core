/**
 * @jest-environment jsdom
 *
 * Plan 070 T4 — truthful failure parity on Canvas: host-key trust receipts, stale/failed file
 * replies across a disconnect/reconnect, and the "—" status in every non-live state.
 *
 * Renderer halves only. The Rust-side refusal/fence halves of the same named rows belong to T7.
 * JSDOM IS NOT A LAYOUT ENGINE; nothing here measures. The 066 tag is read structurally through
 * the `readSshPaneTag` seam, and the 066 launch state through the mocked `readSshLaunchState`.
 */
const fakeCache = new Map<string, any>();
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: fakeCache, isFindShortcut: () => false }));
jest.mock('../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
jest.mock('../../../services/TerminalService', () => ({
  terminalService: { writeToTerminal: jest.fn(), getProcessIdForTerminal: () => undefined },
}));
jest.mock('../../Terminal/useDetectedAgent', () => ({ useDetectedAgent: () => ({ agent: null, icon: null }) }));
jest.mock('../../../utils/clipboard', () => ({ writeClipboardText: jest.fn(async () => {}) }));
jest.mock('../../Ssh/ssh066Contract', () => ({
  ...jest.requireActual('../../Ssh/ssh066Contract'), readSshLaunchState: jest.fn(), readReconnectCoordinator: jest.fn(),
}));

/* eslint-disable import/first */
import React, { act } from 'react';
import { sshMetricsArmed, sshMetricsSampled } from '../../../store/slices/sshSessionSlice';
import type { SshMetrics } from '../../../types/ssh';
import { dismissAllToasts } from '../../../store/slices/uiSlice';
import { terminalService } from '../../../services/TerminalService';
import { SshPaneShell } from '../../Ssh/SshPaneShell';
import type { RemoteListing } from '../../Ssh/sshFileTypes';
import type { SshSessionView } from '../../../types/ssh';
import {
  SshScene, canvasNode, clickAsync, entry, errorToasts, flush, held, installBridge, makeBridge,
  menuItem, nodeSpies, observe, openRowMenu, paneShell, rowButton, seedTerminals, setLaunch,
  setupHarness, store, successToasts,
} from '../../../__testFixtures__/sshCanvasInteractionHarness';
import { LaunchNoticeProbe } from '../../../__testFixtures__/sshLaunchNoticeProbe';
import { sshOwnsKeyboard } from '../canvasGestures';

const A = 'tm-a';
const h = setupHarness();

beforeEach(() => {
  jest.mocked(terminalService.writeToTerminal).mockClear();
  act(() => { store.dispatch(dismissAllToasts()); });
});

const lastList = (bridge: ReturnType<typeof makeBridge>) => bridge.ssh.fsList.mock.calls[bridge.ssh.fsList.mock.calls.length - 1][0];
const buttons = (scope: ParentNode, label: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.getAttribute('aria-label') === label || b.textContent === label);

describe('host-key trust on the Canvas surface', () => {
  // D51: 066's launch notice owns the host-key and secret prompts on BOTH surfaces. In Canvas it is
  // portalled into the SSH node's terminal slot; neither SSH shell renders a second copy.
  it('sshTrust_canvasCancelAndChangedKey_neverWriteSsh', async () => {
    seedTerminals({ [A]: { browserPath: '/srv/a' } });
    const bridge = makeBridge({ [A]: { '/srv/a': [] } });
    installBridge(bridge);
    setLaunch({});                                  // waiting on trust: nothing typed or running
    const hostKey = { algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:unknown', changed: false };
    observe({ terminalId: A, state: 'needs-hostkey', generation: 1, revision: 1, gate: 'pending', promptId: 'p-1', hostKey });
    await h.render(<>
      <SshScene ids={[A]} canvas spies={nodeSpies()} />
      <LaunchNoticeProbe terminalId={A} onTrust={receipt => bridge.sshSessionTrustHost(A, true, receipt)} />
    </>);
    const node = canvasNode(A);

    // Exactly one visible challenge, inside the Canvas node's terminal slot, owned by the notice.
    expect(document.querySelectorAll('.ssh-prompt')).toHaveLength(1);
    const prompt = node.querySelector('.ssh-launch-notice .ssh-prompt')!;
    expect(prompt).not.toBeNull();
    // The notice is portalled into the slot wrapper (inside the shell); no shell renders its own.
    expect([...document.querySelectorAll('.ssh-pane-shell .ssh-prompt')].filter(p => !p.closest('.ssh-launch-notice'))).toEqual([]);
    expect(paneShell(A).querySelector('.ssh-prompt')).toBeNull();
    // Canvas shortcuts and wheel leave the notice alone (D51 item 3).
    expect(sshOwnsKeyboard(prompt.querySelector('button'))).toBe(true);

    // Positive control: Trust on the CURRENT receipt accepts exactly that receipt.
    await clickAsync(buttons(node, 'Trust')[0]);
    expect(bridge.sshSessionTrustHost.mock.calls).toEqual([[A, true, { generation: 1, promptId: 'p-1' }]]);

    // A replacement prompt: Cancel goes to 066's launch coordinator and never accepts a key.
    observe({ terminalId: A, state: 'needs-hostkey', generation: 1, revision: 2, gate: 'pending', promptId: 'p-2', hostKey });
    await act(async () => { await flush(); });
    await clickAsync(buttons(canvasNode(A), 'Cancel')[0]);

    // A CHANGED key, whether still a prompt or already refused: nothing can accept it.
    const changed = { ...hostKey, fingerprintSha256: 'SHA256:changed', changed: true };
    for (const view of [
      { state: 'needs-hostkey' as const, revision: 3, promptId: 'p-3' },
      { state: 'error' as const, revision: 4, promptId: 'p-4', reason: 'Host key changed' },
    ]) {
      observe({ terminalId: A, generation: 1, gate: 'blocked', hostKey: changed, ...view });
      await act(async () => { await flush(); });
      expect(buttons(canvasNode(A), 'Trust')).toHaveLength(0);
      for (const button of Array.from(canvasNode(A).querySelectorAll<HTMLButtonElement>('.ssh-launch-notice button'))) await clickAsync(button);
    }
    expect(bridge.sshSessionTrustHost.mock.calls.filter(([, accept]) => accept)).toEqual([[A, true, { generation: 1, promptId: 'p-1' }]]);

    // No path types `ssh` (or anything) from the renderer: that is 066's Rust launch coordinator.
    expect(terminalService.writeToTerminal).not.toHaveBeenCalled();
    expect(bridge.writeToTerminal).not.toHaveBeenCalled();
    // While not connected, the Canvas status row is "—" and the browser is dimmed and disabled.
    expect(node.querySelector('.ssh-status-text')!.textContent).toBe('—');
    expect(node.querySelector('.ssh-browser')!.classList.contains('offline')).toBe(true);
  });
});

describe('file replies across a disconnect', () => {
  it('sshFsCanvas_lateReplyAndPermissionFailure_neverCommitSuccess', async () => {
    seedTerminals({ [A]: { browserPath: '/srv/a' } });
    const bridge = makeBridge({ [A]: { '/srv/a': [entry('/srv/a/one.txt'), entry('/srv/a/two.txt'), entry('/srv/a/old', 'directory')] } });
    installBridge(bridge);
    const launch: Record<string, number | undefined> = { [A]: 1 };
    setLaunch(launch);
    observe({ terminalId: A, state: 'connected', generation: 1, revision: 1 });
    await h.render(<SshScene ids={[A]} canvas spies={nodeSpies()} />);
    const node = canvasNode(A);
    const refresh = () => buttons(canvasNode(A), 'Refresh')[0];

    // Live listing, then a valid positive action whose success IS toasted (the detector works).
    expect(rowButton(node, '/srv/a/one.txt')).toBeTruthy();
    expect(refresh().disabled).toBe(false);
    await openRowMenu(node, '/srv/a/one.txt');
    await clickAsync(menuItem('Download…'));
    expect(successToasts()).toEqual(['Remote download complete.']);
    act(() => { store.dispatch(dismissAllToasts()); });

    // Hold two replies issued on generation 1: a download and a navigation.
    const download = held<{ status: 'done'; localPath: string; files: number; dirs: number }>();
    bridge.ssh.fsDownload.mockImplementationOnce(() => download.promise);
    await openRowMenu(node, '/srv/a/two.txt');
    await clickAsync(menuItem('Download…'));
    const navigation = held<RemoteListing>();
    bridge.ssh.fsList.mockImplementationOnce(() => navigation.promise);
    await act(async () => { rowButton(canvasNode(A), '/srv/a/old').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await flush(); });
    expect(lastList(bridge)).toEqual({ terminalId: A, path: '/srv/a/old', expectedGeneration: 1 });

    // Disconnect: every control is disabled, the browser dims and the status row reads "—".
    observe({ terminalId: A, state: 'disconnected', generation: 1, revision: 2, reason: 'Connection lost' });
    await act(async () => { await flush(); });
    expect(refresh().disabled).toBe(true);
    expect(buttons(canvasNode(A), 'New folder')[0].disabled).toBe(true);
    expect(canvasNode(A).querySelector<HTMLInputElement>('input[aria-label="Remote path"]')!.disabled).toBe(true);
    expect(canvasNode(A).querySelector('.ssh-browser')!.classList.contains('offline')).toBe(true);
    expect(canvasNode(A).querySelector('.ssh-status-text')!.textContent).toBe('—');
    expect(canvasNode(A).textContent).toContain('Remote files unavailable');

    // Reconnect on generation 2 (both the app channel and the launch seam).
    launch[A] = 2;
    observe({ terminalId: A, state: 'connected', generation: 2, revision: 1 });
    await act(async () => { await flush(); });
    expect(lastList(bridge)).toEqual({ terminalId: A, path: '/srv/a', expectedGeneration: 2 });
    expect(canvasNode(A).querySelector('.ssh-browser')!.classList.contains('offline')).toBe(false);

    // The held generation-1 replies land late. Neither commits.
    await act(async () => {
      download.resolve({ status: 'done', localPath: 'C:/dl/two.txt', files: 1, dirs: 0 });
      navigation.resolve({ path: '/srv/a/old', entries: [entry('/srv/a/old/ghost.txt')], sessionGeneration: 1 });
      await flush();
    });
    expect(successToasts()).toEqual([]);
    expect(canvasNode(A).textContent).toContain('Current directory: /srv/a');
    expect(canvasNode(A).textContent).not.toContain('ghost.txt');

    // A permission failure on the CURRENT generation: a path-specific error, confirmed path kept.
    bridge.ssh.fsList.mockImplementationOnce(async () => {
      throw { code: 'permissionDenied', operation: 'list', path: '/root', message: 'Permission denied', outcome: 'unchanged' };
    });
    const input = canvasNode(A).querySelector<HTMLInputElement>('input[aria-label="Remote path"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '/root');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    });
    await act(async () => {
      input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
    });
    expect(canvasNode(A).querySelector('[role=alert]')!.textContent).toBe('Permission denied: /root');
    expect(canvasNode(A).textContent).toContain('Current directory: /srv/a');
    expect(successToasts()).toEqual([]);
    expect(errorToasts()).toEqual([]);

    // Zero creates/uploads anywhere in the sequence, and no generic PTY write.
    expect(bridge.ssh.fsMkdir).not.toHaveBeenCalled();
    expect(bridge.ssh.fsCreate).not.toHaveBeenCalled();
    expect(bridge.writeToTerminal).not.toHaveBeenCalled();
  });
});

describe('metrics status row', () => {
  // No terminalId: the bare shell then renders no edit notice, which would need the file bridge.
  const view = (state: SshSessionView['state']): SshSessionView => ({ connectionId: 'conn-shared', state, generation: 1, revision: 1, gate: 'verified' });

  it('sshMetricsCanvas_disconnectThenLateSample_staysUnavailable', async () => {
    // The shared shell's status slot (069 plugs its bar in here; 069-rebase).
    const shell = (state: SshSessionView['state'], launchDisconnected: boolean) => <SshPaneShell view={view(state)}
      terminal={<div className="terminal-pane-content" />} status={<span>Live metrics</span>}
      browser={<span>Live files</span>} browserCollapsed={false} onBrowserCollapsedChange={jest.fn()}
      launchDisconnected={launchDisconnected} onSecret={jest.fn(async () => {})} onTrust={jest.fn(async () => {})} onCancel={jest.fn()} />;

    // Positive control: connected with a running launch shows the live slot.
    await h.render(shell('connected', false));
    expect(h.container.querySelector('.ssh-status')!.textContent).toBe('Live metrics');
    expect(h.container.querySelector('.ssh-browser')!.classList.contains('offline')).toBe(false);

    // Every non-live state: "—" and a dimmed browser, including an ENDED launch on a still
    // connected app channel (the remote ssh exited while the local shell lives).
    for (const [state, ended] of [['connected', true], ['connecting', false], ['needs-secret', false], ['needs-hostkey', false], ['disconnected', false], ['error', false]] as const) {
      await h.render(shell(state, ended));
      expect(h.container.querySelector('.ssh-status-text')!.textContent).toBe('—');
      expect(h.container.querySelector('.ssh-browser')!.classList.contains('offline')).toBe(true);
      // Not just dimmed: the live browser slot is replaced, including on an ended launch.
      expect(h.container.textContent).not.toContain('Live files');
      expect(h.container.querySelector('.ssh-browser-unavailable')!.textContent).toBe('Remote files unavailable');
    }

    // The same rule on Canvas, through the real presentation: disconnected reads "—".
    await h.render(null);
    seedTerminals({ [A]: { browserPath: '/srv/a' } });
    installBridge(makeBridge({ [A]: { '/srv/a': [] } }));
    setLaunch({ [A]: 1 });
    observe({ terminalId: A, state: 'connected', generation: 1, revision: 1 });
    await h.render(<SshScene ids={[A]} canvas spies={nodeSpies()} />);
    expect(canvasNode(A).querySelector('.ssh-browser')!.classList.contains('offline')).toBe(false);
    const node = canvasNode(A);
    expect(node.querySelectorAll('.ssh-status')).toHaveLength(1);
    expect(node.querySelectorAll('.ssh-metrics-status-bar')).toHaveLength(1);
    const bar = node.querySelector('.ssh-status > .ssh-metrics-status-bar')!;
    const na = { available: false as const, reason: 'Not sampled' };
    const metrics: SshMetrics = { host: na, cpu: na, ram: na, netUp: { available: true, bytesPerSecond: 3200 },
      netDown: na, uptime: na, users: na, nfs: na, partitions: na };
    const now = { wall: Date.now(), mono: performance.now() };
    const sampleFloor = now.wall - 1;
    const consumerId = 'canvas-test';
    const sample = () => store.dispatch(sshMetricsSampled({ now, consumerId,
      sample: { terminalId: A, sampledAt: now.wall, metrics } }));
    act(() => {
      store.dispatch(sshMetricsArmed({ terminalId: A,
        receipt: { generation: 1, sampleFloor, pauseSeq: 0, pausedReason: null },
        fence: { ...now, consumerId, generation: 1, sampleFloor, trustWall: true } }));
      sample();
    });
    expect(bar.querySelector('[data-metric=netUp]')!.textContent).toBe('3.2KB/s');
    observe({ terminalId: A, state: 'disconnected', generation: 1, revision: 2 });
    await act(async () => { sample(); await flush(); });
    expect(bar.textContent).toContain('Disconnected');
    expect(bar.querySelector('.ssh-metrics-state')!.classList.contains('is-live')).toBe(false);
    expect(bar.textContent).not.toContain('3.2KB/s');
    expect(bar.querySelector('[data-metric=netUp]')!.textContent).toBe('—');
    act(() => { bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    expect(buttons(document, 'Copy all metrics')[0].disabled).toBe(true);
    expect(node.querySelector('.ssh-status-text')!.textContent).toBe('—');
    expect(node.querySelector('.ssh-browser')!.classList.contains('offline')).toBe(true);
  });
});
