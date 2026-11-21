import React, { useEffect, useId, useRef, useState } from 'react';
import type { SshConnection, SshConnectionInput, SshError, SshReply, SshStoreApi, SshView } from '../../../types/ssh';
import { registerSshEditorGuard } from '../../../services/sshEditorGuard';
import { parseArgs } from '../../../services/argParse';
import { buildSshArgv } from '../../../services/buildSshArgv';
import { ConfirmDialog } from '../../UI/ConfirmDialog';
import { SshTestConnectionDialog } from '../../Ssh/SshTestConnectionDialog';
import { isAllowedSshOption, refreshReadOnly, sshErrorMessage, sshFieldMessage } from './sshErrors';
function inputOf(c: SshConnection): SshConnectionInput { return { id:c.id, folderId:c.folderId, name:c.name, host:c.host, port:c.port, user:c.user, auth:c.auth, identityFile:c.identityFile, jumpConnectionId:c.jumpConnectionId, extraOptions:c.extraOptions, bookmarked:c.bookmarked }; }
// Quote a Key=Value token only when parseArgs needs it to stay one token (whitespace, quotes or empty);
// plain tokens stay unquoted so the field reads like what the user typed.
const quoteArg = (token:string) => {
  if (token !== '' && !/[\s"]/.test(token)) return token;
  // parseArgs only escapes backslash-quote; a trailing backslash must stay outside grouping quotes.
  const trailing = token.match(/\\+$/)?.[0] ?? '';
  const head = token.slice(0, token.length - trailing.length);
  return `"${head.replace(/"/g, '\\"')}"${trailing}`;
};
export const optionsText = (input:Pick<SshConnectionInput,'extraOptions'>) => input.extraOptions.map(([k,v]) => quoteArg(`${k}=${v}`)).join(' ');
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const spaceOrControl = /[\s\u0000-\u001f\u007f-\u009f]/;
const validHost = (host:string) => {
  if (/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(host)) return true;
  if (!host.includes(':') || !/^(?:\[[0-9a-f:.]+\]|[0-9a-f:.]+)$/i.test(host)) return false;
  try { return !!new URL('http://' + (host.startsWith('[') ? host : `[${host}]`)).hostname; } catch { return false; }
};
function parseOptions(options:string): { pairs:[string,string][]; code?:string; key?:string } {
  const pairs:[string,string][] = [];
  if (/[\r\n\u2028\u2029]/.test(options)) return { pairs, code:'one-line' };
  let tokens:string[];
  try { tokens = parseArgs(options); } catch { return { pairs, code:'unclosed-quote' }; }
  if (tokens.length > 32) return { pairs, code:'too-many' };
  for (const token of tokens) {
    const split = token.indexOf('=');
    if (split < 0) return { pairs, code:'invalid-pair' };
    const key = token.slice(0,split), value = token.slice(split+1);
    if (!/^[A-Za-z]+$/.test(key)) return { pairs, code:'invalid-key' };
    if (!isAllowedSshOption(key)) return { pairs, code:'option-not-allowed', key };
    if ([...value].length > 1024) return { pairs, code:'length' };
    if (controls.test(value)) return { pairs, code:'invalid-value' };
    pairs.push([key,value]);
  }
  return { pairs };
}
export function SshConnectionEditor({ connectionId, initialFolder, view, api, onSaved, onClose, focusName = 0 }: { connectionId?:string; initialFolder:string | null; view:SshView; api:SshStoreApi; onSaved(reply:SshReply, input:SshConnectionInput):void; onClose():void; focusName?:number }) {
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!connectionId || focusName) nameInput.current?.focus(); }, [connectionId, focusName]);
  const form = useRef<HTMLFormElement>(null); const errorPrefix = useId();
  const readOnly = !!view.loadError;
  const existing = view.connections.find(c => c.id === connectionId);
  const initial = ():SshConnectionInput => existing ? inputOf(existing) : { folderId:initialFolder, name:'', host:'', port:22, user:'', auth:'agent', identityFile:null, jumpConnectionId:null, extraOptions:[], bookmarked:false };
  const [draft, setDraft] = useState(initial); const [options, setOptions] = useState(() => optionsText(initial()));
  const baseline = useRef(JSON.stringify(initial())); const [baseOptions, setBaseOptions] = useState(options);
  const [error, setError] = useState<SshError | null>(null); const [busy, setBusy] = useState(false); const [changed, setChanged] = useState(false); const [confirmDelete, setConfirmDelete] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string,string>>({});
  const [focusInvalid, setFocusInvalid] = useState(false);
  useEffect(() => {
    if (focusInvalid && !busy) { form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(); setFocusInvalid(false); }
  }, [focusInvalid, busy]);
  const clearField = (field:string) => setFieldErrors(errors => { const next = { ...errors }; delete next[field]; return next; });
  const parsed = parseOptions(options);
  const dirty = JSON.stringify(draft) !== baseline.current || options !== baseOptions;
  const removed = !!connectionId && !existing;
  const [testOpen, setTestOpen] = useState(false);
  const sessionApi = window.electronAPI;
  const canTest = !!existing && !!connectionId && !dirty && !changed && !readOnly && !busy
    && JSON.stringify(inputOf(existing)) === baseline.current
    && typeof sessionApi?.sshTestConnection === 'function';
  useEffect(() => { if (!canTest) setTestOpen(false); }, [canTest]);
  useEffect(() => { if (readOnly || removed) setConfirmDelete(false); }, [readOnly, removed]);
  const jumpChoices = view.connections.filter(c => c.id !== connectionId && !c.jumpConnectionId && !view.connections.some(ref => ref.jumpConnectionId === connectionId));
  const reset = () => { const next = initial(); setDraft(next); baseline.current = JSON.stringify(next); const text = optionsText(next); setOptions(text); setBaseOptions(text); setError(null); setFieldErrors({}); setChanged(false); };
  useEffect(() => {
    if (!existing) { if (connectionId) setChanged(true); return; }
    const next = inputOf(existing);
    if (JSON.stringify(next) === baseline.current) setChanged(false);
    else if (dirty) setChanged(true); else reset();
  }, [existing, view.loadError]);
  const save = async ():Promise<boolean> => {
    if (readOnly || removed) { setError({ code:readOnly ? 'store-read-only' : 'removed', message:readOnly ? 'Cannot save: SSH store is read-only. Reload or discard changes.' : 'Cannot save: connection was deleted. Discard changes to leave.' }); return false; }
    if (busy) return false;
    const errors:Record<string,string> = {};
    const check = (field:string, code?:string, key?:string) => { if (code) errors[field] = sshFieldMessage(field,code,key); };
    const name = draft.name.trim(), host = draft.host, user = draft.user, identity = draft.identityFile ?? '';
    check('name', !name || [...name].length > 80 ? 'length' : controls.test(name) ? 'invalid' : undefined);
    check('host', !host ? 'required' : host.startsWith('-') ? 'leading-dash' : spaceOrControl.test(host) || !validHost(host) ? 'invalid' : [...host.replace(/^\[|\]$/g,'')].length > 255 ? 'length' : undefined);
    check('port', !Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535 ? 'range' : undefined);
    check('user', [...user].length > 128 ? 'length' : user.startsWith('-') ? 'leading-dash' : spaceOrControl.test(user) || user.includes('@') ? 'invalid' : undefined);
    if (draft.auth === 'keyFile') check('identityFile', !identity.trim() ? 'required' : [...identity].length > 4096 ? 'length' : controls.test(identity) ? 'invalid' : undefined);
    if (draft.jumpConnectionId) {
      const jump = view.connections.find(c => c.id === draft.jumpConnectionId);
      check('jumpConnectionId', draft.jumpConnectionId === connectionId ? 'self' : !jump ? 'not-found' : jump.jumpConnectionId ? 'nested' : undefined);
    }
    if (draft.folderId && !view.folders.some(f => f.id === draft.folderId)) check('folderId','not-found');
    check('extraOptions', parsed.code, parsed.key);
    if (fieldErrors.extraOptions === sshFieldMessage('extraOptions','one-line')) errors.extraOptions = fieldErrors.extraOptions;
    setError(null); setFieldErrors(errors);
    if (Object.keys(errors).length) { setFocusInvalid(true); return false; }
    setBusy(true);
    try {
      const input = { ...draft, name, identityFile:draft.auth === 'keyFile' ? draft.identityFile : null, extraOptions:parsed.pairs };
      const reply = await api.upsertConnection(input);
      const saved = input.id ? reply.view.connections.find(c => c.id === input.id) : reply.view.connections.find(c => !view.connections.some(old => old.id === c.id));
      if (saved) {
        const next = inputOf(saved), text = optionsText(next);
        baseline.current = JSON.stringify(next); setDraft(next); setOptions(text); setBaseOptions(text); setChanged(false);
        onSaved(reply,next);
      } else onSaved(reply,input);
      return true;
    } catch (failure) { const e = failure as SshError;
      if (e?.field) {
        const message = sshFieldMessage(e.field,e.code,parsed.key);
        if (form.current?.elements.namedItem(e.field)) { setFieldErrors({ [e.field]:message }); setFocusInvalid(true); }
        else setError({ code:e.code, message });
      } else setError({ code:e?.code ?? 'save-failed', message:sshErrorMessage(failure) });
      try { await refreshReadOnly(failure, api, reply => onSaved(reply,draft)); } catch (refreshError) { setError({ code:'refresh', message:sshErrorMessage(refreshError) }); }
      return false; }
    finally { setBusy(false); }
  };
  const current = useRef({ dirty, save, reset }); current.current = { dirty, save, reset };
  useEffect(() => registerSshEditorGuard({ isDirty:() => current.current.dirty, save:() => current.current.save(), discard:() => current.current.reset() }), []);
  const errorProps = (name:string) => ({ 'aria-invalid':!!fieldErrors[name], 'aria-describedby':fieldErrors[name] ? `${errorPrefix}-${name}` : undefined });
  const fieldError = (name:string) => fieldErrors[name] && <span id={`${errorPrefix}-${name}`} role="alert" className="ssh-field-error">{fieldErrors[name]}</span>;
  const field = (name: 'name' | 'host' | 'user' | 'identityFile', label:string) => <div className="ssh-editor-field"><label>{label}<input ref={name === 'name' ? nameInput : undefined} name={name} value={draft[name] ?? ''} title={draft[name] || undefined} onChange={event => { clearField(name); setDraft({ ...draft, [name]:event.target.value }); }} {...errorProps(name)} /></label>{fieldError(name)}</div>;
  const invalidOptions = !!parsed.code || !!fieldErrors.extraOptions;
  let argv:string[] = []; if (!invalidOptions) try { const jump = view.connections.find(c => c.id === draft.jumpConnectionId); argv = buildSshArgv({ hops:jump ? [jump,draft] : [draft], extraOptions:parsed.pairs }); } catch {}
  return <div className="ssh-connection-editor"><h3>{connectionId ? 'Edit SSH connection' : 'New SSH connection'}</h3>
    {changed && !view.loadError && <div role="alert" className="ssh-conflict">{removed ? 'Deleted elsewhere' : 'Changed elsewhere'} — <button type="button" className="au-btn sm" onClick={() => removed ? onClose() : reset()}>{removed ? 'Close' : 'Reload'}</button>{!removed && <button type="button" className="au-btn sm" onClick={() => { if (existing) { baseline.current = JSON.stringify(inputOf(existing)); setBaseOptions(optionsText(existing)); setDraft(value => ({ ...value, extraOptions:existing.extraOptions })); } setChanged(false); }}>Keep mine</button>}</div>}
    <form ref={form} noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
    <fieldset disabled={busy || readOnly || removed}>
      {field('name','Name')}{field('host','Host')}
      <div className="ssh-editor-field"><label>Port<input name="port" type="number" min={1} max={65535} value={draft.port} onChange={event => { clearField('port'); setDraft({ ...draft, port:Number(event.target.value) }); }} {...errorProps('port')} /></label>{fieldError('port')}</div>
      {field('user','User')}
      <div role="group" aria-label="Authentication" className="au-seg ssh-auth">{(['keyFile','agent','password'] as const).map(auth => <button type="button" key={auth} className={draft.auth === auth ? 'on' : undefined} aria-pressed={draft.auth === auth} onClick={() => { clearField('identityFile'); setDraft({ ...draft, auth, identityFile:auth === 'keyFile' ? draft.identityFile ?? '' : null }); }}>{auth === 'keyFile' ? 'Key file' : auth === 'agent' ? 'SSH agent' : 'Ask for password'}</button>)}</div>
      {draft.auth === 'keyFile' && <>{field('identityFile','Identity file')}<button type="button" className="au-btn sm ssh-browse" onClick={async () => { try { const path = await window.electronAPI?.pickFile?.('Select SSH identity file'); if (path) { clearField('identityFile'); setDraft(value => ({ ...value, identityFile:path })); } } catch (e) { setError({ code:'picker', message:sshErrorMessage(e) }); } }}>Browse…</button></>}
      <div className="ssh-editor-field"><label>Jump host<select name="jumpConnectionId" value={draft.jumpConnectionId ?? ''} {...errorProps('jumpConnectionId')} onChange={event => { clearField('jumpConnectionId'); setDraft({ ...draft, jumpConnectionId:event.target.value || null }); }}><option value="">None</option>{draft.jumpConnectionId && !jumpChoices.some(c => c.id === draft.jumpConnectionId) && <option value={draft.jumpConnectionId} disabled>(unavailable: {draft.jumpConnectionId})</option>}{jumpChoices.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>{fieldError('jumpConnectionId')}</div>
      <div className="ssh-editor-field"><label>Folder<select name="folderId" value={draft.folderId ?? ''} {...errorProps('folderId')} onChange={event => { clearField('folderId'); setDraft({ ...draft, folderId:event.target.value || null }); }}><option value="">Top level</option>{draft.folderId && !view.folders.some(f => f.id === draft.folderId) && <option value={draft.folderId} disabled>(unavailable: {draft.folderId})</option>}{view.folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>{fieldError('folderId')}</div>
      <label className="ssh-check"><input name="bookmarked" type="checkbox" className="setting-checkbox" checked={draft.bookmarked} onChange={event => setDraft({ ...draft, bookmarked:event.target.checked })} />Bookmark</label>
      <div className="ssh-editor-field"><label>Extra options<input name="extraOptions" value={options} {...errorProps('extraOptions')} onChange={event => { clearField('extraOptions'); setOptions(event.target.value); }} onPaste={event => { if (/[\r\n\u2028\u2029]/.test(event.clipboardData.getData('text'))) { event.preventDefault(); setFieldErrors(errors => ({ ...errors, extraOptions:sshFieldMessage('extraOptions','one-line') })); } }} /><small>Applies to the terminal ssh only</small></label>{fieldError('extraOptions')}</div>
      <div className={invalidOptions ? 'ssh-argv invalid' : 'ssh-argv'} aria-label="Arguments"><strong>Arguments</strong>{invalidOptions ? <small>Fix Extra options to preview the arguments.</small> : argv.map((arg,index) => <code key={index}>{arg}</code>)}</div>
      {error && <p role="alert">{error.message}</p>}
      <div className="ssh-editor-actions"><button type="submit" className="au-btn primary">Save connection</button>{connectionId && <button type="button" className="au-btn danger" onClick={() => setConfirmDelete(true)}>Delete connection…</button>}</div>
    </fieldset>
    </form>
    <div className="ssh-editor-actions"><button type="button" className="au-btn" disabled={!canTest} aria-describedby="ssh-test-help" onClick={() => { if (canTest) setTestOpen(true); }}>Test connection</button>
      <small id="ssh-test-help">{!existing || dirty || changed ? 'Save changes before testing the saved connection.' : 'Tests the native app channel only; no terminal is opened.'}</small>
    </div>
    {testOpen && canTest && sessionApi && <SshTestConnectionDialog connectionId={connectionId!} api={sessionApi} onClose={() => setTestOpen(false)} />}
    <button type="button" className="au-btn" disabled={busy} onClick={() => { reset(); onClose(); }}>Discard changes</button>
    <ConfirmDialog isOpen={confirmDelete && !readOnly && !removed} title="Delete connection" message={`Delete ${draft.name}?`} destructive confirmText="Delete" onCancel={() => setConfirmDelete(false)} onConfirm={async () => { if (readOnly || removed) { setConfirmDelete(false); return; } try { const reply = await api.deleteConnection({ id:connectionId! }); onSaved(reply,draft); onClose(); } catch (e) { setError({ code:'delete', message:sshErrorMessage(e) }); try { await refreshReadOnly(e,api,reply => onSaved(reply,draft)); } catch (refreshError) { setError({ code:'refresh', message:sshErrorMessage(refreshError) }); } } setConfirmDelete(false); }} />
  </div>;
}
