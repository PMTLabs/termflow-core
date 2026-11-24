/** @jest-environment jsdom */
import React, { act } from 'react';
import path from 'path';
import { readSource } from '../../utils/readSource';
import { createRoot } from 'react-dom/client';
import { SshLaunchNotice } from './SshLaunchNotice';
import type { LaunchSnapshot, SshSessionView } from '../../types/ssh';

const base: LaunchSnapshot = {
  terminalId: 'tm-a', connectionId: 'c-a', launchSeq: 4, revision: 7, stage: 'waiting-trust',
  attempt: { sessionGeneration: 3, attemptReceipt: { generation: 3, gate: 'blocked' },
    processIncarnation: 'pc-a', ownerIncarnation: { pg: 2, seq: 3 } },
};
let el: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => { el = document.createElement('div'); document.body.append(el); root = createRoot(el); });
afterEach(() => { act(() => root.unmount()); el.remove(); });
const props = () => ({ onCancel: jest.fn(), onReconnect: jest.fn(), onTrust: jest.fn(async () => {}), onSecret: jest.fn(async () => {}) });
const button = (name: string) => [...el.querySelectorAll('button')].find(b => b.textContent === name);

function expectFixedStrip() {
  const notice = el.querySelector('.ssh-launch-notice')!;
  // 070's Canvas surface matches the notice root by this class and attribute.
  expect(notice.parentElement).toBe(el);
  expect(notice.hasAttribute('data-ssh-keyboard-owner')).toBe(true);
  const overlay = notice.querySelector('.ssh-launch-overlay');
  expect([...notice.children].filter(child => child !== overlay).map(child => child.className)).toEqual(['ssh-launch-strip']);
  const status = notice.querySelector('.ssh-launch-strip [role=status]');
  expect(status?.getAttribute('title')).toBe(status?.textContent);
  return overlay;
}

test('keeps the strip before a snapshot exists', () => {
  act(() => root.render(<SshLaunchNotice {...props()} />));
  expectFixedStrip();
});

function cssRules(file: string) {
  const css = readSource(path.join(__dirname, file)).replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
}

const declarations = (rules: ReturnType<typeof cssRules>, selector: string) => rules
  .filter(([, name]) => name.split(',').some(part => part.trim() === selector))
  .map(([, , body]) => body).join('\n');
const values = (body: string, property: string) => body.split(';').flatMap(declaration => {
  const colon = declaration.indexOf(':');
  return colon >= 0 && declaration.slice(0, colon).trim() === property
    ? [declaration.slice(colon + 1).trim()] : [];
});

test('CSS reserves only the fixed one-line strip outside Canvas', () => {
  const rules = cssRules('SshLaunchNotice.css');
  const rule = (selector: string) => declarations(rules, selector);
  const strip = rule('.ssh-launch-strip');
  expect(strip).toMatch(/\bheight:\s*\d+px;/);
  expect(values(strip, 'height')).toEqual(['36px']);
  expect(values(strip, 'min-height')).toEqual([]);
  expect(values(strip, 'box-sizing')).toEqual(['border-box']);
  expect(rule('.ssh-launch-strip > [role="status"]')).toMatch(/white-space:\s*nowrap;/);
  expect(values(rule('.ssh-launch-strip > [role="status"]'), 'white-space')).toEqual(['nowrap']);
  expect(values(strip, 'white-space').every(value => value === 'nowrap')).toBe(true);
  expect(values(rule('.ssh-launch-notice'), 'flex')).toEqual(['none']);
  expect(values(rule('.ssh-launch-overlay:empty'), 'display')).toEqual(['none']);
  expect(rule('.ssh-launch-overlay')).toMatch(/position:\s*absolute;/);
  expect(rules.filter(([, name, body]) => name.trim().endsWith('.ssh-launch-notice') && /position:\s*absolute;/.test(body))
    .map(([, name]) => name.trim())).toEqual(['.canvas-surface > .ssh-launch-notice']);
});

test('SSH prompts paint above pane chrome and below the solo header', () => {
  const indices = (file: string, selector: string) => values(declarations(cssRules(file), selector), 'z-index').map(Number);
  const overlay = indices('SshLaunchNotice.css', '.ssh-launch-overlay');
  expect(overlay).toHaveLength(1);
  for (const [file, selector] of [
    ['SshPaneShell.css', '.ssh-pane-chrome'],
    ['../Terminal/AgentChip.css', '.agent-chip'],
    ['../Terminal/ScrollToBottomButton.css', '.scroll-to-bottom-button'],
    ['../Terminal/RemoteSuggestChip.css', '.remote-suggest-chip'],
  ]) {
    const chrome = indices(file, selector);
    expect(chrome.length).toBeGreaterThan(0);
    expect(overlay[0]).toBeGreaterThan(Math.max(...chrome));
  }
  expect(overlay[0]).toBeLessThan(8);
});

test.each([
  ['preparing', 'Preparing SSH…', 'Cancel'],
  ['waiting-ready', 'Waiting for the local shell prompt…', 'Cancel'],
  ['waiting-trust', 'Waiting for host verification…', 'Cancel'],
  ['typed', 'SSH command queued for the terminal.', undefined],
  ['ended', 'SSH has ended.', 'Reconnect'],
  ['blocked', 'SSH launch blocked.', 'Retry'],
  ['error', 'SSH launch failed.', 'Retry'],
  ['cancelled', 'SSH launch cancelled.', 'Retry'],
] as const)('stage %s has truthful copy and the matching control', (stage, text, action) => {
  act(() => root.render(<SshLaunchNotice {...props()} snapshot={{ ...base, stage }} />));
  expect(el.querySelector('[role=status]')?.textContent).toBe(text);
  expectFixedStrip();
  expect([...el.querySelectorAll('button')].map(b => b.textContent)).toEqual(action ? [action] : []);
});

test('timeout guidance and backend reason are shown without test-connection wording', () => {
  const callbacks = props();
  act(() => root.render(<SshLaunchNotice {...callbacks} snapshot={{ ...base, stage: 'error', error: { code: 'Timeout', message: 'Exact backend reason.' } }} />));
  expect(el.querySelector('[role=alert]')?.textContent).toBe('Exact backend reason.');
  expect(el.textContent).toContain('Return to the local shell prompt');
  expect(expectFixedStrip()?.querySelector('[role=status]')?.textContent).toBe('Return to the local shell prompt');
  expect(el.textContent).not.toMatch(/test connection/i);
  act(() => button('Retry')!.click());
  expect(callbacks.onReconnect).toHaveBeenCalledTimes(1);
});

test('Cancel forwards the current attempt after adoption, not the prior owner', () => {
  const callbacks = props();
  act(() => root.render(<SshLaunchNotice {...callbacks} snapshot={base} />));
  const adopted = { ...base, attempt: { ...base.attempt, ownerIncarnation: { pg: 4, seq: 1 } } };
  act(() => root.render(<SshLaunchNotice {...callbacks} snapshot={adopted} />));
  act(() => button('Cancel')!.click());
  expect(callbacks.onCancel.mock.calls).toEqual([[adopted.attempt]]);
});

test('Escape on an unchanged prompt id uses the latest qualified cancel receipt', () => {
  const callbacks = props();
  const view: SshSessionView = {
    terminalId: base.terminalId, connectionId: base.connectionId, state: 'needs-secret', generation: 3,
    gate: 'blocked', promptId: 'same-prompt',
  };
  act(() => root.render(<SshLaunchNotice {...callbacks} snapshot={base} view={view} />));
  const ref = { ...base.attempt, attemptReceipt: { ...base.attempt.attemptReceipt, reason: 'Current receipt' } };
  act(() => root.render(<SshLaunchNotice {...callbacks} snapshot={{ ...base, attempt: ref }} view={view} />));
  act(() => el.querySelector('.ssh-prompt')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(callbacks.onCancel.mock.calls).toEqual([[ref]]);
});

test('jump trust and target secret preserve their exact prompt receipts without reusing the jump id', async () => {
  const callbacks = props();
  const jump: SshSessionView = {
    terminalId: 'tm-a', connectionId: 'c-a', gate: 'blocked', state: 'needs-hostkey', generation: 3, promptId: 'jump-trust',
    promptTarget: { connectionId: 'jump', hop: 'jump', user: 'alice', host: 'jump.test', port: 22 },
    hostKey: { changed: false, algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:fake' },
  };
  act(() => root.render(<SshLaunchNotice {...callbacks} snapshot={base} view={jump} />));
  expect(el.textContent).toContain('Jump host: alice@jump.test:22');
  expect(expectFixedStrip()?.querySelector('.ssh-prompt')?.textContent).toContain('Jump host: alice@jump.test:22');
  await act(async () => button('Trust')!.click());
  const target: SshSessionView = {
    ...jump, state: 'needs-secret', promptId: 'target-secret',
    promptTarget: { connectionId: 'c-a', hop: 'target', user: 'bob', host: 'target.test', port: 2222 },
  };
  act(() => root.render(<SshLaunchNotice {...callbacks} snapshot={base} view={target} />));
  expect(el.textContent).toContain('Target: bob@target.test:2222');
  expect(expectFixedStrip()?.querySelector('.ssh-prompt')?.textContent).toContain('Target: bob@target.test:2222');
  expect(button('Trust')).toBeUndefined();
  await act(async () => button('Continue')!.click());
  expect(callbacks.onTrust.mock.calls).toEqual([[{ generation: 3, promptId: 'jump-trust' }]]);
  expect(callbacks.onSecret.mock.calls).toEqual([['', false, { generation: 3, promptId: 'target-secret' }]]);
  act(() => root.render(<SshLaunchNotice {...callbacks} snapshot={base} view={{ ...target, generation: 2 }} />));
  expect(button('Continue')).toBeUndefined();
});

test.each([
  ['the same launch code as the shown launch error is not repeated',
    { stage: 'error' as const, error: { code: 'Timeout' as const, message: 'Backend timeout copy.' } }, undefined,
    { code: 'Timeout', message: 'Reconnect timeout copy.' }, ['Backend timeout copy.']],
  ['a different launch code is shown as its own alert',
    { stage: 'error' as const, error: { code: 'Timeout' as const, message: 'Backend timeout copy.' } }, undefined,
    { code: 'WriteFailed', message: 'Write failed copy.' }, ['Backend timeout copy.', 'Write failed copy.']],
  ['the same session code as the receipt reason is not repeated',
    { stage: 'blocked' as const }, { reason: 'Host key changed.', errorCode: 'host-key-changed' },
    { code: 'host-key-changed', message: 'Host key changed (again).' }, ['Host key changed.']],
  ['a failure next to a reason without a code is shown',
    { stage: 'blocked' as const }, { reason: 'Free-text reason.' },
    { code: 'LaunchFailed', message: 'Launch failed copy.' }, ['Free-text reason.', 'Launch failed copy.']],
  ['a failure with no shown reason is shown',
    { stage: 'error' as const }, undefined,
    { code: 'Timeout', message: 'Only failure.' }, ['Only failure.']],
])('failure alert dedupes by error code: %s', (_name, patch, receipt, failure, alerts) => {
  const snapshot: LaunchSnapshot = { ...base, ...patch,
    attempt: { ...base.attempt, attemptReceipt: { ...base.attempt.attemptReceipt, ...receipt } } };
  act(() => root.render(<SshLaunchNotice {...props()} snapshot={snapshot} failure={failure} />));
  expect([...el.querySelectorAll('[role=alert]')].map(a => a.textContent)).toEqual(alerts);
  expect([...expectFixedStrip()!.querySelectorAll('[role=alert]')].map(a => a.textContent)).toEqual(alerts);
});

test.each([
  [{ code: 'TransportClosed', message: 'The terminal writer is unavailable.' }, 'The local terminal connection closed. Reconnect to try again.'],
  [{ code: 'SshExitedBeforeConnecting', message: 'other details' }, 'SSH exited before connecting. Check the terminal output above for the reason.'],
  [undefined, 'The reason, if any, is in the terminal output above. Reconnect to try again.'],
] as const)('an ended launch renders its reason by code (%o)', (error, reason) => {
  act(() => root.render(<SshLaunchNotice {...props()} snapshot={{ ...base, stage: 'ended', ...(error ? { error } : {}) }} />));
  expect(el.querySelector('[role=status]')?.textContent).toBe('SSH has ended.');
  expect([...el.querySelectorAll('[role=alert]')].map(a => a.textContent)).toEqual([reason]);
  expect(button('Reconnect')).toBeTruthy();
});

test('a Connect refused for a missing Windows OpenSSH Client shows how to install it', () => {
  const message = 'Windows OpenSSH Client is not installed. Turn it on in Settings > System > Optional features > OpenSSH Client, then try again.';
  act(() => root.render(<SshLaunchNotice {...props()} snapshot={{ ...base, stage: 'error', error: { code: 'SshClientMissing', message } }} />));
  expect([...el.querySelectorAll('[role=alert]')].map(a => a.textContent)).toEqual([message]);
});


test.each([
  ['needs-hostkey', 'Trust'],
  ['needs-secret', 'Continue'],
] as const)('running SSH keeps the %s prompt', (state, action) => {
  const view: SshSessionView = {
    terminalId: base.terminalId, connectionId: base.connectionId, gate: 'blocked', state,
    generation: base.attempt.sessionGeneration, promptId: 'running-prompt',
    ...(state === 'needs-hostkey' ? {
      hostKey: { changed: false, algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:fake' },
    } : {}),
  };
  act(() => root.render(<SshLaunchNotice {...props()} snapshot={{ ...base, stage: 'running' }} view={view} />));
  expectFixedStrip();
  expect(button(action)).toBeDefined();
});

test.each(['snapshot error', 'failure prop'] as const)('running SSH keeps the %s message', source => {
  const message = 'SSH launch failed while running.';
  act(() => root.render(<SshLaunchNotice {...props()} snapshot={{
    ...base, stage: 'running',
    ...(source === 'snapshot error' ? { error: { code: 'SshClientMissing', message } } : {}),
  }} failure={source === 'failure prop' ? { code: 'SshClientMissing', message } : undefined} />));
  expect(expectFixedStrip()?.textContent).toContain(message);
});

test.each(['connected', 'disconnected'] as const)('running SSH with a %s session', state => {
  act(() => root.render(<SshLaunchNotice {...props()} snapshot={{ ...base, stage: 'running' }}
    view={{ terminalId: base.terminalId, connectionId: base.connectionId, state, generation: 3, gate: 'blocked', promptId: 'none' }} />));
  if (state === 'connected') expect(el.querySelector('.ssh-launch-strip')).toBeNull();
  else { expectFixedStrip(); expect(button('Reconnect')).toBeTruthy(); }
});
