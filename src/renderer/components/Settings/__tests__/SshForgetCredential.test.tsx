/** @jest-environment jsdom */
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SshConnectionEditor } from '../SshConnections/SshConnectionEditor';
import type { SshConnection, SshStoreApi, SshView } from '../../../types/ssh';

const row:SshConnection = { id:'c-one', name:'One', host:'one', port:22, user:'', auth:'password', identityFile:null, jumpConnectionId:null, folderId:null, extraOptions:[], bookmarked:false, order:0, lastUsedAt:null, hasSavedSecret:true };
const button = (label:string, scope:ParentNode = document) => [...scope.querySelectorAll('button')].find(b => b.textContent === label)!;
const click = async (b:HTMLButtonElement) => { await act(async () => b.click()); };

function editor(connection = row, loadError:SshView['loadError'] = null) {
  const view:SshView = { revision:1, folders:[], connections:[connection], loadError };
  const forgetSecret = jest.fn().mockResolvedValue({ revision:2, view:{ ...view, revision:2, connections:[{ ...connection, hasSavedSecret:false }] } });
  const get = jest.fn();
  const api = { forgetSecret, get } as unknown as SshStoreApi;
  let update!: (next:SshView) => void;
  function Harness() {
    const [current, setCurrent] = useState(view);
    update = setCurrent;
    return <SshConnectionEditor connectionId={row.id} initialFolder={null} view={current} api={api} onSaved={reply => setCurrent(reply.view)} onClose={() => {}} />;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<Harness />));
  return { host, view, get, forgetSecret, update:(next:SshView) => act(() => update(next)), dispose:() => { act(() => root.unmount()); host.remove(); } };
}

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

test.each([{ ...row, hasSavedSecret:false }, { ...row, auth:'agent' as const }])('hides the action for an unsaved or agent credential', connection => {
  const ui = editor(connection);
  try { expect(button('Forget', ui.host)).toBeUndefined(); } finally { ui.dispose(); }
});

test('read-only store disables Forget', () => {
  const ui = editor({ ...row, auth:'keyFile', identityFile:'fixture' }, { code:'invalid-json', message:'invalid' });
  try { expect(button('Forget', ui.host).disabled).toBe(true); } finally { ui.dispose(); }
});

test('Cancel does not mutate; confirmation applies the view, announces success and restores focus', async () => {
  const ui = editor();
  try {
    const description = button('Forget', ui.host).getAttribute('aria-describedby');
    expect(document.getElementById(description!)?.textContent).toBe('Saved credential for the app channel');
    await click(button('Forget', ui.host));
    const dialog = () => document.querySelector('[role="dialog"]')!;
    expect(dialog().textContent).toContain("Forget the saved credential for One? You'll be asked for it next time.");
    await click(button('Cancel', dialog()));
    expect(ui.forgetSecret).not.toHaveBeenCalled();
    await click(button('Forget', ui.host));
    await click(button('Forget', dialog()));
    expect(ui.forgetSecret).toHaveBeenCalledTimes(1);
    expect(ui.forgetSecret).toHaveBeenCalledWith(row.id);
    expect(button('Forget', ui.host)).toBeUndefined();
    expect(ui.host.querySelector('[role="status"]')?.textContent).toBe('Saved credential forgotten.');
    expect(document.activeElement).toBe(button('Ask for password', ui.host));
  } finally { ui.dispose(); }
});

const dialog = () => document.querySelector('[role="dialog"]')!;
const confirm = async (host:HTMLElement) => {
  await click(button('Forget', host));
  await click(button('Forget', dialog()));
};

test('recoverable failure shows an error and returns focus to Forget', async () => {
  const ui = editor();
  try {
    ui.forgetSecret.mockRejectedValue({ code:'io', message:'Write failed' });
    await confirm(ui.host);
    expect(ui.host.querySelector('[role="alert"]')?.textContent).toContain('Write failed');
    expect(document.activeElement).toBe(button('Forget', ui.host));
  } finally { ui.dispose(); }
});

test('read-only failure refreshes and focuses the editor heading', async () => {
  const ui = editor();
  try {
    ui.forgetSecret.mockRejectedValue({ code:'store-read-only', message:'Store became read-only' });
    ui.get.mockResolvedValue({ revision:2, view:{ ...ui.view, connections:[], loadError:{ code:'invalid-json', message:'Corrupt' } } });
    await confirm(ui.host);
    expect(ui.get).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(ui.host.querySelector('h3'));
  } finally { ui.dispose(); }
});

test('read-only transition dismisses confirmation without reviving it on recovery', async () => {
  const ui = editor();
  try {
    await click(button('Forget', ui.host));
    expect(dialog()).not.toBeNull();
    ui.update({ ...ui.view, loadError:{ code:'invalid-json', message:'Corrupt' } });
    expect(dialog()).toBeNull();
    ui.update(ui.view);
    expect(dialog()).toBeNull();
    expect(ui.forgetSecret).not.toHaveBeenCalled();
  } finally { ui.dispose(); }
});

test('Forget keeps unsaved edits and does not re-announce after an external save and clear', async () => {
  const ui = editor();
  try {
    const input = ui.host.querySelector<HTMLInputElement>('[name="name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Unsaved name');
      input.dispatchEvent(new Event('input', { bubbles:true }));
    });
    expect(input.value).toBe('Unsaved name');
    await confirm(ui.host);
    expect(input.value).toBe('Unsaved name');
    const status = ui.host.querySelector('[role="status"]')!;
    expect(status.textContent).toBe('Saved credential forgotten.');
    ui.update(ui.view);
    ui.update({ ...ui.view, connections:[{ ...row, hasSavedSecret:false }] });
    expect(status.textContent).toBe('');
  } finally { ui.dispose(); }
});
