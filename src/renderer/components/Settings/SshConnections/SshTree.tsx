import React, { useEffect, useRef, useState } from 'react';
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
type Drag = Pick<SshMove, 'kind' | 'id'>;
const MIME = 'application/x-termflow-ssh';
export function SshTree({ tree, view, filter, selectedId, onSelect, onBookmark, onMove, onMenu, onRename, onDelete }: SshTreeProps) {
  const readOnly = !!view.loadError;
  const dragged = useRef<Drag | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('ssh-collapsed') ?? '[]'); } catch { return []; } });
  const toggle = (id: string, close?: boolean) => setCollapsed(previous => { const next = (close ?? !previous.includes(id)) ? [...new Set([...previous, id])] : previous.filter(v => v !== id); try { localStorage.setItem('ssh-collapsed', JSON.stringify(next)); } catch {} return next; });
  const query = filter.trim().toLocaleLowerCase();
  const matches = (node: SshTreeNode): boolean => node.kind === 'folder' ? node.row.name.toLocaleLowerCase().includes(query) || node.children.some(matches) : [node.row.name, node.row.host, node.row.user].some(s => s.toLocaleLowerCase().includes(query));
  const clearDrop = () => treeRef.current?.querySelectorAll('.ssh-drop').forEach(element => { element.classList.remove('ssh-drop'); element.removeAttribute('data-drop-zone'); });
  useEffect(() => { if (readOnly) { dragged.current = null; clearDrop(); } }, [readOnly]);
  const allowed = (drag: Drag | null, parentId: string | null, targetId?: string): drag is Drag => {
    if (readOnly || !drag || drag.id === targetId) return false;
    if (!['folder','connection'].includes(drag.kind) || typeof drag.id !== 'string') return false;
    if (!(drag.kind === 'folder' ? view.folders : view.connections).some(row => row.id === drag.id)) return false;
    // Reject the entire descendant row, including its before/after zones.
    let parent = targetId && view.folders.some(f => f.id === targetId) ? targetId : parentId;
    const seen = new Set<string>();
    while (parent) {
      if (seen.has(parent) || (drag.kind === 'folder' && parent === drag.id)) return false;
      seen.add(parent); parent = view.folders.find(f => f.id === parent)?.parentId ?? null;
    }
    return true;
  };
  const destination = (event: React.DragEvent, node: SshTreeNode) => {
    const { row, kind } = node;
    const parentId = kind === 'folder' ? (row as SshFolder).parentId : (row as SshConnection).folderId;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
    const zone = kind === 'folder' && ratio >= 0.25 && ratio <= 0.75 ? 'inside' : ratio > 0.75 ? 'after' : 'before';
    return { parentId:zone === 'inside' ? row.id : parentId, index:zone === 'inside' && node.kind === 'folder' ? node.children.length : row.order + (zone === 'after' ? 1 : 0), zone };
  };
  const over = (event: React.DragEvent, parentId:string | null, targetId?:string, zone = 'inside') => {
    event.stopPropagation(); clearDrop();
    if (!allowed(dragged.current,parentId,targetId)) return;
    event.preventDefault(); event.currentTarget.classList.add('ssh-drop'); event.currentTarget.setAttribute('data-drop-zone',zone);
  };
  const drop = (event: React.DragEvent, parentId: string | null, index: number, targetId?:string) => {
    event.stopPropagation(); clearDrop();
    let drag = dragged.current;
    if (!drag) { try { drag = JSON.parse(event.dataTransfer.getData(MIME)); } catch { return; } }
    if (!allowed(drag,parentId,targetId)) return;
    event.preventDefault(); dragged.current = null;
    onMove({ kind:drag.kind, id:drag.id, parentId, index });
  };
  const render = (nodes: SshTreeNode[], inherited = false): React.ReactNode => nodes.filter(n => !query || inherited || matches(n)).map(node => {
    const { row, kind } = node; const closed = collapsed.includes(row.id); const expanded = !closed || !!query;
    return <div key={row.id} role="treeitem" aria-expanded={kind === 'folder' ? expanded : undefined} aria-selected={selectedId === row.id} data-row-id={row.id}>
      <div className={`ssh-tree-row ${selectedId === row.id ? 'selected' : ''}`} tabIndex={0} draggable={!readOnly}
        onDragStart={event => { if (readOnly) { event.preventDefault(); return; } dragged.current = { kind,id:row.id }; event.dataTransfer.setData(MIME,JSON.stringify(dragged.current)); }}
        onDragEnd={() => { dragged.current = null; clearDrop(); }}
        onDragOver={event => { const dest = destination(event,node); over(event,dest.parentId,row.id,dest.zone); }}
        onDragLeave={clearDrop}
        onDrop={event => { const dest = destination(event,node); drop(event,dest.parentId,dest.index,row.id); }}
        onClick={() => onSelect(row, kind)} onDoubleClick={() => kind === 'folder' && toggle(row.id)}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (!readOnly) onMenu?.(event, row, kind); }}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); onSelect(row, kind); }
          else if (event.key === 'ArrowRight' && kind === 'folder') toggle(row.id, false);
          else if (event.key === 'ArrowLeft' && kind === 'folder') toggle(row.id, true);
          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const rows = [...event.currentTarget.closest('[role="tree"]')!.querySelectorAll<HTMLElement>('.ssh-tree-row')]; rows[rows.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus(); }
          else if (event.key === 'F2') { event.preventDefault(); if (!readOnly) onRename?.(row, kind); }
          else if (event.key === 'Delete') { event.preventDefault(); if (!readOnly) onDelete?.(row, kind); }
        }}>
        {kind === 'folder' ? <><button aria-label={`Toggle ${row.name}`} aria-expanded={expanded} onClick={event => { event.stopPropagation(); toggle(row.id); }}>{expanded ? '▾' : '▸'}</button><span className={`ssh-folder-icon ssh-color-${(row as SshFolder).color}`} data-icon={(row as SshFolder).icon}><SshFolderIcon icon={(row as SshFolder).icon} /></span></> : <span aria-hidden>⌁</span>}
        <span className="ssh-row-label">{row.name}</span>
        {kind === 'connection' && <button disabled={readOnly} aria-label={`Bookmark ${row.name}`} aria-pressed={(row as SshConnection).bookmarked} onClick={event => { event.stopPropagation(); if (!readOnly) onBookmark(row.id, !(row as SshConnection).bookmarked); }}>{(row as SshConnection).bookmarked ? '★' : '☆'}</button>}
      </div>
      {kind === 'folder' && expanded && <div role="group" className="ssh-tree-children">{render(node.children, inherited || (!!query && row.name.toLocaleLowerCase().includes(query)))}</div>}
    </div>;
  });
  return <div ref={treeRef} role="tree" aria-label="Saved SSH connections" className="ssh-tree" onContextMenu={event => { event.preventDefault(); if (!readOnly) onMenu?.(event); }} onDragOver={event => over(event,null)} onDrop={event => drop(event, null, tree.length)}>{render(tree)}</div>;
}
