import { getPaneStartupStatus } from '../paneStartupStatus';

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

  it('shows a non-blank failure status when startup failed', () => {
    const status = getPaneStartupStatus(undefined, true);
    expect(status).not.toBeNull();
    expect(status?.text).toBe('Failed to start shell');
    expect(status?.failed).toBe(true);
  });
});
