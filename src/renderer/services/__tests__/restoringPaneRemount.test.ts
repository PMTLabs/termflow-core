/** @jest-environment jsdom */
import { configureStore } from '@reduxjs/toolkit';
import tabsReducer, { addTab } from '../../store/slices/tabsSlice';
import panesReducer, { addTabTree, setActiveTabId, splitPaneWithTab, type PaneNode } from '../../store/slices/panesSlice';
import { describePanes, PaneIncarnations, type PaneBridge, type PaneEntry, type PaneRequest } from '../paneIncarnations';
import { TerminalServiceClass } from '../TerminalService';

const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

beforeEach(() => { jest.useFakeTimers(); delete (window as any).electronAPI; });
afterEach(() => { jest.useRealTimers(); });

test.each([undefined, 'tb-legacy-session'])('split remount inherits a waiting holder and exact key (%s)', async override => {
  const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } });
  const tree: PaneNode = { id: 'pn-wait', type: 'terminal', terminalId: 'tm-wait' };
  const key = override ?? 'tm-wait~00000000000040008000000000000001';
  const requests: PaneRequest[] = [];
  const present = new Map<number, PaneEntry>();
  const holders = new Set<number>();
  const admissions = new Map<number, number>();
  const frames: Array<{ kind: 'Spawn' | 'Attach'; leaf: string; key: string }> = [];
  const waitStates: unknown[] = [];
  let listed = false;
  let generation = 0;
  const bridge = jest.fn(async (command: string, args: any) => {
    if (command === 'register_page') return { status: 'Registered', wi: 1, pg: 10 };
    if (command === 'pane_op') {
      const request: PaneRequest = args.request;
      requests.push(request);
      const op = request.op;
      if (op.kind === 'enter') {
        op.panes.forEach(entry => { present.set(entry.pi.seq, entry); if (entry.restore) holders.add(entry.pi.seq); });
      } else if (op.kind === 'depart') {
        holders.delete(op.pi.seq); present.delete(op.pi.seq);
        if ([...present.values()].some(entry => entry.leaf === 'tm-wait')) expect(holders.size).toBe(1);
      } else if (op.kind === 'admit_create') {
        admissions.set(++generation, op.pi.seq);
        return { status: 'Ack', result: { status: 'Create', cg: generation } };
      }
      return { status: 'Ack', result: { status: 'Ok' } };
    }
    if (command === 'create_admitted_terminal') {
      const request = args.request;
      const entry = present.get(admissions.get(request.cg)!)!;
      if (entry.leaf === 'tm-wait') {
        expect(holders.has(entry.pi.seq)).toBe(true);
        expect(request.sessionKey).toBe(override);
        if (!listed) throw new Error('host-ownership-pending: late listing');
        frames.push({ kind: 'Attach', leaf: entry.leaf, key });
        holders.delete(entry.pi.seq);
        return 'pc-original';
      }
      frames.push({ kind: 'Spawn', leaf: entry.leaf, key: 'fresh-key' });
      return 'pc-fresh';
    }
    throw new Error(command);
  }) as unknown as PaneBridge;
  const client = new PaneIncarnations(bridge);
  const service = new TerminalServiceClass(() => store.getState().panes.treesByTabId, () => ({ createTerminal: jest.fn() } as any), () => client);
  const onWait = (event: Event) => { if ((event as CustomEvent).detail.terminalId === 'tm-wait') waitStates.push((event as CustomEvent).detail.state); };
  window.addEventListener('pty:host-wait', onWait);
  try {
    const [old] = client.prepare([{ ...describePanes(tree, true)[0], override }]);
    store.dispatch(addTab({ id: 'tb-wait', title: 'Waiting' }));
    store.dispatch(addTabTree({ tabId: 'tb-wait', tree }));
    store.dispatch(setActiveTabId('tb-wait'));
    client.attachStore(store);
    const mount = (leaf: string, paneId: string) => service.createTerminal(leaf, 'default', undefined, undefined, undefined, undefined, 'tb-wait', undefined, false, 'Mount', paneId);
    const first = mount('tm-wait', tree.id);
    await flush();
    expect(service.getHostWaitState('tm-wait')).toBe('waiting');
    expect(frames).toHaveLength(0);
    waitStates.length = 0;
    store.dispatch(splitPaneWithTab.fulfilled({ paneId: tree.id, direction: 'horizontal', position: 'after', shellType: 'default', newTerminalId: 'tm-fresh', uniqueTitle: 'Fresh', uniqueOriginalTitle: 'Waiting' }, 'split-request', { paneId: tree.id, direction: 'horizontal' }));
    const panes = describePanes(store.getState().panes.treesByTabId['tb-wait']);
    const successor = panes.find(pane => pane.leaf === 'tm-wait')!;
    expect(successor.paneId).not.toBe(tree.id);
    const replacement = client.capture(successor.leaf, successor.paneId)!;
    expect(replacement).not.toBe(old);
    const remount = mount(successor.leaf, successor.paneId);
    const freshPane = panes.find(pane => pane.leaf === 'tm-fresh')!;
    const fresh = mount(freshPane.leaf, freshPane.paneId);
    await flush();
    const entered = requests.flatMap(request => request.op.kind === 'enter' ? request.op.panes : []).filter(entry => entry.leaf === 'tm-wait');
    expect(entered).toEqual([
      { paneId: tree.id, leaf: 'tm-wait', restore: true, override, pi: await old },
      { ...successor, restore: true, override, pi: await replacement },
    ]);
    expect(requests.findIndex(request => request.op.kind === 'depart')).toBeGreaterThan(requests.findIndex(request => request.op.kind === 'enter' && request.op.panes.some(entry => entry.paneId === successor.paneId)));
    expect(frames).toEqual([{ kind: 'Spawn', leaf: 'tm-fresh', key: 'fresh-key' }]);
    expect(waitStates).not.toContain(undefined);
    expect(service.getHostWaitState('tm-wait')).toBe('waiting');
    listed = true;
    await jest.advanceTimersByTimeAsync(1000);
    expect(await first).toBe('');
    expect(await remount).toBe('pc-original');
    expect(await fresh).toBe('pc-fresh');
    expect(frames.filter(frame => frame.leaf === 'tm-wait' && frame.kind === 'Spawn')).toHaveLength(0);
    expect(frames.filter(frame => frame.kind === 'Attach')).toEqual([{ kind: 'Attach', leaf: 'tm-wait', key }]);
    expect(service.getProcessId('tm-wait')).toBe('pc-original');
    expect(holders.size).toBe(0);
    expect(service.getHostWaitState('tm-wait')).toBeUndefined();
    expect(client.restoreKey(replacement)).toBeUndefined();
    const [resolvedCopy] = client.prepare([{ paneId: 'pn-resolved-copy', leaf: 'tm-wait' }]);
    await flush();
    expect(requests.at(-1)?.op).toEqual({ kind: 'enter', panes: [{ paneId: 'pn-resolved-copy', leaf: 'tm-wait', pi: await resolvedCopy }] });
  } finally {
    window.removeEventListener('pty:host-wait', onWait);
    client.stop();
  }
});
