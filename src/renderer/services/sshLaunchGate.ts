import type { SshLaunchEvent, SshUnlisten } from '../types/ssh';
import { isWaitingForSshLaunch, type SshLaunchObservation } from './sshLaunchAttempt';

interface Gate {
  terminalId: string;
  subscribe(listener: (event: SshLaunchEvent) => void): Promise<SshUnlisten>;
  query(): Promise<SshLaunchObservation | undefined>;
  settled?: () => boolean;
  observed(result: SshLaunchObservation): void;
  failed(error: unknown): void;
}

/** Public events are invalidations only. Queue another qualified read if one arrives during hydration. */
export function watchSshLaunch(gate: Gate) {
  let disposed = false, reading = false, dirty = false;
  let stop: SshUnlisten | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    if (disposed) return;
    dirty = true;
    if (stop && !reading) void read();
  };
  const read = async () => {
    reading = true;
    if (timer !== undefined) clearTimeout(timer);
    let poll = true;
    try {
      while (!disposed && dirty) {
        dirty = false;
        try {
          const result = await gate.query();
          if (disposed) return;
          if (result) gate.observed(result);
          poll = result?.snapshot ? isWaitingForSshLaunch(result.snapshot.stage) : !gate.settled?.();
        } catch (error) {
          if (disposed) return;
          gate.failed(error);
          poll = false;
        }
      }
    } finally {
      reading = false;
      if (!disposed && poll) timer = setTimeout(refresh, 250);
    }
  };
  const start = async () => {
    try {
      const unlisten = await gate.subscribe(event => {
        if (event.terminalId === gate.terminalId) refresh();
      });
      if (disposed) { unlisten(); return; }
      stop = unlisten;
      refresh();
    } catch (error) {
      if (!disposed) gate.failed(error);
    }
  };
  void start();
  return {
    refresh,
    stop: () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      stop?.();
    },
  };
}
