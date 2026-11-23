import type { SshFileApi } from '../components/Ssh/sshFileTypes';

export type SshBridgeApi = SshStoreApi & SshFileApi;

export type SshAuth = 'keyFile' | 'agent' | 'password';
export interface SshError { field?: string | null; code: string; message: string }
export interface SshFolderInput { id?: string; parentId: string | null; name: string; icon: string; color: string }
export interface SshFolder extends Omit<SshFolderInput, 'id'> { id: string; order: number }
export interface SshConnectionInput {
  id?: string; folderId: string | null; name: string; host: string; port: number; user: string;
  auth: SshAuth; identityFile: string | null; jumpConnectionId: string | null;
  extraOptions: [string, string][]; bookmarked: boolean;
}
export interface SshConnection extends Omit<SshConnectionInput, 'id'> { id: string; order: number; lastUsedAt: number | null; hasSavedSecret: boolean }
export interface SshView { revision: number; folders: SshFolder[]; connections: SshConnection[]; loadError: SshError | null }
export interface SshReply { revision: number; view: SshView }
export interface SshMove { kind: 'folder' | 'connection'; id: string; parentId: string | null; index: number }
export type SshPreviewSource =
  | { kind: 'saved'; id: string }
  | { kind: 'draft'; draft: SshConnectionInput; editingId?: string };
export interface SshShellCommand { shell: string; label: string; text: string; unavailable?: string }
export interface SshPreview { argv: string[]; commands: SshShellCommand[]; storeRevision: number; configNotice: string; wrapper: string }
export interface SshPreviewError {
  code: 'Validation' | 'NotFound' | 'UnsupportedContext' | 'SshClientMissing' | 'StoreUnavailable' | 'desktop-only';
  message: string;
  fields?: SshError[];
}
/** Display order. Persisted preferences preserve their encoded order. */
export const METRIC_KEYS = ['host', 'cpu', 'ram', 'netUp', 'netDown', 'uptime', 'users', 'partitions', 'nfs'] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];
const knownMetrics: ReadonlySet<unknown> = new Set(METRIC_KEYS);

export function normalizeHiddenMetrics(value: unknown): MetricKey[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((key): key is MetricKey => knownMetrics.has(key)))];
}
export interface SshPaneTag {
  connectionId: string;
  browserCollapsed: boolean;
  browserPath?: string;
  followCd: boolean;
  hiddenMetrics: MetricKey[];
}

export type LaunchAttemptReceipt = Pick<SshSessionView, 'gate' | 'reason' | 'errorCode' | 'knownHostsPaths'> & { generation: number };
export interface LaunchAttemptRef {
  sessionGeneration: number;
  attemptReceipt: LaunchAttemptReceipt;
  processIncarnation: string;
  ownerIncarnation: import('../services/paneIncarnations').PaneIncarnation;
}
export interface LaunchError {
  code: 'StaleAttempt' | 'NotFound' | 'InputLocked' | 'UnsupportedShell' | 'UnsupportedContext' | 'SshClientMissing'
    | 'TrustBlocked' | 'Timeout' | 'WriteFailed' | 'SshExitedBeforeConnecting' | 'TransportClosed' | 'StoreUnavailable' | 'desktop-only';
  message: string;
}
export interface LaunchSnapshot {
  terminalId: string;
  connectionId: string;
  attempt: LaunchAttemptRef;
  revision: number;
  launchSeq: number;
  stage: 'preparing' | 'waiting-ready' | 'waiting-trust' | 'typed' | 'running' | 'ended' | 'blocked' | 'cancelled' | 'error';
  error?: LaunchError;
}
export interface SshLaunchEvent { terminalId: string; state: 'typed' | 'running' | 'ended' }
export interface SshLaunchApi {
  launchTerminal(terminalId: string, connectionId: string, attempt: LaunchAttemptRef): Promise<LaunchSnapshot>;
  cancelTerminalLaunch(terminalId: string, attempt: LaunchAttemptRef): Promise<LaunchSnapshot>;
  terminalLaunchState(terminalId: string, attempt: LaunchAttemptRef): Promise<LaunchSnapshot>;
}

export interface SshStoreApi {
  previewConnection(input: { source: SshPreviewSource }): Promise<SshPreview>;
  markUsed(id: string): Promise<SshReply>;
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
  /** Malformed known_hosts line (1-based), or 0 for invalid file encoding. */
  errorLine?: number;
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
  onSshLaunchState?(listener: (event: SshLaunchEvent) => void): Promise<SshUnlisten>;
  onSshSessionState(listener: (view: SshSessionView) => void): Promise<SshUnlisten>;
  onSshTestState(listener: (view: SshSessionView) => void): Promise<SshUnlisten>;
}
// 069 wire contract. Raw counters never leave the native reducer.
export type Metric<T> = ({ available: true } & T) | { available: false; reason: string };
export interface MountUsage {
  source: string; mountPoint: string; fsType: string;
  totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number;
}
interface MetricPayloads {
  host: { hostname: string; os: Metric<{ name: string }>; architecture: Metric<{ name: string }> };
  cpu: { percent: number | null; cores: Metric<{ count: number }>; load1: Metric<{ value: number }> };
  ram: { usedBytes: number; totalBytes: number; percent: number };
  netUp: { bytesPerSecond: number | null };
  netDown: { bytesPerSecond: number | null };
  uptime: { seconds: number };
  users: { count: number; names: string[] };
  partitions: { mounts: MountUsage[] };
  nfs: { mounts: MountUsage[] };
}
type Assert<T extends true> = T;
// Require both directions so extra wire keys cannot silently escape the display list.
export type MetricPayloadKeysMatch = Assert<
  [keyof MetricPayloads] extends [MetricKey] ? [MetricKey] extends [keyof MetricPayloads] ? true : false : false
>;
export type SshMetrics = { [K in MetricKey]: Metric<MetricPayloads[K]> };
export interface SshMetricsSample { terminalId: string; sampledAt: number; metrics: SshMetrics }
export interface SshMetricsResumeReceipt { sampleFloor: number; generation: number; pauseSeq: number }
export interface SshMetricsWatchReceipt extends SshMetricsResumeReceipt { pausedReason: string | null }
export interface SshMetricsControl { terminalId: string; generation: number; pauseSeq: number; pausedReason: string | null }
export interface SshMetricsAPI {
  sshMetricsWatch(terminalId: string, consumerId: string, pg?: number): Promise<SshMetricsWatchReceipt>;
  sshMetricsUnwatch(terminalId: string, consumerId: string, pg?: number): Promise<void>;
  sshMetricsResume(terminalId: string, consumerId: string, pg?: number): Promise<SshMetricsResumeReceipt>;
  onSshMetricsSample(listener: (sample: SshMetricsSample) => void): Promise<SshUnlisten>;
  onSshMetricsControl(listener: (control: SshMetricsControl) => void): Promise<SshUnlisten>;
}

export function newerSshView(current: SshSessionView | undefined, next: SshSessionView): boolean {
  if (!current) return true;
  const cg = current.generation ?? 0, ng = next.generation ?? 0;
  return ng > cg || (ng === cg && (next.revision ?? 0) > (current.revision ?? 0));
}
