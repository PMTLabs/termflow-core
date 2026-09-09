import type { ConnectedHostRetention } from '../../api/tauri-bridge';

const formatDuration = (activeSecs: number): string => {
  if (activeSecs % 3600 === 0) return `${activeSecs / 3600} hour${activeSecs === 3600 ? '' : 's'}`;
  if (activeSecs % 60 === 0) return `${activeSecs / 60} minute${activeSecs === 60 ? '' : 's'}`;
  return `${activeSecs} seconds`;
};

/**
 * The identical lifecycle warning is intentionally shared by the panel and its
 * confirmation dialog: either surface drifting would falsely describe Offload.
 */
export const offloadRetentionCopy = (retention: ConnectedHostRetention): string => {
  switch (retention.state) {
    case 'bounded': {
      const duration = formatDuration(retention.activeSecs);
      return `The connected PTY host retains shells for ${duration}. Relaunch TermFlow within that grace period to reclaim everything; after it, the shells are closed. MCP/API clients drop when TermFlow closes and may need to reconnect or reinitialize when TermFlow returns.`;
    }
    case 'indefinite':
      return 'The connected PTY host promises no time limit for retaining shells, but that does not mean TermFlow will still be there. Relaunch while the host is available to reclaim everything; if it is no longer available, its shells are closed. MCP/API clients drop when TermFlow closes and may need to reconnect or reinitialize when TermFlow returns.';
    case 'unknown':
      return 'The connected host retention policy is unavailable (legacy host) — no bound promised. Relaunch while the host is available to reclaim everything; if it is no longer available, its shells are closed. MCP/API clients drop when TermFlow closes and may need to reconnect or reinitialize when TermFlow returns.';
  }
};
