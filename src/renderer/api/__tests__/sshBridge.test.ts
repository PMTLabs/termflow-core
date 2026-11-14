/** @jest-environment jsdom */
jest.mock('@tauri-apps/api/core', () => ({ invoke:jest.fn().mockResolvedValue({}) }));
jest.mock('@tauri-apps/api/event', () => ({ listen:jest.fn().mockResolvedValue(() => {}) }));
jest.mock('@tauri-apps/api/window', () => ({ getCurrentWindow:jest.fn(() => ({label:'main'})) }));
import tauriBridge from '../tauri-bridge';
import browserBridge from '../browser-bridge';
import { invoke } from '@tauri-apps/api/core';
import { createSshBridge, browserSshBridge } from '../sshBridge';
import type { SshStoreApi } from '../../types/ssh';
test('both actual bridges wire the SSH surface',async()=>{
  expect(browserBridge.ssh).toBe(browserSshBridge);
  await expect(browserBridge.ssh!.get()).rejects.toMatchObject({code:'desktop-only'});
  expect(tauriBridge.ssh).toBeDefined();
  await tauriBridge.ssh!.setBookmark('c-real',true);
  expect(invoke).toHaveBeenCalledWith('ssh_set_bookmark',{id:'c-real',bookmarked:true});
});
describe('SSH bridge contract', () => {
  const folder = { parentId: null, name: 'F', icon: 'server', color: 'sky' };
  const connection = { folderId: null, name: 'C', host: 'h', port: 22, user: 'u', auth: 'agent' as const, identityFile: null, jumpConnectionId: null, extraOptions: [], bookmarked: true };
  const move = { kind: 'connection' as const, id: 'c-dragged', parentId: 'f-target', index: 2 };
  const cases: [keyof SshStoreApi, any[], string, object | undefined][] = [
    ['get', [], 'ssh_store_get', undefined], ['reload', [], 'ssh_store_reload', undefined],
    ['upsertFolder', [folder], 'ssh_folder_upsert', { input: folder }],
    ['deleteFolder', [{ id: 'f-clicked', recursive: true }], 'ssh_folder_delete', { id: 'f-clicked', recursive: true }],
    ['upsertConnection', [connection], 'ssh_connection_upsert', { input: connection }],
    ['deleteConnection', [{ id: 'c-clicked' }], 'ssh_connection_delete', { id: 'c-clicked' }],
    ['move', [move], 'ssh_move', move], ['setBookmark', ['c-star', true], 'ssh_set_bookmark', { id: 'c-star', bookmarked: true }],
  ];
  test.each(cases)('%s uses exact native command and payload', async (method, args, command, payload) => {
    const invoke = jest.fn().mockResolvedValue({ revision: 1 }); const api = createSshBridge(invoke, jest.fn());
    await (api[method] as Function)(...args);
    expect(invoke.mock.calls).toEqual([[command, ...(payload === undefined ? [] : [payload])]]);
    await expect((browserSshBridge[method] as Function)(...args)).rejects.toMatchObject({ code: 'desktop-only' });
  });
  test('onChanged owns its unlisten and exact event', async () => {
    const unlisten = jest.fn(); const listen = jest.fn().mockResolvedValue(unlisten); const listener = jest.fn();
    const stop = await createSshBridge(jest.fn(), listen).onChanged(listener);
    expect(listen).toHaveBeenCalledWith('ssh-store:changed', expect.any(Function));
    const payload = { revision: 2 }; listen.mock.calls[0][1]({ payload }); expect(listener).toHaveBeenCalledWith(payload);
    stop(); expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
