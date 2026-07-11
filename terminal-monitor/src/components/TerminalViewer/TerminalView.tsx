import React, { useEffect, useRef } from 'react';
import { Box } from '@mui/material';
import { TerminalEngine, DEFAULT_THEME } from '@termflow/terminal-core';
import { useSelector } from 'react-redux';
import '@xterm/xterm/css/xterm.css';
import { RootState } from '../../store/store';
import { monitorBridge } from './MonitorBridge';

// Reuse the main app's full 16-color ANSI palette (DEFAULT_THEME) for color
// parity with the desktop app, while keeping the monitor's dark #1e1e1e
// background + accent cursor for visual cohesion.
const MONITOR_THEME = {
  ...DEFAULT_THEME,
  background: '#1e1e1e',
  cursor: '#90caf9',
};

interface TerminalViewProps {
  terminalId: string;
}

const TerminalView: React.FC<TerminalViewProps> = ({ terminalId }) => {
  const ref = useRef<HTMLDivElement>(null);
  const selectedTerminalId = useSelector(
    (s: RootState) => s.terminals.selectedTerminalId
  );

  useEffect(() => {
    if (!ref.current) return;
    const engine = new TerminalEngine(monitorBridge, {
      cacheKey: terminalId,
      theme: MONITOR_THEME,
      fontSize: 14,
      lineHeight: 1.1,
      // The monitor mirrors a PTY the desktop app owns: don't fit-to-pane or
      // resize the shared PTY; size the xterm to the backend's dimensions so the
      // view matches the main app exactly (no wrap/cut-off). See TerminalEngine.
      mirror: true,
      // macOS: send Option+<key> as a Meta (ESC-prefixed) sequence so CLI apps
      // like Claude Code receive e.g. Option+P as "\x1bp" instead of a composed
      // character. The desktop app gets this via its own InputHandler; the web
      // monitor relies purely on xterm, so enable it here.
      macOptionIsMeta: true,
      // In grid mode multiple panes mount at once; only the selected one should
      // auto-focus so panes don't steal focus from each other. Single-view always
      // has terminalId === selectedTerminalId, so it still focuses. Unselected
      // grid panes rely on the engine's click-to-focus.
      autoFocus: terminalId === selectedTerminalId,
    });
    engine.mount(ref.current);
    engine.attach(terminalId); // monitor: terminalId === backend processId

    // Mirror drift-correction: live deltas alone can't undo a flattened-snapshot
    // view when the backend switches screens (copilot/vim exit, `clear`). Poll the
    // engine's resync(), which reconciles to the backend's authoritative snapshot
    // — but only when output has settled AND the screen changed, so there's no
    // flicker on idle or actively-updating terminals. Paused when the tab is hidden.
    const resyncInterval = setInterval(() => {
      if (!document.hidden) void engine.resync();
    }, 1000);

    // R10: unmount() preserves the cached xterm + scrollback across transient
    // grid/layout remounts. Full teardown happens via cleanupTerminalCache on
    // terminal removal.
    return () => {
      clearInterval(resyncInterval);
      engine.unmount();
    };
    // selectedTerminalId is intentionally excluded: autoFocus only needs to be
    // correct at mount; re-running the effect on selection change would rebuild
    // the engine. Click-to-focus handles subsequent selection within grid mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  return (
    <Box
      ref={ref}
      sx={{
        width: '100%',
        height: '100%',
        backgroundColor: '#1e1e1e',
        // Default (fit) sizes the grid to the pane so nothing scrolls; when the
        // user zooms in past fit (Ctrl +), the grid exceeds the pane and these
        // scrollbars reveal the rest.
        overflow: 'auto',
        // Let .xterm size to its (backend) grid — the engine font-fits it to the
        // pane (mirror mode) — so the scrollable area matches the visual size.
        '& .xterm': { padding: '4px 8px' },
      }}
    />
  );
};

export default TerminalView;
