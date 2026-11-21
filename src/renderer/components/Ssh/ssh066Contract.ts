import type { PaneNode } from '../../store/slices/panesSlice';
import type { SshSessionsState } from '../../store/slices/sshSessionSlice';

type MetricKey = 'host' | 'cpu' | 'ram' | 'netUp' | 'netDown' | 'uptime' | 'users' | 'partitions' | 'nfs';

// 064 §3.1: 066 owns the tag and persists these preferences.
export interface SshPaneTag {
  connectionId: string;
  browserCollapsed: boolean;
  browserPath?: string;
  followCd: boolean;
  hiddenMetrics: MetricKey[];
}

export interface SshLaunchStateEvent {
  terminalId: string;
  state: 'typed' | 'running' | 'ended';
}

/** Consumer port, not a 066 implementation. Reopens the app channel and retypes SSH. */
export interface ReconnectCoordinator {
  reconnect(terminalId: string): Promise<unknown>;
}

export function readSshPaneTag(pane: PaneNode): SshPaneTag | undefined {
  // 066-rebase: replace the structural read with the actual 066 PaneNode tag.
  return (pane as PaneNode & { ssh?: SshPaneTag }).ssh;
}

export interface SshFileSession {
  generation?: number;
  connected: boolean;
}

/** App-channel state only. In particular, connected does not imply launch running. */
export function readSshFileSession(sessions: SshSessionsState, terminalId: string): SshFileSession {
  const session = sessions.byTerminal[terminalId]?.session;
  return { generation: session?.generation, connected: session?.state === 'connected' };
}

export function readSshLaunchState(_terminalId: string): SshLaunchStateEvent['state'] | undefined {
  // 066-rebase: read launch state from 066. Rust current_launch is not exposed by IPC.
  return undefined;
}

export function readReconnectCoordinator(): ReconnectCoordinator | undefined {
  // 066-rebase: supply the 066 coordinator, never a bare sshSessionReconnect.
  return undefined;
}
