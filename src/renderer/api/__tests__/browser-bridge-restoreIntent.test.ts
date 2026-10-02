/** @jest-environment jsdom */
import browserBridge from '../browser-bridge';

test('browser bridge exposes no label-keyed host restore registration', () => {
  expect(browserBridge).not.toHaveProperty('registerRestoringLeaves');
  expect(typeof browserBridge.createTerminal).toBe('function');
});

test('browser bridge has no other window to hand a session to or from', async () => {
  await expect(browserBridge.offerSessionHandoff('tm-moved', 'pc-1')).resolves.toBe(false);
  await expect(browserBridge.takeSessionHandoff('tm-moved')).resolves.toEqual({ status: 'none' });
});

test('browser bridge exposes no label-keyed host forget endpoint', () => {
  expect(browserBridge).not.toHaveProperty('forgetRestoringLeaf');
  expect(typeof browserBridge.closeTerminal).toBe('function');
});
