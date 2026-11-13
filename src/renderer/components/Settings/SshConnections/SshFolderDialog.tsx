import React, { useRef, useState } from 'react';
import { useDialogA11y } from '../../UI/useDialogA11y';
import type { SshFolderInput } from '../../../types/ssh';
export function SshFolderDialog({ input, onSave, onClose }: { input:SshFolderInput; onSave(input:SshFolderInput):Promise<boolean>; onClose():void }) {
  const ref = useRef<HTMLDivElement>(null); const [name, setName] = useState(input.name); const [busy, setBusy] = useState(false);
  useDialogA11y(ref, { isOpen:true, onCancel:onClose });
  return <div className="confirm-dialog-overlay"><div ref={ref} role="dialog" aria-modal="true" aria-label={input.id ? 'Rename folder' : 'New folder'} className="confirm-dialog"><h3>{input.id ? 'Rename folder' : 'New folder'}</h3><form onSubmit={async event => { event.preventDefault(); if (busy) return; setBusy(true); if (await onSave({ ...input, name })) onClose(); setBusy(false); }}><label>Folder name<input autoFocus value={name} onChange={event => setName(event.target.value)} required maxLength={80} /></label><div className="confirm-dialog-buttons"><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={busy}>Save folder</button></div></form></div></div>;
}
