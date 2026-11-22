/** @jest-environment jsdom */
import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SshMenus } from '../../Settings/SshConnections/SshMenus';
import type { SshFolder, SshStoreApi } from '../../../types/ssh';
import { ContextMenu } from '../ContextMenu';

test('checkbox_menu_aria_checked_tracks_actual_visibility', () => {
  const disabledAction = jest.fn();
  function Host() {
    const [open, setOpen] = useState(false);
    const [hidden, setHidden] = useState(false);
    return <>
      <button onClick={() => setOpen(true)}>Metrics menu</button>
      {!hidden && <output>CPU reading</output>}
      {open && <ContextMenu x={10} y={10} onClose={() => setOpen(false)} items={[
        { type: 'heading', label: 'Show in status bar', click: disabledAction },
        { label: 'CPU', checked: !hidden, click: () => setHidden(value => !value) },
        { label: 'RAM', checked: true, enabled: false, click: disabledAction },
      ]} />}
    </>;
  }
  render(<Host />);
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'Metrics menu' }));
  const cpu = () => screen.getByRole('menuitemcheckbox', { name: 'CPU' });
  open();
  fireEvent.click(screen.getByText('Show in status bar'));
  expect(cpu().getAttribute('aria-checked')).toBe('true');
  expect(cpu().textContent).toBe('✓CPU');
  fireEvent.click(cpu());
  expect(screen.queryByText('CPU reading')).toBeNull();
  open();
  expect(cpu().getAttribute('aria-checked')).toBe('false');
  expect(cpu().textContent).toBe('CPU');
  const ram = screen.getByRole('menuitemcheckbox', { name: 'RAM' }) as HTMLButtonElement;
  expect(ram.disabled).toBe(true);
  fireEvent.click(ram);
  fireEvent.keyDown(ram, { key: 'Enter' });
  fireEvent.keyDown(ram, { key: ' ' });
  expect(disabledAction).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' });
  expect(document.activeElement).toBe(cpu());
  fireEvent.keyDown(cpu(), { key: ' ' });
  expect(screen.getByText('CPU reading')).not.toBeNull();
  open();
  expect(cpu().getAttribute('aria-checked')).toBe('true');
  fireEvent.keyDown(cpu(), { key: 'Enter' });
  expect(screen.queryByText('CPU reading')).toBeNull();
});

test('normal_disabled_and_submenu_behaviour_unchanged', async () => {
  const folder: SshFolder = { id: 'folder', parentId: null, name: 'Hosts', icon: 'folder', color: 'blue', order: 0 };
  const rename = jest.fn();
  const commit = jest.fn(async () => true);
  function Host() {
    const [open, setOpen] = useState(false);
    return <>
      <button onClick={() => setOpen(true)}>Folder actions</button>
      {open && <SshMenus target={{ x: 10, y: 10, row: folder, kind: 'folder' }}
        view={{ folders: [folder], connections: [], revision: 1, loadError: null }}
        api={{} as SshStoreApi} commit={commit} onClose={() => setOpen(false)}
        onFolder={jest.fn()} onConnection={jest.fn()} onRename={rename} />}
    </>;
  }
  render(<Host />);
  const invoker = screen.getByRole('button', { name: 'Folder actions' });
  invoker.focus();
  fireEvent.click(invoker);
  const row = (name: RegExp) => screen.getByRole('menuitem', { name }) as HTMLButtonElement;
  const menu = screen.getByRole('menu');
  expect(document.activeElement).toBe(menu);
  const disabled = row(/move down/i);
  expect(disabled.disabled).toBe(true);
  fireEvent.click(disabled);
  fireEvent.keyDown(disabled, { key: 'Enter' });
  expect(commit).not.toHaveBeenCalled();
  const danger = row(/delete folder/i);
  expect(danger.classList.contains('danger')).toBe(true);
  expect(danger.hasAttribute('aria-checked')).toBe(false);
  fireEvent.keyDown(menu, { key: 'End' });
  expect(document.activeElement).toBe(danger);
  fireEvent.keyDown(danger, { key: 'ArrowUp' });
  expect(document.activeElement).toBe(row(/rename/i));
  const submenu = row(/folder icon/i);
  submenu.focus();
  fireEvent.keyDown(submenu, { key: 'ArrowRight' });
  expect(submenu.getAttribute('aria-expanded')).toBe('true');
  expect(within(screen.getByRole('group', { name: 'Choose icon' })).getAllByRole('button')).toContain(document.activeElement);
  submenu.focus();
  fireEvent.keyDown(submenu, { key: 'ArrowLeft' });
  expect(submenu.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(submenu);
  const renameRow = row(/rename/i);
  renameRow.focus();
  fireEvent.keyDown(renameRow, { key: 'Enter' });
  expect(rename).toHaveBeenCalledWith(folder, 'folder');
  expect(screen.queryByRole('menu')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(invoker));
});
