import React, { useEffect, useRef, useState } from 'react';
import type { SshConnection, SshConnectionInput, SshError, SshReply, SshStoreApi, SshView } from '../../../types/ssh';
import { registerSshEditorGuard } from '../../../services/sshEditorGuard';
import { parseArgs } from '../../../services/argParse';
import { buildSshArgv } from '../../../services/buildSshArgv';
import { ConfirmDialog } from '../../UI/ConfirmDialog';
function inputOf(c: SshConnection): SshConnectionInput { return { id:c.id, folderId:c.folderId, name:c.name, host:c.host, port:c.port, user:c.user, auth:c.auth, identityFile:c.identityFile, jumpConnectionId:c.jumpConnectionId, extraOptions:c.extraOptions, bookmarked:c.bookmarked }; }
// Quote a Key=Value token only when parseArgs needs it to stay one token (whitespace, quotes or empty);
// plain tokens stay unquoted so the field reads like what the user typed.
const quoteArg = (token:string) => token === '' || /[\s"]/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token;
export const optionsText = (input:Pick<SshConnectionInput,'extraOptions'>) => input.extraOptions.map(([k,v]) => quoteArg(`${k}=${v}`)).join(' ');
export function SshConnectionEditor({ connectionId, initialFolder, view, api, onSaved, onClose }: { connectionId?:string; initialFolder:string | null; view:SshView; api:SshStoreApi; onSaved(reply:SshReply, input:SshConnectionInput):void; onClose():void }) {
  const existing = view.connections.find(c => c.id === connectionId);
  const initial = ():SshConnectionInput => existing ? inputOf(existing) : { folderId:initialFolder, name:'', host:'', port:22, user:'', auth:'agent', identityFile:null, jumpConnectionId:null, extraOptions:[], bookmarked:false };
  const [draft, setDraft] = useState(initial); const [options, setOptions] = useState(() => optionsText(initial()));
  const baseline = useRef(JSON.stringify(initial())); const [baseOptions, setBaseOptions] = useState(options);
  const [error, setError] = useState<SshError | null>(null); const [busy, setBusy] = useState(false); const [changed, setChanged] = useState(false); const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = JSON.stringify(draft) !== baseline.current || options !== baseOptions;
  // An unreadable store (loadError) empties the view; that is not a deletion of this row.
  const removed = !!connectionId && !existing && !view.loadError;
  const reset = () => { const next = initial(); setDraft(next); baseline.current = JSON.stringify(next); const text = optionsText(next); setOptions(text); setBaseOptions(text); setError(null); setChanged(false); };
  useEffect(() => {
    if (view.loadError) return;
    if (!existing) { if (connectionId) setChanged(true); return; }
    const next = inputOf(existing);
    if (JSON.stringify(next) === baseline.current) setChanged(false);
    else if (dirty) setChanged(true); else reset();
  }, [existing, view.loadError]);
  const save = async ():Promise<boolean> => {
    if (busy || view.loadError || removed) return false;
    setBusy(true); setError(null);
    try {
      const extraOptions: [string,string][] = parseArgs(options).map(token => { const split = token.indexOf('='); if (split <= 0) throw { field:'extraOptions', code:'invalid-pair', message:'Use Key=Value pairs' }; return [token.slice(0,split),token.slice(split+1)]; });
      const input = { ...draft, name:draft.name.trim(), identityFile:draft.auth === 'keyFile' ? draft.identityFile : null, extraOptions };
      const reply = await api.upsertConnection(input); baseline.current = JSON.stringify(input); setDraft(input); setBaseOptions(options); setChanged(false); onSaved(reply,input); return true;
    } catch (failure) { const e = failure as SshError; setError({ field:e.field, code:e.code ?? 'save-failed', message:e.message ?? e.code ?? String(failure) }); return false; }
    finally { setBusy(false); }
  };
  const current = useRef({ dirty, save, reset }); current.current = { dirty, save, reset };
  useEffect(() => registerSshEditorGuard({ isDirty:() => current.current.dirty, save:() => current.current.save(), discard:() => current.current.reset() }), []);
  const field = (name: 'name' | 'host' | 'user' | 'identityFile', label:string) => <label>{label}<input name={name} value={draft[name] ?? ''} onChange={event => setDraft({ ...draft, [name]:event.target.value })} aria-invalid={error?.field === name} />{error?.field === name && <span role="alert" className="ssh-field-error">{error.message || error.code}</span>}</label>;
  let argv:string[] = []; try { const extraOptions = parseArgs(options).map(token => { const at = token.indexOf('='); return [token.slice(0,at), token.slice(at+1)] as [string,string]; }); const jump = view.connections.find(c => c.id === draft.jumpConnectionId); argv = buildSshArgv({ hops:jump ? [jump,draft] : [draft], extraOptions }); } catch {}
  return <div className="ssh-connection-editor"><h3>{connectionId ? 'Edit SSH connection' : 'New SSH connection'}</h3>
    {changed && !view.loadError && <div role="alert" className="ssh-conflict">{removed ? 'Deleted elsewhere' : 'Changed elsewhere'} — <button type="button" className="au-btn sm" onClick={() => removed ? onClose() : reset()}>Reload</button>{!removed && <button type="button" className="au-btn sm" onClick={() => { if (existing) baseline.current = JSON.stringify(inputOf(existing)); setChanged(false); }}>Keep mine</button>}</div>}
    <fieldset disabled={busy || !!view.loadError || removed}>
      {field('name','Name')}{field('host','Host')}
      <label>Port<input name="port" type="number" min={1} max={65535} value={draft.port} onChange={event => setDraft({ ...draft, port:Number(event.target.value) })} />{error?.field === 'port' && <span role="alert">{error.message}</span>}</label>
      {field('user','User')}
      <div role="group" aria-label="Authentication" className="au-seg ssh-auth">{(['keyFile','agent','password'] as const).map(auth => <button type="button" key={auth} className={draft.auth === auth ? 'on' : undefined} aria-pressed={draft.auth === auth} onClick={() => setDraft({ ...draft, auth, identityFile:auth === 'keyFile' ? draft.identityFile ?? '' : null })}>{auth === 'keyFile' ? 'Key file' : auth === 'agent' ? 'SSH agent' : 'Ask for password'}</button>)}</div>
      {draft.auth === 'keyFile' && <>{field('identityFile','Identity file')}<button type="button" className="au-btn sm ssh-browse" onClick={async () => { try { const path = await window.electronAPI?.pickFile?.('Select SSH identity file'); if (path) setDraft(value => ({ ...value, identityFile:path })); } catch (e) { setError({ code:'picker', message:String(e) }); } }}>Browse…</button></>}
      <label>Jump host<select name="jumpConnectionId" value={draft.jumpConnectionId ?? ''} onChange={event => setDraft({ ...draft, jumpConnectionId:event.target.value || null })}><option value="">None</option>{view.connections.filter(c => c.id !== connectionId && !c.jumpConnectionId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Folder<select name="folderId" value={draft.folderId ?? ''} onChange={event => setDraft({ ...draft, folderId:event.target.value || null })}><option value="">Top level</option>{view.folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
      <label className="ssh-check"><input name="bookmarked" type="checkbox" className="setting-checkbox" checked={draft.bookmarked} onChange={event => setDraft({ ...draft, bookmarked:event.target.checked })} />Bookmark</label>
      <label>Extra options<input name="extraOptions" value={options} onChange={event => setOptions(event.target.value)} /><small>Applies to the terminal ssh only</small>{error?.field === 'extraOptions' && <span role="alert">{error.message}</span>}</label>
      <div className="ssh-argv" aria-label="Arguments"><strong>Arguments</strong>{argv.map((arg,index) => <code key={index}>{arg}</code>)}</div>
      {error && !['name','host','port','user','identityFile','extraOptions'].includes(error.field ?? '') && <p role="alert">{error.message}</p>}
      <div className="ssh-editor-actions"><button type="button" className="au-btn primary" onClick={() => void save()}>Save connection</button><button type="button" className="au-btn" onClick={() => { reset(); onClose(); }}>Discard changes</button>{connectionId && <button type="button" className="au-btn danger" onClick={() => setConfirmDelete(true)}>Delete connection…</button>}</div>
    </fieldset>
    <ConfirmDialog isOpen={confirmDelete} title="Delete connection" message={`Delete ${draft.name}?`} destructive confirmText="Delete" onCancel={() => setConfirmDelete(false)} onConfirm={async () => { try { const reply = await api.deleteConnection({ id:connectionId! }); onSaved(reply,draft); onClose(); } catch (e) { setError(e as SshError); } setConfirmDelete(false); }} />
  </div>;
}
