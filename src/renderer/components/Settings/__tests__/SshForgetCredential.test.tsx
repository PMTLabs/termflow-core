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
  const api = { forgetSecret } as unknown as SshStoreApi;
  function Harness() {
    const [current, setCurrent] = useState(view);
    return <SshConnectionEditor connectionId={row.id} initialFolder={null} view={current} api={api} onSaved={reply => setCurrent(reply.view)} onClose={() => {}} />;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<Harness />));
  return { host, forgetSecret, dispose:() => { act(() => root.unmount()); host.remove(); } };
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
    expect(ui.host.textContent).toContain('Saved credential for the app channel');
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
