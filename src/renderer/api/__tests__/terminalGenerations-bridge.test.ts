/**
 * @jest-environment jsdom
 *
 * `generation` on a terminal's info, end to end across the bridges: the backend writes it in two
 * places (the API's terminal JSON and the `get_terminal_generations` command), and each bridge
 * reads one of them. A field dropped at any link leaves the tab strip with nothing to mark and no
 * error to say why.
 */
import path from 'path';
import { readSource } from '../../utils/readSource';

const invokeMock = jest.fn((_cmd: string, _args?: unknown) => Promise.resolve({}));
jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: [string, unknown?]) => invokeMock(...args),
}));
jest.mock('@tauri-apps/api/event', () => ({
  listen: jest.fn(() => Promise.resolve(() => {})),
}));
jest.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: jest.fn(() => ({ label: 'main' })),
}));
Object.defineProperty(global, 'localStorage', {
  value: { getItem: jest.fn(() => null), setItem: jest.fn() },
  writable: true,
});

import tauriBridge from '../tauri-bridge';
import browserBridge from '../browser-bridge';
import { TERMINAL_GENERATIONS } from '../../services/hostGeneration';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const rust = (...parts: string[]) => readSource(path.resolve(ROOT, 'src-tauri', 'src', ...parts));

describe('tauri bridge', () => {
  it('asks the backend for the generations and hands the map back untouched', async () => {
    invokeMock.mockResolvedValueOnce({ 'tm-a': 'previous', 'tm-b': 'current' });
    await expect(tauriBridge.getTerminalGenerations()).resolves.toEqual({ 'tm-a': 'previous', 'tm-b': 'current' });
    expect(invokeMock).toHaveBeenCalledWith('get_terminal_generations');
  });
});

describe('browser bridge', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  const answer = (body: unknown, ok = true) => {
    global.fetch = jest.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;
  };

  it('reads each pane terminal\'s generation off the terminal list by its leaf id', async () => {
    answer({
      terminals: [
        { id: 'pc-1', terminalId: 'tm-a', generation: 'previous' },
        { id: 'pc-2', terminalId: 'tm-b', generation: 'current' },
        // No pane: nothing to mark. A word the backend does not send is not read as either.
        { id: 'pc-3', terminalId: null, generation: 'previous' },
        { id: 'pc-4', terminalId: 'tm-d', generation: 'older' },
        { id: 'pc-5', terminalId: 'tm-e' },
      ],
    });
    await expect(browserBridge.getTerminalGenerations()).resolves.toEqual({ 'tm-a': 'previous', 'tm-b': 'current' });
  });

  it('fails rather than answering with no generations when the list cannot be read', async () => {
    answer({}, false);
    await expect(browserBridge.getTerminalGenerations()).rejects.toThrow('Failed to fetch terminals');
  });
});

describe('the backend side of the same contract', () => {
  it('writes the generation into the terminal JSON under the key the browser bridge reads', () => {
    const api = rust('api_server', 'terminals', 'mod.rs');
    expect(api).toContain('"generation": generation.as_str(),');
    expect(api).toMatch(/pub\(crate\) fn terminal_identity_json\([^)]*generation: crate::state::Marker/);
  });

  it('serialises the marker as the two words the renderer matches', () => {
    const marker = rust('state', 'host_generation.rs');
    const enumBody = marker.slice(marker.indexOf('pub enum Marker'));
    expect(marker).toContain('#[serde(rename_all = "lowercase")]');
    expect(enumBody.slice(0, enumBody.indexOf('}'))).toMatch(/Current,\s*Previous,/);
  });

  it('carries the same key on the fleet list, which the MCP list tool proxies', () => {
    expect(rust('api_server', 'fleet.rs')).toContain('"generation": generation.as_str(),');
  });

  it('publishes a host connection under the event name the renderer also re-reads on', () => {
    expect(rust('state', 'host_port.rs')).toContain('emit("pty-host:connected", ())');
  });

  it('registers the command the tauri bridge invokes', () => {
    expect(rust('lib.rs')).toContain('commands::get_terminal_generations,');
    expect(rust('commands', 'terminal.rs')).toContain('pub fn get_terminal_generations(');
  });

  it('announces changes under the event name the renderer listens for', () => {
    expect(rust('state', 'host_generation.rs')).toContain(`pub const TERMINAL_GENERATIONS_EVENT: &str = "${TERMINAL_GENERATIONS}";`);
  });

  it('announces when a host terminal is registered and when one is forgotten', () => {
    const notifyRegistered = 'state.notify_terminal_generations();';
    const register = rust('commands', 'terminal.rs');
    const registerBody = register.slice(register.indexOf('fn register_host_terminal('));
    const registerFn = registerBody.slice(0, registerBody.indexOf('\n}\n'));
    // After the terminal is observable, or a reader asked in between sees nothing of it.
    expect(registerFn).toContain(notifyRegistered);
    expect(registerFn.indexOf('state.host_terminals.insert(')).toBeGreaterThan(-1);
    expect(registerFn.indexOf('state.terminals.insert(')).toBeGreaterThan(registerFn.indexOf('state.host_terminals.insert('));
    expect(registerFn.indexOf(notifyRegistered)).toBeGreaterThan(registerFn.indexOf('state.terminals.insert('));

    const notifyForgotten = 'self.notify_terminal_generations();';
    const terminals = rust('state', 'terminals.rs');
    const forget = terminals.slice(terminals.indexOf('pub fn forget_host_terminal('));
    const forgetFn = forget.slice(0, forget.indexOf('\n    }\n'));
    // After the channel is gone, or the announcement is answered with the terminal still there.
    expect(forgetFn).toContain(notifyForgotten);
    expect(forgetFn.indexOf('self.host_terminals.remove(')).toBeGreaterThan(-1);
    expect(forgetFn.indexOf(notifyForgotten)).toBeGreaterThan(forgetFn.indexOf('self.host_terminals.remove('));
  });
});
