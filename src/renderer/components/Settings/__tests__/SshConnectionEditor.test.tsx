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
import { writeClipboardText } from '../../../utils/clipboard';
jest.mock('../../../utils/clipboard', () => ({ writeClipboardText:jest.fn().mockResolvedValue(undefined), readClipboardText:jest.fn() }));
const input:SshConnectionInput = { folderId:null,name:'Host',host:'h',port:2222,user:'deploy',auth:'agent',identityFile:null,jumpConnectionId:null,extraOptions:[['ServerAliveInterval','30']],bookmarked:true };
let root:Root; let host:HTMLDivElement; let save:jest.Mock;
const view:SshView = { revision:1,folders:[],connections:[],loadError:null };
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); save = jest.fn().mockResolvedValue({ revision:2,view:{ ...view,revision:2 } }); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
function render(existing = false, previewConnection?: SshStoreApi['previewConnection']) { const data = existing ? { ...view,connections:[{ ...input,id:'c-edited',order:0,lastUsedAt:null,hasSavedSecret:false }] } : view; act(() => root.render(<SshConnectionEditor connectionId={existing ? 'c-edited' : undefined} initialFolder={null} view={data} api={{ upsertConnection:save, previewConnection } as unknown as SshStoreApi} onSaved={() => {}} onClose={() => {}} />)); }
async function change(name:string,value:string) { const field = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value); field.dispatchEvent(new Event('input',{ bubbles:true })); }); }
const toggle = () => host.querySelector<HTMLButtonElement>('[aria-label="Command preview"] button[aria-expanded]')!;
const button = (text:string) => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Command preview"] button')].find(b => b.textContent === text)!;
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
  const server:SshPreview = { argv:['never execute'],commands:[{ shell:'sh',label:'sh, bash or zsh',text:'Native preview of the edited host' }],storeRevision:1,wrapper:'Native proxy wrapper',configNotice:'Isolated config' };
  const previewConnection = jest.fn()
    .mockImplementationOnce(() => new Promise<SshPreview>(resolve => { finishSaved = resolve; }))
    .mockResolvedValue(server);
  render(true, previewConnection);
  expect(previewConnection.mock.calls[0][0]).toEqual({ source:{ kind:'saved', id:'c-edited' } });
  await change('host','edited.test');
  expect(previewConnection.mock.calls[1][0]).toEqual({ source:{ kind:'draft',editingId:'c-edited',draft:{ ...input,id:'c-edited',host:'edited.test' } } });
  await act(async () => finishSaved({ ...server,commands:[{ ...server.commands[0],text:'Stale display' }] }));
  const region = host.querySelector('[aria-label="Command preview"]')!;
  await act(async () => toggle().click());
  expect(region.querySelector('code')!.textContent).toBe(server.commands[0].text);
  expect(region.textContent).toContain('Native proxy wrapper — Isolated config');
  expect(save).not.toHaveBeenCalled();
});

test('command preview is collapsed by default, opens from the keyboard-operable toggle and copies the chosen shell text', async () => {
  const preview:SshPreview = { argv:['ssh'],storeRevision:1,wrapper:'Direct native OpenSSH connection',configNotice:'Isolated config',commands:[
    { shell:'powershell',label:'PowerShell',text:"Start-Process -FilePath 'ssh.exe' -ArgumentList '-- h' -NoNewWindow -Wait" },
    { shell:'cmd',label:'Command Prompt',text:'ssh.exe -- h' },
  ] };
  await act(async () => render(true, jest.fn().mockResolvedValue(preview)));
  const region = host.querySelector('[aria-label="Command preview"]')!;
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(toggle().tagName).toBe('BUTTON');
  expect(region.querySelector('code')).toBeNull();
  await act(async () => toggle().click());
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  expect(document.getElementById(toggle().getAttribute('aria-controls')!)).toBe(region.querySelector('.ssh-argv-body'));
  expect(region.querySelector('code')!.textContent).toBe(preview.commands[0].text);
  expect(region.textContent).toContain('Runs as-is in PowerShell.');
  await act(async () => button('Copy').click());
  expect(writeClipboardText).toHaveBeenLastCalledWith(preview.commands[0].text);
  expect(region.querySelector('[role="status"]')!.textContent).toBe('Copied');
  await act(async () => button('Command Prompt').click());
  expect(button('Command Prompt').getAttribute('aria-pressed')).toBe('true');
  expect(region.querySelector('code')!.textContent).toBe('ssh.exe -- h');
  expect(region.querySelector('[role="status"]')!.textContent).toBe('');
  await act(async () => button('Copy').click());
  expect(writeClipboardText).toHaveBeenLastCalledWith('ssh.exe -- h');
  await act(async () => toggle().click());
  expect(region.querySelector('code')).toBeNull();
});

test('a command that cannot run by hand disables Copy and says why', async () => {
  (writeClipboardText as jest.Mock).mockClear();
  const why = 'This jump host runs through a private helper that only TermFlow creates, so the command cannot be run by hand.';
  const preview:SshPreview = { argv:['ssh'],storeRevision:1,wrapper:'Jump',configNotice:'Isolated config',commands:[{ shell:'sh',label:'sh, bash or zsh',text:"/usr/bin/ssh -o 'ProxyCommand=<helper>' -- h",unavailable:why }] };
  await act(async () => render(true, jest.fn().mockResolvedValue(preview)));
  await act(async () => toggle().click());
  const copy = button('Copy');
  expect(copy.disabled).toBe(true);
  expect(document.getElementById(copy.getAttribute('aria-describedby')!)!.textContent).toBe(why);
  await act(async () => copy.click());
  expect(writeClipboardText).not.toHaveBeenCalled();
});

test('preview problems stay visible while the command is collapsed', async () => {
  const missing = 'Windows OpenSSH Client is not installed. Turn it on in Settings > System > Optional features > OpenSSH Client, then try again.';
  await act(async () => render(true, jest.fn().mockRejectedValue({ code:'SshClientMissing',message:missing })));
  const region = host.querySelector('[aria-label="Command preview"]')!;
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(region.querySelector('[role="alert"]')!.textContent).toBe(missing);
  await change('extraOptions','NotAnOption=1');
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(region.textContent).toContain('Fix Extra options to preview the command.');
});

test('structured host error renders under Host', async () => { save.mockRejectedValue({ field:'host',code:'leading-dash' }); render(true); await submit(); const field = host.querySelector('input[name="host"]')!; expect(document.getElementById(field.getAttribute('aria-describedby')!)?.textContent).toBe("Host can't start with “-”."); });
