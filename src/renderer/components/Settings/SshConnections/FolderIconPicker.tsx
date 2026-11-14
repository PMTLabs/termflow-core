import React from 'react';
import { SSH_FOLDER_ICONS, SSH_FOLDER_COLORS } from './sshFolderIcons';
import { SshFolderIcon } from './SshFolderIcon';
export function FolderIconPicker({ icon, color, onPick, onClose }: { icon: string; color: string; onPick(icon: string, color: string): void; onClose(): void }) {
  return <div className="ssh-icon-picker ssh-connections" onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLButtonElement) { event.preventDefault(); event.target.click(); } if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <div className="ssh-icon-grid">{SSH_FOLDER_ICONS.map(value => <button key={value} aria-label={`Icon ${value}`} aria-pressed={value === icon} onClick={() => onPick(value, color)}><SshFolderIcon icon={value} /></button>)}</div>
    <div className="ssh-color-grid">{SSH_FOLDER_COLORS.map(value => <button key={value} aria-label={`Color ${value}`} aria-pressed={value === color} className={`ssh-color-${value}`} onClick={() => onPick(icon, value)}><span style={{ background:'currentColor', display:'block', width:18, height:18, borderRadius:'50%' }} /></button>)}</div>
  </div>;
}
