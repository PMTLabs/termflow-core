/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { SshTree } from '../SshConnections/SshTree';
import reducer, { applyView, selectTree } from '../../../store/slices/sshSlice';
import type { SshView } from '../../../types/ssh';
const view: SshView = { revision:1, loadError:null, folders:[{ id:'f-root', parentId:null, name:'Root', icon:'flask', color:'violet', order:0 }, { id:'f-child', parentId:'f-root', name:'Child', icon:'server', color:'sky', order:0 }], connections:[
  { id:'c-name', folderId:null, name:'Needle', host:'one', user:'alpha', port:22, auth:'agent', identityFile:null, jumpConnectionId:null, extraOptions:[], bookmarked:false, order:1, lastUsedAt:null, hasSavedSecret:false },
  { id:'c-host', folderId:'f-root', name:'Second', host:'needle', user:'beta', port:22, auth:'agent', identityFile:null, jumpConnectionId:null, extraOptions:[], bookmarked:false, order:1, lastUsedAt:null, hasSavedSecret:false },
  { id:'c-user', folderId:'f-child', name:'Third', host:'three', user:'needle', port:22, auth:'agent', identityFile:null, jumpConnectionId:null, extraOptions:[], bookmarked:false, order:0, lastUsedAt:null, hasSavedSecret:false },
] };
let root: Root; let container: HTMLDivElement; let move: jest.Mock; let bookmark: jest.Mock;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); move = jest.fn(); bookmark = jest.fn(); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
function render(filter = '', data = view) { act(() => root.render(<SshTree tree={selectTree({ ssh:reducer(undefined, applyView({ revision:data.revision, view:data })) })} view={data} filter={filter} onSelect={() => {}} onMove={move} onBookmark={bookmark} />)); }
function row(id: string) { return container.querySelector<HTMLElement>(`[data-row-id="${id}"] > .ssh-tree-row`)!; }
function drop(id: string, drag: object) { const event = new Event('drop', { bubbles:true, cancelable:true }); Object.defineProperty(event, 'dataTransfer', { value:{ getData:() => JSON.stringify(drag) } }); act(() => row(id).dispatchEvent(event)); }
test('renders each folder icon and colour', () => { render(); expect(row('f-root').querySelector('[data-icon="flask"] svg')).not.toBeNull(); expect(row('f-root').querySelector('[data-icon="flask"]')?.className).toContain('ssh-color-violet'); expect(row('f-child').querySelector('[data-icon="server"]')?.className).toContain('ssh-color-sky'); });
test.each([['Needle','c-name','one','alpha'],['Second','c-host','needle','beta'],['Third','c-user','three','needle']])('filter independently matches %s by name, host or user', (_name, id, _host, _user) => {
  const target = view.connections.find(c => c.id === id)!;
  const field = id === 'c-name' ? 'name' : id === 'c-host' ? 'host' : 'user';
  const data = { ...view, connections:view.connections.map(c => ({ ...c, name:'no-name', host:'no-host', user:'no-user', ...(c.id === id ? { [field]:target[field] } : {}) })) };
  render('needle', data); expect([...container.querySelectorAll('[data-row-id^="c-"]')].map(n => n.getAttribute('data-row-id'))).toEqual([id]);
});
test('filter expansion drives children, aria-expanded and glyph together', () => {
  localStorage.setItem('ssh-collapsed',JSON.stringify(['f-root','f-child'])); render('needle');
  expect(container.querySelector('[data-row-id="f-root"]')!.getAttribute('aria-expanded')).toBe('true');
  expect(row('f-root').querySelector('button')!.getAttribute('aria-expanded')).toBe('true');
  expect(row('f-root').querySelector('button')!.textContent).toBe('▾');
  expect(row('c-user')).not.toBeNull();
});
test('star uses that exact connection id', () => { render(); act(() => row('c-name').querySelector('button')!.click()); expect(bookmark.mock.calls).toEqual([['c-name',true]]); });
test('drop uses exact kind, dragged id, target and index', () => { render(); drop('f-child', { kind:'connection', id:'c-name' }); expect(move.mock.calls).toEqual([[{ kind:'connection', id:'c-name', parentId:'f-child', index:1 }]]); });
test('same-parent reorder sends destination index and refusal leaves order intact', () => { render('', { ...view, connections:[...view.connections, { ...view.connections[1], id:'c-sibling', order:2 }] }); const before = [...container.querySelectorAll('[data-row-id]')].map(n => n.getAttribute('data-row-id')); move.mockImplementation(() => {}); drop('c-host', { kind:'connection', id:'c-sibling' }); expect(move.mock.calls).toEqual([[{ kind:'connection', id:'c-sibling', parentId:'f-root', index:1 }]]); expect([...container.querySelectorAll('[data-row-id]')].map(n => n.getAttribute('data-row-id'))).toEqual(before); });
test('folder onto its own child is refused before adapter', () => { render(); drop('f-child', { kind:'folder', id:'f-root' }); expect(move).not.toHaveBeenCalled(); });
