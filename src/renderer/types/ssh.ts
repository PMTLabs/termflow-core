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
  forgetSecret(id: string): Promise<SshReply>;
  setBookmark(id: string, bookmarked: boolean): Promise<SshReply>;
  onChanged(listener: (reply: SshReply) => void): Promise<() => void>;
}

export type SshState = 'connecting' | 'needs-secret' | 'needs-hostkey' | 'connected' | 'disconnected' | 'error';
export interface SshPromptTarget { connectionId: string; host: string; port: number; user: string; hop: 'jump' | 'target' }
export interface SshSessionView {
  terminalId?: string; probeId?: string; connectionId: string; state: SshState;
  generation?: number; revision?: number; gate: 'pending' | 'verified' | 'network-error' | 'blocked';
  reason?: string;
  /** Kebab-case code for `reason` (a backend SessionError code or `saved-credential-unavailable`); read this, never the text. */
  errorCode?: string;
  knownHostsPaths?: { jump?: string; target: string };
  promptId?: string; promptTarget?: SshPromptTarget; secretKind?: 'password' | 'passphrase';
  hostKey?: { algorithm: string; fingerprintSha256: string; changed: boolean };
}
export interface SshPromptReceipt { generation?: number; promptId?: string }
export type SshUnlisten = () => void;
export interface SshAPI {
  sshSessionOpen(terminalId: string, connectionId: string): Promise<SshSessionView>;
  sshSessionState(terminalId: string): Promise<SshSessionView>;
  sshSessionClose(terminalId: string, generation?: number): Promise<void>;
  sshSessionReconnect(terminalId: string): Promise<SshSessionView>;
  sshSessionSubmitSecret(terminalId: string, secret: string, remember: boolean, receipt?: SshPromptReceipt): Promise<void>;
  sshSessionTrustHost(terminalId: string, accept: boolean, receipt?: SshPromptReceipt): Promise<void>;
  sshTestConnection(connectionId: string): Promise<{ probeId: string }>;
  sshTestState(probeId: string): Promise<SshSessionView>;
  sshTestClose(probeId: string): Promise<void>;
  sshTestSubmitSecret(probeId: string, secret: string, remember: boolean, receipt?: SshPromptReceipt): Promise<void>;
  sshTestTrustHost(probeId: string, accept: boolean, receipt?: SshPromptReceipt): Promise<void>;
  onSshSessionState(listener: (view: SshSessionView) => void): Promise<SshUnlisten>;
  onSshTestState(listener: (view: SshSessionView) => void): Promise<SshUnlisten>;
}
export function newerSshView(current: SshSessionView | undefined, next: SshSessionView): boolean {
  if (!current) return true;
  const cg = current.generation ?? 0, ng = next.generation ?? 0;
  return ng > cg || (ng === cg && (next.revision ?? 0) > (current.revision ?? 0));
}
