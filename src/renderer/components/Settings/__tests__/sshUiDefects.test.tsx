/** @jest-environment jsdom */
// Regression oracles for defects found by rendering the SSH Connections panel in a live dev build
// (065 T8 screen check): quoted extra options, detached Bookmark checkbox, native unstyled buttons,
// a corrupt store that looked like data loss, and a conflict banner that outlived its cause.
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { SshConnectionEditor, optionsText } from '../SshConnections/SshConnectionEditor';
import { SshConnectionsPanel } from '../SshConnections/SshConnectionsPanel';
import sshReducer, { applyView } from '../../../store/slices/sshSlice';
import { parseArgs } from '../../../services/argParse';
import type { SshConnection, SshStoreApi, SshView } from '../../../types/ssh';

const row: SshConnection = { id:'c-web', folderId:null, name:'web-01', host:'web.test', port:22, user:'deploy', auth:'agent', identityFile:null, jumpConnectionId:null, extraOptions:[['ServerAliveInterval','30']], bookmarked:true, order:0, lastUsedAt:null, hasSavedSecret:false };
const other: SshConnection = { ...row, id:'c-db', name:'db-01', host:'db.test', bookmarked:false, extraOptions:[] };
const good = (revision:number, connections:SshConnection[] = [row, other]): SshView => ({ revision, folders:[], connections, loadError:null });
const corrupt = (revision:number): SshView => ({ revision, folders:[], connections:[], loadError:{ code:'invalid-json', message:'C:/x/ssh_connections.json: Invalid SSH store JSON or UTF-8' } });

let root:Root; let host:HTMLDivElement;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const text = () => host.textContent ?? '';
const api = { upsertConnection:jest.fn(), deleteConnection:jest.fn(), reload:jest.fn() } as unknown as SshStoreApi;
const editor = (view:SshView, id = 'c-web') => act(() => root.render(<SshConnectionEditor connectionId={id} initialFolder={null} view={view} api={api} onSaved={() => {}} onClose={() => {}} />));
async function type(name:string, value:string) { const field = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value); field.dispatchEvent(new Event('input',{ bubbles:true })); }); }

describe('extra options text', () => {
  test('plain Key=Value tokens are shown unquoted; tokens that need quoting are quoted', () => {
    expect(optionsText({ extraOptions:[['ServerAliveInterval','30'],['Compression','yes']] })).toBe('ServerAliveInterval=30 Compression=yes');
    expect(optionsText({ extraOptions:[['SendEnv','LANG LC_*']] })).toBe('"SendEnv=LANG LC_*"');
    expect(optionsText({ extraOptions:[['SetEnv','A="b c"']] })).toBe('"SetEnv=A=\\"b c\\""');
  });
  test.each([
    [[['ServerAliveInterval','30']]],
    [[['SendEnv','LANG LC_*'],['ConnectTimeout','5']]],
    [[['SetEnv','A="b c"']]],
    [[['SetEnv','TAB=\there']]],
    [[['SetEnv','DIR=C:\\foo\\']]],
    [[['SetEnv','DIR=C:\\a b\\']]],
    [[['SetEnv','A=\\"embedded\\"']]],
    [[['SetEnv','']]],
    [[['SetEnv','""']]],
    [[['LocalForward','8080 localhost:80'],['Compression','yes']]],
  ] as [string,string][][][])('round-trips through parseArgs without loss: %j', pairs => {
    expect(parseArgs(optionsText({ extraOptions:pairs })).map(token => { const at = token.indexOf('='); return [token.slice(0,at), token.slice(at+1)]; })).toEqual(pairs);
  });
  test('the editor field shows the stored option exactly as the user would type it', () => {
    editor(good(1));
    expect(host.querySelector<HTMLInputElement>('input[name="extraOptions"]')!.value).toBe('ServerAliveInterval=30');
  });
});

describe('editor controls use house styles', () => {
  test('Bookmark checkbox sits in its own row label with the house checkbox class', () => {
    editor(good(1));
    const box = host.querySelector<HTMLInputElement>('input[name="bookmarked"]')!;
    const label = box.closest('label')!;
    expect(label.classList.contains('ssh-check')).toBe(true);
    expect(box.classList.contains('setting-checkbox')).toBe(true);
    expect(label.textContent).toBe('Bookmark');
    expect(label.firstElementChild).toBe(box);
  });
  test('every editor button carries a house button style (no native buttons)', () => {
    editor(good(1));
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThanOrEqual(6);
    const bare = buttons.filter(b => !b.classList.contains('au-btn') && !b.closest('.au-seg')).map(b => b.textContent);
    expect(bare).toEqual([]);
    const seg = host.querySelector('[role="group"][aria-label="Authentication"]')!;
    expect(seg.classList.contains('au-seg')).toBe(true);
    expect([...seg.querySelectorAll('button.on')].map(b => b.textContent)).toEqual(['SSH agent']);
    expect([...host.querySelectorAll('button.au-btn.primary')].map(b => b.textContent)).toEqual(['Save connection']);
    expect([...host.querySelectorAll('button.au-btn.danger')].map(b => b.textContent)).toEqual(['Delete connection…']);
  });
});

describe('conflict banner', () => {
  test('a clean editor silently follows an external change (no banner) and shows the new value', () => {
    editor(good(1));
    editor(good(2, [{ ...row, host:'web2.test' }, other]));
    expect(text()).not.toContain('Changed elsewhere');
    expect(host.querySelector<HTMLInputElement>('input[name="host"]')!.value).toBe('web2.test');
  });
  test('positive control: a dirty editor still gets the Changed elsewhere banner', async () => {
    editor(good(1));
    await type('name','my edit');
    editor(good(2, [{ ...row, host:'web2.test' }, other]));
    expect(text()).toContain('Changed elsewhere');
    expect(host.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe('my edit');
  });
  test('an unreadable store is not reported as a deletion, and recovery leaves no stale banner', () => {
    editor(good(1));
    editor(corrupt(2));
    expect(text()).not.toContain('Deleted elsewhere');
    expect(text()).not.toContain('Changed elsewhere');
    expect(host.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe('web-01');
    editor(good(3));
    expect(text()).not.toContain('elsewhere');
    expect(host.querySelector('fieldset')!.disabled).toBe(false);
  });
  test('render guard alone hides a pre-existing dirty conflict during corruption and recovers correctly', async () => {
    editor(good(1)); await type('name','local');
    editor(good(2,[{...row,host:'external'},other])); expect(text()).toContain('Changed elsewhere');
    editor(corrupt(3)); expect(text()).not.toContain('elsewhere');
    editor(good(4,[{...row,host:'external'},other])); expect(text()).toContain('Changed elsewhere');
    editor(corrupt(5)); editor(good(6)); expect(text()).not.toContain('elsewhere');
    expect(host.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe('local');
  });
  test('positive control: a genuinely deleted row still says Deleted elsewhere', () => {
    editor(good(1));
    editor(good(2, [other]));
    expect(text()).toContain('Deleted elsewhere');
  });
});

describe('panel with an unreadable store', () => {
  function panel() {
    window.electronAPI = { ssh:api } as any;
    const store = configureStore({ reducer:{ ssh:sshReducer } });
    store.dispatch(applyView({ revision:1, view:good(1) }));
    act(() => root.render(<Provider store={store}><SshConnectionsPanel /></Provider>));
    return store;
  }
  test('never looks like "no connections": shows a nothing-deleted note, keeps the editor, and no conflict banner', async () => {
    const store = panel();
    await act(async () => host.querySelector<HTMLElement>('[data-row-id="c-web"] > .ssh-tree-row')!.click());
    expect(host.querySelector('input[name="name"]')).not.toBeNull();
    act(() => { store.dispatch(applyView({ revision:2, view:corrupt(2) })); });
    expect(text()).not.toContain('No saved connections yet.');
    expect(text()).not.toContain('Deleted elsewhere');
    expect(text()).toContain('Nothing has been deleted');
    expect(host.querySelector('.ssh-read-only')).not.toBeNull();
    expect(host.querySelector('footer')).toBeNull();
    act(() => { store.dispatch(applyView({ revision:3, view:good(3) })); });
    expect(text()).not.toContain('Nothing has been deleted');
    expect(host.querySelectorAll('[data-row-id]').length).toBe(2);
    expect(text()).not.toContain('elsewhere');
  });
  test('positive control: a genuinely empty readable store shows the empty state', () => {
    const store = panel();
    act(() => { store.dispatch(applyView({ revision:2, view:good(2, []) })); });
    expect(text()).toContain('No saved connections yet.');
    expect(text()).not.toContain('Nothing has been deleted');
  });
  test('toolbar and read-only Reload buttons use house button styles', () => {
    const store = panel();
    act(() => { store.dispatch(applyView({ revision:2, view:corrupt(2) })); });
    const toolbar = [...host.querySelectorAll('.ssh-toolbar button, .ssh-read-only button')];
    expect(toolbar.map(b => b.textContent)).toEqual(['Reload','New folder','New SSH connection']);
    expect(toolbar.every(b => b.classList.contains('au-btn'))).toBe(true);
  });
});
