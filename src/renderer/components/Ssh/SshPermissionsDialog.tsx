import React, { useRef, useState } from 'react';
import { SshFileDialog } from './SshFileDialog';
import { operationError } from './sshFileFeedback';
import type { FsError } from './sshFileTypes';
import type { SshRowScope } from './useSshFileBrowser';
import { staleTarget, statTarget, useSshTargetStat } from './useSshTargetStat';

const classes = ['Owner', 'Group', 'Other'];
const permissions = ['Read', 'Write', 'Execute'];
const octal = (mode: number) => (mode & 0o7777).toString(8).padStart(4, '0');
const parseMode = (mode: string) => /^[0-7]{3,4}$/.test(mode) ? parseInt(mode, 8) : undefined;
const parseId = (id: string) => /^\d+$/.test(id) && Number(id) <= 0xffffffff ? Number(id) : undefined;

export function SshPermissionsDialog({ scope, onClose }: { scope: SshRowScope; onClose(): void }) {
  const { stat, setStat, loadError } = useSshTargetStat(scope);
  const [draft, setDraft] = useState<{ mode?: string; uid?: string; gid?: string }>({});
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [unverified, setUnverified] = useState(false);
  const busy = useRef(false);
  const { api, request } = scope;
  const live = scope.isLive();
  const applicable = stat?.kind === 'file' || stat?.kind === 'directory';
  const canEdit = live && applicable && !pending && !unverified;
  const ownership = stat?.uid !== undefined && stat?.gid !== undefined;
  const modeText = draft.mode ?? (stat?.mode === undefined ? '' : octal(stat.mode));
  const uidText = draft.uid ?? stat?.uid?.toString() ?? '';
  const gidText = draft.gid ?? stat?.gid?.toString() ?? '';
  const mode = parseMode(modeText);
  const uid = parseId(uidText), gid = parseId(gidText);
  const cancel = () => { if (!busy.current) onClose(); };

  const apply = async () => {
    if (!stat || !canEdit || busy.current || !scope.isLive()) return;
    if ((stat.mode !== undefined && mode === undefined) || (ownership && (uid === undefined || gid === undefined))) {
      setError('Use a three- or four-digit octal mode and unsigned numeric UID/GID values.');
      return;
    }
    const ownerChanged = ownership && (uid !== stat.uid || gid !== stat.gid);
    const modeChanged = stat.mode !== undefined && mode !== undefined && mode !== (stat.mode & 0o7777);
    if (!ownerChanged && !modeChanged) { onClose(); return; }
    busy.current = true; setPending(true); setError(undefined);
    let changedOwner = false;
    let failure: string | undefined;
    let refetch = true;
    try {
      if (ownerChanged) {
        await api.fsChown({ ...request, ...(uid !== stat.uid ? { uid } : {}), ...(gid !== stat.gid ? { gid } : {}) });
        changedOwner = true;
      }
      if (modeChanged) {
        if (!scope.isLive()) throw new Error(staleTarget);
        await api.fsChmod({ ...request, mode });
      }
    } catch (cause) {
      const detail = operationError(cause, request.path);
      failure = changedOwner
        ? `Partially completed: ownership changed, but the mode change was not confirmed. ${detail.replace(/ Nothing was changed\.$/, '')}`
        : detail;
      refetch = changedOwner || (cause as Partial<FsError> | undefined)?.outcome !== 'unchanged';
    }

    try {
      if (refetch) {
        setStat(await statTarget(scope));
        setDraft({});
      }
      if (failure) setError(failure);
      else onClose();
    } catch (cause) {
      setUnverified(true);
      setError(`${failure ?? 'Changes acknowledged.'} Could not refresh permissions. ${operationError(cause, request.path)}`);
    } finally {
      busy.current = false; setPending(false);
    }
  };

  return <SshFileDialog title="Permissions" onCancel={cancel} onSubmit={() => void apply()} footer={<>
    <button type="button" className="confirm-btn cancel" data-dialog-cancel disabled={pending} onClick={cancel}>Cancel</button>
    <button type="submit" className="confirm-btn primary" disabled={!canEdit || (!ownership && stat?.mode === undefined)}>Apply</button>
  </>}>
    <p><code>{request.path}</code></p>
    <p>The server changes permissions by path. A concurrent replacement between the final check and the write may change what is affected.</p>
    {!stat && !loadError && live && <p role="status">Loading permissions…</p>}
    {stat && !applicable && <p role="alert">Only regular files and folders support permission changes.</p>}
    <table className="ssh-permission-grid">
      <thead><tr><th scope="col">Class</th>{permissions.map(name => <th key={name} scope="col">{name}</th>)}</tr></thead>
      <tbody>{classes.map((group, row) => <tr key={group}><th scope="row">{group}</th>
        {permissions.map((name, col) => {
          const bit = 1 << (8 - row * 3 - col);
          return <td key={name}><input type="checkbox" aria-label={`${group} ${name.toLowerCase()}`}
            checked={mode !== undefined && !!(mode & bit)} disabled={!canEdit || mode === undefined}
            onChange={event => {
              const next = event.target.checked;
              if (mode !== undefined) setDraft(value => ({ ...value, mode: octal(next ? mode | bit : mode & ~bit) }));
            }} /></td>;
        })}</tr>)}</tbody>
    </table>
    <div className="ssh-permission-fields">
      <label>Octal mode <input inputMode="numeric" value={modeText} placeholder="Unavailable"
        disabled={!canEdit || stat?.mode === undefined} title={stat?.mode === undefined ? 'Server did not report a mode.' : undefined}
        onChange={event => { const mode = event.target.value; setDraft(value => ({ ...value, mode })); }} /></label>
      <label>UID <input inputMode="numeric" value={uidText} placeholder="Unavailable" disabled={!canEdit || !ownership}
        title={!ownership ? 'Server must report both UID and GID.' : undefined}
        onChange={event => { const uid = event.target.value; setDraft(value => ({ ...value, uid })); }} /></label>
      <label>GID <input inputMode="numeric" value={gidText} placeholder="Unavailable" disabled={!canEdit || !ownership}
        title={!ownership ? 'Server must report both UID and GID.' : undefined}
        onChange={event => { const gid = event.target.value; setDraft(value => ({ ...value, gid })); }} /></label>
    </div>
    {(error || loadError || !live) && <p role="alert">{error || loadError || staleTarget}</p>}
  </SshFileDialog>;
}
