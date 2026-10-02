import type { PaneCapture } from './paneIncarnations';

/** Slot retirement, unlike a React unmount, ends this key's reuse lifetime. */
export function retireTerminalInitGuards(pi: PaneCapture): void {
  if (typeof window === 'undefined') return;
  const w = window as any;
  w.terminalInitMap?.delete(pi);
  w.terminalInitLock?.delete(pi);
  w.terminalInitPromises?.delete(pi);
}
