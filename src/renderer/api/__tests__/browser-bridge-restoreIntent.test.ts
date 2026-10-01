/** @jest-environment jsdom */
import browserBridge from '../browser-bridge';

test('browser bridge fails closed when host restore registration is unavailable', async () => {
  await expect(browserBridge.registerRestoringLeaves([{ leafId: 'tm-restored' }])).rejects.toThrow('requires the desktop bridge');
});

test('browser bridge keeps explicit single-window bindings but cannot adopt an unknown leaf', async () => {
  await expect(browserBridge.bindShell('tm-local', 'pc-1')).resolves.toEqual({ status: 'bound', processId: 'pc-1' });
  await expect(browserBridge.bindShell('tm-moved')).resolves.toEqual({ status: 'none' });
  await expect(browserBridge.releaseShellBinding('tm-local')).resolves.toBeUndefined();
});

test('browser bridge has no unowned host intent to forget', async () => {
  await expect(browserBridge.forgetRestoringLeaf('tm-unowned')).resolves.toBeUndefined();
});
