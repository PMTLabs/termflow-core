import React, { createContext, useContext, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSelector, useStore } from 'react-redux';
import type { RootState } from '../../store';
import { filterSshConnections, selectSshSearchRows, type SshConnectionFilter } from '../../store/slices/sshSlice';
import { sshPickerUnavailable, type SshPickerLaunch } from '../../services/sshPicker';
import { useDialogA11y } from '../UI/useDialogA11y';
import '../Settings/Automations/AutomationsPanel.css';
import '../UI/GlobalDialog.css';
import './AllSshConnectionsDialog.css';

export interface SshPickerInvocation {
  launch: SshPickerLaunch;
  invoker: HTMLElement | null;
}

const PickerContext = createContext<((request: SshPickerInvocation) => void) | null>(null);
export const useOpenSshConnections = () => useContext(PickerContext);

export function SshConnectionsDialogHost({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<SshPickerInvocation | null>(null);
  const closePicker = () => setRequest(null);
  return <PickerContext.Provider value={setRequest}>
    {children}
    {request && <AllSshConnectionsDialog request={request} onClose={closePicker} />}
  </PickerContext.Provider>;
}

const filters: SshConnectionFilter[] = ['All', 'Bookmarked', 'Recent'];

export function AllSshConnectionsDialog({ request, onClose }: { request: SshPickerInvocation; onClose: () => void }) {
  const store = useStore<RootState>();
  const unavailable = useSelector(sshPickerUnavailable);
  const source = useSelector(selectSshSearchRows);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<SshConnectionFilter>('All');
  const [selectedId, setSelectedId] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const submitted = useRef(false);
  const composing = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const resultOption = useRef<HTMLDivElement>(null);
  const tablist = useRef<HTMLDivElement>(null);
  const id = useId();
  const rows = filterSshConnections(source, filter, search);
  const activeIndex = selectedId ? rows.findIndex(row => row.connection.id === selectedId) : -1;
  const active = rows[Math.max(0, activeIndex)]?.connection.id;
  // Keep the visible id across replacements; do not revive an old id if it reappears.
  if (active !== selectedId) setSelectedId(active);
  const activeDescendant = active ? `${id}-result-${active}` : undefined;
  useLayoutEffect(() => {
    resultOption.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeDescendant]);

  useDialogA11y(dialog, { isOpen: true, initialFocus: searchInput, returnFocus: request.invoker, onCancel: onClose });

  const activate = () => {
    if (!active || submitted.current || composing.current) return;
    const state = store.getState();
    // Store events can arrive before React has rendered the replacement rows.
    const why = sshPickerUnavailable(state);
    if (why) { setError(why); return; }
    if (!filterSshConnections(selectSshSearchRows(state), filter, search).some(row => row.connection.id === active)) return;

    submitted.current = true;
    const failure = request.launch(active);
    if (failure) {
      submitted.current = false;
      setError(failure);
    } else onClose();
  };

  const onResultsKey = (e: React.KeyboardEvent) => {
    if (composing.current || e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const index = Math.max(0, activeIndex);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1
      : e.key === 'ArrowUp' ? Math.max(0, index - 1)
      : e.key === 'ArrowDown' ? Math.min(rows.length - 1, index + 1) : null;
    if (next === null && e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    if (next !== null) setSelectedId(rows[next]?.connection.id);
    else if (!e.repeat && e.nativeEvent.keyCode !== 229) activate();
  };

  const changeSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    setSearch(e.target.value);
  };
  const startComposition = () => { composing.current = true; };
  const endComposition = () => { composing.current = false; };
  const onFilterKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const index = (filters.indexOf(filter) + (e.key === 'ArrowRight' ? 1 : -1) + filters.length) % filters.length;
    setFilter(filters[index]);
    tablist.current?.querySelectorAll('button')[index]?.focus();
  };

  return createPortal(
    <div className="global-dialog-overlay" onClick={onClose}>
      <div className="global-dialog-content ssh-picker" role="dialog" aria-modal="true"
        aria-labelledby={`${id}-title`} aria-describedby={`${id}-help`} ref={dialog} tabIndex={-1}
        onClick={e => e.stopPropagation()}
        onKeyDownCapture={e => {
          if (e.key === 'Enter' && (e.repeat || composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}>
        <h3 id={`${id}-title`}>All SSH Connections</h3>
        <p id={`${id}-help`}>Choose a saved connection to launch in the default shell after host verification. Recent lists launch attempts.</p>
        <label htmlFor={`${id}-search`}>Search SSH connections</label>
        <input id={`${id}-search`} ref={searchInput} type="search" role="combobox"
          aria-controls={`${id}-results`} aria-expanded="true" aria-autocomplete="list" aria-activedescendant={activeDescendant}
          value={search} onChange={changeSearch}
          onCompositionStart={startComposition} onCompositionEnd={endComposition}
          onKeyDown={onResultsKey} />
        <div ref={tablist} role="tablist" aria-label="Connection filter" className="au-seg" onKeyDown={onFilterKey}>
          {filters.map(value => <button key={value} type="button" role="tab" id={`${id}-${value}`}
            aria-controls={`${id}-panel`} aria-selected={filter === value} className={filter === value ? 'on' : undefined}
            tabIndex={filter === value ? 0 : -1} onClick={() => setFilter(value)}>{value}</button>)}
        </div>
        <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${filter}`}>
          <p role="status">{rows.length} {rows.length === 1 ? 'connection' : 'connections'}</p>
          {unavailable && <p role="status">{unavailable}</p>}
          {!rows.length && !unavailable && <p>No matching SSH connections.</p>}
          <div className="ssh-picker-results" role="listbox" aria-label="Saved SSH connections" id={`${id}-results`}
            aria-activedescendant={activeDescendant} tabIndex={0} onKeyDown={onResultsKey}>
            {rows.map(({ connection, host, breadcrumb }) => (
              <div key={connection.id} role="option" id={`${id}-result-${connection.id}`}
                ref={active === connection.id ? resultOption : undefined}
                aria-selected={active === connection.id} onClick={() => setSelectedId(connection.id)}>
                <strong>{connection.name}</strong>
                <span>{host} · {breadcrumb || 'Top level'}</span>
              </div>
            ))}
          </div>
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="dialog-footer">
          <button type="button" className="au-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="au-btn primary" disabled={!active || !!unavailable} onClick={activate}>Connect</button>
        </div>
      </div>
    </div>, document.body,
  );
}
