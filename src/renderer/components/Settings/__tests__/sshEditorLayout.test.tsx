/** @jest-environment jsdom */
// Pins the SSH connection editor layout (UI/UX F3-8, ALIGN-B-1/2/3): grouped rows, inline Browse,
// one action row with Save last (DOM order is Tab order), and the visible Authentication caption.
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { SshConnectionEditor } from '../SshConnections/SshConnectionEditor';
import type { SshConnection, SshStoreApi, SshView } from '../../../types/ssh';

const row: SshConnection = { id:'c-web', folderId:null, name:'web-01', host:'web.test', port:22, user:'deploy', auth:'keyFile', identityFile:'~/.ssh/id_ed25519', jumpConnectionId:null, extraOptions:[], bookmarked:true, order:0, lastUsedAt:null, hasSavedSecret:false };
const view: SshView = { revision:1, folders:[], connections:[row], loadError:null };
const api = { upsertConnection:jest.fn(), deleteConnection:jest.fn(), reload:jest.fn() } as unknown as SshStoreApi;
let root:Root; let host:HTMLDivElement;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = (id: string | null = 'c-web', onConnect: (() => void) | null = () => {}) => act(() => root.render(<SshConnectionEditor connectionId={id ?? undefined} initialFolder={null} view={view} api={api} onSaved={() => {}} onClose={() => {}} onConnect={onConnect ?? undefined} />));
const input = (name:string) => host.querySelector<HTMLElement>(`[name="${name}"]`)!;
const labels = (el:ParentNode) => [...el.querySelectorAll('button')].map(b => b.textContent);

describe('editor layout', () => {
  test('one action row; Test before Save and Save is the last, only primary action', () => {
    render();
    const actions = host.querySelectorAll('.ssh-editor-actions');
    expect(actions).toHaveLength(1);
    const names = labels(actions[0]);
    expect(names).toEqual(['Connect in new tab', 'Test connection', 'Delete connection…', 'Discard changes', 'Save connection']);
    expect(names[names.length - 1]).toBe('Save connection');
    expect(names.indexOf('Test connection')).toBeLessThan(names.indexOf('Save connection'));
    expect(actions[0].querySelectorAll('button.au-btn.primary')).toHaveLength(1);
    // Two groups as in the mockup: use actions, then the right-aligned edit group that ends with Save.
    const groups = [...actions[0].children];
    expect(groups.map(g => g.className)).toEqual(['ssh-actions-group', 'ssh-actions-group ssh-actions-end']);
    expect(labels(groups[0])).toEqual(['Connect in new tab', 'Test connection']);
    expect(labels(groups[1])).toEqual(['Delete connection…', 'Discard changes', 'Save connection']);
    expect((groups[1].lastElementChild as HTMLButtonElement).type).toBe('submit');
    // Delete is separated from Save by Discard.
    expect(names.indexOf('Save connection') - names.indexOf('Delete connection…')).toBe(2);
  });
  test('every action button follows the fields in DOM (Tab) order, Save last of all buttons in the form', () => {
    render();
    const all = [...host.querySelectorAll<HTMLElement>('form input, form select, form button')];
    const save = all.findIndex(el => el.textContent === 'Save connection');
    const test = all.findIndex(el => el.textContent === 'Test connection');
    expect(test).toBeGreaterThan(all.findIndex(el => el.getAttribute('name') === 'extraOptions'));
    expect(test).toBeLessThan(save);
    expect(save).toBe(all.length - 1);
  });
  test('new connection: no Delete or Connect, Save still last', () => {
    render(null, null);
    expect(labels(host.querySelector('.ssh-editor-actions')!)).toEqual(['Test connection', 'Discard changes', 'Save connection']);
  });
  test('Browse shares a row container with the Identity file input', () => {
    render();
    const rowEl = input('identityFile').parentElement!;
    expect(rowEl.classList.contains('ssh-inline-row')).toBe(true);
    const browse = [...rowEl.querySelectorAll('button')].find(b => b.textContent === 'Browse…')!;
    expect(browse).toBeTruthy();
    expect(browse.classList.contains('au-btn')).toBe(true);
    expect(host.querySelector<HTMLLabelElement>(`label[for="${input('identityFile').id}"]`)?.textContent).toBe('Identity file');
  });
  test('Name groups with Folder, and Host/Port/User share the next row', () => {
    render();
    const grid = host.querySelector('.ssh-editor-grid')!;
    const cell = (name:string) => input(name).closest('.ssh-editor-grid > *')!;
    const kids = [...grid.children];
    expect(kids.indexOf(cell('folderId'))).toBe(kids.indexOf(cell('name')) + 1);
    expect(kids.slice(kids.indexOf(cell('host')), kids.indexOf(cell('host')) + 3)).toEqual([cell('host'), cell('port'), cell('user')]);
    expect(kids.indexOf(cell('folderId'))).toBeLessThan(kids.indexOf(cell('jumpConnectionId')));
    expect(cell('name').classList.contains('ssh-span-2')).toBe(true);
    expect(cell('host').classList.contains('ssh-span-2')).toBe(true);
    expect(cell('port').classList.contains('ssh-span-2')).toBe(false);
  });
  test('visible Authentication caption sits above the segmented control', () => {
    render();
    const caption = host.querySelector('.ssh-caption')!;
    expect(caption.textContent).toBe('Authentication');
    expect(caption.nextElementSibling).toBe(host.querySelector('[role="group"][aria-label="Authentication"]'));
  });
  test('header shows the connection name; Bookmark stays the house checkbox', () => {
    render();
    expect(host.querySelector('h3')!.textContent).toBe('web-01');
    const box = input('bookmarked') as HTMLInputElement;
    expect(box.classList.contains('setting-checkbox')).toBe(true);
    expect(box.closest('.ssh-editor-header')).not.toBeNull();
  });
  test('all inputs and selects use the house setting-input class', () => {
    render();
    const fields = [...host.querySelectorAll<HTMLElement>('.ssh-editor-grid input, .ssh-editor-grid select')];
    expect(fields.length).toBeGreaterThanOrEqual(7);
    expect(fields.filter(f => !f.classList.contains('setting-input')).map(f => f.getAttribute('name'))).toEqual([]);
  });
});
