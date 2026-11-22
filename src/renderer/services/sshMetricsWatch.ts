import { useEffect } from 'react';
import type { SshMetricsAPI, SshMetricsControl, SshMetricsSample, SshSessionView } from '../types/ssh';
import { paneIncarnations, type PaneIncarnations } from './paneIncarnations';
import {
  compareMetricsControl, metricsClockChanged, SSH_METRICS_MAX_AGE, SSH_METRICS_CLOCK_SKEW,
  sshMetricsArmed, sshMetricsControlled, sshMetricsDisarmed, sshMetricsExpired, sshMetricsHidden, sshMetricsSampled, sshMetricsUnavailable,
  type MetricsClock, type SshSessionsState,
} from '../store/slices/sshSessionSlice';

type MetricsAction = ReturnType<typeof sshMetricsArmed | typeof sshMetricsControlled | typeof sshMetricsDisarmed | typeof sshMetricsHidden
  | typeof sshMetricsExpired | typeof sshMetricsSampled | typeof sshMetricsUnavailable>;
interface MetricsStore {
  getState(): { sshSession: SshSessionsState };
  dispatch(action: MetricsAction): unknown;
  subscribe(callback: () => void): () => void;
}
type Page = Pick<PaneIncarnations, 'pageIdentity' | 'subscribe' | 'ended'>;
interface Mount {
  terminalId: string;
  consumerId: string;
  owners: number;
  page: Promise<number | undefined>;
  connected?: SshSessionView;
  epoch: number;
  busy?: Promise<boolean>;
  needsFence: boolean;
  issued: boolean;
  trustWall: boolean;
}
const clock = (): MetricsClock => ({ wall: Date.now(), mono: performance.now() });
const HEARTBEAT_MS = 250;
// Leave room for an in-flight collection and the following collection to finish
// before the admitting fence expires, even when their durations differ.
const RENEW_AFTER_MS = 1000;
const SUSPENDED_MS = 1000;
const noop = () => {};

// getRandomValues also works on WebViews where the custom app scheme does not
// expose the secure-context-only randomUUID(). Set the RFC 9562 v4/variant bits.
function mountUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** One instance per document; React bars only acquire/release terminal interests. */
class MetricsWatch {
  private mounts = new Map<string, Mount>();
  private stops = new Set<() => void>();
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private timerDue?: number;
  private heartbeat?: MetricsClock;
  private ready: Promise<boolean>;

  constructor(private store: MetricsStore, private api: SshMetricsAPI, private page: Page) {
    this.ready = Promise.all([
      this.track(api.onSshMetricsSample(this.sample)),
      this.track(api.onSshMetricsControl(this.control)),
    ]).then(() => true, () => { this.dispose(); return false; });
    this.stops.add(store.subscribe(this.sync));
    this.stops.add(page.subscribe(() => { if (page.ended) this.dispose(); }));
    document.addEventListener('visibilitychange', this.refence);
    window.addEventListener('pageshow', this.refence);
    window.addEventListener('pagehide', this.dispose);
  }

  private async track(promise: Promise<() => void>) {
    const stop = await promise;
    if (this.disposed) stop();
    else this.stops.add(stop);
  }

  retain(terminalId: string): () => void {
    if (this.disposed) return noop;
    let mount = this.mounts.get(terminalId);
    if (!mount) {
      mount = {
        terminalId, consumerId: mountUuid(), owners: 0, epoch: 0,
        page: this.page.pageIdentity().then(page => page?.pg, () => undefined),
        issued: false, needsFence: false, trustWall: true,
      };
      this.mounts.set(terminalId, mount);
    }
    const owned = mount;
    owned.owners++;
    this.sync();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--owned.owners === 0) this.retire(owned);
    };
  }

  async resume(terminalId: string): Promise<boolean> {
    const mount = this.mounts.get(terminalId);
    if (!mount?.connected || !mount.issued || !this.current(mount)) return false;
    this.invalidate(mount, false);
    const epoch = mount.epoch;
    if (mount.busy) await mount.busy;
    if (!this.current(mount) || mount.epoch !== epoch || mount.busy) return false;
    return this.request(mount, true);
  }

  private pane(id: string) { return this.store.getState().sshSession.byTerminal[id]; }

  private current(mount: Mount) { return !this.disposed && !this.page.ended && this.mounts.get(mount.terminalId) === mount; }

  private sync = () => {
    if (!this.mounts.size) return;
    for (const mount of this.mounts.values()) {
      const pane = this.pane(mount.terminalId);
      if (!pane && mount.connected) { this.retire(mount); continue; }
      const next = pane?.session?.state === 'connected' ? pane.session : undefined;
      if (next?.generation === mount.connected?.generation && next?.connectionId === mount.connected?.connectionId
        && !!next === !!mount.connected) continue;
      mount.connected = next;
      this.invalidate(mount, !!next);
      this.kick(mount);
    }
    this.updateTimer();
  };

  private invalidate(mount: Mount, renew: boolean, hidden = false) {
    mount.epoch++;
    mount.needsFence = renew;
    this.store.dispatch((hidden ? sshMetricsHidden : sshMetricsDisarmed)(mount.terminalId));
  }

  private kick(mount: Mount) {
    if (this.current(mount) && mount.connected && mount.needsFence && !mount.busy && !document.hidden) {
      void this.request(mount, false);
    }
  }

  private request(mount: Mount, resume: boolean): Promise<boolean> {
    mount.needsFence = false;
    const work = this.invokeFence(mount, resume);
    mount.busy = work;
    void work.finally(() => {
      mount.busy = undefined;
      this.kick(mount);
      this.updateTimer();
    });
    return work;
  }

  private async invokeFence(mount: Mount, resume: boolean): Promise<boolean> {
    const { terminalId, consumerId, epoch } = mount;
    const generation = mount.connected?.generation;
    const pg = await mount.page;
    if (!await this.ready || !this.current(mount) || mount.epoch !== epoch) return false;
    // Take the monotonic bound before IPC, not at receipt. No sample <= the fence
    // can be made fresh again by a late delivery or by a backwards wall jump.
    const start = clock();
    mount.issued = pg !== undefined;
    try {
      const receipt = resume
        ? { ...await this.api.sshMetricsResume(terminalId, consumerId, pg), pausedReason: null }
        : await this.api.sshMetricsWatch(terminalId, consumerId, pg);
      if (!this.current(mount) || mount.epoch !== epoch) return false;
      if (receipt.generation !== generation || receipt.generation !== this.pane(terminalId)?.session?.generation) return false;
      const control = { terminalId, generation: receipt.generation, pauseSeq: receipt.pauseSeq, pausedReason: receipt.pausedReason };
      if (compareMetricsControl(control, this.pane(terminalId)?.metricsControl) < 0) {
        mount.needsFence = true;
        return false;
      }
      // Controls are valid even when the telemetry fence arrived too late.
      this.store.dispatch(sshMetricsControlled(control));
      if (!this.current(mount) || mount.epoch !== epoch) return false;
      const now = clock();
      if (this.checkSuspension(now)) return false;
      if (metricsClockChanged(start, now) || now.mono - start.mono >= SSH_METRICS_MAX_AGE || document.hidden) {
        mount.trustWall = false;
        this.invalidate(mount, true);
        return false;
      }
      const pane = this.pane(terminalId);
      const previous = pane?.metricsFence;
      const changedClock = (previous && metricsClockChanged(previous, now))
        || (pane?.metricsReading && metricsClockChanged(pane.metricsReading.fence, now));
      if (changedClock || (previous && now.mono - previous.mono >= SSH_METRICS_MAX_AGE)) {
        if (changedClock) mount.trustWall = false;
        this.invalidate(mount, true);
        return false;
      }
      const stampLag = now.wall - receipt.sampleFloor;
      mount.trustWall = mount.trustWall || (stampLag >= 0 && stampLag <= SSH_METRICS_CLOCK_SKEW);
      this.store.dispatch(sshMetricsArmed({ terminalId, receipt, fence: {
        ...start, consumerId, generation: receipt.generation, sampleFloor: receipt.sampleFloor, trustWall: mount.trustWall,
      } }));
      return true;
    } catch (error) {
      if (this.current(mount) && mount.epoch === epoch) {
        const code = (error as { code?: string } | null)?.code;
        if (code === 'owner-retired' || code === 'invalid-page') this.retire(mount);
        this.store.dispatch(sshMetricsUnavailable({ terminalId, reason: error instanceof Error ? error.message : 'SSH host metrics unavailable' }));
      }
      return false;
    }
  }

  private sample = (sample: SshMetricsSample) => {
    const mount = this.mounts.get(sample.terminalId);
    if (!mount?.connected || document.hidden || this.disposed) return;
    const now = clock();
    if (this.checkSuspension(now)) return;
    const pane = this.pane(mount.terminalId);
    const fence = pane?.metricsFence;
    if (!fence) return;
    const changedClock = metricsClockChanged(fence, now)
      || (!!pane.metricsReading && metricsClockChanged(pane.metricsReading.fence, now));
    if (now.mono - fence.mono >= SSH_METRICS_MAX_AGE || changedClock
      || (fence.trustWall && sample.sampledAt > fence.sampleFloor && sample.sampledAt > now.wall)) {
      if (changedClock || (sample.sampledAt > fence.sampleFloor && sample.sampledAt > now.wall)) mount.trustWall = false;
      this.invalidate(mount, true);
      this.kick(mount);
      return;
    }
    this.store.dispatch(sshMetricsSampled({ sample, now, consumerId: mount.consumerId }));
  };

  private control = (control: SshMetricsControl) => {
    const mount = this.mounts.get(control.terminalId);
    if (!mount?.connected || control.generation !== mount.connected.generation || this.disposed
      || compareMetricsControl(control, this.pane(control.terminalId)?.metricsControl) <= 0) return;
    this.store.dispatch(sshMetricsControlled(control));
    // A Resume elsewhere invalidates the local floor. A local pending receipt
    // will either carry this same pair or be rejected as older and re-fenced.
    if (!mount.busy && this.current(mount)) {
      mount.needsFence = true;
      this.kick(mount);
    }
  };

  refence = () => {
    if (this.disposed) return;
    for (const mount of this.mounts.values()) {
      if (!mount.connected) continue;
      // Suspension and system resume really are late; a page going hidden is a pause.
      this.invalidate(mount, true, document.hidden);
      this.kick(mount);
    }
  };

  private checkSuspension(now: MetricsClock): boolean {
    const last = this.heartbeat;
    if (!last || (now.mono - last.mono < SUSPENDED_MS && !metricsClockChanged(last, now))) return false;
    this.heartbeat = now;
    if (metricsClockChanged(last, now)) for (const mount of this.mounts.values()) mount.trustWall = false;
    this.refence();
    return true;
  }

  private tick = () => {
    this.timer = undefined;
    this.timerDue = undefined;
    const now = clock();
    this.checkSuspension(now);
    this.heartbeat = now;
    for (const mount of this.mounts.values()) {
      const pane = this.pane(mount.terminalId);
      const fence = pane?.metricsFence;
      const changedClock = (fence && metricsClockChanged(fence, now))
        || (pane?.metricsReading && metricsClockChanged(pane.metricsReading.fence, now));
      if (fence && (now.mono - fence.mono >= SSH_METRICS_MAX_AGE || changedClock)) {
        if (changedClock) mount.trustWall = false;
        this.invalidate(mount, true);
        this.kick(mount);
      } else if (pane?.metricsReading && now.mono >= pane.metricsReading.deadline) {
        this.store.dispatch(sshMetricsExpired({ terminalId: mount.terminalId, mono: now.mono }));
      } else if (fence && pane?.metricsReading && pane.metricsControl?.pausedReason == null
        && mount.connected && !mount.busy && !document.hidden && now.mono - fence.mono >= RENEW_AFTER_MS) {
        void this.request(mount, false);
      }
    }
    this.updateTimer();
  };

  private updateTimer() {
    const now = clock();
    let deadline = Infinity;
    if (!this.disposed) for (const id of this.mounts.keys()) {
      const pane = this.pane(id);
      if (pane?.metricsFence) deadline = Math.min(deadline, pane.metricsFence.mono + SSH_METRICS_MAX_AGE,
        pane.metricsReading?.deadline ?? Infinity);
    }
    if (!Number.isFinite(deadline)) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.timerDue = undefined;
      this.heartbeat = undefined;
      return;
    }
    this.heartbeat ??= now;
    // Schedule the earlier of the heartbeat and the exact render deadline.
    const due = Math.min(deadline, this.heartbeat.mono + HEARTBEAT_MS);
    if (this.timerDue !== undefined && this.timerDue <= due) return;
    clearTimeout(this.timer);
    this.timerDue = due;
    this.timer = setTimeout(this.tick, Math.max(0, due - now.mono));
  }

  private retire(mount: Mount) {
    if (this.mounts.get(mount.terminalId) !== mount) return;
    this.mounts.delete(mount.terminalId);
    this.store.dispatch(sshMetricsDisarmed(mount.terminalId));
    this.updateTimer();
    // Queue cleanup behind any in-flight command: even a watch that registers
    // after the mount vanished is compensated using its ORIGINAL page and UUID.
    void this.unwatch(mount);
  }

  private async unwatch(mount: Mount) {
    await mount.busy;
    if (!mount.issued) return;
    try { await this.removeNativeWatch(mount, await mount.page); }
    catch { /* page retirement is also reconciled by the native authority */ }
  }

  private removeNativeWatch(mount: Mount, pg: number | undefined) {
    return this.api.sshMetricsUnwatch(mount.terminalId, mount.consumerId, pg);
  }

  dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener('visibilitychange', this.refence);
    window.removeEventListener('pageshow', this.refence);
    window.removeEventListener('pagehide', this.dispose);
    for (const stop of this.stops) stop();
    this.stops.clear();
    for (const mount of this.mounts.values()) this.retire(mount);
  };
}

// Bootstrap owns this lifetime, not the App/bar effects (including StrictMode).
let watch: MetricsWatch | undefined;
export function installSshMetricsWatch(store: MetricsStore, api: SshMetricsAPI | undefined, page: Page = paneIncarnations): () => void {
  if (watch || !api || typeof api.onSshMetricsSample !== 'function') return noop;
  const installed = new MetricsWatch(store, api, page);
  watch = installed;
  return () => { installed.dispose(); if (watch === installed) watch = undefined; };
}
export const retainSshMetrics = (terminalId: string) => watch?.retain(terminalId) ?? noop;
export function useSshMetricsWatch(terminalId: string | undefined) {
  useEffect(() => terminalId ? retainSshMetrics(terminalId) : undefined, [terminalId]);
}
export const resumeSshMetrics = (terminalId: string): Promise<boolean> => watch?.resume(terminalId) ?? Promise.resolve(false);
export const refenceSshMetricsOnSystemResume = () => watch?.refence();
