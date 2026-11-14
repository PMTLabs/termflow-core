import { configureStore } from '@reduxjs/toolkit';
import reducer from '../../store/slices/sshSlice';
import { hydrateSsh } from '../sshHydration';
import { browserSshBridge } from '../../api/sshBridge';
import type { SshReply, SshStoreApi } from '../../types/ssh';
const reply = (revision: number): SshReply => ({ revision, view: { revision, folders: [], connections: [], loadError: null } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
test('listener precedes get; event between registration and reply is retained; stop unlistens', async () => {
  const get = deferred<SshReply>(); const registration = deferred<() => void>(); const unlisten = jest.fn(); let event!: (r: SshReply) => void;
  const api = { get: jest.fn(() => get.promise), onChanged: jest.fn(listener => { event = listener; return registration.promise; }) } as unknown as SshStoreApi;
  const store = configureStore({ reducer: { ssh: reducer } }); const hydration = hydrateSsh(api, store.dispatch);
  expect(api.get).not.toHaveBeenCalled(); registration.resolve(unlisten); await Promise.resolve();
  event(reply(7)); get.resolve(reply(3)); await hydration.ready;
  expect(store.getState().ssh.revision).toBe(7); hydration.stop(); expect(unlisten).toHaveBeenCalledTimes(1);
  event(reply(8)); expect(store.getState().ssh.revision).toBe(7);
});
test('rejected get is error, not successful empty store', async () => {
  const store = configureStore({ reducer: { ssh: reducer } });
  const api = { onChanged: async () => () => {}, get: async () => { throw Error('Disk unavailable'); } } as unknown as SshStoreApi;
  await hydrateSsh(api, store.dispatch).ready; expect(store.getState().ssh.status).toBe('error'); expect(store.getState().ssh.revision).toBe(-1);
});
test.each(['onChanged','get'].flatMap(method => [{method,error:{code:'io'}},{method,error:{code:'io',message:42}}]))('structured $method rejection uses the shared SSH formatter: $error',async ({method,error})=>{
  const store=configureStore({reducer:{ssh:reducer}});
  const api={onChanged:jest.fn().mockResolvedValue(()=>{}),get:jest.fn().mockResolvedValue(reply(0))};
  api[method as keyof typeof api].mockRejectedValue(error);
  await hydrateSsh(api as unknown as SshStoreApi,store.dispatch).ready;
  expect(store.getState().ssh.error).toBe('io');
});
test('browser bridge reports desktop-only', async () => {
  const store = configureStore({ reducer: { ssh: reducer } }); await hydrateSsh(browserSshBridge, store.dispatch).ready;
  expect(store.getState().ssh.status).toBe('desktop-only');
});
test('unmount before listener registration still disposes the eventual listener', async () => {
  const registration = deferred<() => void>(); const stop = jest.fn(); const get = jest.fn();
  const store = configureStore({ reducer: { ssh: reducer } }); const hydration = hydrateSsh({ onChanged: () => registration.promise, get } as unknown as SshStoreApi, store.dispatch);
  hydration.stop(); registration.resolve(stop); await hydration.ready; expect(stop).toHaveBeenCalledTimes(1); expect(get).not.toHaveBeenCalled();
});
