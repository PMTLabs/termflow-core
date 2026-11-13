import React, { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../../../store';
import { applyView, selectTree } from '../../../store/slices/sshSlice';
import { addToast } from '../../../store/slices/uiSlice';
import type { SshConnection, SshFolder, SshReply } from '../../../types/ssh';
import { SshTree } from './SshTree';
import { SshMenus, SshMenuTarget } from './SshMenus';
import { SshFolderDialog } from './SshFolderDialog';
import type { SshFolderInput } from '../../../types/ssh';
import './SshConnections.css';
export function SshConnectionsPanel() {
  const dispatch = useDispatch(); const state = useSelector((s: RootState) => s.ssh); const tree = useSelector(selectTree);
  const [filter, setFilter] = useState(''); const [selected, setSelected] = useState<{ row: SshConnection | SshFolder; kind: 'folder' | 'connection' } | null>(null);
  const [menu, setMenu] = useState<(SshMenuTarget & { key:number }) | null>(null);
  const [folderDraft, setFolderDraft] = useState<SshFolderInput | null>(null);
  const [draftFolder, setDraftFolder] = useState<string | null | undefined>(undefined);
  const api = window.electronAPI?.ssh;
  const newFolder = (parentId: string | null) => { setMenu(null); setFolderDraft({ parentId, name:'', icon:'folder', color:'grey' }); };
  const newConnection = (folderId: string | null) => { setMenu(null); setSelected(null); setDraftFolder(folderId); };
  const rename = (row: SshConnection | SshFolder, kind: 'folder' | 'connection') => { setMenu(null); if (kind === 'folder') { const folder = row as SshFolder; setFolderDraft({ id:folder.id, parentId:folder.parentId, name:folder.name, icon:folder.icon, color:folder.color }); } else { setSelected({ row, kind }); setDraftFolder(undefined); } };
  const commit = async (operation: () => Promise<SshReply>) => {
    if (state.view.loadError) return false;
    try { dispatch(applyView(await operation())); return true; } catch (error) { dispatch(addToast({ type:'error', message: (error as Error)?.message ?? 'SSH operation failed' })); return false; }
  };
  if (!api || state.status === 'desktop-only') return <section data-testid="ssh-connections-panel"><h2>SSH Connections</h2><p>SSH connections are available in the desktop app.</p></section>;
  if (state.status === 'loading') return <section data-testid="ssh-connections-panel">Loading SSH connections…</section>;
  if (state.status === 'error') return <section data-testid="ssh-connections-panel"><p role="alert">{state.error}</p><button onClick={() => void api.reload().then(reply => dispatch(applyView(reply)))}>Reload</button></section>;
  return <section className="ssh-connections" data-testid="ssh-connections-panel"><h2>SSH Connections</h2>
    {state.view.loadError && <div role="alert" className="ssh-read-only">Read-only: {state.view.loadError.message} <button onClick={() => void api.reload().then(reply => dispatch(applyView(reply))).catch(error => dispatch(addToast({ type:'error', message:String(error) })))}>Reload</button></div>}
    <div className="ssh-toolbar"><button disabled={!!state.view.loadError} onClick={() => newFolder(null)}>New folder</button><button disabled={!!state.view.loadError} onClick={() => newConnection(null)}>New SSH connection</button></div>
    <label className="ssh-search">Filter connections<input type="search" value={filter} onChange={event => setFilter(event.target.value)} /></label>
    <div className="ssh-columns"><div className="ssh-tree-pane"><SshTree tree={tree} view={state.view} filter={filter} selectedId={selected?.row.id}
      onSelect={(row, kind) => { setSelected({ row, kind }); setDraftFolder(undefined); }}
      onMenu={(event, row, kind) => { if (!state.view.loadError) setMenu({ x:event.clientX, y:event.clientY, row, kind, key:Date.now() }); }} onRename={rename} onDelete={(row, kind) => setMenu({ x:0, y:0, row, kind, key:Date.now() })}
      onBookmark={(id, bookmarked) => void commit(() => api.setBookmark(id, bookmarked))}
      onMove={input => void commit(() => api.move(input))} />
      {!tree.length && <p>No saved connections yet.</p>}
      <footer>{state.view.folders.length} folders · {state.view.connections.length} connections</footer></div>
      <div className="ssh-editor-pane">{draftFolder !== undefined ? <div data-new-connection-folder={draftFolder ?? 'root'}>New SSH connection</div> : selected ? selected.row.name : 'Select a connection to edit its details.'}</div></div>
    {menu && <SshMenus key={menu.key} target={menu} view={state.view} api={api} commit={commit} onClose={() => setMenu(null)} onFolder={newFolder} onConnection={newConnection} onRename={rename} />}
    {folderDraft && <SshFolderDialog input={folderDraft} onSave={input => commit(() => api.upsertFolder(input))} onClose={() => setFolderDraft(null)} />}
  </section>;
}
