import type { RootState } from '../../store';
import type { PaneNode } from '../../store/slices/panesSlice';
import type { SshSessionsState } from '../../store/slices/sshSessionSlice';
import { selectSshLaunch, type SshLaunchState } from '../../store/slices/sshSessionSlice';
import type { SshPaneTag } from '../../types/ssh';

// The one place 068 reads 066's pane tag, launch state and reconnect coordinator.
export type { SshPaneTag };

/** The tag fields the browser may change. The mount wires this to 066's
 *  `patchSshPaneTag({ terminalId, patch })` (store/slices/panesSlice.ts). */
export type SshBrowserTagPatch = Partial<Pick<SshPaneTag, 'browserCollapsed' | 'browserWidth' | 'browserPath' | 'followCd'>>;

/** 066's per-terminal launch state (`sshLaunch` slice). */
export type LaunchSnapshot = SshLaunchState;

export type ReconnectCoordinator = (terminalId: string) => Promise<
  { ok: true; snapshot: import('../../types/ssh').LaunchSnapshot } | { ok: false; error: { code: string; message: string } }
>;

export function readSshPaneTag(pane: PaneNode): SshPaneTag | undefined {
  return pane.ssh;
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

export function readSshLaunchState(state: RootState, terminalId: string): LaunchSnapshot | undefined {
  return selectSshLaunch(state, terminalId);
}

/**
 * 066's real end-old-login/relaunch coordinator, never a bare `sshSessionReconnect`.
 * Loaded lazily: `services/sshLaunch` imports the store, which must not load with this module.
 */
const reconnectViaLaunchCoordinator: ReconnectCoordinator = terminalId =>
  import('../../services/sshLaunch').then(launch => launch.reconnectSshTerminal(terminalId));

export function readReconnectCoordinator(): ReconnectCoordinator | undefined {
  return reconnectViaLaunchCoordinator;
}
