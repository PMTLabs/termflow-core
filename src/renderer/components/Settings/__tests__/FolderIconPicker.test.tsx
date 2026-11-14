/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { FolderIconPicker } from '../SshConnections/FolderIconPicker';
test('15 real SVG icon buttons, six colour buttons, pressed state and keyboard selection/cancel', () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host); const pick = jest.fn(); const close = jest.fn();
  act(() => root.render(<FolderIconPicker icon="server" color="sky" onPick={pick} onClose={close} />));
  expect(host.querySelectorAll('.ssh-icon-grid button svg')).toHaveLength(15); expect(host.querySelectorAll('.ssh-color-grid button')).toHaveLength(6);
  expect(host.querySelector('[aria-label="Icon server"]')?.getAttribute('aria-pressed')).toBe('true');
  const flask = host.querySelector<HTMLButtonElement>('[aria-label="Icon flask"]')!; flask.focus();
  act(() => flask.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true })));
  expect(pick.mock.calls).toEqual([['flask','sky']]); pick.mockClear();
  act(() => flask.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true })));
  expect(close).toHaveBeenCalledTimes(1); expect(pick).not.toHaveBeenCalled();
  act(() => root.unmount()); host.remove();
});
