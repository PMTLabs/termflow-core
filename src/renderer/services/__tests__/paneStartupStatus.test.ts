import { getPaneStartupStatus, paneStartupFailureCode } from '../paneStartupStatus';

describe('getPaneStartupStatus', () => {
  it('returns null once a processId is set (TerminalDisplay takes over)', () => {
    expect(getPaneStartupStatus('1234', false)).toBeNull();
    // Even a stale startupFailed flag must not resurrect the status once the
    // process is live.
    expect(getPaneStartupStatus('1234', true)).toBeNull();
  });

  it('shows the immediate "Starting new shell…" status while processId is unset', () => {
    const status = getPaneStartupStatus(undefined, false);
    expect(status).not.toBeNull();
    expect(status?.text).toBe('Starting new shell…');
    expect(status?.failed).toBe(false);
  });

  it('carries and renders the SSH data path refusal reason', () => {
    const reason = 'a folder in its path is not a folder';
    const failure = paneStartupFailureCode(`SshDataPathUnusable: ${reason}`);
    expect(failure).toEqual({ code: 'SshDataPathUnusable', reason });
    expect(getPaneStartupStatus(undefined, failure)).toEqual({
      text: `TermFlow's data folder path can't be used for SSH helpers: ${reason}.`,
      failed: true,
    });
    expect(paneStartupFailureCode(`wrapper: SshDataPathUnusable: ${reason}`)).toBe(true);
  });

  it('shows a non-blank failure status when startup failed', () => {
    const status = getPaneStartupStatus(undefined, true);
    expect(status).not.toBeNull();
    expect(status?.text).toBe('Failed to start shell');
    expect(status?.failed).toBe(true);
  });
});
