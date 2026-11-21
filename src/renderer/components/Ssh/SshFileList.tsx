import React from 'react';
import type { RemoteEntry } from './sshFileTypes';

export interface SshFileListProps {
  entries: RemoteEntry[];
  childrenByPath: Record<string, { entries?: RemoteEntry[]; error?: string }>;
  expanded: Set<string>;
  selected?: string;
  disabled: boolean;
  onSelect(path: string): void;
  onNavigate(path: string): void;
  onToggle(entry: RemoteEntry): void;
  onEntryContextMenu?(entry: RemoteEntry, event: React.MouseEvent): void;
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
        <div className="ssh-file-row" data-selected={props.selected === entry.path}
          onContextMenu={event => { if (!disabled) props.onEntryContextMenu?.(entry, event); }}>
          {folder ? <button type="button" className="au-btn ssh-file-expander" disabled={disabled}
            title={expanded ? 'Collapse folder' : 'Expand folder'} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${entry.name}`}
            aria-expanded={expanded} onClick={() => props.onToggle(entry)}>{expanded ? '▾' : '▸'}</button>
            : <span className="ssh-file-expander" aria-hidden="true" />}
          <button type="button" className="ssh-file-name" title={entry.path || entry.name} disabled={disabled}
            aria-pressed={props.selected === entry.path}
            onClick={() => props.onSelect(entry.path)} onDoubleClick={open}
            onKeyDown={event => { if (event.key === 'Enter' && folder) { event.preventDefault(); open(); } }}>
            <span aria-hidden="true">{folder ? '📁 ' : '▤ '}</span>{entry.name}
          </button>
          {!folder && entry.size !== undefined && <span className="ssh-file-size">{entry.size} B</span>}
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
