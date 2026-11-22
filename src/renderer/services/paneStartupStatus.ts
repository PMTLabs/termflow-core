// Decides the top-row status shown in a pane's content area while its shell is
// starting (P0: immediate "Starting new shell..." instead of a blank/centered
// placeholder). Framework-free so TerminalPane's render branch can stay a thin
// call-site and the decision itself is unit-testable without React.

type PaneStartupFailure = 'PtyHostOutdated' | true | { code: 'SshDataPathUnusable'; reason: string };
export type PaneStartupFailed = false | PaneStartupFailure;

const SSH_DATA_PATH_PREFIX = 'SshDataPathUnusable: ';

export function paneStartupFailureCode(error: unknown): PaneStartupFailure {
  if (error === 'PtyHostOutdated') return error;
  if (typeof error === 'string' && error.startsWith(SSH_DATA_PATH_PREFIX)) {
    return { code: 'SshDataPathUnusable', reason: error.slice(SSH_DATA_PATH_PREFIX.length) };
  }
  return true;
}

export interface PaneStartupStatus {
  text: string;
  failed: boolean;
}

/**
 * @param processId - set once the spawned shell's PID is known; while
 *   undefined the shell is still starting (or failed to start).
 * @param startupFailed - true when the most recent create/restart attempt's
 *   promise rejected.
 * @returns null once `processId` is set (TerminalDisplay takes over), else the
 *   status line to render.
 */
export function getPaneStartupStatus(
  processId: string | undefined,
  startupFailed: PaneStartupFailed
): PaneStartupStatus | null {
  if (processId) return null;
  if (startupFailed === 'PtyHostOutdated') return {
    text: "The terminal host is out of date. Restart TermFlow's terminal host, then retry.", failed: true,
  };
  if (typeof startupFailed === 'object') return {
    text: `TermFlow's data folder path can't be used for SSH helpers: ${startupFailed.reason}.`, failed: true,
  };
  if (startupFailed) return { text: 'Failed to start shell', failed: true };
  return { text: 'Starting new shell…', failed: false };
}
