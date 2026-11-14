/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import sshReducer, { applyView, selectTree } from '../../../store/slices/sshSlice';
import { SshTree } from '../SshConnections/SshTree';
import { SshMenus } from '../SshConnections/SshMenus';
import { SshConnectionsPanel } from '../SshConnections/SshConnectionsPanel';
import { SshFolderDialog } from '../SshConnections/SshFolderDialog';
import { SshConnectionEditor } from '../SshConnections/SshConnectionEditor';
import { saveSshEditorDraft } from '../../../services/sshEditorGuard';
import type { SshView, SshStoreApi } from '../../../types/ssh';
import fs from 'fs';
import path from 'path';
const view:SshView={revision:1,loadError:null,folders:[{id:'f-a',parentId:null,name:'A',icon:'folder',color:'grey',order:0},{id:'f-b',parentId:null,name:'B',icon:'server',color:'sky',order:1},{id:'f-child',parentId:'f-a',name:'Child',icon:'cloud',color:'green',order:0}],connections:[{id:'c-one',folderId:null,name:'One',host:'host',port:22,user:'',auth:'agent',identityFile:null,jumpConnectionId:null,extraOptions:[],bookmarked:false,order:2,lastUsedAt:null,hasSavedSecret:false}]};
let root:Root;let host:HTMLDivElement;let move:jest.Mock;
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;localStorage.clear();host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);move=jest.fn();});
afterEach(()=>{act(()=>root.unmount());host.remove();});
const tree=(v=view)=>selectTree({ssh:sshReducer(undefined,applyView({revision:v.revision,view:v}))});
const row=(id:string)=>host.querySelector<HTMLElement>(`[data-row-id="${id}"] > .ssh-tree-row`)!;
const render=()=>act(()=>root.render(<SshTree tree={tree()} view={view} filter="" onSelect={()=>{}} onMove={move} onBookmark={()=>{}}/>));
function dragEvent(element:HTMLElement,type:string,drag?:object,y=50){const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperties(event,{dataTransfer:{value:{setData:jest.fn(),getData:()=>type==='dragover'?'':JSON.stringify(drag)}},clientY:{value:y}});act(()=>element.dispatchEvent(event));return event;}
const start=(id:string)=>dragEvent(row(id),'dragstart');
const geometry=(id:string)=>jest.spyOn(row(id),'getBoundingClientRect').mockReturnValue({top:0,height:100} as DOMRect);
test.each([['f-a','f-a'],['f-a','f-child'],['c-one','c-one']])('drag %s onto %s offers no indicator and makes no move', (from,to)=>{render();start(from);const over=dragEvent(row(to),'dragover');expect(over.defaultPrevented).toBe(false);expect(host.querySelector('.ssh-drop')).toBeNull();dragEvent(row(to),'drop');expect(move).not.toHaveBeenCalled();});
test('folder centre zone nests the row in the final child list',()=>{render();start('f-a');geometry('f-b');const over=dragEvent(row('f-b'),'dragover',undefined,50);expect(over.defaultPrevented).toBe(true);expect(row('f-b').dataset.dropZone).toBe('inside');dragEvent(row('f-b'),'drop',undefined,50);const children:string[]=[];for(const [input] of move.mock.calls){const without=children.filter(id=>id!==input.id);without.splice(input.index,0,input.id);children.splice(0,children.length,...without);}expect(children).toEqual(['f-a']);expect(host.querySelector('.ssh-drop')).toBeNull();});
test('drag cache is cleared on dragend, even though dragover cannot read dataTransfer',()=>{render();start('c-one');expect(dragEvent(row('f-b'),'dragover').defaultPrevented).toBe(true);dragEvent(row('c-one'),'dragend');expect(host.querySelector('.ssh-drop')).toBeNull();expect(dragEvent(row('f-b'),'dragover').defaultPrevented).toBe(false);});
test('read-only mutation entry-point census: no API calls, no dialogs, no offered drop',async()=>{
  const readOnly={...view,loadError:{code:'bad',message:'corrupt'}};
  const mutations={upsertFolder:jest.fn(),deleteFolder:jest.fn(),upsertConnection:jest.fn(),deleteConnection:jest.fn(),move:jest.fn(),setBookmark:jest.fn()};
  const api={...mutations,get:jest.fn(),reload:jest.fn()} as unknown as SshStoreApi;
  window.electronAPI={ssh:api} as any;
  const store=configureStore({reducer:{ssh:sshReducer}});store.dispatch(applyView({revision:1,view:readOnly}));
  const open=jest.fn();const commit=jest.fn(async(operation:()=>Promise<any>)=>operation());
  act(()=>root.render(<Provider store={store}>
    <SshConnectionsPanel/>
    <SshTree tree={tree(readOnly)} view={readOnly} filter="" onSelect={()=>{}} onMove={api.move} onBookmark={api.setBookmark} onRename={open} onDelete={open} onMenu={open}/>
    {[{},{row:view.folders[0],kind:'folder' as const},{row:view.connections[0],kind:'connection' as const}].map((target,i)=><SshMenus key={i} target={{x:0,y:0,...target}} view={readOnly} api={api} commit={commit} onClose={()=>{}} onFolder={open} onConnection={open} onRename={open}/>)}
    <SshFolderDialog input={{parentId:null,name:'New',icon:'folder',color:'grey'}} readOnly onClose={()=>{}} onSave={async input=>{await api.upsertFolder(input);return true;}}/>
    <SshConnectionEditor connectionId="c-one" initialFolder={null} view={readOnly} api={api} onSaved={()=>{}} onClose={()=>{}}/>
  </Provider>));
  // Toolbar, all three context-menu branches (including icon flyout), editor Save/Delete.
  for(const button of [...document.querySelectorAll<HTMLElement>('.ssh-toolbar button,.context-menu-item,.ssh-connection-editor button')])await act(async()=>button.click());
  for(const id of ['f-a','c-one']){
    for(const key of ['F2','Delete'])act(()=>row(id).dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true})));
    act(()=>row(id).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})));
    expect(row(id).draggable).toBe(false);start(id);expect(dragEvent(row('f-b'),'dragover').defaultPrevented).toBe(false);dragEvent(row('f-b'),'drop',{kind:id.startsWith('f')?'folder':'connection',id});
  }
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Bookmark One"]')!.click());
  const treeElement=host.querySelector<HTMLElement>('[role="tree"]')!;
  act(()=>treeElement.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})));
  dragEvent(treeElement,'dragover');dragEvent(treeElement,'drop',{kind:'connection',id:'c-one'});
  await act(async()=>{expect(await saveSshEditorDraft()).toBe(false);});
  expect(open).not.toHaveBeenCalled();expect(commit).not.toHaveBeenCalled();
  for(const mutation of Object.values(mutations))expect(mutation).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();expect(host.querySelector('.ssh-drop')).toBeNull();
});
test('a folder dialog or context menu already open closes when the panel becomes read-only',async()=>{
  window.electronAPI={ssh:{} as SshStoreApi} as any;const store=configureStore({reducer:{ssh:sshReducer}});store.dispatch(applyView({revision:1,view}));
  act(()=>root.render(<Provider store={store}><SshConnectionsPanel/></Provider>));
  await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='New folder')!.click());expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  act(()=>store.dispatch(applyView({revision:2,view:{...view,revision:2,loadError:{code:'bad',message:'corrupt'}}})));expect(document.querySelector('[role="dialog"]')).toBeNull();
});
test('editor destructive dialog is suppressed immediately when the store becomes read-only',async()=>{
  const api={deleteConnection:jest.fn()} as unknown as SshStoreApi;
  const editor=(data:SshView)=>act(()=>root.render(<SshConnectionEditor connectionId="c-one" initialFolder={null} view={data} api={api} onSaved={()=>{}} onClose={()=>{}}/>));
  editor(view);await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Delete connection…')!.click());expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  editor({...view,revision:2,loadError:{code:'bad',message:'corrupt'}});expect(document.querySelector('[role="dialog"]')).toBeNull();expect(api.deleteConnection).not.toHaveBeenCalled();
});
test('folder modal is a body portal using the real house header/body/footer and button structure',()=>{
  act(()=>root.render(<SshFolderDialog input={{parentId:null,name:'',icon:'folder',color:'grey'}} onSave={async()=>true} onClose={()=>{}}/>));
  const overlay=document.querySelector('.confirm-dialog-overlay')!;expect(overlay.parentElement).toBe(document.body);expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(overlay.querySelector('.confirm-dialog-header h3')!.textContent).toBe('New folder');expect(overlay.querySelector('.confirm-dialog-body input')).not.toBeNull();
  expect([...overlay.querySelectorAll('.confirm-dialog-footer button')].map(b=>b.className)).toEqual(['confirm-btn cancel','confirm-btn primary']);
});
test('SSH responsive layout uses its own inline-size container, never viewport or light-theme rules',()=>{
  const css=fs.readFileSync(path.resolve(__dirname,'../SshConnections/SshConnections.css'),'utf8');
  expect(css).toMatch(/\.ssh-connections\s*\{[^}]*container-type:\s*inline-size/);expect(css).toMatch(/@container sshpanel\s*\(max-width:760px\)/);expect(css).not.toMatch(/@media|\.light-theme/);
});
