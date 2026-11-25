import { useLayoutEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { store, type RootState } from '../../store';
import { addToast } from '../../store/slices/uiSlice';
import { sshFileEvents } from '../../services/sshFileEvents';
import { readSshFileSession, readSshLaunchState, type SshBrowserTagPatch, type SshPaneTag } from './ssh066Contract';
import type { FsError, FsRequest, RemoteEntry, RemoteListing, SshFileApi } from './sshFileTypes';
import { validRemoteName } from './sshFileMenu';

export interface SshBrowserControllerProps {
  terminalId: string;
  sshTag: SshPaneTag;
  surfaceActive: boolean;
  onPatchTag(patch: SshBrowserTagPatch): void;
}

interface BrowserEpoch {
  generation: number;
  key: string;
  createRequest?: number;
  rootPending: boolean;
  followToken?: symbol;
  pendingCwd?: string;
  flushCwd?: () => void;
}

export function sshBrowserEpochKey(state: RootState, terminalId: string): string | undefined {
  const { generation, connected } = readSshFileSession(state.sshSession, terminalId);
  const launch = readSshLaunchState(state, terminalId);
  if (!connected || generation === undefined || launch?.stage !== 'running'
      || launch.sessionGeneration !== generation) return undefined;
  return `${generation}:${launch.launchSeq}`;
}

function describeFailure(error: unknown, path: string): string {
  const detail = error as Partial<FsError> | undefined;
  if (detail?.code === 'permissionDenied') return `Permission denied: ${path}`;
  return `${path}: ${detail?.message || (typeof error === 'string' ? error : 'Remote file operation failed.')}`;
}

interface ChildListing { entries?: RemoteEntry[]; error?: string }
interface Confirmed { listing: RemoteListing; epoch: BrowserEpoch; loadedAt: Date }
export type CreateKind = 'folder' | 'file';

export interface SshRowScope {
  api: SshFileApi;
  request: FsRequest;
  isCurrent(): boolean;
  isLive(): boolean;
  refresh(): Promise<boolean>;
}

export function useSshFileBrowser({ terminalId, sshTag, surfaceActive, onPatchTag }: SshBrowserControllerProps) {
  const api = window.electronAPI?.ssh;
  const key = useSelector((state: RootState) => sshBrowserEpochKey(state, terminalId));
  const epoch = useRef<BrowserEpoch | undefined>(undefined);
  const ended = useSelector((state: RootState) => readSshLaunchState(state, terminalId)?.stage === 'ended');
  const sequence = useRef(0);
  const latestRootRequest = useRef(0);
  const rootVersion = useRef(0);
  const childRequests = useRef(new Map<string, number>());
  const latest = useRef({ sshTag, onPatchTag });
  const confirmed = useRef<Confirmed | undefined>(undefined);
  const [current, setCurrent] = useState<Confirmed>();
  const [draft, setDraft] = useState(sshTag.browserPath ?? '');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [reported, setReported] = useState(false);
  const [children, setChildren] = useState<Record<string, ChildListing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>();
  const [restart, setRestart] = useState(0);
  const active = surfaceActive && !sshTag.browserCollapsed;

  useLayoutEffect(() => { latest.current = { sshTag, onPatchTag }; }, [sshTag, onPatchTag]);

  function isCurrent(owner: BrowserEpoch): boolean {
    return epoch.current === owner && sshBrowserEpochKey(store.getState(), terminalId) === owner.key;
  }

  function resetTree() {
    rootVersion.current++;
    childRequests.current.clear();
    setChildren({}); setExpanded(new Set()); setSelected(undefined);
  }

  async function list(path: string, owner: BrowserEpoch, source: 'manual' | 'follow' | 'refresh' = 'manual'): Promise<boolean> {
    if (!api || !isCurrent(owner) || (owner.createRequest && source !== 'refresh')) return false;
    const request = ++sequence.current;
    latestRootRequest.current = request;
    const followToken = owner.followToken;
    const stillLatest = () => isCurrent(owner) && request === latestRootRequest.current;
    const allowed = () => source !== 'follow' || (followToken === owner.followToken && latest.current.sshTag.followCd);
    owner.rootPending = true;
    resetTree();
    setLoading(true); setError(undefined);
    try {
      const listing = await api.fsList({ terminalId, path, expectedGeneration: owner.generation });
      if (!stillLatest() || listing.sessionGeneration !== owner.generation) return false;
      if (!allowed()) return false;
      const next = { listing, epoch: owner, loadedAt: new Date() };
      confirmed.current = next;
      setCurrent(next); setDraft(listing.path);
      if (latest.current.sshTag.browserPath !== listing.path) latest.current.onPatchTag({ browserPath: listing.path });
      return true;
    } catch (failure) {
      if (stillLatest() && allowed()) {
        setError(describeFailure(failure, path));
        setDraft(confirmed.current?.listing.path ?? latest.current.sshTag.browserPath ?? '');
      }
      return false;
    } finally {
      if (stillLatest()) {
        owner.rootPending = false;
        setLoading(false);
        if (!owner.createRequest) owner.flushCwd?.();
      }
    }
  }

  // The terminal's ssh is over (the user quit it, or it died): its listing describes a session
  // that no longer exists, so clear it. A file channel that drops while ssh still runs keeps the
  // dimmed listing. Declared before the reset below, which reads `confirmed`. The tag's path stays,
  // so a reconnect lists the same directory again.
  useLayoutEffect(() => {
    if (!ended) return;
    confirmed.current = undefined;
    setCurrent(undefined);
  }, [ended]);

  useLayoutEffect(() => {
    setError(undefined); setLoading(false); setCreating(false); setReported(false); resetTree();
    setDraft(confirmed.current?.listing.path ?? latest.current.sshTag.browserPath ?? '');
    if (!active || !api || key === undefined) return;
    const { generation } = readSshFileSession(store.getState().sshSession, terminalId);
    if (generation === undefined || sshBrowserEpochKey(store.getState(), terminalId) !== key) return;
    const owner: BrowserEpoch = { generation, key, rootPending: false };
    epoch.current = owner;
    // Invalidate synchronously even if Redux observations are batched into one render.
    const stop = store.subscribe(() => {
      if (epoch.current === owner && !isCurrent(owner)) {
        epoch.current = undefined;
        setRestart(value => value + 1);
      }
    });
    void list(latest.current.sshTag.browserPath ?? confirmed.current?.listing.path ?? '.', owner);
    return () => {
      stop();
      if (epoch.current === owner) epoch.current = undefined;
    };
  }, [active, api, key, terminalId, restart]);

  useLayoutEffect(() => {
    const owner = epoch.current;
    if (!active || !api || !owner || !sshTag.followCd) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (timer !== undefined || owner.rootPending || owner.createRequest || !isCurrent(owner)) return;
      const path = owner.pendingCwd;
      owner.pendingCwd = undefined;
      if (path && path !== confirmed.current?.listing.path) void list(path, owner, 'follow');
    };
    owner.followToken = Symbol();
    owner.flushCwd = flush;
    const registration = sshFileEvents(api).register(terminalId, {
      session: () => readSshFileSession(store.getState().sshSession, terminalId),
      onCwd(event) {
        if (!isCurrent(owner) || event.sessionGeneration !== owner.generation) return;
        setReported(true);
        owner.pendingCwd = event.path;
        clearTimeout(timer);
        timer = setTimeout(() => { timer = undefined; flush(); }, 75);
      },
    });
    return () => {
      registration.unregister(); clearTimeout(timer);
      owner.followToken = undefined;
      owner.flushCwd = undefined; owner.pendingCwd = undefined;
    };
  }, [active, api, key, terminalId, restart, sshTag.followCd]);

  const online = active && !!api && key !== undefined;
  const live = online && !!current && current.epoch === epoch.current && current.epoch.key === key;
  const stale = !!current && !live;
  const canUseRows = live && !loading && !creating;
  const path = current?.listing.path;

  function navigate(target: string) {
    const owner = epoch.current;
    if (owner && target) void list(target, owner);
  }

  function refresh() {
    navigate(path ?? sshTag.browserPath ?? '.');
  }

  function toggleFolder(entry: RemoteEntry) {
    const owner = epoch.current;
    if (!api || !entry.path || !owner || !canUseRows || owner.rootPending || owner.createRequest || !isCurrent(owner)) return;
    const willExpand = !expanded.has(entry.path);
    setExpanded(previous => {
      const next = new Set(previous);
      if (willExpand) next.add(entry.path); else next.delete(entry.path);
      return next;
    });
    if (!willExpand || children[entry.path]?.entries || childRequests.current.has(entry.path)) return;
    const request = ++sequence.current;
    const version = rootVersion.current;
    childRequests.current.set(entry.path, request);
    const valid = () => isCurrent(owner) && version === rootVersion.current && childRequests.current.get(entry.path) === request;
    setChildren(previous => ({ ...previous, [entry.path]: {} }));
    void (async () => {
      try {
        const listing = await api.fsList({ terminalId, path: entry.path, expectedGeneration: owner.generation });
        if (valid() && listing.sessionGeneration === owner.generation) {
          setChildren(previous => ({ ...previous, [entry.path]: { entries: listing.entries } }));
        }
      } catch (failure) {
        if (valid()) setChildren(previous => ({ ...previous, [entry.path]: { error: describeFailure(failure, entry.path) } }));
      } finally {
        if (valid()) childRequests.current.delete(entry.path);
      }
    })();
  }
  async function create(kind: CreateKind, name: string): Promise<{ error?: string; acknowledged?: boolean }> {
    const owner = epoch.current;
    if (!api || !owner || !path || !canUseRows || owner.rootPending || owner.createRequest || !isCurrent(owner)) {
      return { error: 'The directory is not available.' };
    }
    if (!validRemoteName(name)) {
      return { error: 'Enter a single valid remote name.' };
    }
    const target = { terminalId, expectedGeneration: owner.generation, path: `${path === '/' ? '' : path}/${name}` };
    const request = ++sequence.current;
    owner.createRequest = request;
    setCreating(true);
    try {
      if (kind === 'folder') await api.fsMkdir(target); else await api.fsCreate(target);
      const valid = () => isCurrent(owner) && owner.createRequest === request;
      if (!valid() || !(await list(path, owner, 'refresh')) || !valid()) {
        return { acknowledged: true, error: 'Created on the server, but the directory could not be refreshed.' };
      }
      store.dispatch(addToast({ type: 'success', message: kind === 'folder' ? 'Folder created.' : 'File created.' }));
      return {};
    } catch (failure) {
      return { error: describeFailure(failure, target.path) };
    } finally {
      owner.createRequest = undefined;
      if (isCurrent(owner)) { setCreating(false); owner.flushCwd?.(); }
    }
  }

  const isLiveNow = () => !!current && confirmed.current === current && canUseRows && !current.epoch.rootPending
    && !current.epoch.createRequest && isCurrent(current.epoch);

  function captureRow(path: string): SshRowScope | undefined {
    if (!api || !current || !isLiveNow()) return;
    const owner = current.epoch;
    const version = rootVersion.current;
    const sameListing = () => isCurrent(owner) && rootVersion.current === version;
    const isLive = () => sameListing() && !owner.rootPending && !owner.createRequest;
    return {
      api, request: { terminalId, path, expectedGeneration: owner.generation },
      isCurrent: () => isCurrent(owner), isLive,
      refresh: async () => isLive() && list(current.listing.path, owner, 'refresh'),
    };
  }

  return { path, draft, setDraft, navigate, refresh, online, live, stale, loading, creating, error,
    entries: current?.listing.entries, loadedAt: current?.loadedAt, canUseRows, create, reported,
    children, expanded, toggleFolder, selected, setSelected, isLiveNow, captureRow,
  };
}
