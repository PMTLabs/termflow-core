import React, { useId, useLayoutEffect, useRef } from 'react';
import { SSH_FOLDER_ICONS, SSH_FOLDER_COLORS } from './sshFolderIcons';
import { SshFolderIcon } from './SshFolderIcon';
export function FolderIconPicker({ icon, color, onPick, onClose }: { icon: string; color: string; onPick(icon: string, color: string): void; onClose?(): void }) {
  const heading = useId();
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    (panel.current?.querySelector<HTMLButtonElement>('.ssh-icon-grid [aria-pressed="true"]') ??
      panel.current?.querySelector<HTMLButtonElement>('.ssh-icon-grid button'))?.focus();
  }, []);
  return <div ref={panel} className="ssh-icon-picker ssh-connections" role="group" aria-labelledby={heading} onKeyDown={event => {
    if (!(event.target instanceof HTMLButtonElement)) return;
    const icons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.ssh-icon-grid button'));
    const colors = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.ssh-color-grid button'));
    const iconIndex = icons.indexOf(event.target);
    const inIcons = iconIndex >= 0;
    const index = inIcons ? iconIndex : colors.indexOf(event.target);
    const buttons = inIcons ? icons : colors;
    const column = inIcons ? index % 5 : index;
    let next: HTMLButtonElement | undefined;
    switch (event.key) {
      case 'ArrowLeft': if (column > 0) next = buttons[index - 1]; break;
      case 'ArrowRight': if (!inIcons || column < 4) next = buttons[index + 1]; break;
      case 'ArrowUp': next = inIcons ? icons[index - 5] : icons.slice(Math.floor((icons.length - 1) / 5) * 5)[column] ?? icons[icons.length - 1]; break;
      case 'ArrowDown': if (inIcons) next = icons[index + 5] ?? colors[column]; break;
      case 'Enter':
      case ' ': event.preventDefault(); event.stopPropagation(); event.target.click(); return;
      case 'Escape': if (onClose) { event.preventDefault(); event.stopPropagation(); onClose(); } return;
      default: return;
    }
    event.preventDefault(); event.stopPropagation(); next?.focus();
  }}>
    <h4 id={heading}>Choose icon</h4>
    <div className="ssh-icon-grid">{SSH_FOLDER_ICONS.map(value => <button key={value} aria-label={`Icon ${value}`} aria-pressed={value === icon} onClick={() => onPick(value, color)}><SshFolderIcon icon={value} /></button>)}</div>
    <div className="ssh-color-grid">{SSH_FOLDER_COLORS.map(value => <button key={value} aria-label={`Color ${value}`} aria-pressed={value === color} className={`ssh-color-${value}`} onClick={() => onPick(icon, value)}><span style={{ background:'currentColor', display:'block', width:18, height:18, borderRadius:'50%' }} /></button>)}</div>
  </div>;
}
