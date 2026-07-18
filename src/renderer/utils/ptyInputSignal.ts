/**
 * Signals a USER write to a terminal (keyboard or paste) so `RunningActivityTracker`
 * can echo-cancel it — otherwise the shell's echo of typed characters trips the
 * output-rate "running" heuristic and animates the tab sweep while the user types.
 *
 * Emitted from every renderer-side write choke point (the Tauri bridge's
 * `writeToTerminal`/`sendToPty` and the browser bridge's `writeToTerminal`).
 * Backend-issued writes (REST/WebSocket/MCP automation) hit the backend writers
 * directly and deliberately do NOT emit this — only genuine local user input does.
 *
 * Fire-and-forget: this must never throw into the write path.
 */
export function emitPtyInput(processId: string, data: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent('pty:input', { detail: { processId, data, t: Date.now() } }),
    );
  } catch {
    /* no-op: activity signalling must never break terminal input */
  }
}
