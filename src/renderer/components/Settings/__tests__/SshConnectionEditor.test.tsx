/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { SshConnectionEditor } from '../SshConnections/SshConnectionEditor';
import { SshConnectionsPanel } from '../SshConnections/SshConnectionsPanel';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import sshReducer, { applyView } from '../../../store/slices/sshSlice';
import { browserSshBridge } from '../../../api/sshBridge';
import { sshFieldMessage } from '../SshConnections/sshErrors';
import type { SshConnectionInput, SshPreview, SshStoreApi, SshView } from '../../../types/ssh';
const input:SshConnectionInput = { folderId:null,name:'Host',host:'h',port:2222,user:'deploy',auth:'agent',identityFile:null,jumpConnectionId:null,extraOptions:[['ServerAliveInterval','30']],bookmarked:true };
let root:Root; let host:HTMLDivElement; let save:jest.Mock;
const view:SshView = { revision:1,folders:[],connections:[],loadError:null };
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); save = jest.fn().mockResolvedValue({ revision:2,view:{ ...view,revision:2 } }); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
function render(existing = false, previewConnection?: SshStoreApi['previewConnection']) { const data = existing ? { ...view,connections:[{ ...input,id:'c-edited',order:0,lastUsedAt:null,hasSavedSecret:false }] } : view; act(() => root.render(<SshConnectionEditor connectionId={existing ? 'c-edited' : undefined} initialFolder={null} view={data} api={{ upsertConnection:save, previewConnection } as unknown as SshStoreApi} onSaved={() => {}} onClose={() => {}} />)); }
async function change(name:string,value:string) { const field = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value); field.dispatchEvent(new Event('input',{ bubbles:true })); }); }
async function submit() { await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Save connection')!.click()); }
test('create sends every input field and never an id or backend-only fields', async () => {
  render(); for (const [name,value] of Object.entries({ name:'Host',host:'h',port:'2222',user:'deploy',extraOptions:'ServerAliveInterval=30' })) await change(name,value);
  await act(async () => host.querySelector<HTMLInputElement>('input[name="bookmarked"]')!.click()); await submit(); expect(save.mock.calls).toEqual([[input]]); expect(save.mock.calls[0][0]).not.toHaveProperty('id');
});
test('update sends exactly the edited row id and same field set', async () => { render(true); await submit(); expect(save.mock.calls).toEqual([[{ ...input,id:'c-edited' }]]); });
test('dirty row switch prompts and Keep editing retains the original draft', async () => {
  window.electronAPI = { ssh:{ upsertConnection:save } } as any;
  const store = configureStore({ reducer:{ ssh:sshReducer } });
  const connections = ['c-first','c-second'].map((id,order) => ({ ...input,id,name:id,order,lastUsedAt:null,hasSavedSecret:false }));
  store.dispatch(applyView({ revision:1,view:{ ...view,connections } }));
  act(() => root.render(<Provider store={store}><SshConnectionsPanel /></Provider>));
  await act(async () => host.querySelector<HTMLElement>('[data-row-id="c-first"] > .ssh-tree-row')!.click());
  await change('name','Keep my draft');
  await act(async () => host.querySelector<HTMLElement>('[data-row-id="c-second"] > .ssh-tree-row')!.click());
  expect(document.querySelector('.unsaved-dialog-overlay, .confirm-dialog-overlay')).not.toBeNull();
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'Keep editing')!.click());
  expect(host.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe('Keep my draft'); expect(save).not.toHaveBeenCalled();
});
test('preview_validation_fields_and_desktop_only_errors_reach_editor', async () => {
  const previewConnection = jest.fn()
    .mockRejectedValueOnce({ code:'Validation',message:'Invalid draft',fields:[{ field:'extraOptions',code:'option-not-allowed',message:'Option not allowed' }] })
    .mockImplementationOnce(browserSshBridge.previewConnection);
  await act(async () => render(false, previewConnection));
  expect(previewConnection.mock.calls[0][0]).toMatchObject({ source:{ kind:'draft' } });
  const field = host.querySelector('input[name="extraOptions"]')!;
  expect(field.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById(field.getAttribute('aria-describedby')!)?.textContent).toBe(sshFieldMessage('extraOptions','option-not-allowed'));
  await change('extraOptions','ServerAliveInterval=30');
  expect(field.getAttribute('aria-invalid')).toBe('false');
  expect(host.querySelector('[aria-label="Command preview"] [role="alert"]')!.textContent).toBe('SSH connections require the desktop app');
  expect(save).not.toHaveBeenCalled();
});

test('saved preview gives way to the Rust draft display and ignores a late saved reply', async () => {
  let finishSaved!: (value:SshPreview) => void;
  const server = { argv:['never execute'],display:'Native preview of the edited host',storeRevision:1,wrapper:'Native proxy wrapper',configNotice:'Isolated config' };
  const previewConnection = jest.fn()
    .mockImplementationOnce(() => new Promise<SshPreview>(resolve => { finishSaved = resolve; }))
    .mockResolvedValue(server);
  render(true, previewConnection);
  expect(previewConnection.mock.calls[0][0]).toEqual({ source:{ kind:'saved', id:'c-edited' } });
  await change('host','edited.test');
  expect(previewConnection.mock.calls[1][0]).toEqual({ source:{ kind:'draft',editingId:'c-edited',draft:{ ...input,id:'c-edited',host:'edited.test' } } });
  await act(async () => finishSaved({ ...server,display:'Stale display' }));
  const region = host.querySelector('[aria-label="Command preview"]')!;
  expect(region.querySelector('code')!.textContent).toBe(server.display);
  expect(region.textContent).toContain('Native proxy wrapper — Isolated config');
  expect(save).not.toHaveBeenCalled();
});

test('structured host error renders under Host', async () => { save.mockRejectedValue({ field:'host',code:'leading-dash' }); render(true); await submit(); const field = host.querySelector('input[name="host"]')!; expect(document.getElementById(field.getAttribute('aria-describedby')!)?.textContent).toBe("Host can't start with “-”."); });
