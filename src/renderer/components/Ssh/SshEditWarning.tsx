import React, { useEffect, useRef, useState } from 'react';
import { openSettingsTab } from '../../services/openSettings';
import { rehydrateSshEdits, sshFileEvents } from '../../services/sshFileEvents';
import { store } from '../../store';
import { readSshFileSession } from './ssh066Contract';
import type { EditOpen, EditStatus, SshFileApi } from './sshFileTypes';
import './SshEditWarning.css';
import '../Settings/Automations/AutomationsPanel.css';

interface Props {
  terminalId: string;
  openResult?: EditOpen;
  api?: SshFileApi;
}

// Mount once per owning pane, outside any collapsed/disconnected browser slot.
export function SshEditWarning({ terminalId, openResult, api = window.electronAPI?.ssh }: Props) {
  return <EditWarnings key={terminalId} terminalId={terminalId} openResult={openResult} api={api} />;
}

function EditWarnings({ terminalId, openResult, api }: Props) {
  const [edits, setEdits] = useState<EditStatus[]>([]);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<string>();
  const owner = useRef<{ stopping: Set<string>; stopped: Set<string> } | undefined>(undefined);

  useEffect(() => {
    if (!api?.onFsEditState) return;
    const ownership = { stopping: new Set<string>(), stopped: new Set<string>() };
    owner.current = ownership;
    const touched = new Set<string>();
    let seeding = true;
    const session = () => readSshFileSession(store.getState().sshSession, terminalId);
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
  }, [api, terminalId]);

  const stop = async (edit: EditStatus) => {
    const ownership = owner.current;
    if (!api || !ownership || ownership.stopping.has(edit.editId)) return;
    ownership.stopping.add(edit.editId);
    setPending(new Set(ownership.stopping));
    setFailure(undefined);
    try {
      const result = await api.fsEditStop({ terminalId, path: edit.path, editId: edit.editId });
      if (owner.current !== ownership) return;
      ownership.stopped.add(edit.editId);
      setEdits(rows => result.retained
        ? rows.map(row => row.editId === edit.editId ? {
          ...row, state: row.state === 'conflict' || row.state === 'error' ? row.state : 'paused',
          ...result, localPath: result.localPath ?? row.localPath,
        } : row)
        : rows.filter(row => row.editId !== edit.editId));
    } catch {
      if (owner.current === ownership) setFailure('Could not stop the SSH edit.');
    } finally {
      ownership.stopping.delete(edit.editId);
      if (owner.current === ownership) setPending(new Set(ownership.stopping));
    }
  };

  const needsEditor = openResult?.state === 'needsEditor';
  if (!needsEditor && !edits.length && !failure) return null;
  return <section className="ssh-edit-warning" aria-label="Remote file edits">
    {needsEditor && <div>
      Configure a default editor to open remote files.
      <button type="button" className="au-btn" onClick={() => openSettingsTab('terminal')}>Open editor settings</button>
    </div>}
    {failure && <div role="alert">{failure}</div>}
    {edits.length > 0 && <ul>
      {edits.map(edit => {
        // Rust currently reports unsupported atomic replacement as an error with this detail.
        const state = edit.state === 'error' && edit.error === 'The server does not support atomic replacement.'
          ? 'unsupported' : edit.state;
        const showCopy = edit.retained || ['paused', 'conflict', 'error', 'unsupported'].includes(state);
        return <li key={edit.editId}>
          <span role="status">{edit.path} — {state}{edit.retained && ' (retained)'}</span>
          {edit.error && <div>{edit.error}</div>}
          {showCopy && edit.localPath && <div>Local copy: <code>{edit.localPath}</code></div>}
          {!edit.retained && <button type="button" className="au-btn" aria-label={`Stop editing ${edit.path}`}
            disabled={pending.has(edit.editId)} onClick={() => void stop(edit)}>Stop</button>}
        </li>;
      })}
    </ul>}
  </section>;
}
