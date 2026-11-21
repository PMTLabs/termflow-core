import type { RootState } from '../../store';
import type { PaneNode } from '../../store/slices/panesSlice';
import type { SshSessionsState } from '../../store/slices/sshSessionSlice';

type MetricKey = 'host' | 'cpu' | 'ram' | 'netUp' | 'netDown' | 'uptime' | 'users' | 'partitions' | 'nfs';

// 066-rebase: import SshPaneTag from types/ssh.
export interface SshPaneTag {
  connectionId: string;
  browserCollapsed: boolean;
  browserPath?: string;
  followCd: boolean;
  hiddenMetrics: MetricKey[];
}

// 066-rebase: wire the injected callback to patchSshPaneTag({ terminalId, patch }).
export type SshBrowserTagPatch = Partial<Pick<SshPaneTag, 'browserCollapsed' | 'browserPath' | 'followCd'>>;

export interface LaunchSnapshot {
  stage: 'preparing' | 'waiting-ready' | 'waiting-trust' | 'typed' | 'running'
    | 'ended' | 'blocked' | 'cancelled' | 'error';
  sessionGeneration: number;
  launchSeq: number;
  revision: number;
}

export type ReconnectCoordinator = (terminalId: string) => Promise<
  { ok: true; snapshot: LaunchSnapshot } | { ok: false; error: { code: string; message: string } }
>;

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

export function readSshLaunchState(_state: RootState, _terminalId: string): LaunchSnapshot | undefined {
  // 066-rebase: return selectSshLaunch(state, terminalId).
  return undefined;
}

export function readReconnectCoordinator(): ReconnectCoordinator | undefined {
  // 066-rebase: return reconnectSshTerminal from services/sshLaunch.ts, never bare sshSessionReconnect.
  return undefined;
}
