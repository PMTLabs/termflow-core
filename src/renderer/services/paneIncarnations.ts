import type { PaneNode } from '../store/slices/panesSlice';
import { captureWorkspace, isCurrentWorkspace } from './workspaceReplacement';
import { retireTerminalInitGuards } from './terminalInitGuards';

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
  | { kind: 'stash'; tx: string; pairs: PaneEntry[]; ui?: unknown }
  | { kind: 'adopt'; tx: string; pairs: PaneEntry[] }
  | { kind: 'take' | 'cancel'; tx: string }
  | { kind: 'replace_page' | 'settle' };
export type PaneResult =
  | { status: 'Ok' | 'Inert' | 'Retry' | 'Pending' | 'Contended' }
  | { status: 'Create' | 'Join'; cg: Counter }
  | { status: 'Existing' | 'AlreadyBound'; pc: string }
  | { status: 'Taken'; payload: { panes: PaneDescriptor[]; ui?: unknown } }
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
  wait_transfer_taken: { args: { pg: number; tx: string }; result: boolean };
}
export type PaneBridge = <K extends keyof PaneCommands>(
  command: K, args: PaneCommands[K]['args'],
) => Promise<PaneCommands[K]['result']>;

export type PaneCapture = Promise<PaneIncarnation>;
/** `descriptor` is what the backend was told when the pane entered and never changes: a stash must
 *  present exactly that. `resolved` is the local half: the restore it asked for has completed. */
type Slot = { descriptor: PaneDescriptor; pi: PaneCapture; suppressed: boolean; installed: boolean; resolved?: boolean };
type Queued = { seq: number; op: () => Promise<PaneOp>; resolve: (result: PaneResult) => void };
const inert: PaneResult = { status: 'Inert' };
const increment = (value: number): number => {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) throw new Error('pane sequence exhausted');
  return value + 1;
};

/** The backend refused a transfer take, so no pane was adopted and nothing was installed. */
export class TransferNotTaken extends Error {}

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
  private registrationTimer?: ReturnType<typeof setTimeout>;
  private registrationWatchdog?: ReturnType<typeof setInterval>;
  private registering = false;
  private listeners = new Set<() => void>();
  private stagedCaptures = new Map<string, Map<string, PaneCapture>>();
  private attempt = 0;
  private sending = false;
  private stopped = false;
  private failures = 0;
  private unsubscribe?: () => void;
  private readonly onUnload = (): void => this.stop();

  constructor(private readonly bridge?: PaneBridge, private readonly warn: () => void = () => {}) {}

  get enabled(): boolean { return !!this.bridge && !this.stopped; }
  get ended(): boolean { return this.stopped; }
  get waitingForRegistration(): boolean { return this.registering; }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private changed(): void { this.listeners.forEach(listener => listener()); }

  isCurrent(leaf: string, paneId: string | undefined, pi: PaneCapture | undefined): boolean {
    return !this.stopped && this.capture(leaf, paneId) === pi && !!pi && !this.isSuppressed(pi);
  }

  capturesForLeaf(leaf: string): PaneCapture[] {
    return [...this.slots.values()].filter(slot => slot.descriptor.leaf === leaf).map(slot => slot.pi);
  }

  async pageIdentity(): Promise<{ wi: number; pg: number } | undefined> {
    if (!this.enabled) return undefined;
    this.start();
    const page = await this.registration!;
    return this.enabled ? page : undefined;
  }

  start(): void {
    if (this.registration || this.stopped) return;
    this.registration = new Promise(resolve => { this.releaseRegistration = resolve; });
    if (!this.bridge) { this.releaseRegistration!({ wi: 0, pg: 0 }); return; }
    window.addEventListener('beforeunload', this.onUnload, { once: true });
    let delay = 50;
    this.registering = true;
    // Registration allocates a page, unlike an op replay. Observe an unresolved invoke,
    // but never race it with a second allocation or discard its eventual page reply.
    this.registrationWatchdog = setInterval(() => this.failure(), 1000);
    const register = async (): Promise<void> => {
      try {
        const answer = await this.bridge!('register_page', undefined);
        if (this.stopped) return;
        if (answer.status === 'Registered') {
          if (!Number.isSafeInteger(answer.pg) || !Number.isSafeInteger(answer.wi)) throw new Error('page identity exhausted');
          this.registering = false;
          clearInterval(this.registrationWatchdog);
          this.registrationWatchdog = undefined;
          this.failures = 0;
          this.releaseRegistration!(answer);
          return;
        }
      } catch {
        this.failure();
      }
      if (this.stopped) return;
      this.registrationTimer = setTimeout(() => { this.registrationTimer = undefined; void register(); }, delay);
      delay = Math.min(delay * 2, 1000);
    };
    void register();
  }

  /** Retire predecessor pages before installing panes, without releasing the restore sweep. */
  async replacePage(): Promise<void> {
    const result = await this.send({ kind: 'replace_page' });
    if (!accepted(result)) throw new Error(`page replacement ${result.status}`);
  }

  private failure(): void { if (++this.failures === 3) this.warn(); }

  private drain(result: PaneResult): void {
    this.attempt++;
    this.sending = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.registrationTimer !== undefined) clearTimeout(this.registrationTimer);
    if (this.registrationWatchdog !== undefined) clearInterval(this.registrationWatchdog);
    this.registrationTimer = undefined;
    this.registrationWatchdog = undefined;
    this.registering = false;
    this.releaseRegistration?.({ wi: 0, pg: 0 });
    this.queue.splice(0).forEach(item => item.resolve(result));
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    window.removeEventListener('beforeunload', this.onUnload);
    this.drain({ status: 'Rejected', message: 'page ended' });
    this.slots.forEach(slot => retireTerminalInitGuards(slot.pi));
    this.slots.clear();
    this.observed.clear();
    this.staged.clear();
    this.stagedCaptures.clear();
    this.changed();
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
    } catch {
      if (attempt !== this.attempt) return;
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
    let changed = false;
    const restoring = [...this.slots.values()].filter(slot => !slot.suppressed && slot.descriptor.restore && !slot.resolved);
    const descriptors = panes.map(descriptor => {
      const predecessor = restoring.find(slot => slot.descriptor.leaf === descriptor.leaf);
      return !descriptor.restore && predecessor
        ? { ...descriptor, restore: true, override: predecessor.descriptor.override ?? descriptor.override }
        : descriptor;
    });
    const retired: Slot[] = [];
    const captures = descriptors.map(descriptor => {
      const old = this.slots.get(descriptor.paneId);
      if (old && old.descriptor.leaf === descriptor.leaf && !old.suppressed) return old.pi;
      const pi = this.mint();
      this.slots.set(descriptor.paneId, { descriptor, pi, suppressed: false, installed: this.observed.has(descriptor.paneId) });
      changed = true;
      void this.send(async () => ({ kind: 'enter', panes: [{ ...descriptor, pi: await pi }] }));
      if (old) retired.push(old);
      return pi;
    });
    // A swap can replace several node ids: enter the whole batch before any old
    // copy leaves, so each leaf's successor already has its own holder.
    retired.forEach(old => {
      retireTerminalInitGuards(old.pi);
      if (!old.suppressed) void this.depart(old.pi);
    });
    if (changed) this.changed();
    return captures;
  }

  discardPrepared(pis: PaneCapture[] = [...this.slots.values()].map(slot => slot.pi)): void {
    for (const slot of this.slots.values()) {
      if (!slot.installed && pis.includes(slot.pi)) void this.depart(slot.pi);
    }
  }

  capture(leaf: string, paneId?: string): PaneCapture | undefined {
    if (paneId) {
      const slot = this.slots.get(paneId);
      return slot?.descriptor.leaf === leaf ? slot.pi : undefined;
    }
    return [...this.slots.values()].find(slot => slot.descriptor.leaf === leaf && !slot.suppressed)?.pi;
  }

  restoreKey(pi: PaneCapture): string | undefined {
    return [...this.slots.values()].find(slot => slot.pi === pi && !slot.suppressed && slot.descriptor.restore && !slot.resolved)?.descriptor.override;
  }

  setRestoreResolved(pi: PaneCapture): void {
    for (const slot of this.slots.values()) {
      if (slot.pi === pi && !slot.suppressed) slot.resolved = true;
    }
  }

  isSuppressed(pi: PaneCapture): boolean {
    return [...this.slots.values()].some(slot => slot.pi === pi && slot.suppressed);
  }

  captureClose(leaf: string, paneId?: string): PaneCapture | undefined {
    const pi = paneId ? this.slots.get(paneId)?.pi
      : [...this.slots.values()].find(slot => slot.descriptor.leaf === leaf)?.pi;
    for (const slot of this.slots.values()) if (slot.pi === pi) slot.suppressed = true;
    return pi;
  }

  close(pi: PaneCapture): Promise<PaneResult> {
    for (const slot of this.slots.values()) if (slot.pi === pi) slot.suppressed = true;
    return this.send(async () => ({ kind: 'close', pi: await pi }));
  }

  depart(pi: PaneCapture): Promise<PaneResult> {
    for (const [id, slot] of this.slots) if (slot.pi === pi) this.slots.delete(id);
    retireTerminalInitGuards(pi);
    this.changed();
    return this.send(async () => ({ kind: 'depart', pi: await pi }));
  }

  async bind(pi: PaneCapture, pc: string, via: BindVia): Promise<PaneResult> {
    const result = await this.send(async () => ({ kind: 'bind', pi: await pi, pc, via }));
    if (accepted(result)) this.setRestoreResolved(pi);
    return result;
  }

  admit(pi: PaneCapture, mode: CreateMode): Promise<PaneResult> {
    return this.send(async () => ({ kind: 'admit_create', pi: await pi, mode }));
  }

  async create(cg: number, request: Omit<AdmittedCreateRequest, 'pg' | 'cg'>): Promise<string> {
    const { pg } = await this.registration!;
    if (!this.enabled) throw new Error('page ended');
    return this.bridge!('create_admitted_terminal', { request: { ...request, pg, cg } });
  }

  async waitTransfer(tx: string): Promise<boolean> {
    const page = await this.pageIdentity();
    if (!page) return false;
    return this.bridge!('wait_transfer_taken', { pg: page.pg, tx });
  }

  async reap(pc: string, fallback: () => Promise<void>): Promise<void> {
    if (!this.enabled) { await fallback(); return; }
    await this.bridge!('close_process', { pc, reap: true });
  }

  observe(panes: PaneDescriptor[]): void {
    const current = new Map(panes.map(pane => [pane.paneId, pane]));
    this.observed = new Set(current.keys());
    for (const [tx, panes] of this.staged) if (panes.every(pane => !current.has(pane.paneId)
        || this.slots.get(pane.paneId)?.pi !== this.stagedCaptures.get(tx)?.get(pane.paneId))) {
      this.staged.delete(tx);
      this.stagedCaptures.delete(tx);
    }
    // Prepare from the still-present descriptors, just as transfer adoption carries them.
    // FIFO Enter precedes Depart, so even an unanswered listing never sees a holder gap.
    this.prepare(panes.filter(pane => this.slots.get(pane.paneId)?.descriptor.leaf !== pane.leaf));
    for (const [id, slot] of this.slots) {
      if (current.get(id)?.leaf === slot.descriptor.leaf) { slot.installed = true; continue; }
      if (!slot.installed) continue;
      this.slots.delete(id);
      retireTerminalInitGuards(slot.pi);
      if (!slot.suppressed) void this.depart(slot.pi);
    }
    this.changed();
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

  async stash(tx: string, panes: PaneDescriptor[], ui?: unknown): Promise<PaneResult> {
    if (this.staged.has(tx)) return { status: 'Rejected', message: 'transfer token already staged' };
    const sources = panes.map(pane => this.slots.get(pane.paneId));
    const captures = sources.map(slot => slot?.pi);
    if (captures.some(pi => !pi)) throw new Error('transfer source pane is not present');
    const suppressed = sources.map(slot => slot!.suppressed);
    // Suppress the differ while the UI still contains the staged source copy.
    panes.forEach(pane => { this.slots.get(pane.paneId)!.suppressed = true; });
    this.staged.set(tx, sources.map(slot => slot!.descriptor));
    this.stagedCaptures.set(tx, new Map(panes.map((pane, i) => [pane.paneId, captures[i]!])));
    const result = await this.send(async () => ({ kind: 'stash', tx, ...(ui === undefined ? {} : { ui }), pairs: await Promise.all(sources.map(async (slot, i) => ({ ...slot!.descriptor, pi: await captures[i]! }))) }));
    if (!accepted(result)) {
      this.staged.delete(tx);
      this.stagedCaptures.delete(tx);
      sources.forEach((slot, i) => { if (slot && this.slots.get(panes[i].paneId) === slot) slot.suppressed = suppressed[i]; });
    }
    return result;
  }

  async cancel(tx: string, panes: PaneDescriptor[], processes: Map<string, string>, isPresent: (pane: PaneDescriptor) => boolean = () => true): Promise<void> {
    const workspace = captureWorkspace();
    const sources = this.stagedCaptures.get(tx) ?? new Map(panes.map(pane => [pane.paneId, this.capture(pane.leaf, pane.paneId)]));
    const result = await this.send({ kind: 'cancel', tx });
    // Expiry already released the transfer. Re-enter without reviving its authority;
    // an orphaned shell can only be rebound by an ordinary restore.
    if (!accepted(result) && result.status !== 'Rejected') throw new Error(`transfer cancel ${result.status}`);
    const descriptors = (this.staged.get(tx) ?? panes).filter(descriptor =>
      panes.some(pane => pane.paneId === descriptor.paneId && pane.leaf === descriptor.leaf)
      && (!this.capture(descriptor.leaf, descriptor.paneId) || sources.get(descriptor.paneId) === this.capture(descriptor.leaf, descriptor.paneId))
      && isPresent(descriptor) && isCurrentWorkspace(workspace) && !this.stopped);
    this.staged.delete(tx);
    this.stagedCaptures.delete(tx);
    descriptors.forEach(pane => {
      const slot = this.slots.get(pane.paneId);
      if (slot) retireTerminalInitGuards(slot.pi);
      this.slots.delete(pane.paneId);
    });
    const pis = this.prepare(descriptors);
    for (let i = 0; i < descriptors.length; i++) {
      if (!this.isCurrent(descriptors[i].leaf, descriptors[i].paneId, pis[i])) continue;
      const pc = processes.get(descriptors[i].leaf);
      if (pc) {
        const bound = await this.bind(pis[i], pc, result.status === 'Rejected' ? 'restore' : 'transfer');
        if (!accepted(bound)) throw new Error(`transfer rollback bind ${bound.status}`);
      }
    }
  }

  async installTransfer(tx: string, panes: PaneDescriptor[] | ((ui: unknown, members: PaneDescriptor[]) => PaneDescriptor[]), install: (ui?: unknown) => void | Promise<void>): Promise<void> {
    const workspace = captureWorkspace();
    const taken = await this.send({ kind: 'take', tx });
    if (taken.status !== 'Taken') throw new TransferNotTaken(`transfer take ${taken.status}`);
    const ui = taken.payload.ui;
    const members = typeof panes === 'function' ? panes(ui, taken.payload.panes) : panes;
    const descriptors = members.flatMap(pane => {
      const member = taken.payload.panes.find(source => source.leaf === pane.leaf);
      return member ? [{ ...pane, restore: member.restore, override: member.override }] : [];
    });
    const pis = descriptors.map(() => this.mint());
    const adopted = await this.send(async () => ({ kind: 'adopt', tx, pairs: await Promise.all(descriptors.map(async (pane, i) => ({ ...pane, pi: await pis[i] }))) }));
    if (!accepted(adopted)) throw new Error(`transfer adopt ${adopted.status}`);
    try {
      if (!isCurrentWorkspace(workspace) || !this.enabled) throw new Error('transfer workspace replaced');
      descriptors.forEach((descriptor, i) => {
        const old = this.slots.get(descriptor.paneId);
        if (old) retireTerminalInitGuards(old.pi);
        this.slots.set(descriptor.paneId, { descriptor, pi: pis[i], suppressed: false, installed: false });
      });
      this.changed();
      if (descriptors.length) await install(ui);
    }
    catch (error) {
      for (const pi of pis) await this.depart(pi);
      throw error;
    }
  }
}

export const accepted = (result: PaneResult): boolean => ['Ok', 'Inert', 'Existing', 'AlreadyBound'].includes(result.status);

export async function acceptsTransferNotice(notice: { wi?: number; pg?: number }): Promise<boolean> {
  if (paneIncarnations.ended) return false;
  const client = paneIncarnations;
  const page = await client.pageIdentity();
  return client === paneIncarnations && client.enabled && !!page && page.wi === notice.wi && page.pg === notice.pg;
}
export function describePanes(tree: PaneNode | null, restore = false): PaneDescriptor[] {
  if (!tree) return [];
  if (tree.type === 'terminal' && tree.terminalId) return [{ paneId: tree.id, leaf: tree.terminalId, restore, override: tree.sessionKey }];
  return tree.children?.flatMap(child => describePanes(child, restore)) ?? [];
}

// Browser and bridge-free tests keep the single-window terminal path. Native bootstrap replaces this
// instance before installing the store differ; tests can install their own deferred bridge.
export let paneIncarnations = new PaneIncarnations();
export function installPaneIncarnations(client: PaneIncarnations): void { paneIncarnations.stop(); paneIncarnations = client; }
