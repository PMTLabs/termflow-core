/** @jest-environment jsdom */
test('browserSshRejectsDesktopOnly', async () => {
  (global as any).WebSocket = class { onopen = null; onmessage = null; onclose = null; onerror = null; };
  const api = (await import('../browser-bridge')).default;
  for (const run of [
    () => api.sshSessionOpen('tm-a', 'c-a'), () => api.sshSessionState('tm-a'), () => api.sshSessionClose('tm-a'),
    () => api.sshSessionReconnect('tm-a'), () => api.sshSessionSubmitSecret('tm-a', 'secret', false),
    () => api.sshSessionTrustHost('tm-a', true), () => api.sshTestConnection('c-a'), () => api.sshTestState('probe-a'),
    () => api.sshTestClose('probe-a'), () => api.sshTestSubmitSecret('probe-a', 'secret', false),
    () => api.sshTestTrustHost('probe-a', true), () => api.onSshSessionState(() => {}), () => api.onSshTestState(() => {}),
  ]) await expect(run()).rejects.toThrow('desktop-only');
});
