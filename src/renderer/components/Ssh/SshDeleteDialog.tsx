import React, { useRef, useState } from 'react';
import { ConfirmDialog } from '../UI/ConfirmDialog';
import { operationError, sshFileToast } from './sshFileFeedback';
import type { FsError } from './sshFileTypes';
import type { SshRowScope } from './useSshFileBrowser';
import { staleTarget } from './useSshTargetStat';
import { sshShellOwnsFocusRestore } from './SshFileDialog';

export function SshDeleteDialog({ scope, recursive, onClose }: {
  scope: SshRowScope; recursive: boolean; onClose(): void;
}) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  const [completedPaths, setCompletedPaths] = useState<string[]>([]);
  const { api, request } = scope;
  const confirm = async () => {
    if (busy.current || done || !scope.isLive()) return;
    busy.current = true; setPending(true); setError(undefined);
    try {
      await api.fsDelete({ ...request, recursive, confirmed: true });
      if (await scope.refresh() && scope.isCurrent()) {
        sshFileToast('success', 'Remote entry deleted.');
        onClose();
      } else {
        setDone(true);
        setError('Deleted on the server, but the directory could not be refreshed.');
      }
    } catch (cause) {
      setError(operationError(cause, request.path));
      const { outcome, completedPaths } = (cause ?? {}) as Partial<FsError>;
      setCompletedPaths(completedPaths ?? []);
      if (outcome !== 'unchanged') {
        setDone(true);
        await scope.refresh();
      }
    } finally {
      busy.current = false; setPending(false);
    }
  };
  // Same Canvas keyboard ownership and focus-restore veto as the other SSH dialogs (plan 070 T4).
  return <ConfirmDialog isOpen destructive title="Delete remote entry?" confirmText="Delete"
    sshKeyboardOwner restoreFocusIf={sshShellOwnsFocusRestore}
    cancelText={done ? 'Close' : 'Cancel'}
    confirmDisabled={done || pending || !scope.isLive()} cancelDisabled={pending}
    onCancel={() => { if (!busy.current) onClose(); }} onConfirm={() => void confirm()}
    message={<>
      <p>Delete <code className="ssh-remote-path">{request.path}</code>?</p>
      {recursive && <>
        <p>This recursively deletes the folder and all its contents, without traversing symbolic links.</p>
        <p>Concurrent changes between the server checks and deletion can still affect the result.</p>
      </>}
      {pending && <p role="status">Deleting…</p>}
      {(error || !scope.isLive()) && !pending && <p role="alert">{error || staleTarget}</p>}
      {!!completedPaths.length && <details>
        <summary>{completedPaths.length} removals acknowledged</summary>
        <ul>{completedPaths.map(path => <li key={path}><code className="ssh-remote-path">{path}</code></li>)}</ul>
      </details>}
    </>} />;
}
