/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { SshConnectionEditor } from '../SshConnections/SshConnectionEditor';
import type { SshStoreApi, SshView } from '../../../types/ssh';
const connection = { id:'c-saved', folderId:null, name:'Saved', host:'target.test', port:22, user:'alice', auth:'password' as const, identityFile:null, jumpConnectionId:null, extraOptions:[], bookmarked:false, order:0, lastUsedAt:null, hasSavedSecret:false };
const view:SshView = { revision:1, folders:[], connections:[connection], loadError:null };
let root:Root, host:HTMLDivElement, testConnection:jest.Mock, close:jest.Mock, stop:jest.Mock;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  testConnection = jest.fn(async () => ({ probeId:'probe-settings' })); close = jest.fn(async () => {}); stop = jest.fn();
  window.electronAPI = {
    onSshTestState:async () => stop, sshTestConnection:testConnection, sshTestClose:close,
    sshTestState:async () => ({ probeId:'probe-settings', connectionId:'c-saved', state:'connecting', generation:1, revision:1, gate:'pending' }),
  } as any;
});
afterEach(() => { act(() => root.unmount()); host.remove(); delete (window as any).electronAPI; });
function render(persisted = true, data = view) {
  act(() => root.render(<SshConnectionEditor connectionId={persisted ? 'c-saved' : undefined} initialFolder={null} view={data} api={{} as SshStoreApi} onSaved={jest.fn()} onClose={jest.fn()} />));
}
function testButton() { return [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Test connection')!; }
async function open() { await act(async () => { testButton().click(); await flush(); }); }
test('Test is enabled only for a clean persisted row; dirty drafts never test stale saved values', async () => {
  render(false); expect(testButton().disabled).toBe(true);
  await open(); expect(testConnection).not.toHaveBeenCalled();
  act(() => root.unmount()); root = createRoot(host);
  render(); expect(testButton().disabled).toBe(false);
  const field = host.querySelector<HTMLInputElement>('input[name=host]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,'changed.test'); field.dispatchEvent(new Event('input',{ bubbles:true })); });
  expect(testButton().disabled).toBe(true); expect(host.textContent).toContain('Save changes before testing');
  await open(); expect(testConnection).not.toHaveBeenCalled();
});
test('opening tests the persisted id; dialog Close disposes without a pane or usage write', async () => {
  render(); await open(); expect(testConnection.mock.calls).toEqual([['c-saved']]);
  expect(document.querySelector('[aria-label="Test SSH connection"]')).not.toBeNull();
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('.ssh-test-dialog button')].find(b => b.textContent === 'Close')!.click(); await flush(); });
  expect(close.mock.calls).toEqual([['probe-settings']]); expect(stop).toHaveBeenCalledTimes(1);
  expect(document.querySelector('.ssh-test-dialog')).toBeNull();
});
test('editor unmount disposes the probe and read-only/deleted rows cannot open one', async () => {
  render(); await open(); act(() => root.unmount()); root = createRoot(host);
  expect(close).toHaveBeenCalledWith('probe-settings'); expect(stop).toHaveBeenCalledTimes(1);
  render(true, { ...view, loadError:{ code:'read-only', message:'Repair store' } }); expect(testButton().disabled).toBe(true);
  render(true, { ...view, connections:[] }); expect(testButton().disabled).toBe(true);
});
