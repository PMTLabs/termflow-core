import type { SshFileSession } from '../components/Ssh/ssh066Contract';
import type { CwdEvent, EditNotice, EditStatus, SshFileApi } from '../components/Ssh/sshFileTypes';

type FileEventsApi = Pick<SshFileApi, 'onFsEditState' | 'onFsCwd' | 'fsEditList'>;

interface FileListener {
  // Read live state at dispatch time, not a React render's captured snapshot.
  session(): SshFileSession;
  onEdit?(notice: EditNotice): void;
  onCwd?(event: CwdEvent): void;
}

function createFileEvents(api: FileEventsApi) {
  const listeners = new Map<string, Set<FileListener>>();
  let subscription: { stop(): void; ready: Promise<void> } | undefined;

  function subscribe() {
    let disposed = false;
    const unlisten: (() => void)[] = [];
    function route<T extends { terminalId: string; sessionGeneration: number }>(
      event: T, deliver: (listener: FileListener, session: SshFileSession) => void,
    ) {
      if (disposed) return;
      for (const listener of listeners.get(event.terminalId) ?? []) {
        const session = listener.session();
        if (session.generation !== undefined && event.sessionGeneration < session.generation) continue;
        deliver(listener, session);
      }
    }
    const keep = (stop: () => void) => { if (disposed) stop(); else unlisten.push(stop); };
    const ready = Promise.all([
      api.onFsEditState(notice => route(notice, (listener, session) => {
        if (notice.state === 'uploaded' && (!session.connected || session.generation !== notice.sessionGeneration)) return;
        listener.onEdit?.(notice);
      })).then(keep),
      api.onFsCwd(event => route(event, listener => listener.onCwd?.(event))).then(keep),
    ]).then(() => undefined);
    const stop = () => {
      if (disposed) return;
      disposed = true;
      unlisten.splice(0).forEach(unlistenEvent => unlistenEvent());
    };
    void ready.catch(stop); // Includes the desktop-only browser bridge.
    return { ready, stop };
  }

  return {
    register(terminalId: string, listener: FileListener) {
      const entry = { ...listener };
      const owners = listeners.get(terminalId) ?? new Set<FileListener>();
      listeners.set(terminalId, owners);
      owners.add(entry);
      const current = subscription ??= subscribe();
      let active = true;
      return {
        ready: current.ready,
        unregister() {
          if (!active) return;
          active = false;
          owners.delete(entry);
          if (owners.size === 0) listeners.delete(terminalId);
          if (listeners.size === 0) {
            current.stop();
            subscription = undefined;
          }
        },
      };
    },
  };
}

// The bridge object is window-local. All pane consumers share these two channels.
const services = new WeakMap<FileEventsApi, ReturnType<typeof createFileEvents>>();
export function sshFileEvents(api: FileEventsApi) {
  let service = services.get(api);
  if (!service) {
    service = createFileEvents(api);
    services.set(api, service);
  }
  return service;
}

/** Read-only seed; subscribe first so the caller can prefer newer live events. */
export async function rehydrateSshEdits(
  api: Pick<SshFileApi, 'fsEditList'>, terminalId: string,
): Promise<EditStatus[]> {
  const edits = await api.fsEditList({ terminalId, path: '.' });
  return edits.filter(edit => edit.terminalId === terminalId);
}
