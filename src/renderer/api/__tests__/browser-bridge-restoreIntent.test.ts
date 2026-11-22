/** @jest-environment jsdom */
import browserBridge from '../browser-bridge';

test('browser bridge exposes no label-keyed host restore registration', () => {
  expect(browserBridge).not.toHaveProperty('registerRestoringLeaves');
  expect(typeof browserBridge.createTerminal).toBe('function');
});

test('browser bridge exposes no label-keyed host forget endpoint', () => {
  expect(browserBridge).not.toHaveProperty('forgetRestoringLeaf');
  expect(typeof browserBridge.closeTerminal).toBe('function');
});
