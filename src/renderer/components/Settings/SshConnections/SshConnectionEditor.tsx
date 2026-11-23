import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { SshConnection, SshConnectionInput, SshError, SshPreview, SshPreviewError, SshPreviewSource, SshReply, SshStoreApi, SshView } from '../../../types/ssh';
import { registerSshEditorGuard } from '../../../services/sshEditorGuard';
import { parseArgs } from '../../../services/argParse';
import { ConfirmDialog } from '../../UI/ConfirmDialog';
import { writeClipboardText } from '../../../utils/clipboard';
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
// Draft sent to the Rust preview: the same normalisation save() applies, or the first local field error.
function connectionInput(draft:SshConnectionInput, options:string):SshConnectionInput {
  if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) throw { field:'port', code:'range' };
  const parsed = parseOptions(options);
  if (parsed.code) throw { field:'extraOptions', code:parsed.code, key:parsed.key };
  return { ...draft, name:draft.name.trim(), identityFile:draft.auth === 'keyFile' ? draft.identityFile : null, extraOptions:parsed.pairs };
}

/** Monochrome trash glyph (inherits currentColor, so the danger hover colours it); the codebase uses inline SVGs. */
function TrashIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.7 6.5v4.5M9.3 6.5v4.5" />
  </svg>;
}

export function SshConnectionEditor({ connectionId, initialFolder, view, api, onSaved, onClose, focusName = 0, onConnect }: { connectionId?:string; initialFolder:string | null; view:SshView; api:SshStoreApi; onSaved(reply:SshReply, input:SshConnectionInput):void; onClose():void; focusName?:number; onConnect?(id:string):void }) {
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
  const [confirmForget, setConfirmForget] = useState(false);
  const [forgotten, setForgotten] = useState(false);
  const [forgetFocus, setForgetFocus] = useState<'auth' | 'forget' | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const forgetButton = useRef<HTMLButtonElement>(null);
  const credentialDescription = useId();
  const showSavedCredential = !!existing?.hasSavedSecret && existing.auth !== 'agent' && draft.auth !== 'agent';
  useEffect(() => {
    if (readOnly || !showSavedCredential) setConfirmForget(false);
  }, [readOnly, showSavedCredential]);
  useEffect(() => {
    if (forgetFocus && !busy) {
      const target = readOnly || removed ? heading.current : forgetFocus === 'forget'
        ? forgetButton.current : form.current?.querySelector<HTMLButtonElement>('.ssh-auth [aria-pressed="true"]');
      (target ?? heading.current)?.focus();
      setForgetFocus(null);
    }
  }, [forgetFocus, busy, readOnly, removed]);
  const forget = async () => {
    if (!existing || !showSavedCredential || readOnly || busy) return;
    setConfirmForget(false);
    setBusy(true);
    setError(null);
    setForgotten(false);
    try {
      const reply = await api.forgetSecret(existing.id);
      onSaved(reply, inputOf(existing));
      setForgotten(true);
      setForgetFocus('auth');
    } catch (failure) {
      setError({ code:'forget', message:sshErrorMessage(failure) });
      try { await refreshReadOnly(failure, api, reply => onSaved(reply,draft)); }
      catch (refreshError) { setError({ code:'refresh', message:sshErrorMessage(refreshError) }); }
      setForgetFocus('forget');
    } finally {
      setBusy(false);
    }
  };
  const previewRequest = useMemo((): { source?: SshPreviewSource; error?: SshError } => {
    if (removed || readOnly) return {};
    if (connectionId && !dirty && !changed && existing && JSON.stringify(inputOf(existing)) === baseline.current) {
      return { source:{ kind:'saved', id:connectionId } };
    }
    try {
      return { source:{ kind:'draft', draft:connectionInput(draft, options), editingId:connectionId } };
    } catch (failure) {
      return { error:failure as SshError };
    }
  }, [removed, readOnly, connectionId, dirty, changed, existing, draft, options, view.revision]);
  const [previewResult, setPreviewResult] = useState<{ request:typeof previewRequest; value?:SshPreview; errors?:SshError[] }>();
  useEffect(() => {
    if (!previewRequest.source || !api.previewConnection) return;
    let current = true;
    void api.previewConnection({ source:previewRequest.source }).then(
      value => { if (current) setPreviewResult({ request:previewRequest, value }); },
      (failure:unknown) => {
        if (!current) return;
        const e = failure as SshPreviewError | null;
        setPreviewResult({ request:previewRequest, errors:e?.fields?.length ? e.fields : [{ code:e?.code ?? 'preview-failed', message:sshErrorMessage(failure) }] });
      },
    );
    return () => { current = false; };
  }, [api, previewRequest]);
  const currentPreview = previewResult?.request === previewRequest ? previewResult : undefined;
  const [showCommand, setShowCommand] = useState(false);
  const [shell, setShell] = useState<string>();
  // The text last copied: "Copied" shows only while that exact text is on screen.
  const [copiedText, setCopiedText] = useState<string>();
  const commandId = useId();
  const previewErrors = previewRequest.error ? [previewRequest.error] : currentPreview?.errors ?? [];
  // Save-time errors win; otherwise the live preview's field error, worded by code like save() or as the backend sent it.
  const fieldMessage = (name:string):string | undefined => {
    if (fieldErrors[name]) return fieldErrors[name];
    const issue = previewErrors.find(e => e.field === name) as (SshError & { key?:string }) | undefined;
    if (!issue) return undefined;
    const mapped = sshFieldMessage(name, issue.code, issue.key);
    return mapped !== sshFieldMessage(name, '') ? mapped : issue.message || issue.code;
  };
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
  useEffect(() => {
    if (existing?.hasSavedSecret) setForgotten(false);
  }, [existing?.hasSavedSecret]);
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
  // Always the SAVED id: the panel decides what a dirty draft means (Save / Discard / Cancel) before launching.
  const connect = () => { if (existing && onConnect && !readOnly && !removed && !busy) onConnect(existing.id); };
  const current = useRef({ dirty, save, reset }); current.current = { dirty, save, reset };
  useEffect(() => registerSshEditorGuard({ isDirty:() => current.current.dirty, save:() => current.current.save(), discard:() => current.current.reset() }), []);
  const errorProps = (name:string) => { const message = fieldMessage(name); return { 'aria-invalid':!!message, 'aria-describedby':message ? `${errorPrefix}-${name}` : undefined }; };
  const fieldError = (name:string) => { const message = fieldMessage(name); return message && <span id={`${errorPrefix}-${name}`} role="alert" className="ssh-field-error">{message}</span>; };
  const identityId = useId();
  const field = (name: 'name' | 'host' | 'user', label:string, extra = '') => <div className={`ssh-editor-field ${extra}`.trim()}><label>{label}<input className="setting-input" ref={name === 'name' ? nameInput : undefined} name={name} value={draft[name] ?? ''} title={draft[name] || undefined} onChange={event => { clearField(name); setDraft({ ...draft, [name]:event.target.value }); }} {...errorProps(name)} /></label>{fieldError(name)}</div>;
  const inlineFields = ['name','host','port','user','extraOptions','jumpConnectionId','folderId', ...(draft.auth === 'keyFile' ? ['identityFile'] : [])];
  const invalidOptions = !!parsed.code || !!fieldErrors.extraOptions;
  const locked = busy || readOnly || removed;
  const browse = async () => { try { const path = await window.electronAPI?.pickFile?.('Select SSH identity file'); if (path) { clearField('identityFile'); setDraft(value => ({ ...value, identityFile:path })); } } catch (e) { setError({ code:'picker', message:sshErrorMessage(e) }); } };
  const canConnect = !!existing && !!onConnect;
  const commands = currentPreview?.value?.commands ?? [];
  const shellIndex = Math.max(0, commands.findIndex(c => c.shell === shell));
  const command = commands[shellIndex];
  const toggleCommand = () => setShowCommand(open => !open);
  const chooseShell = (next:string) => setShell(next);
  const copy = async () => {
    if (!command || command.unavailable) return;
    const text = command.text;
    try { await writeClipboardText(text); setCopiedText(text); } catch (e) { setError({ code:'copy', message:sshErrorMessage(e) }); }
  };
  return <div className="ssh-connection-editor">
    {changed && !view.loadError && <div role="alert" className="ssh-conflict">{removed ? 'Deleted elsewhere' : 'Changed elsewhere'} — <button type="button" className="au-btn sm" onClick={() => removed ? onClose() : reset()}>{removed ? 'Close' : 'Reload'}</button>{!removed && <button type="button" className="au-btn sm" onClick={() => { if (existing) { baseline.current = JSON.stringify(inputOf(existing)); setBaseOptions(optionsText(existing)); setDraft(value => ({ ...value, extraOptions:existing.extraOptions })); } setChanged(false); }}>Keep mine</button>}</div>}
    <form ref={form} noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="ssh-editor-header"><h3 ref={heading} tabIndex={-1} title={existing?.name || undefined} aria-label={connectionId ? `Edit SSH connection: ${existing?.name || 'SSH connection'}` : undefined}>{existing?.name || (connectionId ? 'SSH connection' : 'New SSH connection')}</h3>
      <label className="ssh-check"><input name="bookmarked" type="checkbox" className="setting-checkbox" disabled={locked} checked={draft.bookmarked} onChange={event => setDraft({ ...draft, bookmarked:event.target.checked })} />Bookmark</label></div>
    <fieldset disabled={locked}>
      <div className="ssh-editor-grid">
        {field('name','Name','ssh-span-2')}
        <div className="ssh-editor-field ssh-span-2"><label>Folder<select className="setting-input" name="folderId" value={draft.folderId ?? ''} {...errorProps('folderId')} onChange={event => { clearField('folderId'); setDraft({ ...draft, folderId:event.target.value || null }); }}><option value="">Top level</option>{draft.folderId && !view.folders.some(f => f.id === draft.folderId) && <option value={draft.folderId} disabled>(unavailable: {draft.folderId})</option>}{view.folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>{fieldError('folderId')}</div>
        {field('host','Host','ssh-span-2')}
        <div className="ssh-editor-field"><label>Port<input className="setting-input" name="port" type="number" min={1} max={65535} value={draft.port} onChange={event => { clearField('port'); setDraft({ ...draft, port:Number(event.target.value) }); }} {...errorProps('port')} /></label>{fieldError('port')}</div>
        {field('user','User')}
        <div className="ssh-editor-field ssh-span-all"><span className="ssh-caption" aria-hidden="true">Authentication</span>
          <div role="group" aria-label="Authentication" className="au-seg ssh-auth">{(['keyFile','agent','password'] as const).map(auth => <button type="button" key={auth} className={draft.auth === auth ? 'on' : undefined} aria-pressed={draft.auth === auth} onClick={() => { clearField('identityFile'); setDraft({ ...draft, auth, identityFile:auth === 'keyFile' ? draft.identityFile ?? '' : null }); }}>{auth === 'keyFile' ? 'Key file' : auth === 'agent' ? 'SSH agent' : 'Ask for password'}</button>)}</div></div>
        {draft.auth === 'keyFile' && <div className="ssh-editor-field ssh-span-all"><label htmlFor={identityId}>Identity file</label>
          <div className="ssh-inline-row"><input id={identityId} className="setting-input" name="identityFile" value={draft.identityFile ?? ''} title={draft.identityFile || undefined} onChange={event => { clearField('identityFile'); setDraft({ ...draft, identityFile:event.target.value }); }} {...errorProps('identityFile')} /><button type="button" className="au-btn ssh-browse" onClick={browse}>Browse…</button></div>{fieldError('identityFile')}</div>}
        {showSavedCredential && <div className="ssh-span-all"><small id={credentialDescription}>Saved credential for the app channel</small>{' '}<button type="button" ref={forgetButton} className="au-btn sm" aria-describedby={credentialDescription} disabled={readOnly || busy} onClick={() => setConfirmForget(true)}>Forget</button></div>}
        <div className="ssh-editor-field ssh-span-2"><label>Jump host<select className="setting-input" name="jumpConnectionId" value={draft.jumpConnectionId ?? ''} {...errorProps('jumpConnectionId')} onChange={event => { clearField('jumpConnectionId'); setDraft({ ...draft, jumpConnectionId:event.target.value || null }); }}><option value="">None</option>{draft.jumpConnectionId && !jumpChoices.some(c => c.id === draft.jumpConnectionId) && <option value={draft.jumpConnectionId} disabled>(unavailable: {draft.jumpConnectionId})</option>}{jumpChoices.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>{fieldError('jumpConnectionId')}</div>
        <div className="ssh-editor-field ssh-span-2"><label>Extra options<input className="setting-input" name="extraOptions" value={options} title={options || undefined} {...errorProps('extraOptions')} onChange={event => { clearField('extraOptions'); setOptions(event.target.value); }} onPaste={event => { if (/[\r\n\u2028\u2029]/.test(event.clipboardData.getData('text'))) { event.preventDefault(); setFieldErrors(errors => ({ ...errors, extraOptions:sshFieldMessage('extraOptions','one-line') })); } }} /><small>Applies to the terminal ssh only</small></label>{fieldError('extraOptions')}</div>
        <div className={invalidOptions ? 'ssh-argv invalid ssh-span-all' : 'ssh-argv ssh-span-all'} role="group" aria-label="Command preview">
          {/* Collapsed by default; problems below stay visible either way so a closed panel never hides an error. */}
          <button type="button" className="au-btn sm ssh-argv-toggle" aria-expanded={showCommand} aria-controls={commandId} onClick={toggleCommand}><span aria-hidden="true">{showCommand ? '▾' : '▸'}</span> Command preview</button>
          {invalidOptions && <small>Fix Extra options to preview the command.</small>}
          {/* The body exists whenever the toggle says expanded, even with nothing to show yet. */}
          {showCommand && <div id={commandId} className="ssh-argv-body">{!invalidOptions && command && <>
            {commands.length > 1 && <div role="group" aria-label="Shell" className="au-seg">{commands.map((c,i) => <button type="button" key={c.shell} className={i === shellIndex ? 'on' : undefined} aria-pressed={i === shellIndex} onClick={() => chooseShell(c.shell)}>{c.label}</button>)}</div>}
            <code>{command.text}</code>
            <div className="ssh-inline-row"><button type="button" className="au-btn sm" disabled={!!command.unavailable} aria-describedby={command.unavailable ? `${commandId}-why` : undefined} onClick={copy}>Copy</button><span role="status">{copiedText === command.text ? 'Copied' : ''}</span></div>
            {command.unavailable ? <small id={`${commandId}-why`}>{command.unavailable}</small> : <small>Runs as-is in {command.label}.</small>}
            <small>{currentPreview!.value!.wrapper} — {currentPreview!.value!.configNotice}</small>
          </>}</div>}
          {previewErrors.filter(e => !inlineFields.includes(e.field ?? '')).map(e => <small role="alert" key={e.field ?? e.code}>{e.message || e.code}</small>)}
        </div>
        {error && <p role="alert" className="ssh-span-all">{error.message}</p>}
      </div>
    </fieldset>
    {/* ONE non-wrapping action row in two groups: use actions left (Delete as an icon first), edit actions right.
        DOM order is Tab order, so Save (primary) is last. Short labels keep the row on one line at the narrowest
        editor width; the full wording stays in the titles and the ssh-*-help descriptions. */}
    <div className="ssh-editor-actions">
      <div className="ssh-actions-group">
        {connectionId && <button type="button" className="au-btn icon danger ssh-delete-btn" disabled={locked} aria-label="Delete connection" title="Delete connection…" onClick={() => setConfirmDelete(true)}><TrashIcon /></button>}
        {canConnect && <button type="button" className="au-btn" disabled={readOnly || removed || busy} title="Connect in a new tab" aria-describedby="ssh-connect-help" onClick={connect}>Connect</button>}
        <button type="button" className="au-btn" disabled={!canTest} title="Test connection" aria-describedby="ssh-test-help" onClick={() => { if (canTest) setTestOpen(true); }}>Test</button>
      </div>
      <div className="ssh-actions-group ssh-actions-end">
        <button type="button" className="au-btn" disabled={busy} title="Discard changes" onClick={() => { reset(); onClose(); }}>Discard</button>
        <button type="submit" className="au-btn primary" disabled={locked} title="Save connection">Save</button>
      </div>
    </div>
    <div className="ssh-editor-help">
      {canConnect && <small id="ssh-connect-help">{dirty || changed ? 'Opens the last saved version; you will be asked about unsaved changes.' : 'Opens a new tab and starts this saved connection.'}</small>}
      <small id="ssh-test-help">{!existing || dirty || changed ? 'Save changes before testing the saved connection.' : 'Tests the native app channel only; no terminal is opened.'}</small>
    </div>
    </form>
    <div role="status">{forgotten && !existing?.hasSavedSecret ? 'Saved credential forgotten.' : ''}</div>
    {testOpen && canTest && sessionApi && <SshTestConnectionDialog connectionId={connectionId!} api={sessionApi} onClose={() => setTestOpen(false)} />}
    <ConfirmDialog isOpen={confirmForget && showSavedCredential && !readOnly && !busy} title="Forget saved credential" message={`Forget the saved credential for ${existing?.name}? You'll be asked for it next time.`} destructive confirmText="Forget" onCancel={() => setConfirmForget(false)} onConfirm={forget} />
    <ConfirmDialog isOpen={confirmDelete && !readOnly && !removed} title="Delete connection" message={`Delete ${draft.name}?`} destructive confirmText="Delete" onCancel={() => setConfirmDelete(false)} onConfirm={async () => { if (readOnly || removed) { setConfirmDelete(false); return; } try { const reply = await api.deleteConnection({ id:connectionId! }); onSaved(reply,draft); onClose(); } catch (e) { setError({ code:'delete', message:sshErrorMessage(e) }); try { await refreshReadOnly(e,api,reply => onSaved(reply,draft)); } catch (refreshError) { setError({ code:'refresh', message:sshErrorMessage(refreshError) }); } } setConfirmDelete(false); }} />
  </div>;
}
