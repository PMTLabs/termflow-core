export type SshAuth = 'keyFile' | 'agent' | 'password';
export interface SshError { field?: string | null; code: string; message: string }
export interface SshFolderInput { id?: string; parentId: string | null; name: string; icon: string; color: string }
export interface SshFolder extends Omit<SshFolderInput, 'id'> { id: string; order: number }
export interface SshConnectionInput {
  id?: string; folderId: string | null; name: string; host: string; port: number; user: string;
  auth: SshAuth; identityFile: string | null; jumpConnectionId: string | null;
  extraOptions: [string, string][]; bookmarked: boolean;
}
export interface SshConnection extends Omit<SshConnectionInput, 'id'> { id: string; order: number; lastUsedAt: string | null; hasSavedSecret: boolean }
export interface SshView { revision: number; folders: SshFolder[]; connections: SshConnection[]; loadError: SshError | null }
export interface SshReply { revision: number; view: SshView }
export interface SshMove { kind: 'folder' | 'connection'; id: string; parentId: string | null; index: number }
export interface SshStoreApi {
  get(): Promise<SshReply>; reload(): Promise<SshReply>;
  upsertFolder(input: SshFolderInput): Promise<SshReply>;
  deleteFolder(input: { id: string; recursive: boolean }): Promise<SshReply>;
  upsertConnection(input: SshConnectionInput): Promise<SshReply>;
  deleteConnection(input: { id: string }): Promise<SshReply>;
  move(input: SshMove): Promise<SshReply>;
  setBookmark(id: string, bookmarked: boolean): Promise<SshReply>;
  onChanged(listener: (reply: SshReply) => void): Promise<() => void>;
}
