import React, { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../../../store';
import { applyView, selectTree } from '../../../store/slices/sshSlice';
import { addToast } from '../../../store/slices/uiSlice';
import type { SshConnection, SshFolder, SshReply } from '../../../types/ssh';
import { SshTree } from './SshTree';
import './SshConnections.css';
export function SshConnectionsPanel() {
  const dispatch = useDispatch(); const state = useSelector((s: RootState) => s.ssh); const tree = useSelector(selectTree);
  const [filter, setFilter] = useState(''); const [selected, setSelected] = useState<{ row: SshConnection | SshFolder; kind: 'folder' | 'connection' } | null>(null);
  const api = window.electronAPI?.ssh;
  const commit = async (operation: () => Promise<SshReply>) => {
    if (state.view.loadError) return;
    try { dispatch(applyView(await operation())); } catch (error) { dispatch(addToast({ type:'error', message: (error as Error)?.message ?? 'SSH operation failed' })); }
  };
  if (!api || state.status === 'desktop-only') return <section data-testid="ssh-connections-panel"><h2>SSH Connections</h2><p>SSH connections are available in the desktop app.</p></section>;
  if (state.status === 'loading') return <section data-testid="ssh-connections-panel">Loading SSH connections…</section>;
  if (state.status === 'error') return <section data-testid="ssh-connections-panel"><p role="alert">{state.error}</p><button onClick={() => void api.reload().then(reply => dispatch(applyView(reply)))}>Reload</button></section>;
  return <section className="ssh-connections" data-testid="ssh-connections-panel"><h2>SSH Connections</h2>
    {state.view.loadError && <div role="alert" className="ssh-read-only">Read-only: {state.view.loadError.message} <button onClick={() => void api.reload().then(reply => dispatch(applyView(reply))).catch(error => dispatch(addToast({ type:'error', message:String(error) })))}>Reload</button></div>}
    <label className="ssh-search">Filter connections<input type="search" value={filter} onChange={event => setFilter(event.target.value)} /></label>
    <div className="ssh-columns"><div className="ssh-tree-pane"><SshTree tree={tree} view={state.view} filter={filter} selectedId={selected?.row.id}
      onSelect={(row, kind) => setSelected({ row, kind })}
      onBookmark={(id, bookmarked) => void commit(() => api.setBookmark(id, bookmarked))}
      onMove={input => void commit(() => api.move(input))} />
      {!tree.length && <p>No saved connections yet.</p>}
      <footer>{state.view.folders.length} folders · {state.view.connections.length} connections</footer></div>
      <div className="ssh-editor-pane">{selected ? selected.row.name : 'Select a connection to edit its details.'}</div></div>
  </section>;
}
