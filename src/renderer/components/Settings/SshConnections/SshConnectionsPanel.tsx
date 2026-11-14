import React, { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../../../store';
import { applyView, selectTree } from '../../../store/slices/sshSlice';
import { addToast } from '../../../store/slices/uiSlice';
import type { SshConnection, SshFolder, SshReply, SshFolderInput } from '../../../types/ssh';
import { isSshEditorDirty, saveSshEditorDraft, discardSshEditorDraft } from '../../../services/sshEditorGuard';
import { UnsavedChangesDialog } from '../../UI/UnsavedChangesDialog';
import { SshTree } from './SshTree';
import { SshMenus, SshMenuTarget } from './SshMenus';
import { SshFolderDialog } from './SshFolderDialog';
import { SshConnectionEditor } from './SshConnectionEditor';
import '../Automations/AutomationsPanel.css'; // house .au-btn / .au-seg button styles shared by Settings panels
import './SshConnections.css';
export function SshConnectionsPanel() {
  const dispatch = useDispatch(); const state = useSelector((s: RootState) => s.ssh); const tree = useSelector(selectTree);
  const [filter, setFilter] = useState(''); const [selected, setSelected] = useState<{ row:SshConnection | SshFolder; kind:'folder' | 'connection' } | null>(null);
  const [menu, setMenu] = useState<(SshMenuTarget & { key:number }) | null>(null);
  const [folderDraft, setFolderDraft] = useState<SshFolderInput | null>(null);
  const [draftFolder, setDraftFolder] = useState<string | null | undefined>(undefined);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const api = window.electronAPI?.ssh;
  const navigate = (action: () => void) => { if (isSshEditorDirty()) setPending(() => action); else action(); };
  const closeEditor = () => { setSelected(null); setDraftFolder(undefined); };
  const newFolder = (parentId:string | null) => { setMenu(null); navigate(() => setFolderDraft({ parentId, name:'', icon:'folder', color:'grey' })); };
  const newConnection = (folderId:string | null) => { setMenu(null); navigate(() => { setSelected(null); setDraftFolder(folderId); }); };
  const rename = (row:SshConnection | SshFolder, kind:'folder' | 'connection') => { setMenu(null); navigate(() => { if (kind === 'folder') { const folder = row as SshFolder; setFolderDraft({ id:folder.id, parentId:folder.parentId, name:folder.name, icon:folder.icon, color:folder.color }); } else { setSelected({ row,kind }); setDraftFolder(undefined); } }); };
  const commit = async (operation: () => Promise<SshReply>) => {
    if (state.view.loadError) return false;
    try { dispatch(applyView(await operation())); return true; } catch (error) { dispatch(addToast({ type:'error', message:(error as Error)?.message ?? 'SSH operation failed' })); return false; }
  };
  if (!api || state.status === 'desktop-only') return <section data-testid="ssh-connections-panel"><h2>SSH Connections</h2><p>SSH connections are available in the desktop app.</p></section>;
  if (state.status === 'loading') return <section data-testid="ssh-connections-panel">Loading SSH connections…</section>;
  if (state.status === 'error') return <section data-testid="ssh-connections-panel"><p role="alert">{state.error}</p><button className="au-btn" onClick={() => void api.reload().then(reply => dispatch(applyView(reply))).catch(error => dispatch(addToast({ type:'error', message:String(error) })))}>Reload</button></section>;
  return <section className="ssh-connections" data-testid="ssh-connections-panel"><h2>SSH Connections</h2>
    {state.view.loadError && <div role="alert" className="ssh-read-only">Read-only: {state.view.loadError.message} <button className="au-btn sm" onClick={() => void api.reload().then(reply => dispatch(applyView(reply))).catch(error => dispatch(addToast({ type:'error', message:String(error) })))}>Reload</button></div>}
    <div className="ssh-toolbar"><button className="au-btn" disabled={!!state.view.loadError} onClick={() => newFolder(null)}>New folder</button><button className="au-btn primary" disabled={!!state.view.loadError} onClick={() => newConnection(null)}>New SSH connection</button></div>
    <label className="ssh-search">Filter connections<input type="search" value={filter} onChange={event => setFilter(event.target.value)} /></label>
    <div className="ssh-columns"><div className="ssh-tree-pane">{state.view.loadError ? <p className="ssh-tree-note">Your saved connections can't be shown while the file is unreadable. Nothing has been deleted: fix the file, then press Reload.</p> : <><SshTree tree={tree} view={state.view} filter={filter} selectedId={selected?.row.id}
      onSelect={(row,kind) => { if (selected?.row.id !== row.id) navigate(() => { setSelected({ row,kind }); setDraftFolder(undefined); }); }}
      onMenu={(event,row,kind) => { if (!state.view.loadError) setMenu({ x:event.clientX, y:event.clientY, row,kind,key:Date.now() }); }} onRename={rename} onDelete={(row,kind) => { if (!state.view.loadError) setMenu({ x:0,y:0,row,kind,key:Date.now(),deleteRequested:true }); }}
      onBookmark={(id,bookmarked) => void commit(() => api.setBookmark(id,bookmarked))} onMove={input => void commit(() => api.move(input))} />
      {!tree.length && <p className="ssh-tree-note">No saved connections yet.</p>}<footer>{state.view.folders.length} folders · {state.view.connections.length} connections</footer></>}</div>
      <div className="ssh-editor-pane">{draftFolder !== undefined || selected?.kind === 'connection' ? <SshConnectionEditor key={selected?.kind === 'connection' ? selected.row.id : `new-${draftFolder}`} connectionId={selected?.kind === 'connection' ? selected.row.id : undefined} initialFolder={draftFolder ?? null} view={state.view} api={api} onClose={closeEditor} onSaved={(reply,input) => {
        dispatch(applyView(reply)); const row = input.id ? reply.view.connections.find(c => c.id === input.id) : reply.view.connections.find(c => !state.view.connections.some(old => old.id === c.id));
        if (row) { setSelected({ row,kind:'connection' }); setDraftFolder(undefined); }
      }} /> : selected ? selected.row.name : 'Select a connection to edit its details.'}</div></div>
    {menu && <SshMenus key={menu.key} target={menu} view={state.view} api={api} commit={commit} onClose={() => setMenu(null)} onFolder={newFolder} onConnection={newConnection} onRename={rename} />}
    {folderDraft && <SshFolderDialog input={folderDraft} onSave={input => commit(() => api.upsertFolder(input))} onClose={() => setFolderDraft(null)} />}
    <UnsavedChangesDialog isOpen={!!pending} categoryLabel="SSH connection" onCancel={() => setPending(null)} onDiscard={() => { discardSshEditorDraft(); const go = pending; setPending(null); go?.(); }} onSave={() => { void saveSshEditorDraft().then(saved => { if (saved) { const go = pending; setPending(null); go?.(); } }); }} />
  </section>;
}
