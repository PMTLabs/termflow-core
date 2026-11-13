import type { SshReply, SshStoreApi } from '../types/ssh';
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <T>(event: string, listener: (event: { payload: T }) => void) => Promise<() => void>;
export function createSshBridge(invoke: Invoke, listen: Listen): SshStoreApi {
  return {
    get: () => invoke('ssh_store_get'), reload: () => invoke('ssh_store_reload'),
    upsertFolder: input => invoke('ssh_folder_upsert', { input }),
    deleteFolder: input => invoke('ssh_folder_delete', { ...input }),
    upsertConnection: input => invoke('ssh_connection_upsert', { input }),
    deleteConnection: input => invoke('ssh_connection_delete', { ...input }),
    move: input => invoke('ssh_move', { ...input }),
    setBookmark: (id, bookmarked) => invoke('ssh_set_bookmark', { id, bookmarked }),
    onChanged: listener => listen<SshReply>('ssh-store:changed', event => listener(event.payload)),
  };
}
const desktopOnly = async (): Promise<never> => { throw { code: 'desktop-only', message: 'SSH connections require the desktop app' }; };
export const browserSshBridge: SshStoreApi = {
  get: desktopOnly, reload: desktopOnly, upsertFolder: desktopOnly, deleteFolder: desktopOnly,
  upsertConnection: desktopOnly, deleteConnection: desktopOnly, move: desktopOnly,
  setBookmark: desktopOnly, onChanged: desktopOnly,
};
