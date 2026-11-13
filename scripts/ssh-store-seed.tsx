// Dev-only, in-memory 500-row seed/timing fixture. Never writes a user's store.
// Run: bun scripts/ssh-store-seed.tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import reducer, { applyView, selectTree } from '../src/renderer/store/slices/sshSlice';
import { SshTree } from '../src/renderer/components/Settings/SshConnections/SshTree';
import type { SshView } from '../src/renderer/types/ssh';
if (process.env.NODE_ENV === 'production') throw Error('Development fixture only');
const view:SshView = { revision:1,loadError:null,
  folders:Array.from({ length:20 }, (_,i) => ({ id:`f-${i}`,parentId:null,name:`Group ${i}`,icon:'server',color:'sky',order:i })),
  connections:Array.from({ length:500 }, (_,i) => ({ id:`c-${i}`,folderId:`f-${Math.floor(i/25)}`,name:`web-${i}`,host:`host-${i}.test`,port:22,user:'deploy',auth:'agent' as const,identityFile:null,jumpConnectionId:null,extraOptions:[],bookmarked:i%7===0,order:i%25,lastUsedAt:null,hasSavedSecret:false })),
};
const start = performance.now(); const ssh = reducer(undefined,applyView({ revision:1,view })); const tree = selectTree({ ssh }); const selected = performance.now();
const html = renderToStaticMarkup(<SshTree tree={tree} view={view} filter="" onSelect={() => {}} onBookmark={() => {}} onMove={() => {}} />);
console.log(JSON.stringify({ connections:500,folders:20,selectMs:selected-start,ssrMs:performance.now()-selected,htmlBytes:html.length }));
