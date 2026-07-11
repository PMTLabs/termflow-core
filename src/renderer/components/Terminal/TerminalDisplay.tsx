import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { useDispatch } from 'react-redux';
import { nudgeZoom, resetZoom } from '../../store/slices/zoomSlice';
import { Terminal } from '@xterm/xterm';
import { TerminalEngine } from '@termflow/terminal-core';
import type { TerminalSearchOptions, TerminalSearchResult } from '@termflow/terminal-core';
import { ContextMenu } from './ContextMenu';
import { TerminalSearchBar } from './TerminalSearchBar';
import { CommandSuggestPopup } from './CommandSuggestPopup';
import { useCommandSuggest } from './useCommandSuggest';
import { commandHistoryService } from '../../services/commandHistoryService';
import { inputHandler } from '../../services/InputHandler';
import { terminalService } from '../../services/TerminalService';
import { termDiag, isTermDiagEnabled, setTermDiag } from '../../utils/diag';
import { readClipboardText, writeClipboardText } from '../../utils/clipboard';
import { openNewTabWithDefaultProfile, openNewWindow, splitPaneById } from '../../services/paneActions';
import { createMainBridge } from './MainBridge';
import { getWindowsBuildNumber } from '../../api/tauri-bridge';
import { store } from '../../store';
import { getSchemaTheme, COLOR_SCHEMAS } from '../../store/colorSchemas';
import { resolveSchemaId, setPaneBackgroundVar } from '../../store/terminalTheme';
import { agentSchemeTracker } from '../../services/AgentSchemeTracker';
import { setAgentColorScheme, removeAgentColorScheme } from '../../store/slices/settingsSlice';
import { addToast } from '../../store/slices/uiSlice';
import { listen } from '@tauri-apps/api/event';
import { isAbsolutePath, joinCwd } from '../../utils/pathResolve';
import '@xterm/xterm/css/xterm.css';
import './TerminalDisplay.css';

// Host-level (once per renderer) suppression of dimension heals triggered by the
// backend pipeline watchdog jiggle. When the Rust backend emits `terminal:pipeline-healed`
// it has just resized EVERY terminal's PTY — all engines must skip their next heal
// for REPAINT_SETTLE_MS (600 ms) to avoid a race with the settle repaint.
let pipelineHealSub = false;
function ensurePipelineHealSuppression(): void {
  if (pipelineHealSub) return;
  pipelineHealSub = true;
  // listen() is fire-and-forget; the subscription is intentionally permanent
  // (one per renderer lifetime, never needs unlisten). Payload: { generation }.
  void listen('terminal:pipeline-healed', () => {
    // Mirror of REPAINT_SETTLE_MS = 600 (packages/terminal-core/src/TerminalEngine.ts).
    TerminalEngine.suppressHealUntil = Date.now() + 600;
  });
}

interface TerminalDisplayProps {
  terminalId: string;
  processId?: string;
  /** The pane hosting this terminal, so the right-click menu can split it. */
  paneId?: string;
  // Vestigial (spec §6.1 / §17 R2): input/resize now flow engine→bridge→electronAPI.
  // Kept in the type so TerminalPane's prop surface is unchanged; intentionally unused.
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onTitleChange: (title: string) => void;
  onReady?: (terminal: Terminal) => void;
  fontSize?: number;
  isActive?: boolean;
  // True when this terminal is the active pane of the active tab. Drives focus:
  // autofocus-on-mount and refocus when the tab/pane is (re)activated.
  shouldFocus?: boolean;
}

export const TerminalDisplay: React.FC<TerminalDisplayProps> = ({
  terminalId,
  processId,
  paneId,
  // onData / onResize are vestigial — see TerminalDisplayProps.
  onData: _onData,
  onResize: _onResize,
  onTitleChange,
  onReady,
  fontSize = 14,
  isActive = true,
  shouldFocus = true,
}) => {
  const dispatch = useDispatch();
  // Smart Ctrl+C targets Windows/Linux; macOS keeps Cmd+C / Ctrl+C=SIGINT (design §5).
  const isMac = typeof navigator !== 'undefined' && !!navigator.platform?.includes('Mac');
  const terminalRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<TerminalEngine | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // Bumped on every Ctrl+F so the bar refocuses its input each press — even when
  // it's already open and focus has moved back into the terminal (setSearchOpen
  // alone is a no-op then, so it would never refocus). See onOpenSearch below.
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  // Stable callbacks for the search overlay. engineRef is a ref (stable), so these
  // never change identity — important for subscribeResults, which the bar passes to
  // a useEffect dependency; an inline arrow would resubscribe on every render.
  const searchNextCb = useCallback(
    (q: string, o: TerminalSearchOptions, inc: boolean) => engineRef.current?.searchNext(q, o, inc),
    [],
  );
  const searchPreviousCb = useCallback(
    (q: string, o: TerminalSearchOptions) => engineRef.current?.searchPrevious(q, o),
    [],
  );
  const searchClearCb = useCallback(() => engineRef.current?.clearSearch(), []);
  const searchCloseCb = useCallback(() => {
    engineRef.current?.clearSearch();
    setSearchOpen(false);
    engineRef.current?.focus();
  }, []);
  const subscribeResultsCb = useCallback(
    (cb: (r: TerminalSearchResult) => void) => {
      const sub = engineRef.current?.onSearchResults(cb);
      return () => sub?.dispose();
    },
    [],
  );
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  // Backlog 003 follow-up: when a clicked relative path resolves to MULTIPLE files
  // (e.g. a coding agent cd'd into a subfolder), show a picker at the click point.
  const [pathPicker, setPathPicker] = useState<{
    x: number; y: number; candidates: string[]; base?: string; line?: number; col?: number;
  } | null>(null);
  // Backlog 007: per-agent color scheme. `agentForMenu` is the coding agent
  // detected in this pane when the right-click menu opened (null if none);
  // `schemaPicker` is the secondary schema-list menu it opens.
  const [agentForMenu, setAgentForMenu] = useState<string | null>(null);
  const [schemaPicker, setSchemaPicker] = useState<{ x: number; y: number; agent: string } | null>(null);

  // Open a fully-resolved path via the configured editor (with line/col) or the OS
  // default handler; surface any failure as a toast. Stable identity (deps: dispatch)
  // so the engine's openPath closure and the picker JSX can both call it.
  const openResolved = useCallback(async (path: string, line?: number, col?: number) => {
    const editor = store.getState().settings.defaultEditor;
    try {
      if (editor) await window.electronAPI.openInEditor?.(editor, path, line, col);
      else await window.electronAPI.openPath?.(path);
    } catch (e) {
      dispatch(addToast({ message: typeof e === 'string' ? e : 'Could not open file', type: 'error' }));
    }
  }, [dispatch]);

  // Single shared bridge instance (output keyed by processId; input/resize direct by processId).
  const bridge = useMemo(() => createMainBridge(), []);

  // Keep the latest onTitleChange in a ref so the engine's onTitleChange option
  // (created once per terminalId) always calls the current callback.
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;

  // Keep the latest processId in a ref so the engine's openPath option (created once
  // per terminalId) resolves relative paths against the LIVE process — e.g. after an
  // in-place session restart changes the processId without remounting.
  const processIdRef = useRef(processId);
  processIdRef.current = processId;

  // Backlog 011: suggest popup state. Routed via a ref so the once-per-terminalId
  // engine options always call the live hook callbacks (same pattern as
  // onTitleChangeRef above).
  const suggest = useCommandSuggest(engineRef);
  const suggestRef = useRef(suggest);
  suggestRef.current = suggest;

  // Create the engine + mount it once per terminalId. Reattach existing process
  // when available. Cleanup → unmount() (NOT dispose — preserve the cache).
  useEffect(() => {
    if (!terminalRef.current) return;

    // Ensure the host-level pipeline-healed suppressor is registered once.
    ensurePipelineHealSuppression();

    const engine = new TerminalEngine(bridge, {
      cacheKey: terminalId,
      // Effective schema: per-pane agent override > per-tab override > global
      // default (see store/terminalTheme.ts). A freshly-mounted terminal thus
      // picks up an already-detected agent's scheme immediately.
      theme: getSchemaTheme(
        resolveSchemaId(
          terminalId,
          store.getState(),
          (id) => agentSchemeTracker.getAgentForTerminal(id),
        ),
      ),
      fontSize,
      // Only the active pane of the active tab grabs focus on mount; background
      // panes must not steal it from each other. Refocus on activation is handled
      // by the shouldFocus effect below. (Captured at mount; deps stay [terminalId].)
      autoFocus: shouldFocus,
      isWindows: typeof navigator !== 'undefined' && !!navigator.platform?.includes('Win'),
      // Real Windows OS build number so xterm's windowsPty heuristics match the ConPTY
      // backend (disables the wrapping heuristic that corrupts codex/ratatui on >= 21376).
      // 0 until the startup fetch resolves → engine assumes a modern build.
      windowsBuildNumber: getWindowsBuildNumber(),
      isMac: typeof navigator !== 'undefined' && !!navigator.platform?.includes('Mac'),
      // Ctrl/Cmd +/-/0 and modifier+wheel zoom THIS pane only — keyed by terminalId
      // so the level follows the pane across tab/window moves and never touches the
      // shared font-size setting. TerminalPane turns the level into the font prop.
      onZoom: (direction) => {
        if (direction === 'reset') dispatch(resetZoom(terminalId));
        else dispatch(nudgeZoom({ key: terminalId, direction }));
      },
      onPaste: (text) => inputHandler.handlePasteText(text, terminalId),
      // Native clipboard for context-menu copy/paste + Ctrl+Shift+C/V, so they
      // don't trigger the WebView clipboard permission popup.
      readClipboard: () => readClipboardText(),
      writeClipboard: (text) => writeClipboardText(text),
      // Backlog 005: read live each keypress so the setting toggles without remount.
      smartCopy: () => !isMac && store.getState().settings.smartCtrlC,
      // Live each keypress so the Settings toggle applies without remount.
      enhancedKeyboard: () => store.getState().settings.enhancedKeyboard,
      // Backlog 011: command-history suggestions. Live getter (toggle without
      // remount); popup events routed through the ref to the hook.
      commandSuggestions: () => store.getState().settings.commandSuggestions,
      // Cross-window detach handoff: this window's terminalCache has no entry for
      // terminalId yet on first mount, so the source window's live prompt-gate
      // (stashed by attachExistingTerminal) fills the gap. Single-use — undefined
      // for a normal (non-detach) mount.
      initialPromptGate: terminalService.takePromptGateHandoff(terminalId),
      onInputLineChanged: (text) => suggestRef.current.onInputLineChanged(text),
      onCommandSubmitted: (cmd) => commandHistoryService.record(cmd),
      onSuggestAction: (action) => suggestRef.current.onAction(action),
      onCopy: () => dispatch(addToast({ message: 'Copied', type: 'success', duration: 2000 })),
      // Backlog 003: open URLs via the OS browser; open file paths via the OS
      // association or the configured editor, resolving relatives against the
      // terminal's live cwd. Errors surface as a toast.
      openExternal: (url) => {
        window.electronAPI.openExternal?.(url)
          .catch((e: unknown) => dispatch(addToast({ message: String(e ?? 'Could not open link'), type: 'error' })));
      },
      openPath: async (rawPath, line, col, x, y) => {
        const pid = processIdRef.current;
        // Absolute path (or no live process to resolve against): open as-is.
        if (isAbsolutePath(rawPath) || !pid) {
          void openResolved(rawPath, line, col);
          return;
        }
        // Resolve against the shell cwd, then the foreground-process cwd, then a
        // bounded background search (handles a coding agent that cd'd into a subfolder).
        let candidates: string[] = [];
        try {
          candidates = (await window.electronAPI.resolveTerminalPath?.(pid, rawPath)) ?? [];
        } catch { /* fall through to the direct-join fallback below */ }

        if (candidates.length === 1) {
          void openResolved(candidates[0], line, col);
        } else if (candidates.length > 1) {
          // Ambiguous — let the user pick which file they meant.
          let base: string | undefined;
          try { base = (await window.electronAPI.getTerminalCwd?.(pid)) ?? undefined; } catch { /* no base */ }
          setPathPicker({ x: x ?? 0, y: y ?? 0, candidates, base, line, col });
        } else {
          // Nothing matched — open the direct join so the user gets a meaningful
          // "File not found" rather than silence.
          let path = rawPath;
          try {
            const cwd = await window.electronAPI.getTerminalCwd?.(pid);
            if (cwd) path = joinCwd(cwd, rawPath);
          } catch { /* keep rawPath */ }
          void openResolved(path, line, col);
        }
      },
      onTitleChange: (t) => onTitleChangeRef.current(t),
      // Backlog 006: Ctrl/Cmd+F opens the in-terminal search overlay. The engine
      // has already preventDefault'd the browser's native find dialog. Bump the
      // focus token too so a repeat Ctrl+F (bar already open, focus back in the
      // terminal) pulls focus back to the search input.
      onOpenSearch: () => {
        setSearchOpen(true);
        setSearchFocusToken((t) => t + 1);
      },
      // termDiag gates on isTermDiagEnabled() internally — restores the exact
      // old [TERM-OUT]/[TERM-DIAG] behavior (spec §11 gate item g).
      onDiag: (build) => termDiag(build),
    });
    engineRef.current = engine;

    engine.mount(terminalRef.current);
    // Scope this pane's slack/scrollbar background to its own effective scheme
    // right away (before the next schema-apply sweep), so a split pane with a
    // different scheme never briefly inherits a sibling's background.
    setPaneBackgroundVar(
      terminalId,
      getSchemaTheme(resolveSchemaId(terminalId, store.getState(), (id) => agentSchemeTracker.getAgentForTerminal(id))).background,
    );
    if (processId) {
      engine.attach(processId);
    }
    onReady?.(engine.terminal);

    return () => {
      engine.unmount();
      engineRef.current = null;
    };
    // Only recreate if terminalId changes (matches the legacy useEffect([terminalId])).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  // Attach (or re-attach) when the processId becomes available / changes.
  // attach() is idempotent in the engine.
  useEffect(() => {
    if (engineRef.current && processId) {
      engineRef.current.attach(processId);
    }
  }, [processId]);

  // Backlog 011: a new process means a fresh prompt — stale suggestions must
  // not linger across a restart/reattach.
  useEffect(() => {
    suggestRef.current.close();
  }, [processId, terminalId]);

  // Backlog 011: a pane that lost focus must not keep a popup open. shouldFocus
  // is PANE-level (active pane of the active tab); isActive is only tab-level,
  // which would leave a popup floating over an unfocused pane in a split.
  useEffect(() => {
    if (!shouldFocus) suggestRef.current.close();
  }, [shouldFocus]);

  // Re-fit on activation.
  useEffect(() => {
    engineRef.current?.setActive(isActive);
  }, [isActive]);

  // Restore keyboard focus to this terminal when it becomes the active pane of
  // the active tab (e.g. switching back to a tab, or selecting a pane). xterm is
  // otherwise only focused on first mount + on click, so a tab switch would leave
  // the cursor on document.body and the user unable to type until they click.
  useEffect(() => {
    if (shouldFocus) {
      engineRef.current?.focus();
    }
  }, [shouldFocus]);

  // Propagate font-size changes.
  useEffect(() => {
    if (fontSize) {
      engineRef.current?.setFontSize(fontSize);
    }
  }, [fontSize]);

  // Context menu
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
    // Detect the pane's agent for the "Color scheme for <agent>" item; refresh
    // once so a just-started agent is offered without waiting for the next poll.
    setAgentForMenu(agentSchemeTracker.getDetectedAgentForTerminal(terminalId));
    void agentSchemeTracker.refreshNow().then(() =>
      setAgentForMenu(agentSchemeTracker.getDetectedAgentForTerminal(terminalId)),
    );
  };

  const getContextMenuItems = () => {
    const engine = engineRef.current;
    const actions = engine?.getContextMenuActions();
    // hasCopyableSelection (not getSelection) so Copy stays enabled under mouse-tracking
    // CLIs (Claude/Copilot), where xterm clears the live selection on the right-click
    // that opens this menu — the engine serves it from the selection retained mid-drag.
    const hasSelection = engine?.hasCopyableSelection() ?? false;
    const webglDisabled = engine?.isWebGLGloballyDisabled() ?? true;
    // Selection mode: shown only when an app holds mouse tracking (Claude/Copilot),
    // where a drag is grabbed by the app instead of selecting. Pausing the app's mouse
    // lets a plain drag select locally so the user can copy. See engine.setSelectionMode.
    const selectionMode = engine?.isSelectionMode() ?? false;
    const offerSelectionMode = selectionMode || (engine?.isMouseTrackingActive() ?? false);

    return [
      ...(paneId ? [
        {
          label: 'New Pane Horizontally',
          icon: '▤',
          title: 'Split this pane with a new terminal below it (stacked top/bottom).',
          click: () => splitPaneById(paneId, 'horizontal'),
        },
        {
          label: 'New Pane Vertically',
          icon: '▥',
          title: 'Split this pane with a new terminal beside it (side-by-side left/right).',
          click: () => splitPaneById(paneId, 'vertical'),
        },
      ] : []),
      {
        label: 'New Tab',
        icon: '➕',
        title: 'Open a new tab using your default shell profile.',
        click: () => openNewTabWithDefaultProfile(),
      },
      {
        label: 'New Window',
        icon: '🪟',
        title: 'Open a new, empty application window.',
        click: () => { void openNewWindow(); },
      },
      // Backlog 007: color scheme for the coding agent running in this pane.
      // Only shown when an agent is detected; opens a secondary schema list.
      ...(agentForMenu ? [{
        label: `Color scheme for "${agentForMenu}"`,
        icon: '🎨',
        title: `Pick a terminal color scheme for the "${agentForMenu}" agent. Applies whenever this agent runs in any pane, overriding the tab/default scheme.`,
        click: () => setSchemaPicker({ x: contextMenu?.x ?? 0, y: contextMenu?.y ?? 0, agent: agentForMenu }),
      }] : []),
      { type: 'separator' as const },
      {
        label: 'Copy',
        icon: '📋',
        accelerator: 'Ctrl+C',
        title: 'Copy the selected terminal text to the clipboard.',
        enabled: hasSelection,
        click: () => actions?.copy(),
      },
      {
        label: 'Paste',
        icon: '📥',
        accelerator: 'Ctrl+V',
        title: 'Paste clipboard text into the terminal at the cursor.',
        click: () => actions?.paste(),
      },
      // Selection mode sits with Copy/Paste as a text-interaction control. Shown
      // only when an app holds mouse tracking (Claude/Copilot), where a drag is
      // grabbed by the app instead of selecting. See engine.setSelectionMode.
      ...(offerSelectionMode ? [
        {
          label: selectionMode ? '✓ Selection mode (app mouse paused)' : 'Selection mode (pause app mouse)',
          icon: '🖱️',
          title: selectionMode
            ? 'The app\'s mouse is paused: drag to select text, then Copy. Click to give mouse control back to the app.'
            : 'A CLI is using the mouse, so dragging won\'t select. Click to pause its mouse so you can drag-select text and copy, then click again to restore it.',
          click: () => engine?.setSelectionMode(!selectionMode),
        },
      ] : []),
      { type: 'separator' as const },
      {
        label: 'Clear',
        icon: '🧹',
        accelerator: 'Ctrl+Shift+C',
        title: 'Clear the visible screen. Your command history and scrollback are kept.',
        click: () => actions?.clear(),
      },
      {
        label: 'Select All',
        icon: '🔲',
        accelerator: 'Ctrl+A',
        title: 'Select all text in this terminal, including scrollback.',
        click: () => actions?.selectAll(),
      },
      { type: 'separator' as const },
      {
        label: 'Reset Rendering',
        icon: '🔄',
        title: 'Repaint just this terminal from scratch to fix visual glitches (drops GPU/WebGL drawing for this pane). Does not affect the shell, output, or history.',
        click: () => actions?.resetRendering(),
      },
      {
        label: webglDisabled ? 'Re-enable WebGL (New Terminals)' : 'Disable WebGL (All Terminals)',
        icon: '⚡',
        title: webglDisabled
          ? 'Turn GPU (WebGL) rendering back on for newly created terminals. Existing terminals keep their current renderer until reset or reopened.'
          : 'Switch every terminal to the safer DOM renderer. Use this if GPU rendering causes glitches (smeared or misaligned text) across the app.',
        click: () => actions?.toggleWebGL(),
      },
      { type: 'separator' as const },
      {
        // Diagnostics stays in the wrapper (spec §17 R8 — the engine does not own it).
        label: isTermDiagEnabled() ? 'Disable Diagnostics Logging' : 'Enable Diagnostics Logging',
        icon: '🐞',
        title: 'Log terminal resize/cursor/output diagnostics to the developer console for troubleshooting rendering issues.',
        click: () => {
          // Logs terminal resize/cursor/output diagnostics to the dev terminal.
          // See docs/024-terminal-diagnostics-logging.md.
          setTermDiag(!isTermDiagEnabled());
        },
      },
    ];
  };

  return (
    <div className="terminal-display-wrapper">
      <div
        ref={terminalRef}
        className="terminal-display"
        onContextMenu={handleContextMenu}
        data-terminal-id={terminalId}
      />
      {searchOpen && (
        <TerminalSearchBar
          onSearchNext={searchNextCb}
          onSearchPrevious={searchPreviousCb}
          onClear={searchClearCb}
          onClose={searchCloseCb}
          subscribeResults={subscribeResultsCb}
          focusToken={searchFocusToken}
        />
      )}
      {suggest.open && (
        <CommandSuggestPopup
          suggestions={suggest.items}
          selectedIndex={suggest.selectedIndex}
          focused={suggest.focused}
          anchor={suggest.anchor}
          onPick={suggest.pick}
        />
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems()}
          onClose={() => setContextMenu(null)}
        />
      )}
      {pathPicker && (
        <ContextMenu
          x={pathPicker.x}
          y={pathPicker.y}
          items={pathPicker.candidates.map((c) => ({
            label: pickerLabel(c, pathPicker.base),
            icon: '📄',
            title: c,
            click: () => { void openResolved(c, pathPicker.line, pathPicker.col); },
          }))}
          onClose={() => setPathPicker(null)}
        />
      )}
      {schemaPicker && (
        <ContextMenu
          x={schemaPicker.x}
          y={schemaPicker.y}
          items={[
            {
              label: 'Use tab / default',
              icon: '↩️',
              title: `Remove the "${schemaPicker.agent}" agent color-scheme override.`,
              click: () => dispatch(removeAgentColorScheme({ agent: schemaPicker.agent })),
            },
            ...COLOR_SCHEMAS.map((s) => ({
              label: (store.getState().settings.agentColorSchemes[schemaPicker.agent] === s.id ? '✓ ' : '') + s.name,
              icon: '🎨',
              title: `Use ${s.name} while "${schemaPicker.agent}" is running.`,
              click: () => dispatch(setAgentColorScheme({ agent: schemaPicker.agent, colorSchemaId: s.id })),
            })),
          ]}
          onClose={() => setSchemaPicker(null)}
        />
      )}
    </div>
  );
};

/** Label a candidate by the part below the searched base dir (the differing folder),
 *  so the picker reads `rephlo-sites\…\file.cs` rather than a long absolute path. */
function pickerLabel(candidate: string, base?: string): string {
  if (base && candidate.toLowerCase().startsWith(base.toLowerCase())) {
    return candidate.slice(base.length).replace(/^[\\/]+/, '') || candidate;
  }
  return candidate;
}

// Re-export the module-level cache helpers so external callers (e.g.
// TabManager's `cleanupTerminalCache` import) keep resolving from this module.
export {
  cleanupTerminalCache,
  resetTerminalRendering,
  disableWebGLGlobally,
  enableWebGLGlobally,
} from '@termflow/terminal-core';
