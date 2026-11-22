import type { SshState } from '../store/slices/sshSlice';

const issues = {
  StoreUnavailable: { code: 'StoreUnavailable', message: "SSH connections couldn't be loaded. Open Settings > SSH Connections to see the details.", settings: true },
  NotFound: { code: 'NotFound', message: 'This saved SSH connection was deleted. Pick another from SSH Connections.', settings: true },
  Loading: { code: 'Loading', message: 'Loading SSH connections…' },
  'desktop-only': { code: 'desktop-only', message: 'SSH connections require the desktop app.' },
} as const;

export type SavedSshConnectionIssue = typeof issues[keyof typeof issues];

export function savedSshConnectionIssue(state: SshState | undefined, connectionId: string): SavedSshConnectionIssue | undefined {
  if (!state || state.status === 'loading') return issues.Loading;
  if (state.status === 'desktop-only') return issues['desktop-only'];
  if (state.status === 'error' || state.view.loadError?.code) return issues.StoreUnavailable;
  return state.view.connections.some(connection => connection.id === connectionId) ? undefined : issues.NotFound;
}
