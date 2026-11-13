import React, { useEffect, useState } from 'react';
import { ContextMenu, ContextMenuItem } from '../../Terminal/ContextMenu';
import { ConfirmDialog } from '../../UI/ConfirmDialog';
import { FolderIconPicker } from './FolderIconPicker';
import type { SshFolder, SshConnection, SshStoreApi, SshView, SshReply } from '../../../types/ssh';
export interface SshMenuTarget { deleteRequested?:boolean; x:number; y:number; row?: SshFolder | SshConnection; kind?: 'folder' | 'connection' }
export function SshMenus({ target, view, api, commit, onClose, onFolder, onConnection, onRename }: {
  target:SshMenuTarget; view:SshView; api:SshStoreApi; commit(operation: () => Promise<SshReply>): Promise<unknown>;
  onClose():void; onFolder(parentId:string | null):void; onConnection(folderId:string | null):void; onRename(row:SshFolder | SshConnection, kind:'folder' | 'connection'):void;
}) {
  const [confirm, setConfirm] = useState(false); const [menuOpen, setMenuOpen] = useState(true);
  const { row, kind } = target; const folder = kind === 'folder' ? row as SshFolder : undefined;
  const ids = new Set(folder ? [folder.id] : []);
  for (let i = 0; i < view.folders.length; i++) for (const f of view.folders) if (f.parentId && ids.has(f.parentId)) ids.add(f.id);
  const connections = view.connections.filter(c => c.folderId && ids.has(c.folderId)).length;
  const nonempty = ids.size > 1 || connections > 0;
  const remove = () => { if (!row) return; void commit(() => folder ? api.deleteFolder({ id:folder.id, recursive:nonempty }) : api.deleteConnection({ id:row.id })); onClose(); };
  const requestDelete = () => { if (folder && !nonempty) remove(); else { setConfirm(true); setMenuOpen(false); } };
  useEffect(() => { if (target.deleteRequested) requestDelete(); }, []);
  const items: ContextMenuItem[] = folder ? [
    { label:'Add subfolder', click:() => onFolder(folder.id) },
    { label:'New SSH connection here', click:() => onConnection(folder.id) },
    { label:'Folder icon', customFlyout:{ panelClassName:'ssh-picker-flyout', content:<FolderIconPicker icon={folder.icon} color={folder.color} onClose={onClose} onPick={(icon,color) => { void commit(() => api.upsertFolder({ id:folder.id, parentId:folder.parentId, name:folder.name, icon, color })); onClose(); }} /> } },
    { label:'Rename', accelerator:'F2', click:() => onRename(folder, 'folder') },
    { label:'Delete folder…', accelerator:'Del', click:requestDelete },
  ] : row ? [
    { label:(row as SshConnection).bookmarked ? 'Unbookmark' : 'Bookmark', click:() => { void commit(() => api.setBookmark(row.id, !(row as SshConnection).bookmarked)); } },
    { label:'Rename', accelerator:'F2', click:() => onRename(row, 'connection') },
    { label:'Delete…', accelerator:'Del', click:requestDelete },
  ] : [ { label:'New folder', click:() => onFolder(null) }, { label:'New SSH connection', click:() => onConnection(null) } ];
  return <>{menuOpen && <ContextMenu x={target.x} y={target.y} items={items} onClose={() => { if (!confirm) setMenuOpen(false); }} />}
    <ConfirmDialog isOpen={confirm} title={folder ? 'Delete folder' : 'Delete connection'} message={folder ? `Delete ${folder.name}: ${ids.size - 1} subfolders and ${connections} connections?` : `Delete ${row?.name}?`} confirmText="Delete" destructive onConfirm={remove} onCancel={onClose} />
  </>;
}
