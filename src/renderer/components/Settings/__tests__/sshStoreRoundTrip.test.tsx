/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import reducer from '../../../store/slices/sshSlice';
import { SshConnectionsPanel } from '../SshConnections/SshConnectionsPanel';
import { hydrateSsh } from '../../../services/sshHydration';
import type { SshReply, SshStoreApi, SshView } from '../../../types/ssh';
// Panel + real slice + revisioned fake bridge. NOT a native IPC test.
test('sshStoreRoundTrip: folder → subfolder → connection → bookmark → move → delete, stale reply cannot regress', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear();
  let view:SshView = { revision:0,folders:[],connections:[],loadError:null }; let listener:((reply:SshReply) => void) | undefined; let folderSeq = 0; let connectionSeq = 0;
  const snapshot = ():SshReply => JSON.parse(JSON.stringify({ revision:view.revision,view }));
  const mutate = (operation:() => void) => { operation(); view = { ...view,revision:view.revision + 1 }; const reply = snapshot(); listener?.(reply); return Promise.resolve(reply); };
  const api:SshStoreApi = {
    get:async () => snapshot(), reload:async () => snapshot(), onChanged:async next => { listener = next; return () => { listener = undefined; }; },
    upsertFolder:jest.fn(input => mutate(() => { const id = input.id ?? `f-${++folderSeq}`; view.folders = [...view.folders.filter(f => f.id !== id), { ...input,id,order:view.folders.filter(f => f.parentId === input.parentId).length }]; })),
    deleteFolder:jest.fn(({id}) => mutate(() => { view.folders = view.folders.filter(f => f.id !== id); })),
    upsertConnection:jest.fn(input => mutate(() => { const id = input.id ?? `c-${++connectionSeq}`; view.connections = [...view.connections.filter(c => c.id !== id), { ...input,id,order:0,lastUsedAt:null,hasSavedSecret:false }]; })),
    deleteConnection:jest.fn(({id}) => mutate(() => { view.connections = view.connections.filter(c => c.id !== id); })),
    move:jest.fn(input => mutate(() => { view.connections = view.connections.map(c => c.id === input.id ? { ...c,folderId:input.parentId,order:input.index } : c); })),
    setBookmark:jest.fn(async (id,bookmarked) => { const stale = snapshot(); await mutate(() => { view.connections = view.connections.map(c => c.id === id ? { ...c,bookmarked } : c); }); return stale; }),
  };
  window.electronAPI = { ssh:api } as any;
  const store = configureStore({ reducer:{ ssh:reducer } }); const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  const hydration = hydrateSsh(api,store.dispatch); await hydration.ready;
  const button = (label:string) => { const b = [...document.querySelectorAll<HTMLElement>('button, .context-menu-item')].find(b => (b.querySelector('.context-menu-label')?.textContent ?? b.textContent)?.trim() === label); if (!b) throw Error(`Missing ${label}`); return b; };
  const row = (id:string) => host.querySelector<HTMLElement>(`[data-row-id="${id}"] > .ssh-tree-row`)!;
  const change = async (element:HTMLInputElement,value:string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,value); element.dispatchEvent(new Event('input',{ bubbles:true })); }); };
  const context = async (id:string) => { await act(async () => row(id).dispatchEvent(new MouseEvent('contextmenu',{ bubbles:true,clientX:12,clientY:16 }))); };
  try {
    await act(async () => root.render(<Provider store={store}><SshConnectionsPanel /></Provider>));
    await act(async () => button('New folder').click()); await change(document.querySelector<HTMLInputElement>('[role="dialog"] input')!,'Root'); await act(async () => button('Save folder').click()); expect(row('f-1')).not.toBeNull();
    await context('f-1'); await act(async () => button('Add subfolder').click()); await change(document.querySelector<HTMLInputElement>('[role="dialog"] input')!,'Nested'); await act(async () => button('Save folder').click());
    expect(row('f-2').closest('[data-row-id="f-1"]')).not.toBeNull();
    await context('f-2'); await act(async () => button('New SSH connection here').click()); await change(host.querySelector<HTMLInputElement>('input[name="name"]')!,'web'); await change(host.querySelector<HTMLInputElement>('input[name="host"]')!,'h'); await act(async () => button('Save connection').click());
    expect(row('c-1').closest('[data-row-id="f-2"]')).not.toBeNull(); expect(api.upsertConnection).toHaveBeenCalledWith(expect.objectContaining({ folderId:'f-2' }));
    await act(async () => row('c-1').querySelector<HTMLButtonElement>('[aria-label="Bookmark web"]')!.click());
    expect(row('c-1').querySelector('[aria-pressed="true"]')).not.toBeNull(); expect(store.getState().ssh.revision).toBe(4); expect(api.setBookmark).toHaveBeenCalledWith('c-1',true);
    const drop = new Event('drop',{ bubbles:true,cancelable:true }); Object.defineProperty(drop,'dataTransfer',{ value:{ getData:() => JSON.stringify({ kind:'connection',id:'c-1' }) } }); await act(async () => row('f-1').dispatchEvent(drop));
    expect(api.move).toHaveBeenCalledWith({ kind:'connection',id:'c-1',parentId:'f-1',index:1 }); expect(row('c-1').closest('[data-row-id="f-2"]')).toBeNull(); expect(row('c-1').closest('[data-row-id="f-1"]')).not.toBeNull();
    await context('c-1'); await act(async () => button('Delete…').click()); await act(async () => button('Delete').click()); expect(row('c-1')).toBeNull(); expect(api.deleteConnection).toHaveBeenCalledWith({ id:'c-1' });
    await context('f-2'); await act(async () => button('Delete folder…').click()); expect(row('f-2')).toBeNull(); expect(api.deleteFolder).toHaveBeenCalledWith({ id:'f-2',recursive:false }); expect(row('f-1')).not.toBeNull();
  } finally { hydration.stop(); await act(async () => root.unmount()); host.remove(); }
});
