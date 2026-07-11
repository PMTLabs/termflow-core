import type { TerminalBridge } from '@termflow/terminal-core';
import WebSocketService from '../../services/WebSocketService';
import terminalApiService from '../../services/terminalApiService';

// Adapts the monitor's WebSocket + REST services to the terminal-core
// `TerminalBridge` contract. The monitor's terminalId IS the backend
// processId, so `id` maps directly with no translation.
export const monitorBridge: TerminalBridge = {
  onData(id, cb) {
    return WebSocketService.onOutput(id, cb);
  },
  onExit(id, cb) {
    return WebSocketService.onExit(id, cb);
  },
  write(id, data) {
    // WS-first (preserve current low latency); REST fallback when the socket
    // is down so input still reaches the backend.
    if (WebSocketService.isConnected()) {
      WebSocketService.sendInput(id, data);
      return;
    }
    return terminalApiService.sendInput(id, data);
  },
  resize(_id, _cols, _rows) {
    // No-op: the monitor is a PASSIVE viewer of a PTY that the desktop app owns
    // and sizes. Resizing it here would fight the main app (last-writer-wins) and
    // reflow the user's live session. The engine's mirror mode instead sizes the
    // monitor's xterm to the backend's reported dimensions (see TerminalEngine).
  },
  getSnapshot(id, cols, rows) {
    return terminalApiService.getSnapshot(id, cols, rows);
  },
  getHistory(id, lines, offset) {
    return terminalApiService
      .getTerminalOutput(id, lines, offset)
      .then((r) => ({ raw: r.raw }));
  },
};
