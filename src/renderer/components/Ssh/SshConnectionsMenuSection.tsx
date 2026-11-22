import React from 'react';
import { useDispatch, useSelector, useStore } from 'react-redux';
import type { RootState } from '../../store';
import { selectSshSearchRows } from '../../store/slices/sshSlice';
import { addToast } from '../../store/slices/uiSlice';
import { sshPickerUnavailable, type SshPickerLaunch } from '../../services/sshPicker';
import { CanvasMenuItem } from '../Canvas/CanvasMenu';
import { useOpenSshConnections, type SshPickerInvocation } from './AllSshConnectionsDialog';

export function SshConnectionsMenuSection({ variant, capture, onClose }: {
  variant: 'dropdown' | 'canvas';
  capture: () => SshPickerInvocation;
  onClose: () => void;
}) {
  const store = useStore<RootState>();
  const dispatch = useDispatch();
  const open = useOpenSshConnections();
  const unavailable = useSelector(sshPickerUnavailable);
  const rows = useSelector(selectSshSearchRows);
  const canvas = variant === 'canvas';
  const notify = (message: string) => dispatch(addToast({ message, type: 'warning' }));
  const pick = (id: string) => {
    const state = store.getState();
    const why = sshPickerUnavailable(state);
    if (why) { notify(why); return; }
    if (!state.ssh.view.connections.some(row => row.id === id && row.bookmarked)) return;
    const launch: SshPickerLaunch = capture().launch;
    onClose();
    const error = launch(id);
    if (error) notify(error);
  };
  const showAll = () => {
    if (!open) return;
    const request = capture();
    onClose();
    open(request);
  };

  const headerClass = canvas ? 'context-menu-header' : 'dropdown-header';
  const row = (key: string, label: string, detail: string | undefined, onClick: () => void, disabled = false) => {
    const name = <span className="ssh-menu-label"><span>{label}</span>{detail && <small>{detail}</small>}</span>;
    return canvas
      ? <CanvasMenuItem key={key} icon="⌁" onClick={onClick} disabled={disabled}>{name}</CanvasMenuItem>
      : <button key={key} type="button" className={`dropdown-item ssh-menu-item${disabled ? ' disabled' : ''}`}
          onClick={onClick} disabled={disabled}><span className="profile-icon" aria-hidden="true">⌁</span>{name}</button>;
  };

  return <>
    <div className={canvas ? 'context-menu-divider' : 'dropdown-divider'} />
    <div className={headerClass}>SSH Connections</div>
    {unavailable && <div className={`${headerClass} ssh-menu-reason`}>{unavailable}</div>}
    {rows.filter(({ connection }) => connection.bookmarked).map(({ connection, host, breadcrumb }) =>
      row(connection.id, connection.name, `${host} · ${breadcrumb || 'Top level'}`, () => pick(connection.id), !!unavailable))}
    {row('all-ssh-connections', 'All SSH Connections…', undefined, showAll, !open)}
  </>;
}
