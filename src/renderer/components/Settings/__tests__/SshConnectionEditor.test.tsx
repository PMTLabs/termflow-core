/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { SshConnectionEditor } from '../SshConnections/SshConnectionEditor';
import { SshConnectionsPanel } from '../SshConnections/SshConnectionsPanel';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import sshReducer, { applyView } from '../../../store/slices/sshSlice';
import type { SshConnectionInput, SshStoreApi, SshView } from '../../../types/ssh';
const input:SshConnectionInput = { folderId:null,name:'Host',host:'h',port:2222,user:'deploy',auth:'agent',identityFile:null,jumpConnectionId:null,extraOptions:[['ServerAliveInterval','30']],bookmarked:true };
let root:Root; let host:HTMLDivElement; let save:jest.Mock;
const view:SshView = { revision:1,folders:[],connections:[],loadError:null };
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); save = jest.fn().mockResolvedValue({ revision:2,view:{ ...view,revision:2 } }); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
function render(existing = false) { const data = existing ? { ...view,connections:[{ ...input,id:'c-edited',order:0,lastUsedAt:null,hasSavedSecret:false }] } : view; act(() => root.render(<SshConnectionEditor connectionId={existing ? 'c-edited' : undefined} initialFolder={null} view={data} api={{ upsertConnection:save } as unknown as SshStoreApi} onSaved={() => {}} onClose={() => {}} />)); }
async function change(name:string,value:string) { const field = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value); field.dispatchEvent(new Event('input',{ bubbles:true })); }); }
async function submit() { await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Save connection')!.click()); }
test('create sends every input field and never an id or backend-only fields', async () => {
  render(); for (const [name,value] of Object.entries({ name:'Host',host:'h',port:'2222',user:'deploy',extraOptions:'ServerAliveInterval=30' })) await change(name,value);
  await act(async () => host.querySelector<HTMLInputElement>('input[name="bookmarked"]')!.click()); await submit(); expect(save.mock.calls).toEqual([[input]]); expect(save.mock.calls[0][0]).not.toHaveProperty('id');
});
test('update sends exactly the edited row id and same field set', async () => { render(true); await submit(); expect(save.mock.calls).toEqual([[{ ...input,id:'c-edited' }]]); });
test('dirty row switch prompts and Cancel retains the original draft', async () => {
  window.electronAPI = { ssh:{ upsertConnection:save } } as any;
  const store = configureStore({ reducer:{ ssh:sshReducer } });
  const connections = ['c-first','c-second'].map((id,order) => ({ ...input,id,name:id,order,lastUsedAt:null,hasSavedSecret:false }));
  store.dispatch(applyView({ revision:1,view:{ ...view,connections } }));
  act(() => root.render(<Provider store={store}><SshConnectionsPanel /></Provider>));
  await act(async () => host.querySelector<HTMLElement>('[data-row-id="c-first"] > .ssh-tree-row')!.click());
  await change('name','Keep my draft');
  await act(async () => host.querySelector<HTMLElement>('[data-row-id="c-second"] > .ssh-tree-row')!.click());
  expect(document.querySelector('.unsaved-dialog-overlay, .confirm-dialog-overlay')).not.toBeNull();
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'Cancel')!.click());
  expect(host.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe('Keep my draft'); expect(save).not.toHaveBeenCalled();
});
test('structured host error renders under Host', async () => { save.mockRejectedValue({ field:'host',code:'leading-dash' }); render(); await submit(); expect(host.querySelector('input[name="host"]')?.closest('label')?.textContent).toContain('leading-dash'); });
