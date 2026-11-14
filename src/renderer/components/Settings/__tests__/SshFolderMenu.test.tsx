/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { SshMenus } from '../SshConnections/SshMenus';
import type { SshFolder, SshStoreApi, SshView } from '../../../types/ssh';
const selected: SshFolder = { id:'f-selected', parentId:null, name:'Selected', icon:'server', color:'sky', order:0 };
const clicked: SshFolder = { id:'f-clicked', parentId:null, name:'Clicked', icon:'database', color:'amber', order:1 };
const view: SshView = { revision:1, folders:[selected,clicked,{ ...selected, id:'f-child', parentId:'f-clicked', name:'Child' }], connections:[{ id:'c-child', folderId:'f-child', name:'Child host', host:'h', port:22, user:'', auth:'agent', identityFile:null, jumpConnectionId:null, extraOptions:[], bookmarked:false, order:0, lastUsedAt:null, hasSavedSecret:false }], loadError:null };
let root:Root; let host:HTMLDivElement; let api:SshStoreApi; let close:jest.Mock; let onConnection:jest.Mock; let onFolder:jest.Mock; let rename:jest.Mock;
function button(label:string) { const b = [...document.querySelectorAll<HTMLElement>('.context-menu-item, button')].find(b => (b.querySelector('.context-menu-label')?.textContent ?? b.textContent)?.trim() === label || b.getAttribute('aria-label') === label); if (!b) throw Error(`Missing ${label}`); return b; }
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); api = { upsertFolder:jest.fn().mockResolvedValue({ revision:2 }), deleteFolder:jest.fn().mockResolvedValue({ revision:2 }), setBookmark:jest.fn().mockResolvedValue({revision:2}), deleteConnection:jest.fn().mockResolvedValue({revision:2}) } as any; close = jest.fn(); onConnection = jest.fn(); onFolder = jest.fn(); rename = jest.fn(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
function mount(row:SshFolder | undefined = clicked, data = view) { act(() => root.render(<SshMenus target={{ x:12,y:14,row,kind:row ? 'folder' : undefined }} view={data} api={api} commit={async operation => { await operation(); }} onClose={close} onFolder={onFolder} onConnection={onConnection} onRename={rename} />)); }
test.each([['Icon flask','flask','amber'],['Color violet','database','violet']])('right-clicked folder, not selected folder: %s exact payload', async (label, icon, color) => {
  expect(selected.id).not.toBe(clicked.id); mount(); await act(async () => button('Folder icon').click()); await act(async () => button(label).click());
  expect(api.upsertFolder).toHaveBeenCalledWith({ id:'f-clicked', parentId:null, name:'Clicked', icon, color });
});
test('nonempty delete names exact descendant counts; confirm targets clicked id recursively', async () => {
  mount(); await act(async () => button('Delete folder…').click()); expect(document.body.textContent).toContain('Delete Clicked: 1 subfolders and 1 connections?');
  await act(async () => button('Delete').click()); expect(api.deleteFolder).toHaveBeenCalledWith({ id:'f-clicked', recursive:true });
});
test('cancel destructive confirmation makes no call', async () => { mount(); await act(async () => button('Delete folder…').click()); await act(async () => button('Cancel').click()); expect(api.deleteFolder).not.toHaveBeenCalled(); });
test('empty folder deletes without dialog', async () => { mount(clicked, { ...view, folders:[selected,clicked], connections:[] }); await act(async () => button('Delete folder…').click()); expect(api.deleteFolder).toHaveBeenCalledWith({ id:'f-clicked', recursive:false }); expect(document.querySelector('[role="dialog"]')).toBeNull(); });
test.each(['New folder','New SSH connection'])('empty-space %s targets root', async label => {
  act(() => root.render(<SshMenus target={{ x:0,y:0 }} view={view} api={api} commit={async operation => { await operation(); }} onClose={close} onFolder={onFolder} onConnection={onConnection} onRename={rename} />));
  await act(async () => button(label).click()); expect((label === 'New folder' ? onFolder : onConnection).mock.calls).toEqual([[null]]);
});
test.each(['Add subfolder','New SSH connection here','Rename'])('folder %s targets clicked row', async label => {
  mount(); await act(async () => button(label).click());
  if (label === 'Rename') expect(rename.mock.calls).toEqual([[clicked,'folder']]);
  else expect((label === 'Add subfolder' ? onFolder : onConnection).mock.calls).toEqual([['f-clicked']]);
});
test.each(['Bookmark','Unbookmark','Rename','Delete…'])('connection %s targets clicked connection', async label => {
  const row={...view.connections[0],bookmarked:label==='Unbookmark'};
  act(() => root.render(<SshMenus target={{x:0,y:0,row,kind:'connection'}} view={view} api={api} commit={async operation => { await operation(); }} onClose={close} onFolder={onFolder} onConnection={onConnection} onRename={rename} />));
  await act(async () => button(label).click());
  if(label==='Rename')expect(rename.mock.calls).toEqual([[row,'connection']]);
  else if(label==='Delete…'){await act(async()=>button('Delete').click());expect(api.deleteConnection).toHaveBeenCalledWith({id:'c-child'});}
  else expect(api.setBookmark).toHaveBeenCalledWith('c-child',label==='Bookmark');
});
