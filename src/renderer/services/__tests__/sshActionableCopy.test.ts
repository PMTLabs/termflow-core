import { getPaneStartupStatus, paneStartupFailureCode } from '../paneStartupStatus';
import { savedSshConnectionIssue } from '../savedSshConnectionIssue';
import type { SshState } from '../../store/slices/sshSlice';
import { sshLaunchEndReason } from '../../components/Ssh/SshLaunchNotice';

test('only the terminal host wire code selects the outdated-host copy', () => {
  const copy = "The terminal host is out of date. Restart TermFlow's terminal host, then retry.";
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
