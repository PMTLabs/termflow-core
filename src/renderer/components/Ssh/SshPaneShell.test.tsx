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
  const innerCancel = buttons.find(b => b.textContent === 'Cancel')!, outerClose = buttons.find(b => b.textContent === 'Close')!;
  innerCancel.focus();
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  act(() => innerCancel.dispatchEvent(tab));
  expect(tab.defaultPrevented).toBe(false); // Browser default may advance to outer Close.
  outerClose.focus(); expect(document.activeElement).toBe(outerClose);
  act(() => root.unmount()); root = createRoot(container); expect(close).toHaveBeenCalledWith('probe-a'); expect(unlisten).toHaveBeenCalledTimes(1);
  listener({ ...view('connected'), probeId: 'probe-a' }); expect(document.body.textContent).not.toContain('File and metric capabilities');
});
test('SshTestConnectionDialog creation racing close still disposes the returned probe', async () => {
  let created: (v: { probeId: string }) => void = () => {}; const close = jest.fn(async () => {}), stop = jest.fn();
  const api = { onSshTestState: async () => stop, sshTestConnection: () => new Promise<{ probeId: string }>(r => { created = r; }), sshTestClose: close } as unknown as SshAPI;
  const dispose = startSshProbe(api, 'c-a', jest.fn(), jest.fn()); await flush(); dispose(); dispose(); created({ probeId: 'late-probe' }); await flush();
  expect(close).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledWith('late-probe'); expect(stop).toHaveBeenCalledTimes(1);
});
