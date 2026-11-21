import React, { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialogA11y } from '../../UI/useDialogA11y';
import type { SshFolderInput } from '../../../types/ssh';
import '../../UI/ConfirmDialog.css';
export function SshFolderDialog({ input, onSave, onClose, readOnly = false }: { input:SshFolderInput; onSave(input:SshFolderInput):Promise<boolean>; onClose():void; readOnly?:boolean }) {
  const ref = useRef<HTMLDivElement>(null); const titleId = useId();
  const [name, setName] = useState(input.name); const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const length = [...name].length;
  const errorId = useId(); const hintId = useId();
  const [trigger] = useState(() => input.id
    ? Array.from(document.querySelectorAll<HTMLElement>('[data-row-id]')).find(row => row.dataset.rowId === input.id)?.querySelector<HTMLElement>('.ssh-tree-row')
    : document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const close = () => { onClose(); requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus(); }); };
  useDialogA11y(ref, { isOpen:!readOnly, onCancel:close, initialFocus:'first' });
  if (readOnly) return null;
  return createPortal(<div className="confirm-dialog-overlay" onClick={close}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="confirm-dialog ssh-folder-dialog" onClick={event => event.stopPropagation()}>
      <div className="confirm-dialog-header"><h3 id={titleId}>{input.id ? 'Rename folder' : 'New folder'}</h3></div>
      <form onSubmit={async event => { event.preventDefault(); if (busy || readOnly) return; const invalid = !name.trim() ? 'Enter a folder name.' : length > 80 ? 'Folder names can be up to 80 characters.' : ''; if (invalid) { setError(invalid); return; } setBusy(true); try { if (await onSave({ ...input, name })) close(); } finally { setBusy(false); } }}>
        <div className="confirm-dialog-body"><label>Folder name<input value={name} onChange={event => { setName(event.target.value); setError(''); }} aria-invalid={!!error} aria-describedby={[error && errorId, length > 70 && hintId].filter(Boolean).join(' ') || undefined} /></label>{error && <p id={errorId} role="alert">{error}</p>}<div aria-live="polite">{length > 70 && <span id={hintId}>{length} / 80 characters</span>}</div></div>
        <div className="confirm-dialog-footer"><button type="button" className="confirm-btn cancel" data-dialog-cancel onClick={close}>Cancel</button><button type="submit" className="confirm-btn primary" data-dialog-confirm disabled={busy}>Save folder</button></div>
      </form>
    </div>
  </div>, document.body);
}
