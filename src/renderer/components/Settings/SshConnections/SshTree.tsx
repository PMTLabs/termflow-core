import React, { useState } from 'react';
import type { SshConnection, SshFolder, SshMove, SshView } from '../../../types/ssh';
import type { SshTreeNode } from '../../../store/slices/sshSlice';
import { SshFolderIcon } from './SshFolderIcon';
export interface SshTreeProps {
  tree: SshTreeNode[]; view: SshView; filter: string; selectedId?: string;
  onSelect(row: SshConnection | SshFolder, kind: 'folder' | 'connection'): void;
  onBookmark(id: string, bookmarked: boolean): void; onMove(input: SshMove): void;
  onMenu?(event: React.MouseEvent, row?: SshConnection | SshFolder, kind?: 'folder' | 'connection'): void;
  onRename?(row: SshConnection | SshFolder, kind: 'folder' | 'connection'): void;
  onDelete?(row: SshConnection | SshFolder, kind: 'folder' | 'connection'): void;
}
export function SshTree({ tree, view, filter, selectedId, onSelect, onBookmark, onMove, onMenu, onRename, onDelete }: SshTreeProps) {
  const [collapsed, setCollapsed] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('ssh-collapsed') ?? '[]'); } catch { return []; } });
  const toggle = (id: string, close?: boolean) => setCollapsed(previous => { const next = (close ?? !previous.includes(id)) ? [...new Set([...previous, id])] : previous.filter(v => v !== id); try { localStorage.setItem('ssh-collapsed', JSON.stringify(next)); } catch {} return next; });
  const query = filter.trim().toLocaleLowerCase();
  const matches = (node: SshTreeNode): boolean => node.kind === 'folder' ? node.row.name.toLocaleLowerCase().includes(query) || node.children.some(matches) : [node.row.name, node.row.host, node.row.user].some(s => s.toLocaleLowerCase().includes(query));
  const drop = (event: React.DragEvent, parentId: string | null, index: number) => {
    event.preventDefault(); event.stopPropagation(); event.currentTarget.classList.remove('ssh-drop');
    try {
      const drag = JSON.parse(event.dataTransfer.getData('application/x-termflow-ssh')) as { kind: 'folder' | 'connection'; id: string };
      if (!['folder','connection'].includes(drag.kind) || typeof drag.id !== 'string') return;
      let parent = parentId;
      while (parent) { if (parent === drag.id && drag.kind === 'folder') return; parent = view.folders.find(f => f.id === parent)?.parentId ?? null; }
      onMove({ ...drag, parentId, index });
    } catch {}
  };
  const render = (nodes: SshTreeNode[], inherited = false): React.ReactNode => nodes.filter(n => !query || inherited || matches(n)).map(node => {
    const { row, kind } = node; const closed = collapsed.includes(row.id); const expanded = !closed || !!query; const parent = kind === 'folder' ? (row as SshFolder).parentId : (row as SshConnection).folderId;
    return <div key={row.id} role="treeitem" aria-expanded={kind === 'folder' ? expanded : undefined} aria-selected={selectedId === row.id} data-row-id={row.id}>
      <div className={`ssh-tree-row ${selectedId === row.id ? 'selected' : ''}`} tabIndex={0} draggable
        onDragStart={event => event.dataTransfer.setData('application/x-termflow-ssh', JSON.stringify({ kind, id: row.id }))}
        onDragOver={event => { event.preventDefault(); event.currentTarget.classList.add('ssh-drop'); }} onDragLeave={event => event.currentTarget.classList.remove('ssh-drop')}
        onDrop={event => drop(event, kind === 'folder' ? row.id : parent, kind === 'folder' ? node.children.length : row.order)}
        onClick={() => onSelect(row, kind)} onDoubleClick={() => kind === 'folder' && toggle(row.id)}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onMenu?.(event, row, kind); }}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); onSelect(row, kind); }
          else if (event.key === 'ArrowRight' && kind === 'folder') toggle(row.id, false);
          else if (event.key === 'ArrowLeft' && kind === 'folder') toggle(row.id, true);
          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const rows = [...event.currentTarget.closest('[role="tree"]')!.querySelectorAll<HTMLElement>('.ssh-tree-row')]; rows[rows.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus(); }
          else if (event.key === 'F2') { event.preventDefault(); onRename?.(row, kind); }
          else if (event.key === 'Delete') { event.preventDefault(); onDelete?.(row, kind); }
        }}>
        {kind === 'folder' ? <><button aria-label={`Toggle ${row.name}`} aria-expanded={expanded} onClick={event => { event.stopPropagation(); toggle(row.id); }}>{expanded ? '▾' : '▸'}</button><span className={`ssh-folder-icon ssh-color-${(row as SshFolder).color}`} data-icon={(row as SshFolder).icon}><SshFolderIcon icon={(row as SshFolder).icon} /></span></> : <span aria-hidden>⌁</span>}
        <span className="ssh-row-label">{row.name}</span>
        {kind === 'connection' && <button aria-label={`Bookmark ${row.name}`} aria-pressed={(row as SshConnection).bookmarked} onClick={event => { event.stopPropagation(); onBookmark(row.id, !(row as SshConnection).bookmarked); }}>{(row as SshConnection).bookmarked ? '★' : '☆'}</button>}
      </div>
      {kind === 'folder' && expanded && <div role="group" className="ssh-tree-children">{render(node.children, inherited || (!!query && row.name.toLocaleLowerCase().includes(query)))}</div>}
    </div>;
  });
  return <div role="tree" aria-label="Saved SSH connections" className="ssh-tree" onContextMenu={event => { event.preventDefault(); onMenu?.(event); }} onDragOver={event => event.preventDefault()} onDrop={event => drop(event, null, tree.length)}>{render(tree)}</div>;
}
