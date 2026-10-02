import type { PaneNode } from '../store/slices/panesSlice';

// JSON counters are restricted to safe integers here; exhaustion refuses new work rather
// than rounding two identities to the same number. Rust counters remain checked u64s.
export type Counter = number;
export interface PaneIncarnation { pg: Counter; seq: Counter }
export type PageRegistration = { status: 'Retry' } | { status: 'Registered'; wi: Counter; pg: Counter };
export interface PaneDescriptor { paneId: string; leaf: string; restore?: boolean; override?: string }
export interface PaneEntry extends PaneDescriptor { pi: PaneIncarnation }
export type BindVia = 'restore' | 'reconcile' | 'transfer' | { offer: Counter };
export type CreateMode = 'Mount' | 'Restart';
export type PaneOp =
  | { kind: 'enter'; panes: PaneEntry[] }
  | { kind: 'depart' | 'close'; pi: PaneIncarnation }
  | { kind: 'admit_create'; pi: PaneIncarnation; mode: CreateMode }
  | { kind: 'bind'; pi: PaneIncarnation; pc: string; via: BindVia }
  | { kind: 'stash' | 'adopt'; tx: string; pairs: PaneEntry[] }
  | { kind: 'take' | 'cancel'; tx: string }
  | { kind: 'settle' };
export type PaneResult =
  | { status: 'Ok' | 'Inert' | 'Retry' | 'Pending' | 'Contended' }
  | { status: 'Create' | 'Join'; cg: Counter }
  | { status: 'Existing' | 'AlreadyBound'; pc: string }
  | { status: 'Taken'; payload: { panes: PaneDescriptor[] } }
  | { status: 'Rejected'; message: string };
export interface PaneRequest { pg: Counter; seq: Counter; op: PaneOp }
export type PaneReply = { status: 'Ack'; result: PaneResult } | { status: 'Resync'; nextSeq: Counter };
export interface AdmittedCreateRequest {
  pg: Counter; cg: Counter; leaf: string; profile: string; name?: string; cwd?: string;
  cols?: number; rows?: number; owningTabId?: string; sessionKey?: string; elevated?: boolean;
}
export interface PaneCommands {
  register_page: { args: undefined; result: PageRegistration };
  pane_op: { args: { request: PaneRequest }; result: PaneReply };
  create_admitted_terminal: { args: { request: AdmittedCreateRequest }; result: string };
  close_process: { args: { pc: string; reap: boolean }; result: PaneResult };
}
export type PaneBridge = <K extends keyof PaneCommands>(
  command: K, args: PaneCommands[K]['args'],
) => Promise<PaneCommands[K]['result']>;

export type PaneCapture = Promise<PaneIncarnation>;
type Slot = { descriptor: PaneDescriptor; pi: PaneCapture; suppressed: boolean; installed: boolean };
type Queued = { seq: number; op: () => Promise<PaneOp>; resolve: (result: PaneResult) => void };
const inert: PaneResult = { status: 'Inert' };
const missingCommand = (error: unknown): boolean => /(?:unknown|not found|not registered|does not exist).*command|command.*(?:unknown|not found|not registered|does not exist)/i.test(String(error));
const increment = (value: number): number => {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) throw new Error('pane sequence exhausted');
  return value + 1;
};

/** A page owns one FIFO. Transport failures never spend the head sequence number. */
export class PaneIncarnations {
  private registration?: Promise<{ wi: number; pg: number }>;
  private releaseRegistration?: (page: { wi: number; pg: number }) => void;
  private queue: Queued[] = [];
  private sequence = 0;
  private incarnation = 0;
  private slots = new Map<string, Slot>();
  private observed = new Set<string>();
  private staged = new Map<string, PaneDescriptor[]>();
  private timer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private sending = false;
  private stopped = false;
  private degraded: boolean;
  private failures = 0;
  private unsubscribe?: () => void;
  private readonly onUnload = (): void => this.stop();

  constructor(private readonly bridge?: PaneBridge, private readonly warn: () => void = () => {}) {
    this.degraded = !bridge;
  }

  get enabled(): boolean { return !this.degraded && !this.stopped; }
  get ended(): boolean { return this.stopped; }

  start(): void {
    if (this.registration || this.stopped) return;
    this.registration = new Promise(resolve => { this.releaseRegistration = resolve; });
    if (this.degraded) { this.releaseRegistration!({ wi: 0, pg: 0 }); return; }
    window.addEventListener('beforeunload', this.onUnload, { once: true });
    let delay = 50;
    const register = async (): Promise<void> => {
      try {
        const answer = await this.bridge!('register_page', undefined);
        if (this.stopped || this.degraded) return;
        if (answer.status === 'Registered') {
          if (!Number.isSafeInteger(answer.pg) || !Number.isSafeInteger(answer.wi)) throw new Error('page identity exhausted');
          this.releaseRegistration!(answer);
          return;
        }
      } catch (error) {
        if (missingCommand(error)) { this.degrade(); return; }
        this.failure();
      }
      if (this.stopped || this.degraded) return;
      this.timer = setTimeout(() => { this.timer = undefined; void register(); }, delay);
      delay = Math.min(delay * 2, 1000);
    };
    void register();
  }

  private failure(): void { if (++this.failures === 3) this.warn(); }

  private degrade(result: PaneResult = inert): void {
    this.degraded = true;
    this.attempt++;
    this.sending = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.releaseRegistration?.({ wi: 0, pg: 0 });
    this.queue.splice(0).forEach(item => item.resolve(result));
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    window.removeEventListener('beforeunload', this.onUnload);
    this.degrade({ status: 'Rejected', message: 'page ended' });
    this.slots.clear();
    this.observed.clear();
    this.staged.clear();
  }

  resync(): void {
    if (!this.enabled) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.attempt++;
    this.sending = false;
    void this.pump();
  }

  send(op: PaneOp | (() => Promise<PaneOp>)): Promise<PaneResult> {
    if (this.stopped) return Promise.resolve({ status: 'Rejected', message: 'page ended' });
    if (!this.enabled) return Promise.resolve(inert);
    this.start();
    this.sequence = increment(this.sequence);
    const result = new Promise<PaneResult>(resolve => this.queue.push({
      seq: this.sequence, op: typeof op === 'function' ? op : async () => op, resolve,
    }));
    void this.pump();
    return result;
  }

  private async pump(): Promise<void> {
    if (this.sending || this.timer !== undefined || !this.enabled || !this.queue.length) return;
    this.sending = true;
    const attempt = ++this.attempt;
    const head = this.queue[0];
    try {
      const page = await this.registration!;
      const op = await head.op();
      if (attempt !== this.attempt || !this.enabled) return;
      // A reply can be lost without the invoke rejecting. A late reply from this attempt
      // cannot acknowledge the next head; the backend caches the applied result.
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.failure();
        this.resync();
      }, 1000);
      const reply = await this.bridge!('pane_op', { request: { pg: page.pg, seq: head.seq, op } });
      if (attempt !== this.attempt || !this.enabled) return;
      clearTimeout(this.timer);
      this.timer = undefined;
      if (reply.status === 'Ack') {
        this.failures = 0;
        this.queue.shift();
        head.resolve(reply.result);
      }
    } catch (error) {
      if (attempt !== this.attempt) return;
      if (missingCommand(error)) { this.degrade(); return; }
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
      this.failure();
    }
    if (attempt !== this.attempt) return;
    this.sending = false;
    if (this.queue[0] === head) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); }, 50);
    } else {
      void this.pump();
    }
  }

  private mint(): PaneCapture {
    this.start();
    this.incarnation = increment(this.incarnation);
    const seq = this.incarnation;
    return this.registration!.then(page => ({ pg: page.pg, seq }));
  }

  /** Call before installing a normal pane. Transfer entries are made only by adopt. */
  prepare(panes: PaneDescriptor[]): PaneCapture[] {
    return panes.map(descriptor => {
      const old = this.slots.get(descriptor.paneId);
      if (old && old.descriptor.leaf === descriptor.leaf && !old.suppressed) return old.pi;
      if (old && !old.suppressed) void this.depart(old.pi);
      const pi = this.mint();
      this.slots.set(descriptor.paneId, { descriptor, pi, suppressed: false, installed: this.observed.has(descriptor.paneId) });
      void this.send(async () => ({ kind: 'enter', panes: [{ ...descriptor, pi: await pi }] }));
      return pi;
    });
  }

  discardPrepared(pis: PaneCapture[] = [...this.slots.values()].map(slot => slot.pi)): void {
    for (const slot of this.slots.values()) {
      if (!slot.installed && pis.includes(slot.pi)) void this.depart(slot.pi);
    }
  }

  capture(leaf: string, paneId?: string): PaneCapture | undefined {
    if (paneId) return this.slots.get(paneId)?.pi;
    return [...this.slots.values()].find(slot => slot.descriptor.leaf === leaf && !slot.suppressed)?.pi;
  }

  captureClose(leaf: string, paneId?: string): PaneCapture | undefined {
    const pi = this.capture(leaf, paneId);
    for (const slot of this.slots.values()) if (slot.pi === pi) slot.suppressed = true;
    return pi;
  }

  close(pi: PaneCapture): Promise<PaneResult> {
    for (const slot of this.slots.values()) if (slot.pi === pi) slot.suppressed = true;
    return this.send(async () => ({ kind: 'close', pi: await pi }));
  }

  depart(pi: PaneCapture): Promise<PaneResult> {
    for (const [id, slot] of this.slots) if (slot.pi === pi) this.slots.delete(id);
    return this.send(async () => ({ kind: 'depart', pi: await pi }));
  }

  bind(pi: PaneCapture, pc: string, via: BindVia): Promise<PaneResult> {
    return this.send(async () => ({ kind: 'bind', pi: await pi, pc, via }));
  }

  admit(pi: PaneCapture, mode: CreateMode): Promise<PaneResult> {
    return this.send(async () => ({ kind: 'admit_create', pi: await pi, mode }));
  }

  async create(cg: number, request: Omit<AdmittedCreateRequest, 'pg' | 'cg'>): Promise<string | undefined> {
    const { pg } = await this.registration!;
    try { return await this.bridge!('create_admitted_terminal', { request: { ...request, pg, cg } }); }
    catch (error) {
      if (!missingCommand(error)) throw error;
      this.degrade();
      return undefined;
    }
  }

  async reap(pc: string, fallback: () => Promise<void>): Promise<void> {
    if (!this.enabled) { await fallback(); return; }
    try { await this.bridge!('close_process', { pc, reap: true }); }
    catch (error) {
      if (!missingCommand(error)) throw error;
      this.degrade();
      await fallback();
    }
  }

  observe(panes: PaneDescriptor[]): void {
    const current = new Map(panes.map(pane => [pane.paneId, pane]));
    this.observed = new Set(current.keys());
    for (const [tx, panes] of this.staged) if (panes.every(pane => !current.has(pane.paneId))) this.staged.delete(tx);
    for (const [id, slot] of this.slots) {
      if (current.get(id)?.leaf === slot.descriptor.leaf) { slot.installed = true; continue; }
      if (!slot.installed) continue;
      this.slots.delete(id);
      if (!slot.suppressed) void this.depart(slot.pi);
    }
    this.prepare(panes.filter(pane => !this.slots.has(pane.paneId)));
  }

  attachStore(store: { getState: () => { panes: { treesByTabId: Record<string, PaneNode | null> }; tabs: { tabs: { id: string }[] } }; subscribe: (fn: () => void) => () => void }): void {
    const observe = () => {
      const state = store.getState();
      // Removed tabs can retain a tree until React's cleanup runs. They are no longer panes.
      const tabs = new Set(state.tabs.tabs.map(tab => tab.id));
      this.observe(Object.entries(state.panes.treesByTabId).flatMap(([id, tree]) => tabs.has(id) ? describePanes(tree) : []));
    };
    this.unsubscribe?.();
    this.unsubscribe = store.subscribe(observe);
    observe();
  }

  async stash(tx: string, panes: PaneDescriptor[]): Promise<PaneResult> {
    const sources = panes.map(pane => this.slots.get(pane.paneId));
    const captures = sources.map(slot => slot?.pi);
    if (captures.some(pi => !pi)) throw new Error('transfer source pane is not present');
    // Suppress the differ while the UI still contains the staged source copy.
    panes.forEach(pane => { this.slots.get(pane.paneId)!.suppressed = true; });
    this.staged.set(tx, sources.map(slot => slot!.descriptor));
    const result = await this.send(async () => ({ kind: 'stash', tx, pairs: await Promise.all(sources.map(async (slot, i) => ({ ...slot!.descriptor, pi: await captures[i]! }))) }));
    if (!accepted(result)) {
      this.staged.delete(tx);
      sources.forEach(slot => { if (slot) slot.suppressed = false; });
    }
    return result;
  }

  async cancel(tx: string, panes: PaneDescriptor[], processes: Map<string, string>): Promise<void> {
    const result = await this.send({ kind: 'cancel', tx });
    if (!accepted(result)) throw new Error(`transfer cancel ${result.status}`);
    const descriptors = this.staged.get(tx) ?? panes;
    this.staged.delete(tx);
    panes.forEach(pane => this.slots.delete(pane.paneId));
    const pis = this.prepare(descriptors);
    for (let i = 0; i < panes.length; i++) {
      const pc = processes.get(panes[i].leaf);
      if (pc) await this.bind(pis[i], pc, 'transfer');
    }
  }

  async installTransfer(tx: string, panes: PaneDescriptor[], install: () => void | Promise<void>): Promise<void> {
    const taken = await this.send({ kind: 'take', tx });
    if (taken.status !== 'Taken' && taken.status !== 'Inert') throw new Error(`transfer take ${taken.status}`);
    const descriptors = panes.map(pane => {
      const member = taken.status === 'Taken' ? taken.payload.panes.find(source => source.leaf === pane.leaf) : undefined;
      return { ...pane, restore: member?.restore ?? pane.restore, override: member?.override ?? pane.override };
    });
    const pis = descriptors.map(() => this.mint());
    const adopted = await this.send(async () => ({ kind: 'adopt', tx, pairs: await Promise.all(descriptors.map(async (pane, i) => ({ ...pane, pi: await pis[i] }))) }));
    if (!accepted(adopted)) throw new Error(`transfer adopt ${adopted.status}`);
    descriptors.forEach((descriptor, i) => this.slots.set(descriptor.paneId, { descriptor, pi: pis[i], suppressed: false, installed: false }));
    try { await install(); }
    catch (error) {
      for (const pi of pis) await this.depart(pi);
      throw error;
    }
  }
}

export const accepted = (result: PaneResult): boolean => ['Ok', 'Inert', 'Existing', 'AlreadyBound'].includes(result.status);
export function describePanes(tree: PaneNode | null, restore = false): PaneDescriptor[] {
  if (!tree) return [];
  if (tree.type === 'terminal' && tree.terminalId) return [{ paneId: tree.id, leaf: tree.terminalId, restore, override: tree.sessionKey }];
  return tree.children?.flatMap(child => describePanes(child, restore)) ?? [];
}

// Browser/older backends keep the original terminal path. Native bootstrap replaces this
// instance before installing the store differ; tests can install their own deferred bridge.
export let paneIncarnations = new PaneIncarnations();
export function installPaneIncarnations(client: PaneIncarnations): void { paneIncarnations.stop(); paneIncarnations = client; }
