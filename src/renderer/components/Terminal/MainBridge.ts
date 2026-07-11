import type { TerminalBridge, Disposable, TerminalSnapshot } from '@termflow/terminal-core';

// Main-app bridge for terminal-core (spec §6.1 / §17 R2).
//
// Output/exit are delivered via the global `pty:data`/`pty:exit` window events that
// `TerminalService` dispatches (filtered by backend `processId`). Input/resize/snapshot/
// history call `window.electronAPI` DIRECTLY by `processId` — equivalent to what
// `TerminalService` does internally after its `terminalId→processId` mapping, and
// correct for hydration's pre-resize (which historically called electronAPI by
// processId directly). A single shared instance suffices; the wrapper owns
// `cacheKey: terminalId` for cross-mount reuse.
export function createMainBridge(): TerminalBridge {
  const hasSnapshot = typeof window !== 'undefined' && !!window.electronAPI?.getTerminalSnapshot;
  const hasSize = typeof window !== 'undefined' && !!window.electronAPI?.getTerminalSize;
  return {
    onData(processId, cb): Disposable {
      const handler = (e: Event) => {
        const d = (e as CustomEvent).detail as { processId: string; data: string };
        if (d.processId === processId) cb(d.data);
      };
      window.addEventListener('pty:data', handler as EventListener);
      return { dispose: () => window.removeEventListener('pty:data', handler as EventListener) };
    },
    onExit(processId, cb): Disposable {
      const handler = (e: Event) => {
        const d = (e as CustomEvent).detail as { processId: string; exitCode: number };
        if (d.processId === processId) cb(d.exitCode);
      };
      window.addEventListener('pty:exit', handler as EventListener);
      return { dispose: () => window.removeEventListener('pty:exit', handler as EventListener) };
    },
    // processId is the backend terminal id — call electronAPI directly (≡ TerminalService internals).
    write(processId, data) {
      return window.electronAPI.writeToTerminal(processId, data);
    },
    resize(processId, cols, rows) {
      return window.electronAPI.resizeTerminal(processId, cols, rows);
    },
    getSnapshot: hasSnapshot
      ? (processId, cols, rows): Promise<TerminalSnapshot> =>
          window.electronAPI.getTerminalSnapshot!(processId, cols, rows)
      : undefined,
    getHistory(processId, lines, offset) {
      return window.electronAPI.getTerminalOutput(processId, lines, offset);
    },
    getSize: hasSize
      ? (processId: string) => window.electronAPI.getTerminalSize!(processId)
      : undefined,
  };
}
