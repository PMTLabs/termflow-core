/** @jest-environment jsdom */
// Full mounted oracles intentionally run at T7, by orchestrator ordering decision.
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
jest.mock('../SettingsPage.css', () => ({}));
jest.mock('../PeersPanel', () => ({ PeersPanel: () => null }));
jest.mock('../AboutLegalPanel', () => ({ AboutLegalPanel: () => null }));
jest.mock('../McpConnectModal', () => ({ McpConnectModal: () => null }));
jest.mock('../Automations/AutomationsPanel', () => ({ AutomationsPanel: () => null }));
jest.mock('../../UI/SplitButton', () => ({ SplitButton: () => null }));
jest.mock('../../../services/openSettings', () => ({ consumePendingSettingsCategory: () => null }));
jest.mock('../../../hooks/useSurfaceZoom', () => ({ useSurfaceZoom: () => ({ zoom: 1, reset: () => {} }), useZoomGestures: () => {} }));
import settingsReducer from '../../../store/slices/settingsSlice';
import sshReducer, { applyView } from '../../../store/slices/sshSlice';
import { SettingsPage } from '../SettingsPage';
import { clearSettingsGuard, runSettingsGuard } from '../../../services/settingsNavGuard';
import type { SshStoreApi } from '../../../types/ssh';
let root: Root; let container: HTMLDivElement; let save: jest.Mock;
const button = (label: string) => { const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label); if (!result) throw Error(`Button missing: ${label}`); return result; };
const active = () => container.querySelector('.settings-nav-item.active')?.textContent;
const prompt = () => document.querySelector('.unsaved-dialog-overlay, .confirm-dialog-overlay');
async function dirty() {
  await act(async () => button('New SSH connection').click());
  const name = container.querySelector<HTMLInputElement>('input[name="name"]'); if (!name) throw Error('Real editor missing');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Unsaved draft'); name.dispatchEvent(new Event('input', { bubbles: true })); });
}
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  global.fetch = jest.fn().mockRejectedValue(Error('No test server'));
  save = jest.fn().mockRejectedValue({ field: 'host', code: 'required', message: 'Host required' });
  window.electronAPI = { ssh: { upsertConnection: save } as unknown as SshStoreApi } as any;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  const store = configureStore({ reducer: { settings: settingsReducer, ssh: sshReducer } });
  store.dispatch(applyView({ revision: 0, view: { revision: 0, folders: [], connections: [], loadError: null } }));
  await act(async () => root.render(<Provider store={store}><SettingsPage isActive /></Provider>));
  await act(async () => button('SSH Connections').click());
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); clearSettingsGuard(); });
test('SSH category renders the real panel and has no global Save Settings', () => {
  expect(container.querySelector('[data-testid="ssh-connections-panel"]')).not.toBeNull();
  expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Save Settings')).toBe(false);
});
test.each(['sidebar', 'deep-link', 'tab'])('%s navigation prompts for a real dirty SSH draft', async route => {
  await dirty(); const proceed = jest.fn();
  await act(async () => {
    if (route === 'sidebar') button('Appearance').click();
    else if (route === 'deep-link') window.dispatchEvent(new CustomEvent('settings:goto-category', { detail: 'appearance' }));
    else expect(runSettingsGuard(proceed)).toBe(true);
  });
  expect(prompt()).not.toBeNull(); expect(active()).toContain('SSH Connections'); expect(proceed).not.toHaveBeenCalled();
  await act(async () => button('Cancel').click()); expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe('Unsaved draft');
});
test('a rejected editor Save refuses navigation and keeps the draft', async () => {
  await dirty(); await act(async () => button('Appearance').click()); await act(async () => button('Save').click());
  expect(active()).toContain('SSH Connections'); expect(prompt()).not.toBeNull();
  expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe('Unsaved draft');
});
test('Discard navigates and drops the draft', async () => {
  await dirty(); await act(async () => button('Appearance').click()); await act(async () => button('Discard').click()); expect(active()).toContain('Appearance');
  await act(async () => button('SSH Connections').click()); expect(container.querySelector('input[name="name"]')).toBeNull(); expect(save).not.toHaveBeenCalled();
});
