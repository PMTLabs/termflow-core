import { store } from '../../store';
import { addToast } from '../../store/slices/uiSlice';
import { writeClipboardText } from '../../utils/clipboard';
import type { FsError } from './sshFileTypes';

export function sshFileToast(type: 'success' | 'error', message: string) {
  store.dispatch(addToast({ type, message }));
}

export function operationError(failure: unknown, path: string): string {
  const detail = failure as Partial<FsError> | undefined;
  const message = detail?.message || (typeof failure === 'string' ? failure : 'Remote file operation failed.');
  return `${detail?.path ?? path}: ${message}`;
}

export async function copyRemotePath(path: string) {
  try {
    await writeClipboardText(path);
    sshFileToast('success', 'Remote path copied.');
  } catch {
    sshFileToast('error', 'Could not copy the remote path.');
  }
}
