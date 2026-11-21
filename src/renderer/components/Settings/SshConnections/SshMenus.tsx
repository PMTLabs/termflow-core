import React, { useEffect, useState } from 'react';
import { ContextMenu, ContextMenuItem } from '../../Terminal/ContextMenu';
import { ConfirmDialog } from '../../UI/ConfirmDialog';
import { sshMoveIndex } from '../../../services/sshMoveIndex';
import { FolderIconPicker } from './FolderIconPicker';
import type { SshFolder, SshConnection, SshStoreApi, SshView, SshReply } from '../../../types/ssh';
export interface SshMenuTarget { deleteRequested?:boolean; x:number; y:number; row?: SshFolder | SshConnection; kind?: 'folder' | 'connection' }
export function SshMenus({ target, view, api, commit, onClose, onFolder, onConnection, onRename }: {
  target:SshMenuTarget; view:SshView; api:SshStoreApi; commit(operation: () => Promise<SshReply>): Promise<unknown>;
  onClose():void; onFolder(parentId:string | null):void; onConnection(folderId:string | null):void; onRename(row:SshFolder | SshConnection, kind:'folder' | 'connection'):void;
}) {
  const [confirm, setConfirm] = useState(false); const [menuOpen, setMenuOpen] = useState(true);
  const readOnly = !!view.loadError;
  const { row, kind } = target; const folder = kind === 'folder' ? row as SshFolder : undefined;
  const ids = new Set(folder ? [folder.id] : []);
  for (let i = 0; i < view.folders.length; i++) for (const f of view.folders) if (f.parentId && ids.has(f.parentId)) ids.add(f.id);
  const connections = view.connections.filter(c => c.folderId && ids.has(c.folderId)).length;
  const nonempty = ids.size > 1 || connections > 0;
  const treeRow = () => Array.from(document.querySelectorAll<HTMLElement>('.ssh-tree [data-row-id]')).find(element => element.dataset.rowId === row?.id);
  const restoreDeleteFocus = (ids: (string | undefined)[]) => requestAnimationFrame(() => {
    const tree = document.querySelector<HTMLElement>('.ssh-tree');
    const rows = Array.from(tree?.querySelectorAll<HTMLElement>('[data-row-id]') ?? []);
    for (const id of ids) {
      const control = rows.find(element => element.dataset.rowId === id)?.querySelector<HTMLElement>(':scope > .ssh-tree-row');
      if (control) { control.focus(); return; }
    }
    tree?.focus();
  });
  const cancelDelete = () => { onClose(); restoreDeleteFocus([row?.id]); };
  const remove = async () => {
    if (readOnly || !row) return;
    const origin = treeRow();
    const siblings = Array.from(origin?.parentElement?.querySelectorAll<HTMLElement>(':scope > [data-row-id]') ?? []);
    const index = origin ? siblings.indexOf(origin) : -1;
    const nearest = siblings.map((element, position) => ({ id:element.dataset.rowId, position }))
      .filter(({ position }) => position !== index)
      .sort((a,b) => Math.abs(a.position - index) - Math.abs(b.position - index) || b.position - a.position);
    onClose();
    const deleted = await commit(() => folder ? api.deleteFolder({ id:folder.id, recursive:nonempty }) : api.deleteConnection({ id:row.id }));
    restoreDeleteFocus(deleted ? nearest.map(({ id }) => id) : [row.id]);
  };
  const requestDelete = () => { if (readOnly) return; if (folder && !nonempty) void remove(); else { setConfirm(true); setMenuOpen(false); } };
  useEffect(() => { if (target.deleteRequested) requestDelete(); }, []);
  const moves: ContextMenuItem[] = row && kind ? ([-1, 1] as const).map(step => {
    const parentId = folder ? folder.parentId : (row as SshConnection).folderId;
    const sibling = view.folders.find(f => f.parentId === parentId && f.order === row.order + step)
      ?? view.connections.find(c => c.folderId === parentId && c.order === row.order + step);
    const move = sibling && sshMoveIndex(view, { kind,id:row.id }, { zone:step < 0 ? 'before' : 'after',id:sibling.id });
    return { label:step < 0 ? 'Move up' : 'Move down', icon:step < 0 ? '↑' : '↓', enabled:!!move, click:async () => {
      if (!move) return;
      if (await commit(() => api.move(move))) {
        const status = document.getElementById('ssh-move-status');
        if (status) status.textContent = `${row.name} moved ${step < 0 ? 'up' : 'down'}.`;
      }
    } };
  }) : [];
  const items: ContextMenuItem[] = folder ? [
    { label:'Add subfolder', icon:'📁', click:() => onFolder(folder.id) },
    { label:'New SSH connection here', icon:'⌁', click:() => onConnection(folder.id) },
    { label:'Folder icon', icon:'⚗', customFlyout:{ panelClassName:'ssh-picker-flyout', content:<FolderIconPicker icon={folder.icon} color={folder.color} onPick={(icon,color) => { if (readOnly) return; void commit(() => api.upsertFolder({ id:folder.id, parentId:folder.parentId, name:folder.name, icon, color })); onClose(); }} /> } },
    { label:'Rename', icon:'✎', accelerator:'F2', click:() => onRename(folder, 'folder') },
    ...moves,
    { type:'separator' },
    { label:'Delete folder…', icon:'🗑', accelerator:'Del', danger:true, click:requestDelete },
  ] : row ? [
    { icon:'★', label:(row as SshConnection).bookmarked ? 'Unbookmark' : 'Bookmark', click:() => { void commit(() => api.setBookmark(row.id, !(row as SshConnection).bookmarked)); } },
    { label:'Rename', icon:'✎', accelerator:'F2', click:() => onRename(row, 'connection') },
    ...moves,
    { type:'separator' },
    { label:'Delete…', icon:'🗑', accelerator:'Del', danger:true, click:requestDelete },
  ] : [ { label:'New folder', icon:'📁', click:() => onFolder(null) }, { label:'New SSH connection', icon:'⌁', click:() => onConnection(null) } ];
  return <>{menuOpen && <ContextMenu className="ssh-menu" x={target.x} y={target.y} items={items.map(item => ({ ...item, enabled:!readOnly && item.enabled !== false, click:item.click ? () => { if (!readOnly && item.enabled !== false) item.click?.(); } : undefined }))} onClose={() => { if (!confirm) setMenuOpen(false); }} />}
    <ConfirmDialog isOpen={confirm && !readOnly} title={folder ? 'Delete folder' : 'Delete connection'} message={folder ? `Delete ${folder.name}: ${ids.size - 1} subfolder${ids.size === 2 ? '' : 's'} and ${connections} connection${connections === 1 ? '' : 's'}?` : `Delete ${row?.name}?`} confirmText="Delete" destructive onConfirm={() => void remove()} onCancel={cancelDelete} />
  </>;
}
