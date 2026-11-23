import fs from 'fs';
import path from 'path';
import { readSource } from '../../utils/readSource';
import { getPaneStartupStatus, paneStartupFailureCode } from '../paneStartupStatus';
import { savedSshConnectionIssue } from '../savedSshConnectionIssue';
import type { SshState } from '../../store/slices/sshSlice';
import { sshLaunchEndReason } from '../../components/Ssh/SshLaunchNotice';

test('only the terminal host wire code selects the outdated-host copy', () => {
  const copy = "This TermFlow's terminal host is older than the app, so it can't open SSH sessions. Reinstall or rebuild TermFlow to get a matching host.";
  expect(getPaneStartupStatus(undefined, paneStartupFailureCode('PtyHostOutdated'))?.text).toBe(copy);
  for (const message of [copy, 'PtyHostOutdated: details', 'another error']) {
    expect(getPaneStartupStatus(undefined, paneStartupFailureCode(message))?.text).toBe('Failed to start shell');
  }
});

test('a coded store load failure is not mistaken for a deleted connection', () => {
  const state: SshState = { status: 'ready', revision: 0, error: null,
    view: { revision: 0, folders: [], connections: [], loadError: null } };
  const deleted = savedSshConnectionIssue(state, 'missing');
  expect(deleted).toMatchObject({ code: 'NotFound', message: expect.stringContaining('was deleted') });
  for (const message of [deleted!.message, 'different details']) {
    state.view.loadError = { field: null, code: 'invalid-json', message };
    expect(savedSshConnectionIssue(state, 'missing')).toMatchObject({
      code: 'StoreUnavailable', message: expect.stringContaining("couldn't be loaded"),
    });
  }
});

test.each([
  ['SshExitedBeforeConnecting', 'SSH exited before connecting. Check the terminal output above for the reason.'],
  ['TransportClosed', 'The local terminal connection closed. Reconnect to try again.'],
] as const)('%s end reason depends on its code, not message', (code, copy) => {
  for (const message of ['SSH did not start', 'different details']) {
    expect(sshLaunchEndReason({ code, message })).toBe(copy);
  }
});

test('an end with no reason code points at the terminal output and Reconnect', () => {
  expect(sshLaunchEndReason()).toBe('The reason, if any, is in the terminal output above. Reconnect to try again.');
});

test('loading, desktop-only and a failed load each keep their own issue', () => {
  expect(savedSshConnectionIssue(undefined, 'c')?.code).toBe('Loading');
  expect(savedSshConnectionIssue({ status: 'loading' } as SshState, 'c')?.code).toBe('Loading');
  expect(savedSshConnectionIssue({ status: 'desktop-only' } as SshState, 'c')?.code).toBe('desktop-only');
  expect(savedSshConnectionIssue({ status: 'error', error: 'x' } as unknown as SshState, 'c')?.code).toBe('StoreUnavailable');
  const listed: SshState = { status: 'ready', revision: 0, error: null,
    view: { revision: 0, folders: [], connections: [{ id: 'c' } as SshState['view']['connections'][number]], loadError: null } };
  expect(savedSshConnectionIssue(listed, 'c')).toBeUndefined();
});

test('census: no SSH surface renders the old ↗ connection icon', () => {
  const roots = ['components/Ssh', 'components/Settings/SshConnections'].map(dir => path.join(__dirname, '..', '..', dir));
  const offenders = roots.flatMap(dir => fs.readdirSync(dir).filter(f => /\.tsx?$/.test(f) && !/\.test\./.test(f))
    .filter(f => readSource(path.join(dir, f)).includes('↗')).map(f => path.join(dir, f)));
  expect(offenders).toEqual([]);
});

test('census: every TerminalPane startup failure keeps its code, and the pane uses the coded SSH issue', () => {
  const pane = readSource(path.join(__dirname, '..', '..', 'components', 'Panes', 'TerminalPane.tsx'));
  // The two create/restart error catches. The `setStartupFailed(true)` sites are authorizeExisting
  // refusals, which never carry a host spawn error, so they keep the generic copy.
  expect(pane.match(/setStartupFailed\(paneStartupFailureCode\(error\)\)/g)).toHaveLength(2);
  expect(pane.match(/\.catch\(error => \{[^}]*setStartupFailed\(true\)/g)).toBeNull();
  expect(pane).toMatch(/savedSshConnectionIssue\(state\.ssh, sshConnectionId\)/);
  expect(pane).not.toMatch(/saved SSH connection is unavailable/);
});
