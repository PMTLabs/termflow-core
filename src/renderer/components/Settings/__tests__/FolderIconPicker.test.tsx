/** @jest-environment jsdom */
import path from 'path';
import React, { act } from 'react';
import { readSource } from '../../../utils/readSource';
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
// jsdom has no layout, so pin the CSS that the live pass measured (FINAL-P2-1): the picker root also
// carries .ssh-connections for its colour variables, and that class's inline-size containment gave
// the max-content flyout a zero content width, spilling the icon grid over the menu.
test('the picker opts out of the panel container containment', () => {
  const css = readSource(path.resolve(__dirname, '..', 'SshConnections', 'SshConnections.css')).replace(/\s+/g, ' ');
  expect(css).toMatch(/\.ssh-connections \{ container-type:inline-size;/);
  expect(css).toMatch(/\.ssh-picker-flyout \{[^}]*width:max-content/);
  expect(css).toMatch(/\.ssh-icon-picker\.ssh-connections \{ container-type:normal; \}/);
});
