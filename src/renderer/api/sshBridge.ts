import type { SshLaunchApi, SshReply, SshStoreApi } from '../types/ssh';
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <T>(event: string, listener: (event: { payload: T }) => void) => Promise<() => void>;
export function createSshBridge(invoke: Invoke, listen: Listen): SshStoreApi & SshLaunchApi {
  return {
    get: () => invoke('ssh_store_get'), reload: () => invoke('ssh_store_reload'),
    upsertFolder: input => invoke('ssh_folder_upsert', { input }),
    deleteFolder: input => invoke('ssh_folder_delete', { ...input }),
    upsertConnection: input => invoke('ssh_connection_upsert', { input }),
    deleteConnection: input => invoke('ssh_connection_delete', { ...input }),
    move: input => invoke('ssh_move', { ...input }),
    forgetSecret: id => invoke('ssh_forget_secret', { id }),
    setBookmark: (id, bookmarked) => invoke('ssh_set_bookmark', { id, bookmarked }),
    previewConnection: input => invoke('ssh_connection_preview', input),
    markUsed: id => invoke('ssh_connection_mark_used', { id }),
    launchTerminal: (terminalId, connectionId, attempt) => invoke('ssh_terminal_launch', { terminalId, connectionId, attempt }),
    cancelTerminalLaunch: (terminalId, attempt) => invoke('ssh_terminal_cancel_launch', { terminalId, attempt }),
    terminalLaunchState: (terminalId, attempt) => invoke('ssh_terminal_launch_state', { terminalId, attempt }),
    onChanged: listener => listen<SshReply>('ssh-store:changed', event => listener(event.payload)),
  };
}
const desktopOnly = async (): Promise<never> => { throw { code: 'desktop-only', message: 'SSH connections require the desktop app' }; };
export const browserSshBridge: SshStoreApi & SshLaunchApi = {
  get: desktopOnly, reload: desktopOnly, upsertFolder: desktopOnly, deleteFolder: desktopOnly,
  upsertConnection: desktopOnly, deleteConnection: desktopOnly, move: desktopOnly,
  forgetSecret: desktopOnly, setBookmark: desktopOnly, previewConnection: desktopOnly, markUsed: desktopOnly, onChanged: desktopOnly,
  launchTerminal: desktopOnly, cancelTerminalLaunch: desktopOnly, terminalLaunchState: desktopOnly,
};
