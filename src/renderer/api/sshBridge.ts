import type { SshBridgeApi, SshLaunchApi, SshReply } from '../types/ssh';
import type { CwdEvent, EditNotice } from '../components/Ssh/sshFileTypes';
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <T>(event: string, listener: (event: { payload: T }) => void) => Promise<() => void>;
export function createSshBridge(invoke: Invoke, listen: Listen): SshBridgeApi & SshLaunchApi {
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
    fsList: input => invoke('ssh_fs_list', { ...input }),
    fsStat: input => invoke('ssh_fs_stat', { ...input }),
    fsMkdir: input => invoke('ssh_fs_mkdir', { ...input }),
    fsCreate: input => invoke('ssh_fs_create', { ...input }),
    fsRename: input => invoke('ssh_fs_rename', { ...input }),
    fsDelete: input => invoke('ssh_fs_delete', { ...input }),
    fsChmod: input => invoke('ssh_fs_chmod', { ...input }),
    fsChown: input => invoke('ssh_fs_chown', { ...input }),
    fsDownload: input => invoke('ssh_fs_download', { ...input }),
    fsOpen: input => invoke('ssh_fs_open', { ...input }),
    fsOpenWith: input => invoke('ssh_fs_open_with', { ...input }),
    fsInsertPath: input => invoke('ssh_fs_insert_path', { ...input }),
    fsEditStop: input => invoke('ssh_fs_edit_stop', { ...input }),
    fsEditList: input => invoke('ssh_fs_edit_list', { ...input }),
    onFsEditState: listener => listen<EditNotice>('ssh-fs:edit-state', event => listener(event.payload)),
    onFsCwd: listener => listen<CwdEvent>('ssh-fs:cwd', event => listener(event.payload)),
  };
}
const desktopOnly = async (): Promise<never> => { throw { code: 'desktop-only', message: 'SSH connections require the desktop app' }; };
const desktopFilesOnly = async (): Promise<never> => { throw new Error('SSH files are desktop only'); };
export const browserSshBridge: SshBridgeApi & SshLaunchApi = {
  get: desktopOnly, reload: desktopOnly, upsertFolder: desktopOnly, deleteFolder: desktopOnly,
  upsertConnection: desktopOnly, deleteConnection: desktopOnly, move: desktopOnly,
  forgetSecret: desktopOnly, setBookmark: desktopOnly, previewConnection: desktopOnly, markUsed: desktopOnly, onChanged: desktopOnly,
  launchTerminal: desktopOnly, cancelTerminalLaunch: desktopOnly, terminalLaunchState: desktopOnly,
  fsList: desktopFilesOnly, fsStat: desktopFilesOnly, fsMkdir: desktopFilesOnly,
  fsCreate: desktopFilesOnly, fsRename: desktopFilesOnly, fsDelete: desktopFilesOnly,
  fsChmod: desktopFilesOnly, fsChown: desktopFilesOnly, fsDownload: desktopFilesOnly,
  fsOpen: desktopFilesOnly, fsOpenWith: desktopFilesOnly, fsInsertPath: desktopFilesOnly,
  fsEditStop: desktopFilesOnly, fsEditList: desktopFilesOnly,
  onFsEditState: desktopFilesOnly, onFsCwd: desktopFilesOnly,
};
