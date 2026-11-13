/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import reducer from '../../../store/slices/sshSlice';
import { hydrateSsh } from '../../../services/sshHydration';
import { SshConnectionsPanel } from '../SshConnections/SshConnectionsPanel';
import type { SshReply, SshStoreApi } from '../../../types/ssh';
// Rust's paired store tests prove equal/lower DISK revisions become served R+1.
// Here the bridge fixture supplies that Rust-owned snapshot; no renderer exception.
test.each([18,4])('repair at disk revision %i exits read-only using server revision 19 and enables menus', async diskRevision => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const readOnly:SshReply = { revision:18,view:{ revision:18,folders:[],connections:[],loadError:{ code:'invalid-json',message:'ssh_connections.json: Invalid JSON' } } };
  const recovered:SshReply = { revision:19,view:{ revision:19,folders:[{ id:'f-repaired',parentId:null,name:'Repaired',icon:'server',color:'sky',order:0 }],connections:[],loadError:null } };
  expect(diskRevision).toBeLessThanOrEqual(readOnly.revision);
  let listener:((reply:SshReply) => void) | undefined;
  const api = { get:async () => readOnly,onChanged:async (next:(reply:SshReply) => void) => { listener = next; return () => { listener = undefined; }; },reload:jest.fn(async () => { listener?.(recovered); return recovered; }) } as unknown as SshStoreApi;
  window.electronAPI = { ssh:api } as any;
  const store = configureStore({ reducer:{ ssh:reducer } }); const hydration = hydrateSsh(api,store.dispatch); await hydration.ready;
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<Provider store={store}><SshConnectionsPanel /></Provider>));
    const newFolder = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'New folder')!;
    expect(host.querySelector('.ssh-read-only')).not.toBeNull(); expect(newFolder().disabled).toBe(true);
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Reload')!.click());
    expect(store.getState().ssh.revision).toBe(19); expect(host.querySelector('.ssh-read-only')).toBeNull(); expect(newFolder().disabled).toBe(false);
    await act(async () => host.querySelector<HTMLElement>('[data-row-id="f-repaired"] > .ssh-tree-row')!.dispatchEvent(new MouseEvent('contextmenu',{ bubbles:true,clientX:12,clientY:14 })));
    expect([...document.querySelectorAll('.context-menu-label')].map(n => n.textContent)).toContain('Folder icon');
  } finally { hydration.stop(); await act(async () => root.unmount()); host.remove(); }
});
