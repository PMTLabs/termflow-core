/** @jest-environment jsdom */
import browserBridge from '../browser-bridge';

test('browser bridge fails closed when host restore registration is unavailable', async () => {
  await expect(browserBridge.registerRestoringLeaves([{ leafId: 'tm-restored' }])).rejects.toThrow('requires the desktop bridge');
});

test('browser bridge has no unowned host intent to forget', async () => {
  await expect(browserBridge.forgetRestoringLeaf('tm-unowned')).resolves.toBeUndefined();
});
