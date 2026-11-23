import React from 'react';
import type { RemoteEntry } from './sshFileTypes';
import { SshIcon } from './SshIcons';
import { formatBytes, formatBytesExact } from '../../utils/formatBytes';

export interface SshFileListProps {
  entries: RemoteEntry[];
  childrenByPath: Record<string, { entries?: RemoteEntry[]; error?: string }>;
  expanded: Set<string>;
  selected?: string;
  disabled: boolean;
  onSelect(path: string): void;
  onNavigate(path: string): void;
  onToggle(entry: RemoteEntry): void;
  onEntryContextMenu?(entry: RemoteEntry, event: React.MouseEvent<HTMLDivElement>): void;
  onInsert?(entry: RemoteEntry): void;
  onShortcut?(entry: RemoteEntry, action: 'rename' | 'delete', trigger: HTMLButtonElement): void;
}

const ordered = (entries: RemoteEntry[]) => [...entries].sort((a, b) =>
  Number(b.kind === 'directory') - Number(a.kind === 'directory')
    || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));

export function SshFileList(props: SshFileListProps) {
  function rows(entries: RemoteEntry[], ancestors: ReadonlySet<string>): React.ReactNode {
    return <ul className="ssh-file-list">{ordered(entries).map((entry, index) => {
      const disabled = props.disabled || !entry.path;
      const folder = entry.kind === 'directory';
      const expanded = folder && !ancestors.has(entry.path) && props.expanded.has(entry.path);
      const children = props.childrenByPath[entry.path];
      const open = () => { if (folder && !disabled) props.onNavigate(entry.path); };
      return <li key={entry.path || `invalid-name:${index}`}>
        <div className="ssh-file-row" data-selected={props.selected === entry.path} tabIndex={-1}
          onContextMenu={event => {
            event.preventDefault(); event.stopPropagation();
            props.onEntryContextMenu?.(entry, event);
          }}
          onMouseDown={event => {
            if (event.button !== 1) return;
            event.preventDefault(); event.stopPropagation();
            if (!disabled) props.onInsert?.(entry);
          }}
          onKeyDown={event => {
            if (!(event.target instanceof HTMLButtonElement) || disabled || event.repeat
                || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            const action = event.key === 'F2' ? 'rename' : event.key === 'Delete' ? 'delete' : undefined;
            if (action) {
              event.preventDefault(); event.stopPropagation();
              props.onShortcut?.(entry, action, event.target);
            }
          }}
          onAuxClick={event => {
            if (event.button !== 1) return;
            // The gesture was handled on mousedown (even if the listing changed since).
            event.preventDefault(); event.stopPropagation();
          }}>
          {folder ? <button type="button" className="ssh-file-expander" disabled={disabled}
            title={expanded ? 'Collapse folder' : 'Expand folder'} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${entry.name}`}
            aria-expanded={expanded} onClick={() => props.onToggle(entry)}><SshIcon name="chevron" size={12} /></button>
            : <span className="ssh-file-expander" aria-hidden="true" />}
          <button type="button" className="ssh-file-name" title={entry.path || entry.name} disabled={disabled}
            aria-pressed={props.selected === entry.path}
            onClick={() => props.onSelect(entry.path)} onDoubleClick={open}
            onKeyDown={event => { if (event.key === 'Enter' && folder) { event.preventDefault(); open(); } }}>
            <span aria-hidden="true">{folder ? '📁 ' : '▤ '}</span>{entry.name}
          </button>
          {!folder && entry.size !== undefined && <span className="ssh-file-size"
            title={formatBytesExact(entry.size)}>{formatBytes(entry.size)}</span>}
        </div>
        {expanded && (children?.error ? <div role="alert">{children.error}</div>
          : children?.entries ? (children.entries.length
            ? rows(children.entries, new Set([...ancestors, entry.path])) : <div>Empty directory</div>)
            : <div role="status">Loading folder…</div>)}
      </li>;
    })}</ul>;
  }

  return rows(props.entries, new Set());
}
