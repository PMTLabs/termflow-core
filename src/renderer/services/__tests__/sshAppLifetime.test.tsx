/** @jest-environment jsdom */
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import fs from 'fs';
import path from 'path';
import { hydrateSsh } from '../sshHydration';

// Execute App's actual mount-effect and initializeApp bodies in a mounted host.
// Stub unrelated boot services rather than mounting the full terminal/UI graph.
test('App unmount before getConfig resolves cannot start or leak an SSH listener',async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const source=ts.createSourceFile('App.tsx',fs.readFileSync(path.resolve(__dirname,'../../App.tsx'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let mount:ts.ArrowFunction|undefined; let init:ts.ArrowFunction|undefined;
  const visit=(node:ts.Node)=>{
    if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='initializeApp')init=node.initializer as ts.ArrowFunction;
    if(ts.isCallExpression(node)&&node.expression.getText(source)==='useEffect'&&node.arguments[0]?.getText(source).includes('initializeApp('))mount=node.arguments[0] as ts.ArrowFunction;
    ts.forEachChild(node,visit);
  };visit(source);expect(mount).toBeDefined();expect(init).toBeDefined();
  const transpile=(node:ts.Node)=>ts.transpileModule(`const value = ${node.getText(source)};`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText+'return value;';
  let resolveConfig!:(value:unknown)=>void;
  const getConfig=jest.fn(()=>new Promise(resolve=>{resolveConfig=resolve;}));
  const unlisten=jest.fn();const onChanged=jest.fn().mockResolvedValue(unlisten);const get=jest.fn().mockResolvedValue({revision:0,view:{revision:0,folders:[],connections:[],loadError:null}});
  window.electronAPI={getConfig,ssh:{onChanged,get}} as any;
  const deps:Record<string,unknown>={hydrateSsh,store:{dispatch:jest.fn()},sshHydration:{current:null},StateManager:{saveState:jest.fn()},saveStateWithCwds:jest.fn(),lastCwdRefreshAt:{current:0},listen:jest.fn().mockResolvedValue(jest.fn()),cleanupIPCListeners:jest.fn(),inputHandler:{destroy:jest.fn()},commandHistoryService:{hydrate:jest.fn()},loadConfigSettings:()=>new Promise(()=>{}),initializeShellProfiles:()=>new Promise(()=>{})};
  const initFn=new Function(...Object.keys(deps),transpile(init!))(...Object.values(deps));
  const mountDeps={...deps,initializeApp:initFn};
  const effect=new Function(...Object.keys(mountDeps),transpile(mount!))(...Object.values(mountDeps));
  function Host(){useEffect(effect,[]);return null;}
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  try{
    await act(async()=>root.render(<Host/>));expect(getConfig).toHaveBeenCalledTimes(1);
    await act(async()=>root.unmount());
    await act(async()=>{resolveConfig({});await Promise.resolve();await Promise.resolve();});
    expect(onChanged).toHaveBeenCalledTimes(1);expect(unlisten).toHaveBeenCalledTimes(1);
    expect((deps.sshHydration as {current:unknown}).current).toBeNull();
  }finally{host.remove();}
});
