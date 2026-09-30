/** @jest-environment jsdom */
import browserBridge from '../browser-bridge';

test('browser bridge fails closed when host restore registration is unavailable', async () => {
  await expect(browserBridge.registerRestoringLeaves([{ leafId: 'tm-restored' }])).rejects.toThrow('requires the desktop bridge');
});

test('browser bridge has no other window to hand a session to or from', async () => {
  await expect(browserBridge.offerSessionHandoff('tm-moved')).resolves.toBe(false);
  await expect(browserBridge.takeSessionHandoff('tm-moved')).resolves.toBeNull();
});

test('browser bridge has no unowned host intent to forget', async () => {
  await expect(browserBridge.forgetRestoringLeaf('tm-unowned')).resolves.toBeUndefined();
});
