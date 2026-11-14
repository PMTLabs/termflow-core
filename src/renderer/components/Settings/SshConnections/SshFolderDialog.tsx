import React, { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialogA11y } from '../../UI/useDialogA11y';
import type { SshFolderInput } from '../../../types/ssh';
import '../../UI/ConfirmDialog.css';
export function SshFolderDialog({ input, onSave, onClose, readOnly = false }: { input:SshFolderInput; onSave(input:SshFolderInput):Promise<boolean>; onClose():void; readOnly?:boolean }) {
  const ref = useRef<HTMLDivElement>(null); const titleId = useId();
  const [name, setName] = useState(input.name); const [busy, setBusy] = useState(false);
  useDialogA11y(ref, { isOpen:!readOnly, onCancel:onClose });
  if (readOnly) return null;
  return createPortal(<div className="confirm-dialog-overlay" onClick={onClose}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="confirm-dialog ssh-folder-dialog" onClick={event => event.stopPropagation()}>
      <div className="confirm-dialog-header"><h3 id={titleId}>{input.id ? 'Rename folder' : 'New folder'}</h3></div>
      <form onSubmit={async event => { event.preventDefault(); if (busy || readOnly) return; setBusy(true); try { if (await onSave({ ...input, name })) onClose(); } finally { setBusy(false); } }}>
        <div className="confirm-dialog-body"><label>Folder name<input autoFocus value={name} onChange={event => setName(event.target.value)} required maxLength={80} /></label></div>
        <div className="confirm-dialog-footer"><button type="button" className="confirm-btn cancel" data-dialog-cancel onClick={onClose}>Cancel</button><button type="submit" className="confirm-btn primary" data-dialog-confirm disabled={busy}>Save folder</button></div>
      </form>
    </div>
  </div>, document.body);
}
