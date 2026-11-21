import React, { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialogA11y } from '../UI/useDialogA11y';
import type { CreateKind } from './useSshFileBrowser';
import '../UI/ConfirmDialog.css';

interface Props {
  kind: CreateKind;
  path: string;
  onSubmit(name: string): Promise<{ error?: string; acknowledged?: boolean }>;
  onClose(): void;
}

export function SshNameDialog({ kind, path, onSubmit, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const cancel = () => { if (!busy.current) onClose(); };
  useDialogA11y(ref, { isOpen: true, onCancel: cancel });
  return createPortal(<div className="confirm-dialog-overlay" onClick={cancel}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
      className="confirm-dialog" onClick={event => event.stopPropagation()}>
      <div className="confirm-dialog-header"><h3 id={titleId}>New {kind}</h3></div>
      <form onSubmit={async event => {
        event.preventDefault();
        if (busy.current || done || !name) return;
        busy.current = true; setPending(true); setError(undefined);
        try {
          const result = await onSubmit(name);
          if (!result.error) onClose();
          else { setError(result.error); setDone(!!result.acknowledged); }
        } finally { busy.current = false; setPending(false); }
      }}>
        <div className="confirm-dialog-body">
          <p>In <code>{path}</code></p>
          <label>{kind === 'folder' ? 'Folder name' : 'File name'}
            <input className="ssh-remote-name" required value={name} readOnly={pending || done}
              onChange={event => setName(event.target.value)} />
          </label>
          {error && <p role="alert">{error}</p>}
        </div>
        <div className="confirm-dialog-footer">
          <button type="button" className="confirm-btn cancel" disabled={pending}
            data-dialog-cancel onClick={cancel}>{done ? 'Close' : 'Cancel'}</button>
          <button type="submit" className="confirm-btn primary" disabled={pending || done}>Create</button>
        </div>
      </form>
    </div>
  </div>, document.body);
}
