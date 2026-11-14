import type { SshReply, SshStoreApi } from '../../../types/ssh';

export function sshErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return typeof error === 'string' ? error : 'SSH operation failed';
}

export async function refreshReadOnly(error: unknown, api: SshStoreApi, apply: (reply: SshReply) => void): Promise<void> {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'store-read-only') apply(await api.get());
}
