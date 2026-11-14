import type { SshMove, SshView } from '../types/ssh';
export type SshDrag = Pick<SshMove, 'kind' | 'id'>;
export type SshDropTarget = { zone:'root' } | { zone:'before' | 'after' | 'inside'; id:string };

/** Convert a visual drop into Rust move_row's FINAL index in one mixed sibling list. */
export function sshMoveIndex(view:SshView, dragged:SshDrag, target:SshDropTarget):SshMove | null {
  const rows = [
    ...view.folders.map(row => ({id:row.id,parentId:row.parentId,order:row.order,kind:'folder' as const})),
    ...view.connections.map(row => ({id:row.id,parentId:row.folderId,order:row.order,kind:'connection' as const})),
  ];
  const source = rows.find(row => row.id === dragged.id && row.kind === dragged.kind);
  if (!source) return null;
  const row = target.zone === 'root' ? undefined : rows.find(row => row.id === target.id);
  if (target.zone !== 'root' && (!row || row.id === source.id)) return null;
  if (target.zone === 'inside' && row?.kind !== 'folder') return null;
  const parentId = target.zone === 'root' ? null : target.zone === 'inside' ? row!.id : row!.parentId;
  const raw = target.zone === 'root' || target.zone === 'inside'
    ? rows.filter(row => row.parentId === parentId).length
    : row!.order + (target.zone === 'after' ? 1 : 0);
  const index = raw - (source.parentId === parentId && source.order < raw ? 1 : 0);
  if (source.parentId === parentId && source.order === index) return null;
  return {...dragged,parentId,index};
}
