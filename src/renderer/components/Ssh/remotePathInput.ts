import type { SshRowScope } from './useSshFileBrowser';

export function insertPathReason(path: string): string | undefined {
  if (!path.startsWith('/')) return 'Terminal insertion requires an absolute remote path.';
  if (/\p{Cc}/u.test(path)) return 'Terminal insertion refuses paths containing control characters.';
  return undefined;
}

export async function insertRemotePath(scope: SshRowScope): Promise<void> {
  if (!scope.isLive() || insertPathReason(scope.request.path)) return;
  // Rust owns encoding, the write-time generation fence, and PTY routing.
  const result = await scope.api.fsInsertPath(scope.request);
  if (!result.written) throw new Error('The terminal did not accept the path.');
}
