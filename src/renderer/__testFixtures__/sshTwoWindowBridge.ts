import { createSshBridge } from '../api/sshBridge';
import type { LaunchAttemptRef, LaunchSnapshot, SshConnection, SshLaunchEvent, SshPromptReceipt, SshReply, SshSessionView } from '../types/ssh';
import type { PaneBridge, PaneRequest } from '../services/paneIncarnations';
import type { CanvasEdge } from '../store/slices/canvasSlice';
import { gatedBridge } from './gatedBridge';

export function sshTwoWindowBridge(initial: SshReply, isTagged: (id: string, connectionId: string) => boolean) {
  let saved = initial;
  const held = gatedBridge();
  const mutations: SshReply[] = [];
  const invokes: { window: 'A' | 'B'; command: string; args?: Record<string, unknown> }[] = [];
  const writes: { terminalId: string; processId: string; data: string }[] = [];
  const admitted: string[] = [];
  const order: string[] = [];
  const sessions = new Map<string, SshSessionView>();
  const snapshots = new Map<string, LaunchSnapshot>();
  const processes = new Map<string, string>();
  const paneLeaves = new Map<string, string>();
  const paneKey = ({ pg, seq }: { pg: number; seq: number }) => `${pg}:${seq}`;
  let nextGeneration = 0;
  let nextProcess = 0;
  let nextCreate = 0;
  let nextEdge = 0;
  let holdEdges = false;
  let holdCreate = false;
  let opening: Partial<SshSessionView> = {};
  const serverEdges: CanvasEdge[] = [];
  const endpoints = { A: endpoint('A'), B: endpoint('B') };

  function endpoint(window: 'A' | 'B') {
    const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
    const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach(fn => fn({ payload }));
    const listen = async <T,>(event: string, callback: (event: { payload: T }) => void) => {
      const listenersForEvent = listeners.get(event) ?? new Set();
      listeners.set(event, listenersForEvent);
      const handler = (message: { payload: unknown }) => callback({ payload: message.payload as T });
      listenersForEvent.add(handler);
      return () => { listenersForEvent.delete(handler); };
    };
    const record = (command: string, args?: Record<string, unknown>) => invokes.push({ window, command, args });
    function save(connections: SshConnection[]) {
      const revision = saved.revision + 1;
      saved = { revision, view: { ...saved.view, revision, connections } };
      mutations.push(saved);
      return saved;
    }
    const matching = (id: string, attempt: LaunchAttemptRef) => {
      const previous = snapshots.get(id);
      if (!previous || previous.attempt.sessionGeneration !== attempt.sessionGeneration ||
          previous.attempt.processIncarnation !== attempt.processIncarnation ||
          previous.attempt.ownerIncarnation.pg !== attempt.ownerIncarnation.pg ||
          previous.attempt.ownerIncarnation.seq !== attempt.ownerIncarnation.seq) throw { code: 'StaleAttempt' };
      return previous;
    };
    const invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      record(command, args);
      const { id, bookmarked, terminalId, connectionId, attempt } = args ?? {};
      switch (command) {
        case 'ssh_store_get': return await held.command(`${window}:get`)() as T;
        case 'ssh_set_bookmark': return save(saved.view.connections.map(row => row.id === id ? { ...row, bookmarked: !!bookmarked } : row)) as T;
        case 'ssh_connection_delete': return save(saved.view.connections.filter(row => row.id !== id)) as T;
        case 'ssh_connection_mark_used': return saved as T;
        case 'ssh_terminal_launch': {
          const leaf = terminalId as string;
          const qualified = attempt as LaunchAttemptRef;
          const session = sessions.get(leaf)!;
          if (session.generation !== qualified.sessionGeneration || session.generation !== qualified.attemptReceipt.generation ||
              processes.get(leaf) !== qualified.processIncarnation || snapshots.has(leaf)) throw { code: 'StaleAttempt' };
          const snapshot: LaunchSnapshot = { terminalId: leaf, connectionId: connectionId as string, attempt: qualified,
            stage: 'waiting-trust', launchSeq: 1, revision: 1 };
          snapshots.set(leaf, snapshot);
          drive(leaf, session);
          return snapshots.get(leaf) as T;
        }
        case 'ssh_terminal_launch_state': return matching(terminalId as string, attempt as LaunchAttemptRef) as T;
        case 'ssh_terminal_cancel_launch': {
          const previous = matching(terminalId as string, attempt as LaunchAttemptRef);
          const next = { ...previous, stage: 'cancelled' as const, revision: previous.revision + 1 };
          snapshots.set(previous.terminalId, next);
          return next as T;
        }
        default: throw new Error(`Unexpected SSH IPC ${command}`);
      }
    };
    const paneInvoke = (async (command: string, args?: Record<string, unknown>) => {
      record(command, args);
      switch (command) {
        case 'register_page': return { status: 'Registered', wi: 2, pg: 41 };
        case 'pane_op': {
          const { op } = args!.request as PaneRequest;
          if (op.kind === 'enter' || op.kind === 'adopt') {
            for (const pane of op.kind === 'enter' ? op.panes : op.pairs) paneLeaves.set(paneKey(pane.pi), pane.leaf);
          }
          if (op.kind === 'close') {
            const key = paneKey(op.pi);
            const leaf = paneLeaves.get(key);
            if (leaf) {
              paneLeaves.delete(key);
              processes.delete(leaf);
              sessions.delete(leaf);
              snapshots.delete(leaf);
              for (let i = serverEdges.length - 1; i >= 0; i--) {
                if (serverEdges[i].from === leaf || serverEdges[i].to === leaf) serverEdges.splice(i, 1);
              }
            }
          }
          return { status: 'Ack', result: op.kind === 'admit_create'
            ? { status: 'Create', cg: ++nextCreate } : { status: 'Ok' } };
        }
        case 'create_admitted_terminal': {
          const { leaf } = args!.request as { leaf: string };
          const pc = `pc-${++nextProcess}`;
          processes.set(leaf, pc);
          if (holdCreate) await held.command('create-reply')(leaf, pc);
          return pc;
        }
        case 'close_process': return { status: 'Ok' };
        default: throw new Error(`Unexpected pane IPC ${command}`);
      }
    }) as PaneBridge;
    return { emit, api: {
      paneInvoke,
      ssh: createSshBridge(invoke, listen),
      getWindowLabel: () => window,
      setDefaultProfile: async () => {},
      takeReattachPromptHook: async () => null,
      onTerminalData: () => () => {}, onTerminalExit: () => () => {},
      updateTerminalName: async () => true,
      writeToTerminal: async (processId: string, data: string) => {
        record('write_to_terminal', { processId, data });
        writes.push({ terminalId: [...processes].find(([, pc]) => pc === processId)![0], processId, data });
      },
      onSshSessionState: (listener: (view: SshSessionView) => void) =>
        listen<SshSessionView>('ssh-session:state', ({ payload }) => listener(payload)),
      onSshLaunchState: (listener: (event: SshLaunchEvent) => void) =>
        listen<SshLaunchEvent>('ssh-launch:state', ({ payload }) => listener(payload)),
      sshSessionState: async (terminalId: string) => {
        record('ssh_session_state', { terminalId });
        const view = sessions.get(terminalId);
        if (!view) throw { code: 'not-found' };
        return view;
      },
      sshSessionOpen: async (terminalId: string, connectionId: string) => {
        if (isTagged(terminalId, connectionId)) order.push(`tagged:${terminalId}`);
        order.push(`ssh_session_open:${terminalId}`);
        record('ssh_session_open', { terminalId, connectionId });
        const view: SshSessionView = { terminalId, connectionId, generation: ++nextGeneration, revision: 1,
          state: 'connecting', gate: 'verified', ...opening };
        sessions.set(terminalId, view);
        drive(terminalId, view);
        emit('ssh-session:state', view);
        return view;
      },
      sshSessionTrustHost: async (terminalId: string, accept: boolean, receipt: SshPromptReceipt) => {
        record('ssh_session_trust_host', { terminalId, accept, ...receipt });
        const current = sessions.get(terminalId)!;
        if (current.generation !== receipt.generation || current.promptId !== receipt.promptId || current.hostKey?.changed) throw { code: 'StaleAttempt' };
        transition(terminalId, { state: 'connecting', gate: accept ? 'verified' : 'blocked', promptId: undefined });
      },
      canvasApiRequest: async (path: string, init?: { method?: string; body?: unknown }) => {
        record(`${init?.method ?? 'GET'} ${path}`, { body: init?.body });
        if (path === '/canvas/graph') return { edges: [...serverEdges] };
        if (path === '/canvas/edges' && init?.method === 'POST') {
          const { from, to, label } = init.body as Pick<CanvasEdge, 'from' | 'to' | 'label'>;
          const edge: CanvasEdge = { id: `server-${++nextEdge}`, from, to, label, origin: 'user', createdAt: nextEdge };
          serverEdges.push(edge);
          if (holdEdges) await held.command('edge-reply')(edge);
          return edge;
        }
        return null;
      },
    } };
  }

  // The invoke registers/locks the attempt, even when pending. Writer admission is
  // native and consults the authoritative receipt, never the published UI state.
  function drive(id: string, view: SshSessionView) {
    order.push(`gate:${view.gate}:${id}`);
    const previous = snapshots.get(id);
    if (!previous || previous.stage !== 'waiting-trust') return;
    if (view.gate === 'pending') return;
    if (view.gate === 'blocked') {
      if (view.state === 'error' || view.state === 'disconnected') {
        snapshots.set(id, { ...previous, stage: 'blocked', revision: previous.revision + 1 });
      }
      return;
    }
    admitted.push(id);
    order.push(`ssh_terminal_launch:${id}`);
    writes.push({ terminalId: id, processId: previous.attempt.processIncarnation, data: `native-ssh:${view.connectionId}` });
    snapshots.set(id, { ...previous, stage: 'typed', revision: previous.revision + 1 });
  }
  function transition(id: string, patch: Partial<SshSessionView>) {
    const previous = sessions.get(id)!;
    const next = { ...previous, ...patch, revision: previous.revision! + 1 };
    sessions.set(id, next);
    drive(id, next);
    endpoints.B.emit('ssh-session:state', next);
  }
  return { ...endpoints, held, invokes, mutations, writes, admitted, order, sessions, snapshots, serverEdges, transition,
    opening: (view: Partial<SshSessionView>) => { opening = view; },
    holdEdgeReplies: () => { holdEdges = true; }, holdCreateReplies: () => { holdCreate = true; },
  };
}
