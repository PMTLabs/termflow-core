import React, { useEffect, useRef, useState } from 'react';
import { rehydrateSshEdits, sshFileEvents } from '../../services/sshFileEvents';
import { readSshFileSession } from './ssh066Contract';
import type { EditOpen, EditStatus, SshFileApi } from './sshFileTypes';
import type { SshSessionsState } from '../../store/slices/sshSessionSlice';
import './SshEditWarning.css';
import '../Settings/Automations/AutomationsPanel.css';

// Read the live store through the window handle (and load openSettings lazily): importing `store`
// drags tauri-bridge into every test that mounts the SSH shell.
const sshSessions = (): SshSessionsState =>
  (window as any).__REDUX_STORE__?.getState().sshSession ?? { byTerminal: {} };

/** The backend canonicalizes the edit root, so Windows copies carry a verbatim prefix
 *  (`\\?\C:\…` or `\\?\UNC\server\share\…`). Valid, but noise to a reader: strip it for display
 *  only; the path the backend uses is unchanged (P068-6). */
export function displayLocalPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return '\\\\' + path.slice(8);
  return path.startsWith('\\\\?\\') ? path.slice(4) : path;
}

interface Props {
  terminalId: string;
  enabled?: boolean;
  openResult?: EditOpen;
  api?: SshFileApi;
  children?: (summaries: string[], details: React.ReactNode, routine: EditStatus[]) => React.ReactNode;
}

// Mount once per owning pane, outside any collapsed/disconnected browser slot.
export function SshEditWarning({ terminalId, enabled, openResult, children, api = window.electronAPI?.ssh }: Props) {
  return <EditWarnings key={terminalId} terminalId={terminalId} enabled={enabled} openResult={openResult} api={api} children={children} />;
}

function EditWarnings({ terminalId, enabled = true, openResult, api, children }: Props) {
  const [edits, setEdits] = useState<EditStatus[]>([]);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<string>();
  const owner = useRef<{ stopping: Set<string>; stopped: Set<string> } | undefined>(undefined);

  useEffect(() => {
    if (!enabled) { setEdits([]); setPending(new Set()); setFailure(undefined); return; }
    if (!api?.onFsEditState) return;
    const ownership = { stopping: new Set<string>(), stopped: new Set<string>() };
    owner.current = ownership;
    const touched = new Set<string>();
    let seeding = true;
    const session = () => readSshFileSession(sshSessions(), terminalId);
    const registration = sshFileEvents(api).register(terminalId, {
      session,
      onEdit(notice) {
        if (ownership.stopped.has(notice.editId)) return;
        if (seeding) touched.add(notice.editId);
        if (notice.state === 'stopped') {
          ownership.stopped.add(notice.editId);
          setEdits(rows => rows.filter(row => row.editId !== notice.editId));
          return;
        }
        setEdits(rows => {
          const previous = rows.find(row => row.editId === notice.editId);
          if (previous?.retained) return rows;
          return [...rows.filter(row => row.editId !== notice.editId), { ...notice, retained: false }];
        });
      },
    });
    void registration.ready.then(async () => {
      if (owner.current !== ownership) return;
      try {
        const snapshot = await rehydrateSshEdits(api, terminalId);
        if (owner.current !== ownership) return;
        const generation = session().generation;
        const seed = snapshot.filter(edit => !ownership.stopped.has(edit.editId)
          && (edit.retained || (!touched.has(edit.editId) && (generation === undefined || edit.sessionGeneration >= generation))));
        // Retention is final for an edit ID; a live notice does not carry this flag.
        const seededIds = new Set(seed.map(edit => edit.editId));
        setEdits(rows => [...seed, ...rows.filter(row => !seededIds.has(row.editId))]);
      } catch {
        if (owner.current === ownership) setFailure('Could not load SSH edits.');
      } finally {
        seeding = false;
        touched.clear();
      }
    }, () => { /* No file events in the plain browser. */ });
    return () => { owner.current = undefined; registration.unregister(); };
  }, [api, enabled, terminalId]);

  const finish = async (edit: EditStatus) => {
    const ownership = owner.current;
    if (!api || !ownership || ownership.stopping.has(edit.editId)) return;
    ownership.stopping.add(edit.editId);
    setPending(new Set(ownership.stopping));
    setFailure(undefined);
    try {
      const target = { terminalId, path: edit.path, editId: edit.editId };
      const result = edit.retained
        ? (await api.fsEditDismiss(target), { retained: false, localPath: undefined })
        : await api.fsEditStop(target);
      if (owner.current !== ownership) return;
      ownership.stopped.add(edit.editId);
      setEdits(rows => result.retained
        ? rows.map(row => row.editId === edit.editId ? {
          ...row, state: row.state === 'conflict' || row.state === 'error' ? row.state : 'paused',
          ...result, localPath: result.localPath ?? row.localPath,
        } : row)
        : rows.filter(row => row.editId !== edit.editId));
    } catch {
      if (owner.current === ownership) setFailure(edit.retained ? 'Could not dismiss the SSH edit.' : 'Could not stop the SSH edit.');
    } finally {
      ownership.stopping.delete(edit.editId);
      if (owner.current === ownership) setPending(new Set(ownership.stopping));
    }
  };

  const needsEditor = openResult?.state === 'needsEditor';
  const editState = (edit: EditStatus) => edit.state === 'error' && edit.error === 'The server does not support atomic replacement.'
    ? 'unsupported' : edit.state;
  const summary = (edit: EditStatus) => `${edit.path} — ${editState(edit)}${edit.retained ? ' (retained)' : ''}`;
  const routine = edits.filter(edit => edit.state !== 'conflict' && edit.state !== 'error');
  const summaries = edits.filter(edit => edit.state === 'conflict' || edit.state === 'error').reverse().map(summary);
  if (needsEditor) summaries.unshift('Configure a default editor to open remote files.');
  if (failure) summaries.unshift(failure);
  const details = summaries.length > 0 || edits.length > 0 ? <section className="ssh-edit-warning" aria-label="Remote file edits">
    {needsEditor && <div>
      Configure a default editor to open remote files.
      <button type="button" className="au-btn" onClick={() => void import('../../services/openSettings').then(({ openSettingsTab }) => openSettingsTab('terminal'))}>Open editor settings</button>
    </div>}
    {failure && <div role="alert">{failure}</div>}
    {edits.length > 0 && <ul>
      {edits.map(edit => {
        // Rust currently reports unsupported atomic replacement as an error with this detail.
        const state = editState(edit);
        const showCopy = edit.retained || ['paused', 'conflict', 'error', 'unsupported'].includes(state);
        return <li key={edit.editId}>
          <span role="status">{summary(edit)}</span>
          {edit.error && <div>{edit.error}</div>}
          {showCopy && edit.localPath && <div>Local copy: <code>{displayLocalPath(edit.localPath)}</code></div>}
          <button type="button" className="au-btn"
            aria-label={edit.retained ? `Dismiss ${edit.path} (keeps the local copy)` : `Stop editing ${edit.path}`}
            disabled={pending.has(edit.editId)} onClick={() => void finish(edit)}>
            {edit.retained ? 'Dismiss (keeps the local copy)' : 'Stop'}
          </button>
        </li>;
      })}
    </ul>}
  </section> : null;
  return <>{children ? children(summaries, details, routine) : details}</>;
}
