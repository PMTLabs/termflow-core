/** IPC shapes from commands/ssh_fs.rs, ssh/sftp and ssh/session/remote_cwd.rs. */
export type RemoteKind = 'file' | 'directory' | 'symlink' | 'other';

export interface RemoteEntry {
  name: string;
  path: string;
  kind: RemoteKind;
  size?: string; // Decimal u64, not a JS number.
  mtime?: number;
  atime?: number;
  mode?: number;
  uid?: number;
  gid?: number;
}

export interface RemoteStat extends RemoteEntry {
  linkTarget?: string;
}

export interface RemoteListing {
  path: string;
  entries: RemoteEntry[];
  sessionGeneration: number;
}

export type FsCode = 'notConnected' | 'permissionDenied' | 'notFound' | 'exists'
  | 'unsupported' | 'invalidPath' | 'conflict' | 'io' | 'cancelled' | 'stale';
export type FsOutcome = 'unchanged' | 'partial' | 'unknown';

export interface FsError {
  code: FsCode;
  operation: string;
  path: string;
  message: string;
  outcome: FsOutcome;
  completedPaths?: string[];
  retainedLocalPath?: string;
}

export interface InsertPath { written: boolean }
export type DownloadResult =
  | { status: 'cancelled' }
  | { status: 'done'; localPath: string; files: number; dirs: number };

export type EditState = 'watching' | 'uploading' | 'paused' | 'conflict' | 'error';
export type OpenStatus = 'needsEditor' | 'cancelled';
export type EditOpen =
  | { editId: string; state: EditState; localPath: string }
  | { editId?: never; state: OpenStatus };

export interface EditNotice {
  terminalId: string;
  editId: string;
  path: string;
  state: string; // Rust &'static str, including transient 'uploaded' and 'stopped'.
  sessionGeneration: number;
  localPath?: string;
  error?: string;
}

export interface EditStatus extends EditNotice { retained: boolean }
export interface EditStop { retained: boolean; localPath?: string }

export interface CwdEvent {
  terminalId: string;
  path: string;
  host: string;
  sessionGeneration: number;
}

export interface FsTarget { terminalId: string; path: string }
export interface FsRequest extends FsTarget { expectedGeneration: number }

export interface SshFileApi {
  fsList(input: FsRequest): Promise<RemoteListing>;
  fsStat(input: FsRequest): Promise<RemoteStat>;
  fsMkdir(input: FsRequest): Promise<void>;
  fsCreate(input: FsRequest): Promise<void>;
  fsRename(input: FsRequest & { newPath: string }): Promise<void>;
  fsDelete(input: FsRequest & { recursive: boolean; confirmed: boolean }): Promise<void>;
  fsChmod(input: FsRequest & { mode: number }): Promise<void>;
  fsChown(input: FsRequest & { uid?: number; gid?: number }): Promise<void>;
  fsDownload(input: FsRequest): Promise<DownloadResult>;
  fsOpen(input: FsRequest): Promise<EditOpen>;
  fsOpenWith(input: FsRequest): Promise<EditOpen>;
  fsInsertPath(input: FsRequest): Promise<InsertPath>;
  fsEditStop(input: FsTarget & { editId: string }): Promise<EditStop>;
  fsEditList(input: FsTarget): Promise<EditStatus[]>;
  onFsEditState(listener: (notice: EditNotice) => void): Promise<() => void>;
  onFsCwd(listener: (event: CwdEvent) => void): Promise<() => void>;
}
