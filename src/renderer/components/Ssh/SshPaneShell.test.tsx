/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { SshPaneShell } from './SshPaneShell';
import { SshSecretPrompt } from './SshSecretPrompt';
import { SshHostKeyPrompt } from './SshHostKeyPrompt';
import { SshDisconnectedBanner } from './SshDisconnectedBanner';
import { startSshProbe, SshTestConnectionDialog } from './SshTestConnectionDialog';
import type { SshAPI, SshSessionView } from '../../types/ssh';
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const view = (state: SshSessionView['state']): SshSessionView => ({ terminalId: 'tm-a', connectionId: 'c-a', state, generation: 1, revision: 1, gate: 'blocked', promptId: 'p-a', secretKind: 'password', promptTarget: { connectionId: 'jump', host: 'bastion.test', port: 2222, user: 'alice', hop: 'jump' }, hostKey: { algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:fixture', changed: false } });
let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

test('SshSecretPrompt secret_submit_sends_once_then_clears_without_redux_or_pty_write', async () => {
  let resolve: () => void = () => {}; const submit = jest.fn(() => new Promise<void>(r => { resolve = r; }));
  container.tabIndex = -1; container.focus();
  act(() => root.render(<SshSecretPrompt view={view('needs-secret')} onSubmit={submit} onCancel={jest.fn()} />));
  const input = container.querySelector('input[type=password]') as HTMLInputElement;
  expect(document.activeElement).toBe(input);
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sentinel-password'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  act(() => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(submit).toHaveBeenCalledTimes(1); expect(submit).toHaveBeenCalledWith('sentinel-password', false);
  await act(async () => { resolve(); await flush(); }); expect(input.value).toBe('');
  expect(container.textContent).toContain('Jump host: alice@bastion.test:2222');
});
test('SshHostKeyPrompt changed_key_has_no_trust; unknown host Cancel and Escape block', () => {
  const trust = jest.fn(async () => {}), cancel = jest.fn();
  act(() => root.render(<SshHostKeyPrompt view={{ ...view('error'), hostKey: { ...view('error').hostKey!, changed: true } }} onTrust={trust} onCancel={cancel} />));
  expect(container.textContent).not.toContain('Unknown'); expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Trust')).toBe(false);
  expect(container.querySelector('button')).toBeNull();
  container.tabIndex = -1; container.focus();
  act(() => root.render(<SshHostKeyPrompt view={view('needs-hostkey')} onTrust={trust} onCancel={cancel} />));
  expect(document.activeElement?.textContent).toBe('Cancel');
  act(() => container.querySelector('[role=region]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(cancel).toHaveBeenCalledTimes(1); expect(trust).not.toHaveBeenCalled();
});
test('SshPaneShell disconnected_never_renders_live_slots; terminal DOM identity survives', () => {
  const props = { terminal: <div className="terminal-pane-content" data-terminal="stable" />, browser: <button>Live file</button>, status: <span>Live metrics</span>, browserCollapsed: false, onBrowserCollapsedChange: jest.fn(), onSecret: jest.fn(async () => {}), onTrust: jest.fn(async () => {}), onCancel: jest.fn() };
  act(() => root.render(<SshPaneShell {...props} view={view('connected')} />)); const terminal = container.querySelector('[data-terminal]'); expect(container.textContent).toContain('Live file');
  act(() => root.render(<SshPaneShell {...props} view={view('disconnected')} />)); expect(container.querySelector('[data-terminal]')).toBe(terminal);
  expect(container.textContent).not.toContain('Live file'); expect(container.textContent).not.toContain('Live metrics'); expect(container.querySelector('.ssh-status')!.textContent).toBe('—');
});
test('inline prompts do not steal or restore sibling focus and refusals render once', () => {
  const sibling = document.createElement('button'); document.body.append(sibling); sibling.focus();
  const props = { terminal: <button>Terminal</button>, browserCollapsed: false, onBrowserCollapsedChange: jest.fn(), onSecret: jest.fn(async () => {}), onTrust: jest.fn(async () => {}), onCancel: jest.fn() };
  for (const state of ['needs-hostkey', 'needs-secret'] as const) {
    act(() => root.render(<SshPaneShell {...props} view={view(state)} />));
    expect(document.activeElement).toBe(sibling);
    expect(container.querySelector('[aria-modal]')).toBeNull();
    act(() => root.render(<SshPaneShell {...props} view={view('connecting')} />));
    expect(document.activeElement).toBe(sibling);
  }
  act(() => root.render(<SshPaneShell {...props} view={{ ...view('error'), reason: 'Refused', hostKey: { ...view('error').hostKey!, changed: true } }} />));
  expect(container.querySelectorAll('.ssh-prompt')).toHaveLength(1);
  expect(container.textContent!.split('SSH host key refused')).toHaveLength(2); // refusal renders once
  expect(container.textContent).not.toContain('SSH disconnected');
  expect(container.querySelector('[data-action=cancel]')).toBeNull();
  const warning = 'Connected; password was not saved (Remember unavailable).';
  act(() => root.render(<SshPaneShell {...props} view={{ ...view('connecting'), reason: warning }} />));
  expect(container.textContent).not.toContain(warning);
  act(() => root.render(<SshPaneShell {...props} view={{ ...view('connected'), reason: warning }} />));
  expect(container.textContent).toContain(warning);
  sibling.remove();
});

test('two-hop prompts retain pending focus, chain, and restore only inside their scope', async () => {
  let finish: () => void = () => {};
  const submit = () => new Promise<void>(resolve => { finish = resolve; });
  const render = (id?: string) => <div className="ssh-pane-shell"><button data-terminal>Terminal</button>{id && <SshSecretPrompt key={id} view={view('needs-secret')} onSubmit={submit} onCancel={jest.fn()} />}</div>;
  act(() => root.render(render()));
  const terminal = container.querySelector<HTMLButtonElement>('[data-terminal]')!;
  terminal.focus();
  act(() => root.render(render('jump')));
  const jump = container.querySelector<HTMLInputElement>('input[type=password]')!;
  expect(document.activeElement).toBe(jump);
  act(() => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(jump.readOnly).toBe(true); expect(document.activeElement).toBe(jump);
  await act(async () => { finish(); await flush(); });
  act(() => root.render(render('target')));
  expect(document.activeElement).toBe(container.querySelector('input[type=password]'));
  act(() => root.render(render()));
  expect(document.activeElement).toBe(terminal);
  const outside = document.createElement('button'); document.body.append(outside); outside.focus();
  act(() => root.render(render('unowned')));
  expect(document.activeElement).toBe(outside);
  container.querySelector<HTMLInputElement>('input[type=password]')!.focus();
  act(() => root.render(render()));
  expect(document.activeElement).not.toBe(outside);
  outside.remove();
});

test('SshDisconnectedBanner reconnect_waits and double clicks do not launch twice', async () => {
  let resolve: () => void = () => {}; const reconnect = jest.fn(() => new Promise<void>(r => { resolve = r; }));
  act(() => root.render(<SshDisconnectedBanner onReconnect={reconnect} />));
  act(() => { container.querySelector('button')!.click(); container.querySelector('button')!.click(); }); expect(reconnect).toHaveBeenCalledTimes(1); expect(container.querySelector('button')!.disabled).toBe(true);
  await act(async () => { resolve(); await flush(); }); expect(container.textContent).toContain('SSH disconnected');
});
test('SshTestConnectionDialog test_dialog_close_disposes_probe_even_during_auth', async () => {
  let listener: (v: SshSessionView) => void = () => {}; const unlisten = jest.fn(), close = jest.fn(async () => {});
  const api = { onSshTestState: async (cb: typeof listener) => { listener = cb; return unlisten; }, sshTestConnection: async () => ({ probeId: 'probe-a' }), sshTestState: async () => ({ ...view('needs-secret'), terminalId: undefined, probeId: 'probe-a' }), sshTestClose: close } as unknown as SshAPI;
  await act(async () => { root.render(<SshTestConnectionDialog connectionId="c-a" api={api} onClose={jest.fn()} />); await flush(); });
  expect(document.body.textContent).toContain('SSH password');
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.ssh-test-dialog button')];
  expect(buttons.some(b => b.textContent === 'Close')).toBe(false);
  const credential = document.querySelector<HTMLInputElement>('.ssh-test-dialog input[type=password]')!;
  const last = buttons[buttons.length - 1]; // house order: Cancel, then the primary action last
  expect(last.textContent).toBe('Continue');
  last.focus();
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  act(() => last.dispatchEvent(tab));
  expect(tab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(credential);
  act(() => root.unmount()); root = createRoot(container); expect(close).toHaveBeenCalledWith('probe-a'); await act(async () => { await flush(); }); expect(unlisten).toHaveBeenCalledTimes(1);
  listener({ ...view('connected'), probeId: 'probe-a' }); expect(document.body.textContent).not.toContain('File and metric capabilities');
});
test('SshTestConnectionDialog creation racing close still disposes the returned probe', async () => {
  let created: (v: { probeId: string }) => void = () => {}; const close = jest.fn(async () => {}), stop = jest.fn();
  const api = { onSshTestState: async () => stop, sshTestConnection: () => new Promise<{ probeId: string }>(r => { created = r; }), sshTestClose: close } as unknown as SshAPI;
  const dispose = startSshProbe(api, 'c-a', jest.fn(), jest.fn()); await flush(); dispose(); dispose(); created({ probeId: 'late-probe' }); await flush();
  expect(close).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledWith('late-probe'); expect(stop).toHaveBeenCalledTimes(1);
});
test('startSshProbe keeps the bridge listener until the backend close settles, on every dispose path', async () => {
  // Backlog 018: unlisten before ssh_test_close lets the close's final event hit a removed Tauri callback.
  const events: string[] = []; let settle: () => void = () => {};
  const close = jest.fn(() => { events.push('close-start'); return new Promise<void>(r => { settle = () => { events.push('close-done'); r(); }; }); });
  const stop = jest.fn(() => { events.push('unlisten'); });
  const settled = (probe: () => Promise<{ probeId: string }>) => ({ onSshTestState: async () => stop, sshTestConnection: probe,
    sshTestState: async () => ({ ...view('connected'), terminalId: undefined, probeId: 'probe-a' }), sshTestClose: close } as unknown as SshAPI);
  // Probe created, then disposed (Close button, Escape and host-key Cancel all call this disposer).
  const dispose = startSshProbe(settled(async () => ({ probeId: 'probe-a' })), 'c-a', jest.fn(), jest.fn()); await flush();
  dispose(); dispose(); await flush();
  expect(events).toEqual(['close-start']); expect(stop).not.toHaveBeenCalled();
  settle(); await flush(); expect(events).toEqual(['close-start', 'close-done', 'unlisten']); expect(close).toHaveBeenCalledTimes(1);
  // Disposed while creation is in flight: the returned probe is closed, then the listener goes.
  events.length = 0; let created: (v: { probeId: string }) => void = () => {};
  const racing = startSshProbe(settled(() => new Promise(r => { created = r; })), 'c-a', jest.fn(), jest.fn()); await flush();
  racing(); await flush(); expect(events).toEqual([]);
  created({ probeId: 'late' }); await flush(); expect(events).toEqual(['close-start']);
  settle(); await flush(); expect(events).toEqual(['close-start', 'close-done', 'unlisten']);
  // A rejected close still retires the listener, and creation failing after dispose leaves nothing behind.
  events.length = 0; close.mockImplementationOnce(async () => { events.push('close-start'); throw new Error('gone'); });
  const failing = startSshProbe(settled(async () => ({ probeId: 'probe-a' })), 'c-a', jest.fn(), jest.fn()); await flush();
  failing(); await flush(); expect(events).toEqual(['close-start', 'unlisten']);
  events.length = 0; let reject: (e: unknown) => void = () => {}; const failed = jest.fn();
  const refused = startSshProbe(settled(() => new Promise((_, r) => { reject = r; })), 'c-a', jest.fn(), failed); await flush();
  refused(); reject(new Error('refused')); await flush(); expect(events).toEqual(['unlisten']); expect(failed).not.toHaveBeenCalled();
});
test('SSH prompt and banner controls use the house button and checkbox classes', () => {
  const houseButtons = () => [...container.querySelectorAll('button')].map(b => [b.textContent, b.classList.contains('au-btn')]);
  act(() => root.render(<SshHostKeyPrompt view={view('needs-hostkey')} onTrust={jest.fn(async () => {})} onCancel={jest.fn()} />));
  expect(houseButtons()).toEqual([['Cancel', true], ['Trust', true]]);
  expect(container.querySelector('button:last-of-type')!.classList.contains('primary')).toBe(true);
  act(() => root.render(<SshSecretPrompt view={view('needs-secret')} onSubmit={jest.fn(async () => {})} onCancel={jest.fn()} />));
  expect(houseButtons()).toEqual([['Cancel', true], ['Continue', true]]);
  const box = container.querySelector('input[type=checkbox]')!;
  expect(box.classList.contains('setting-checkbox')).toBe(true);
  expect(box.closest('label')!.classList.contains('ssh-prompt-check')).toBe(true);
  act(() => root.render(<SshDisconnectedBanner reason="Connection ended." onReconnect={jest.fn(async () => {})} />));
  expect([...container.querySelectorAll('button')].every(b => b.classList.contains('au-btn'))).toBe(true);
});
test('Test dialog and prompt pick copy from errorCode, never from the reason text', async () => {
  // Backlog 017. Every reason here is text the renderer must not decode; only errorCode may pick the copy.
  const odd = 'Backend wording the renderer must not parse.';
  const dialogFor = async (snapshot: SshSessionView) => {
    const api = { onSshTestState: async () => () => {}, sshTestConnection: async () => ({ probeId: 'probe-a' }),
      sshTestState: async () => ({ ...snapshot, terminalId: undefined, probeId: 'probe-a' }), sshTestClose: async () => {} } as unknown as SshAPI;
    await act(async () => { root.render(<SshTestConnectionDialog connectionId="c-a" api={api} onClose={jest.fn()} />); await flush(); });
    const text = document.querySelector('.ssh-test-dialog')!.textContent!;
    act(() => root.unmount()); root = createRoot(container); return text;
  };
  const failed = (errorCode?: string): SshSessionView => ({ ...view('error'), hostKey: undefined, reason: odd, errorCode });
  expect(await dialogFor(failed('host-key-revoked'))).toContain("The host key has been revoked. Contact the server's administrator before trying again.");
  expect(await dialogFor(failed('cancelled'))).toContain('The SSH attempt was cancelled. Run Test connection again when ready.');
  // No prompt was seen in this probe, so the final auth copy is the generic one for the code.
  expect(await dialogFor(failed('auth-rejected'))).toContain("Authentication was not accepted. Check the server's allowed methods and the saved sign-in settings.");
  const fallback = await dialogFor(failed(undefined));
  expect(fallback).toContain('The SSH test could not finish.'); expect(fallback).not.toContain(odd);
  const connected = (errorCode?: string): SshSessionView => ({ ...view('connected'), reason: odd, errorCode });
  expect(await dialogFor(connected('remember-unavailable'))).toContain('The credential was not saved.');
  expect(await dialogFor(connected(undefined))).not.toContain('The credential was not saved.');
  const prompt = (errorCode?: string): SshSessionView => ({ ...view('needs-secret'), reason: odd, errorCode });
  expect(await dialogFor(prompt('saved-credential-unavailable'))).toContain(odd);
  // No secretKind: the dialog's own auth copy must reach the prompt, which only happens if the dialog
  // withholds errorCode (the prompt would otherwise substitute its password copy).
  const kindless = await dialogFor({ ...prompt('auth-rejected'), secretKind: undefined });
  expect(kindless).toContain("Authentication was not accepted. Check the server's allowed methods"); expect(kindless).not.toContain("That password wasn't accepted.");
  const rejected = await dialogFor(prompt('auth-rejected'));
  expect(rejected).toContain("That password wasn't accepted. Check it and try again."); expect(rejected).not.toContain(odd);
  // The pane prompt maps the same codes on its own.
  act(() => root.render(<SshSecretPrompt view={{ ...prompt('auth-rejected'), secretKind: 'passphrase' }} onSubmit={jest.fn(async () => {})} onCancel={jest.fn()} />));
  expect(container.textContent).toContain("That passphrase didn't unlock the key."); expect(container.querySelector('[role=status]')).toBeNull();
  act(() => root.render(<SshSecretPrompt view={prompt('saved-credential-unavailable')} onSubmit={jest.fn(async () => {})} onCancel={jest.fn()} />));
  expect(container.querySelector('[role=status]')?.textContent).toBe(odd);
  act(() => root.render(<SshSecretPrompt view={prompt(undefined)} onSubmit={jest.fn(async () => {})} onCancel={jest.fn()} />));
  expect(container.querySelector('[role=status]')).toBeNull(); expect(container.textContent).toContain(odd);
});
