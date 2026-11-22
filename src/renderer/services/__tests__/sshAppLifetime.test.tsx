/** @jest-environment jsdom */
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import fs from 'fs';
import path from 'path';
import { hydrateSsh } from '../sshHydration';
const source = () => ts.createSourceFile('App.tsx',fs.readFileSync(path.resolve(__dirname,'../../App.tsx'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);

test('App has exactly one hydrateSsh call site across every effect and initializer',()=>{
  const calls:ts.CallExpression[]=[];
  const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&node.expression.getText()==='hydrateSsh')calls.push(node);ts.forEachChild(node,visit);};
  visit(source());expect(calls).toHaveLength(1);
});

// Execute the actual effect, its actual dependencies, and the COMPLETE initializer.
// The terminal/UI collaborators are stubs; no boot await is left permanently pending.
test('App lifetime completes boot after early unmount without starting or leaking SSH listeners',async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const app=source();let mount:ts.CallExpression|undefined;let init:ts.ArrowFunction|undefined;
  const visit=(node:ts.Node)=>{
    if(ts.isVariableDeclaration(node)&&node.name.getText(app)==='initializeApp')init=node.initializer as ts.ArrowFunction;
    if(ts.isCallExpression(node)&&node.expression.getText(app)==='useEffect'&&node.arguments[0]?.getText(app).includes('initializeApp('))mount=node;
    ts.forEachChild(node,visit);
  };visit(app);expect(mount).toBeDefined();expect(init).toBeDefined();
  const transpile=(node:ts.Node)=>ts.transpileModule(`const value = ${node.getText(app)};`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText+'return value;';
  const configs:((value:unknown)=>void)[]=[];
  const getConfig=jest.fn(()=>new Promise(resolve=>configs.push(resolve)));
  const unlisten=jest.fn();const onChanged=jest.fn().mockResolvedValue(unlisten);const get=jest.fn().mockResolvedValue({revision:0,view:{revision:0,folders:[],connections:[],loadError:null}});
  window.electronAPI={getConfig,ssh:{onChanged,get}} as any;
  const settled=jest.fn().mockResolvedValue(undefined);
  const deps:Record<string,any>={hydrateSsh,store:{dispatch:jest.fn(),getState:()=>({tabs:{tabs:[]}})},dispatch:jest.fn(),sshHydration:{current:null},StateManager:{saveState:jest.fn(),restoreState:jest.fn().mockResolvedValue(false)},saveStateWithCwds:jest.fn(),lastCwdRefreshAt:{current:0},listen:jest.fn().mockResolvedValue(jest.fn()),cleanupIPCListeners:jest.fn(),inputHandler:{destroy:jest.fn(),enable:jest.fn()},commandHistoryService:{hydrate:jest.fn()},loadConfigSettings:jest.fn().mockResolvedValue(undefined),initializeShellProfiles:jest.fn().mockResolvedValue(undefined),isDetachWindow:()=>false,setupIPCListeners:jest.fn(),resolvePostRestoreAction:()=> 'createDefaultTab',createDefaultTabIfNeeded:jest.fn(),openFolderTab:jest.fn(),paneIncarnations:{send:settled}};
  const initFn=new Function(...Object.keys(deps),transpile(init!))(...Object.values(deps));
  const boots:Promise<void>[]=[];
  const mountDeps={...deps,initializeApp:(...args:unknown[])=>{const promise=initFn(...args);boots.push(promise);return promise;}};
  const effect=new Function(...Object.keys(mountDeps),transpile(mount!.arguments[0]))(...Object.values(mountDeps));
  const effectDeps=mount!.arguments[1] ? new Function(transpile(mount!.arguments[1]))() : undefined;
  function Host(){useEffect(effect,effectDeps);return null;}
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  const added=jest.spyOn(window,'addEventListener');let mounted=true;
  try{
    await act(async()=>root.render(<Host/>));
    await act(async()=>root.render(<Host/>));
    await act(async()=>{root.unmount();mounted=false;});
    await act(async()=>{configs.forEach(resolve=>resolve({}));await Promise.all(boots);});
    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);expect(deps.createDefaultTabIfNeeded).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);expect(unlisten).toHaveBeenCalledTimes(1);
    expect(deps.sshHydration.current).toBeNull();
  }finally{
    if(mounted)await act(async()=>root.unmount());host.remove();
    for(const [event,listener] of added.mock.calls)if(event==='focus')window.removeEventListener(event,listener);
    added.mockRestore();
  }
});
