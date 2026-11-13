/** @jest-environment jsdom */
const invokeMock = jest.fn((_cmd: string, _args?: unknown): Promise<any> => Promise.resolve({}));
const unlistenMock = jest.fn();
const listenMock = jest.fn((event: string, _cb: unknown) => Promise.resolve(event.startsWith('ssh-') ? unlistenMock : jest.fn()));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: [string, unknown]) => invokeMock(...args) }));
jest.mock('@tauri-apps/api/event', () => ({ listen: (...args: [string, unknown]) => listenMock(...args) }));
jest.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
import bridge, { disposeBridgeListeners } from '../tauri-bridge';
test('sshBridge invokes all eleven names and camelCase receipts without PTY writes', async () => {
  invokeMock.mockClear(); const receipt = { generation: 7, promptId: 'prompt-target' };
  await bridge.sshSessionOpen('tm-a', 'c-a'); await bridge.sshSessionState('tm-a'); await bridge.sshSessionClose('tm-a', 7); await bridge.sshSessionReconnect('tm-a');
  await bridge.sshSessionSubmitSecret('tm-a', 'sentinel', true, receipt); await bridge.sshSessionTrustHost('tm-a', true, receipt);
  await bridge.sshTestConnection('c-b'); await bridge.sshTestState('probe-a'); await bridge.sshTestClose('probe-a');
  await bridge.sshTestSubmitSecret('probe-a', 'sentinel', false, receipt); await bridge.sshTestTrustHost('probe-a', false, receipt);
  expect(invokeMock.mock.calls.map(c => c[0])).toEqual(['ssh_session_open', 'ssh_session_state', 'ssh_session_close', 'ssh_session_reconnect', 'ssh_session_submit_secret', 'ssh_session_trust_host', 'ssh_test_connection', 'ssh_test_state', 'ssh_test_close', 'ssh_test_submit_secret', 'ssh_test_trust_host']);
  expect(invokeMock).toHaveBeenCalledWith('ssh_session_submit_secret', { terminalId: 'tm-a', secret: 'sentinel', remember: true, generation: 7, promptId: 'prompt-target' });
  expect(invokeMock).toHaveBeenCalledWith('ssh_test_trust_host', { probeId: 'probe-a', accept: false, generation: 7, promptId: 'prompt-target' });
});
test('sshBridge listener unsubscription is owned and released once', async () => {
  unlistenMock.mockClear(); const callback = jest.fn(); const stop = await bridge.onSshSessionState(callback);
  expect(listenMock).toHaveBeenCalledWith('ssh-session:state', expect.any(Function));
  stop(); stop(); disposeBridgeListeners(); await Promise.resolve(); expect(unlistenMock).toHaveBeenCalledTimes(1);
});
