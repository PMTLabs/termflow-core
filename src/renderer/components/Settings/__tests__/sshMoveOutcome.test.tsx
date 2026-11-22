/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import fs from 'fs';
import path from 'path';
import { sshMoveIndex, SshDropTarget } from '../../../services/sshMoveIndex';
import { SshTree } from '../SshConnections/SshTree';
import reducer, { applyView, selectTree } from '../../../store/slices/sshSlice';
import type { SshMove, SshView } from '../../../types/ssh';
type Row={id:string;kind:'folder'|'connection';parentId:string|null};
type Case={name:string;from:string;target:SshDropTarget;expected:Record<string,string[]>;noOp:boolean};
const table=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/sshMoveCases.json'),'utf8')) as {start:Row[];cases:Case[]};
function initial():SshView {
  const view:SshView={revision:1,folders:[],connections:[],loadError:null};const counts:Record<string,number>={};
  for(const row of table.start){const key=row.parentId??'root';const order=counts[key]??0;counts[key]=order+1;
    if(row.kind==='folder')view.folders.push({id:row.id,parentId:row.parentId,name:row.id,order,icon:'folder',color:'grey'});
    else view.connections.push({id:row.id,folderId:row.parentId,name:row.id,order,host:'h',user:'',port:22,auth:'agent',identityFile:null,jumpConnectionId:null,extraOptions:[],bookmarked:false,lastUsedAt:null,hasSavedSecret:false});
  }return view;
}
// Same remove-then-insert operation pinned by Rust's shared-fixture test.
function applyMove(view:SshView,move:SshMove):SshView {
  const rows=[...view.folders.map(row=>({id:row.id,parentId:row.parentId,order:row.order})),...view.connections.map(row=>({id:row.id,parentId:row.folderId,order:row.order}))];
  const moved=rows.find(row=>row.id===move.id)!;moved.parentId=move.parentId;
  const siblings=rows.filter(row=>row.parentId===move.parentId&&row.id!==move.id).sort((a,b)=>a.order-b.order);
  siblings.splice(Math.min(move.index,siblings.length),0,moved);siblings.forEach((row,index)=>{row.order=index;});
  return {...view,folders:view.folders.map(row=>{const next=rows.find(r=>r.id===row.id)!;return {...row,parentId:next.parentId,order:next.order};}),connections:view.connections.map(row=>{const next=rows.find(r=>r.id===row.id)!;return {...row,folderId:next.parentId,order:next.order};})};
}
function order(view:SshView){const rows=[...view.folders.map(f=>({id:f.id,parentId:f.parentId,order:f.order})),...view.connections.map(c=>({id:c.id,parentId:c.folderId,order:c.order}))];return Object.fromEntries([null,'f-parent'].map(parent=>[parent??'root',rows.filter(r=>r.parentId===parent).sort((a,b)=>a.order-b.order).map(r=>r.id)]));}
test.each(table.cases)('ssh move final-order helper outcome: $name',testCase=>{
  let view=initial();const source=table.start.find(r=>r.id===testCase.from)!;const api=jest.fn((move:SshMove)=>{view=applyMove(view,move);});
  const move=sshMoveIndex(view,{id:source.id,kind:source.kind},testCase.target);if(move)api(move);
  expect(order(view)).toEqual(testCase.expected);expect(api).toHaveBeenCalledTimes(testCase.noOp?0:1);
});
test.each(table.cases)('ssh tree final-order drop outcome: $name',testCase=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;localStorage.clear();let view=initial();
  const api=jest.fn((move:SshMove)=>{view=applyMove(view,move);});const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  try {
    act(()=>root.render(<SshTree tree={selectTree({ssh:reducer(undefined,applyView({revision:1,view}))})} view={view} filter="" onMove={api} onSelect={()=>{}} onBookmark={()=>{}}/>));
    const row=(id:string)=>host.querySelector<HTMLElement>(`[data-row-id="${id}"] > .ssh-tree-row`)!;
    const event=(element:HTMLElement,type:string,y=50)=>{const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperties(event,{clientY:{value:y},dataTransfer:{value:{setData:jest.fn(),getData:()=>''}}});act(()=>element.dispatchEvent(event));};
    event(row(testCase.from),'dragstart');
    const target=testCase.target.zone==='root'?host.querySelector<HTMLElement>('[role="tree"]')!:row(testCase.target.id);
    jest.spyOn(target,'getBoundingClientRect').mockReturnValue({top:0,height:100} as DOMRect);
    event(target,'drop',testCase.target.zone==='before'?10:testCase.target.zone==='after'?90:50);
    expect(order(view)).toEqual(testCase.expected);expect(api).toHaveBeenCalledTimes(testCase.noOp?0:1);
  }finally{act(()=>root.unmount());host.remove();}
});
