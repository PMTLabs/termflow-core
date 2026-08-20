import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { nudgeZoom, resetZoom } from '../../store/slices/zoomSlice';
import { Terminal } from '@xterm/xterm';
import { TerminalEngine } from '@termflow/terminal-core';
import type { TerminalSearchOptions, TerminalSearchResult } from '@termflow/terminal-core';
import { ContextMenu } from './ContextMenu';
import { TerminalSearchBar } from './TerminalSearchBar';
import { CommandSuggestPopup } from './CommandSuggestPopup';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { useCommandSuggest } from './useCommandSuggest';
import { useSurfaceRelocation } from './useSurfaceRelocation';
import { commandHistoryService } from '../../services/commandHistoryService';
import { getCwdSnapshot } from '../../services/cwdSnapshot';
import { inputHandler } from '../../services/InputHandler';
import { terminalService } from '../../services/TerminalService';
import { termDiag, isTermDiagEnabled, setTermDiag } from '../../utils/diag';
import { readClipboardText, writeClipboardText } from '../../utils/clipboard';
import { openNewTabWithDefaultProfile, openNewWindow, splitPaneById } from '../../services/paneActions';
import { createMainBridge } from './MainBridge';
import { getWindowsBuildNumber } from '../../api/tauri-bridge';
import { store, RootState } from '../../store';
import { setSurfaceChrome, clearSurfaceChrome } from '../../services/surfaceChrome';
import { getSchemaTheme, COLOR_SCHEMAS } from '../../store/colorSchemas';
import { resolveSchemaId, setPaneBackgroundVar } from '../../store/terminalTheme';
import { agentSchemeTracker } from '../../services/AgentSchemeTracker';
import { blendEndedTint, endedRailColor } from '../../store/endedTint';
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
  // The tab's shell profile id (e.g. 'cmd', 'powershell', 'bash'), passed straight
  // through to the engine so it can gate the Ctrl+Backspace/Ctrl+Delete word-delete
  // shim (see TerminalEngineOptions.shellType).
  shellType?: string;
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
  shellType,
}) => {
  const dispatch = useDispatch();
  // Smart Ctrl+C targets Windows/Linux; macOS keeps Cmd+C / Ctrl+C=SIGINT (design §5).
  const isMac = typeof navigator !== 'undefined' && !!navigator.platform?.includes('Mac');
  const terminalRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<TerminalEngine | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // Scroll-to-bottom button: true while the viewport is pinned to the live tail.
  // Seeded from the engine right after mount (a cached reattach may already be
  // scrolled up), then kept live via onScrollPosition.
  const [atBottom, setAtBottom] = useState(true);
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

  // Keep the latest shellType in a ref (same pattern as onTitleChangeRef above) so
  // the engine's live shellType getter sees the current value even though the
  // engine itself is constructed once per terminalId — shellType can change after
  // mount (e.g. the fallback chain resolving once shell profiles finish loading).
  const shellTypeRef = useRef(shellType);
  shellTypeRef.current = shellType;

  // Backlog 011: suggest popup state. Routed via a ref so the once-per-terminalId
  // engine options always call the live hook callbacks (same pattern as
  // onTitleChangeRef above).
  const suggest = useCommandSuggest(engineRef, () => getCwdSnapshot(terminalId));
  const suggestRef = useRef(suggest);
  suggestRef.current = suggest;

  /**
   * `plan/020` §5 — the pane's floating chrome, published so the Canvas overlay can draw it.
   *
   * This component's own render tree is UNCHANGED, deliberately: the chrome stays a sibling of
   * `.terminal-display` here, and `NodeTerminal` renders the same two components from the
   * published state when the terminal is overlaid. A portal would have been the obvious way and
   * is closed — see `surfaceChrome.ts` and `terminalDisplayRelocationWiring.test.ts`.
   *
   * Stable callbacks: they are compared by identity when deciding whether a publish is a real
   * change, so a fresh arrow per render would notify on every keystroke.
   */
  const scrollToBottomCb = useCallback(() => {
    engineRef.current?.scrollToBottom();
    engineRef.current?.focus();
  }, []);
  // One token per component instance, so a stale unmount cleanup cannot wipe the registration
  // a remount has already made under the same terminalId.
  const chromeOwner = useRef({});
  useEffect(() => {
    setSurfaceChrome(terminalId, chromeOwner.current, {
      atBottom,
      suggest: {
        open: suggest.open,
        items: suggest.items,
        selectedIndex: suggest.selectedIndex,
        focused: suggest.focused,
        anchor: suggest.anchor,
      },
      scrollToBottom: scrollToBottomCb,
      pickSuggestion: suggest.pick,
    });
  }, [
    terminalId, atBottom, scrollToBottomCb, suggest.pick,
    suggest.open, suggest.items, suggest.selectedIndex, suggest.focused, suggest.anchor,
  ]);
  useEffect(() => {
    const owner = chromeOwner.current;
    return () => clearSurfaceChrome(terminalId, owner);
  }, [terminalId]);

  /**
   * And the gate that decides whether the popup may open at all (design 012 §8.1).
   *
   * It is normally set by WHERE the surface went — `relocateTo({ paneChrome })` — because until
   * now the pane was the only surface that drew chrome. Opening the overlay moves nothing
   * (`plan/017` decision C: the same host, a bigger world rect), so there is no relocation to
   * carry the change and the host has to say so directly.
   *
   * A relocation overwrites the flag from its own argument, so leaving the canvas re-gates the
   * engine without this effect having to notice.
   *
   * KEYED ON `engineGeneration` as well, and that is not defensive. This effect is declared
   * ABOVE the engine effect, so on the first run of a component instance `engineRef.current` is
   * still null; worse, `TerminalDisplay` is rendered without a key and `TerminalPane`'s reuse
   * path lets `terminalId` change on the same instance (review 098 A1), so on that change this
   * effect would re-run BEFORE the engine effect replaces the ref — configuring the OUTGOING
   * engine and leaving the incoming one gated shut. `engineGeneration` bumps right after
   * `mount()`, which is the only moment the ref is known to hold the current terminal's engine.
   */
  const overlaidOnCanvas = useSelector((s: RootState) => s.canvas.overlayId === terminalId);
  // The effect itself is declared BELOW `useSurfaceRelocation`, which is where
  // `engineGeneration` comes from.

  // Canvas Mode surface relocation (design 012 §4.2). Placed here because its
  // callbacks close over dispatch (:85), setContextMenu (:123), setPathPicker
  // (:126), setSchemaPicker (:133) and suggestRef (:173), all declared above.
  // `engineMounted` is a stable useCallback the engine effect below calls right
  // after mount() — that bump is what makes relocation-at-mount reachable at all
  // (hazard H12, measured by spike 004 Q1).
  const { engineMounted, engineGeneration } = useSurfaceRelocation({
    terminalId,
    engineRef,
    paneRef: terminalRef,
    onRelocated: (toCanvas) => {
      // The suggest popup's REACT state — the engine's own gate (design 012 §8.1)
      // is what stops it coming back while relocated. Only on the way out: the
      // return trip should be able to re-open it normally.
      if (toCanvas) suggestRef.current.close();
      // ContextMenu portals to <body> with position: fixed at literal x/y
      // (ContextMenu.tsx:63, :67), so a menu opened before the move floats at a
      // viewport point unrelated to the terminal. Same for both pickers.
      setContextMenu(null);
      setPathPicker(null);
      setSchemaPicker(null);
      // The SEARCH BAR is deliberately left open with its state intact (§8): it
      // holds user-typed query/caseSensitive/wholeWord/regex
      // (TerminalSearchBar.tsx:27-30) and the SearchAddon's highlights live on the
      // buffer and travel with term.element. Closing it would call clearSearch()
      // and discard their query.
    },
    onAborted: () => {
      // design 012 §5.1's recovery contract. The engine is fully restored and the
      // terminal is still usable in its previous container; the surface-host
      // registration is left alone, so the canvas node shows an empty box.
      dispatch(addToast({ message: 'Could not move this terminal', type: 'error' }));
    },
  });

  // The overlay's engine gate — see the block comment above `overlaidOnCanvas`. It lives here
  // rather than up there because `engineGeneration` is declared by the hook above.
  useEffect(() => {
    if (!overlaidOnCanvas) return;
    // Captured, for the same reason the relocation effect captures its engine: at cleanup time
    // the ref can already hold a different one, and re-gating that one is not this effect's job.
    const engine = engineRef.current;
    engine?.setChromeHostActive(true);
    return () => {
      engine?.setChromeHostActive(false);
      // The engine stops emitting, but the popup's REACT state is this hook's, and a popup left
      // open would keep drawing in a node that has shrunk back to a thumbnail.
      suggestRef.current.close();
    };
  }, [overlaidOnCanvas, engineGeneration]);

  // Create the engine + mount it once per terminalId. Reattach existing process
  // when available. Cleanup → unmount() (NOT dispose — preserve the cache).
  useEffect(() => {
    // CAPTURED, not re-read at cleanup time: on a whole-component deletion React
    // detaches host refs (terminalRef.current = null) during the deletion traversal,
    // which runs BEFORE passive deletion cleanup. Rev 5 of design 012 guarded the
    // cleanup on `terminalRef.current` and that guard was FALSE on exactly the
    // interleaving it was written for, so the fallback cover relocated nothing
    // (review 099 T1-F3). The captured element is still a real — now detached — div,
    // which is all appendChild needs.
    const pane = terminalRef.current;
    if (!pane) return;

    // Ensure the host-level pipeline-healed suppressor is registered once.
    ensurePipelineHealSuppression();

    // SINGLE-USE HANDOFFS, TAKEN BEFORE THE MOUNT THAT CONSUMES THEM.
    //
    // Both `take*` calls are DESTRUCTIVE (get-then-delete; Set.delete), and they run
    // while the options object below is built — before `engine.mount()` can refuse.
    // Held in locals so the refusal path can hand them back.
    //
    // Neither is recoverable if dropped: the cross-window prompt gate exists only in
    // the source window, which has already let go of it, and ConPTY announced `?9001h`
    // once at session start with no stream still replaying it. And a refusal is exactly
    // when they are non-empty — the create-branch refusal is a FIRST-EVER mount in this
    // window, i.e. the cross-window detach and the hot-swap reattach. This effect's deps
    // are `[terminalId]` only, so it does not re-run on its own; a later mount (tab
    // switch away and back) would take `undefined`/`false` and the loss would be silent
    // and permanent for the session.
    const promptGateHandoff = terminalService.takePromptGateHandoff(terminalId);
    const win32InputModeHandoff = terminalService.takeWin32InputModeHandoff(terminalId);

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
      // Initial pane visibility (tab active state) — captured at mount, deps stay
      // [terminalId]. REQUIRED so a background tab is hidden-aware BEFORE mount()/
      // attach()/hydrate() run: the setActive effect below fires only AFTER this
      // effect, so without this the engine would SIGWINCH a CSS-hidden pane during
      // that window and wipe a ratatui CLI's (codex) scrollback. The [isActive]
      // effect handles every subsequent change.
      active: isActive,
      isWindows: typeof navigator !== 'undefined' && !!navigator.platform?.includes('Win'),
      shellType: () => shellTypeRef.current,
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
      initialPromptGate: promptGateHandoff,
      // Reattach to a session that outlived this renderer (hot-swap update /
      // webview reload): re-seed Win32-Input-Mode, whose ?9001h handshake no
      // stream still carries. Single-use — false for a normal mount, and the
      // engine ignores it off-Windows and whenever the cache entry already
      // tracks the session itself.
      initialWin32InputMode: win32InputModeHandoff,
      onInputLineChanged: (text) => suggestRef.current.onInputLineChanged(text),
      onCommandSubmitted: (cmd) => commandHistoryService.record(cmd, getCwdSnapshot(terminalId)),
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

    // The identical element captured at the top of this effect.
    //
    // The result MUST be checked (review 126). A refused mount — today, a surface
    // move that throws, or a `term.open()` that throws — leaves the engine exactly
    // as it was before the call (review 129). This effect constructs a FRESH engine
    // immediately above, so "as it was" means never wired: `engine.terminal` below
    // would throw "terminal accessed before mount()" and attach() would deliver
    // output to an engine with no terminal. The cache entry is left intact by every
    // refusal, and a refused create disposes its own half-built Terminal, so the
    // pane is left clean and the surface and its scrollback survive for a later
    // mount; this effect simply has no engine to run against and drops out.
    if (!engine.mount(pane)) {
      console.warn('TerminalDisplay: engine.mount refused; skipping attach/hydration');
      // GIVE THE SINGLE-USE HANDOFFS BACK. They were consumed above for a mount that
      // wired nothing, and REFUSAL's whole promise is that a later mount can still
      // succeed — so the state this effect took must be returned, not just the state
      // `mount()` owns. The engine's contract stops at the engine boundary; this
      // caller's does not.
      if (promptGateHandoff) terminalService.stashPromptGate(terminalId, promptGateHandoff);
      if (win32InputModeHandoff) terminalService.markReattachedSession(terminalId);
      engineRef.current = null;
      return () => {};
    }
    engineMounted();                 // ADDED — the relocation dep (design 012 §4.2.1)
    setAtBottom(engine.isScrolledToBottom());
    const scrollPositionDisposable = engine.onScrollPosition(setAtBottom);
    // Scope this pane's slack/scrollbar background to its own effective scheme
    // right away (before the next schema-apply sweep), so a split pane with a
    // different scheme never briefly inherits a sibling's background.
    const mountBackground = getSchemaTheme(
      resolveSchemaId(terminalId, store.getState(), (id) => agentSchemeTracker.getAgentForTerminal(id)),
    ).background;
    setPaneBackgroundVar(terminalId, mountBackground);
    // Seed the ended-program mark colours for THIS pane; later scheme changes are
    // pushed by applyEffectiveThemes, which this component never re-renders for.
    engine.setEndedRegionColors(blendEndedTint(mountBackground), endedRailColor(mountBackground));
    if (processId) {
      engine.attach(processId);
    }
    onReady?.(engine.terminal);

    return () => {
      scrollPositionDisposable.dispose();
      // The ORDERED FALLBACK (design 012 §4.2.2). The relocation effect's LAYOUT
      // cleanup is the PRIMARY cover and the only one that returns the element to a
      // CONNECTED node; this one runs later, in the passive phase, and lands it in a
      // detached pane div — the same place today's every remount already leaves it.
      // Whichever runs second is a free R0 identity no-op.
      //
      // It must run BEFORE unmount(): unmount() disposes every subscription, removes
      // the rail layer and nulls this.container, but it NEVER removes term.element
      // from the DOM (TerminalEngine.ts:3218-3276) — so without this, a pane teardown
      // while displayed on canvas strands a live-painting, input-dead surface in the
      // canvas host with nothing to reclaim it (hazard H11).
      //
      // Both bindings are captured: `engine` is this effect's own local, and `pane`
      // was captured at the top of this effect body — NOT re-read here, because
      // React has already nulled `terminalRef.current` by the time a deletion's
      // passive cleanup runs (review 099 T1-F3).
      engine.relocateTo(pane, { paneChrome: true });
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

  // Mark the current prompt-to-prompt span as "a program ran here", so the engine
  // can tint that scrollback once the program exits and the shell returns.
  //
  // AgentSchemeTracker already polls for exactly this and detects ANY non-shell
  // program, not a known-agent allowlist (pty_manager.rs detect_agent). Its
  // subscribe() is a zero-arg "the detected map changed", so re-read our own
  // terminal's entry. The poll is far too coarse to place a boundary (~2s), but a
  // fine yes/no predicate over a span lasting seconds to minutes — the boundary
  // comes from the shell's prompt OSC instead.
  //
  // No immediate check on subscribe: the map can hold a PREVIOUS span's program
  // until the next poll rebuilds it, and reading it eagerly would mark a fresh
  // `ls` span as a program run. Only a poll observed DURING this span may mark it.
  useEffect(() => {
    if (!terminalId) return undefined;
    return agentSchemeTracker.subscribe(() => {
      if (agentSchemeTracker.getDetectedAgentForTerminal(terminalId)) {
        engineRef.current?.markProgramActive();
      }
    });
  }, [terminalId]);

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
          label: 'New Pane Right',
          icon: '➡️',
          title: 'Split this pane with a new terminal to its right.',
          click: () => splitPaneById(paneId, 'vertical', 'after'),
        },
        {
          label: 'New Pane Left',
          icon: '⬅️',
          title: 'Split this pane with a new terminal to its left.',
          click: () => splitPaneById(paneId, 'vertical', 'before'),
        },
        {
          label: 'New Pane Up',
          icon: '⬆️',
          title: 'Split this pane with a new terminal above it.',
          click: () => splitPaneById(paneId, 'horizontal', 'before'),
        },
        {
          label: 'New Pane Down',
          icon: '⬇️',
          title: 'Split this pane with a new terminal below it.',
          click: () => splitPaneById(paneId, 'horizontal', 'after'),
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
      <ScrollToBottomButton visible={!atBottom} onClick={scrollToBottomCb} />
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
