import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { nudgeZoom, resetZoom } from '../../store/slices/zoomSlice';
import { Terminal } from '@xterm/xterm';
import type { FontWeight } from '@xterm/xterm';
import { TerminalEngine } from '@termflow/terminal-core';
import type { TerminalLinkHit } from '@termflow/terminal-core';
import { ContextMenu } from './ContextMenu';
import { TerminalSearchBar } from './TerminalSearchBar';
import { CommandSuggestPopup } from './CommandSuggestPopup';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { SnippetDialog } from '../UI/SnippetDialog';
import { useCommandSuggest } from './useCommandSuggest';
import { useTerminalSearch } from './useTerminalSearch';
import { useSurfaceRelocation } from './useSurfaceRelocation';
import { useOverlayChromeGate } from './useOverlayChromeGate';
import { buildCommandHistoryMenuItem, buildSnippetsMenuItem } from './snippetsHistoryMenu';
import { commandHistoryService } from '../../services/commandHistoryService';
import { getCwdSnapshot } from '../../services/cwdSnapshot';
import { inputHandler } from '../../services/InputHandler';
import { insertTextIntoTerminal } from '../../services/insertTextIntoTerminal';
import { terminalService } from '../../services/TerminalService';
import { termDiag, isTermDiagEnabled, setTermDiag } from '../../utils/diag';
import { readClipboardText, writeClipboardText } from '../../utils/clipboard';
import { openNewTabWithDefaultProfile, openNewWindow, splitPaneById } from '../../services/paneActions';
import { usePaneMuteState } from '../Panes/usePaneMuteState';
import { createMainBridge } from './MainBridge';
import { getWindowsBuildNumber } from '../../api/tauri-bridge';
import { store, RootState } from '../../store';
import { setSurfaceChrome, clearSurfaceChrome } from '../../services/surfaceChrome';
import { getSchemaTheme, COLOR_SCHEMAS } from '../../store/colorSchemas';
import { resolveSchemaId, setPaneBackgroundVar } from '../../store/terminalTheme';
import { agentSchemeTracker } from '../../services/AgentSchemeTracker';
import { blendEndedTint, endedRailColor } from '../../store/endedTint';
import { setAgentColorScheme, removeAgentColorScheme, addSnippet, setSnippetsViewMode } from '../../store/slices/settingsSlice';
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
  fontWeight?: FontWeight;
  fontWeightBold?: FontWeight;
  isActive?: boolean;
  // True when this terminal is the active pane of the active tab. Drives focus:
  // autofocus-on-mount and refocus when the tab/pane is (re)activated.
  shouldFocus?: boolean;
  // The tab's shell profile id (e.g. 'cmd', 'powershell', 'bash'), passed straight
  // through to the engine so it can gate the Ctrl+Backspace/Ctrl+Delete word-delete
  // shim (see TerminalEngineOptions.shellType).
  shellType?: string;
  /**
   * The pane's session-closed actions, published into `surfaceChrome` so the Canvas overlay can
   * draw the same `SessionClosedBanner` this pane does (`plan/024` Req 4).
   *
   * They arrive as props rather than being rebuilt here because a restart needs the profile, the
   * cwd the shell died in and the migrated session key — all `TerminalPane`'s. This component is
   * only the PUBLISHER: `surfaceChrome` allows one owner per terminalId and it is already this
   * one, so routing them through here keeps that single registration intact.
   */
  onRestartSession?: () => void;
  onDismissSessionClosed?: () => void;
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
  onRestartSession,
  onDismissSessionClosed,
  fontSize = 14,
  fontWeight,
  fontWeightBold,
  isActive = true,
  shouldFocus = true,
  shellType,
}) => {
  const dispatch = useDispatch();
  // plan/025 §2.7: the pane/tab mute pair shared with TerminalPane's header bell
  // and PaneContextMenu — see usePaneMuteState for why it is one hook, not a
  // third copy. Reaches this surface on the Canvas overlay too: the overlay
  // never renders its own TerminalDisplay (there is exactly one instantiation
  // site, TerminalPane.tsx), it only borrows this engine's context menu.
  const { paneMuted, tabMuted, effectiveMuted, toggle: toggleMute } = usePaneMuteState(paneId, terminalId);
  // plan/029 link 9: MUST be a live store read, never a hard-coded list — the
  // Snippets flyout (and Settings' own CRUD panel, T7) both read this same slice.
  const snippets = useSelector((s: RootState) => s.settings.snippets);
  // Same rule as `snippets` above: a live store read, so the flyout redraws in the
  // arrangement the toggle just persisted rather than the one it opened with.
  const snippetsViewMode = useSelector((s: RootState) => s.settings.snippetsViewMode);
  const [snippetDialogOpen, setSnippetDialogOpen] = useState(false);
  /**
   * The Snippets flyout opened by the KEYBOARD (plan/029 §6), as opposed to by a
   * right-click. Its own slot rather than a flag on `contextMenu`: it is a different
   * menu — one item, its flyout already open — and folding the two together would
   * mean every read of `contextMenu.link` had to ask which kind it was looking at.
   */
  const [snippetsMenu, setSnippetsMenu] = useState<{ x: number; y: number } | null>(null);
  // Smart Ctrl+C targets Windows/Linux; macOS keeps Cmd+C / Ctrl+C=SIGINT (design §5).
  const isMac = typeof navigator !== 'undefined' && !!navigator.platform?.includes('Mac');
  const terminalRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<TerminalEngine | null>(null);
  // Scroll-to-bottom button: true while the viewport is pinned to the live tail.
  // Seeded from the engine right after mount (a cached reattach may already be
  // scrolled up), then kept live via onScrollPosition.
  const [atBottom, setAtBottom] = useState(true);
  /**
   * The find bar's state, LIFTED into its own hook (`plan/027` §1.3).
   *
   * It used to live inside `TerminalSearchBar`, which made the bar unrenderable on a second
   * surface: its as-you-type effect runs on mount with an empty query and calls `clearSearch()`,
   * so an overlay instance mounting wiped the pane instance's live search. The bar is now
   * presentational and this is its one owner — the same move `useCommandSuggest` already made,
   * and the reason the state can be published for the Canvas overlay to draw.
   */
  const search = useTerminalSearch(engineRef, terminalId);
  /**
   * The open menu, and the LINK the right-click landed on (Tam, 2026-08-21).
   *
   * `link` is captured when the menu OPENS, not read when an item is clicked: by then the mouse
   * has moved to the item and the cell it was over is gone. Held here rather than in its own
   * state so the pair cannot desync — a separate `linkHit` slot would keep the previous
   * right-click's link alive for a menu opened somewhere with no link at all.
   */
  const [contextMenu, setContextMenu] =
    useState<{ x: number; y: number; link: TerminalLinkHit | null } | null>(null);
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
  /**
   * Mirrors `snippetDialogOpen` for code that runs BEFORE React has re-rendered.
   *
   * "Add New Snippet" opens the dialog and dismisses the menu in one click handler, so
   * `refocusTerminal` below runs while the state variable still reads `false`. Reading
   * the ref is what lets that one path opt out of the refocus.
   */
  const snippetDialogOpenRef = useRef(false);
  /**
   * Put the keyboard back in the terminal.
   *
   * Opening any of these menus moves DOM focus off the terminal — onto a menu button,
   * or the flyout's search box — and dismissing the menu unmounts whatever held it, so
   * focus lands on `document.body` and the terminal is deaf until the user clicks it.
   * That is a property of the MENU, not of any one item, so it belongs on the shared
   * close path rather than on the snippet row that happened to expose it: an item added
   * tomorrow inherits the fix instead of rediscovering the bug.
   *
   * The one exception is a menu item that opens a dialog. `SnippetDialog` focuses its
   * textarea from an effect, which runs after this synchronous call and would therefore
   * win anyway — but only by ordering, and ordering that no test could pin. The ref is
   * checked so the intent is stated rather than implied.
   */
  const refocusTerminal = useCallback(() => {
    if (snippetDialogOpenRef.current) return;
    engineRef.current?.focus();
  }, []);
  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    refocusTerminal();
  }, [refocusTerminal]);
  const closeSnippetsMenu = useCallback(() => {
    setSnippetsMenu(null);
    refocusTerminal();
  }, [refocusTerminal]);
  const closePathPicker = useCallback(() => {
    setPathPicker(null);
    refocusTerminal();
  }, [refocusTerminal]);
  const closeSchemaPicker = useCallback(() => {
    setSchemaPicker(null);
    refocusTerminal();
  }, [refocusTerminal]);
  const openSnippetDialog = useCallback(() => {
    snippetDialogOpenRef.current = true;
    setSnippetDialogOpen(true);
  }, []);
  /** Both dialog exits (Save and Cancel) land here. `useDialogA11y` restores focus to the
   *  element that opened the dialog — a menu button that has since unmounted — so the
   *  terminal has to be asked for explicitly or the keyboard is left on `<body>`. */
  const closeSnippetDialog = useCallback(() => {
    snippetDialogOpenRef.current = false;
    setSnippetDialogOpen(false);
    refocusTerminal();
  }, [refocusTerminal]);
  /**
   * Open the terminal's context menu at a point in VIEWPORT coordinates.
   *
   * Declared up here with the other published callbacks rather than beside its DOM handler
   * (which is ~380 lines down) because the publish effect below reads it, and a `const`
   * declared after that effect is in its temporal dead zone.
   *
   * The reason it is published at all: once the terminal is relocated onto a canvas node, the
   * right-click happens on that node's host and never reaches `.terminal-display`'s
   * `onContextMenu` — it lands on `.canvas-node`'s own menu instead, which offers no Copy and
   * no Paste. Only the TRIGGER has to cross the boundary; `ContextMenu` portals to
   * `document.body` and positions itself `fixed` at the literal coordinates given, so the menu
   * draws in the right place and at natural size no matter which surface asked for it, and its
   * items act on the one engine either way.
   */
  const openContextMenuAt = useCallback((x: number, y: number) => {
    // Resolved HERE, from the point the right-click happened. By the time an item is clicked the
    // pointer is on the menu and the cell it came from is unreachable — so the hit is captured
    // with the menu, in the same setState, and travels with it.
    //
    // This is also what gives the canvas OVERLAY the item for free: `NodeTerminal` routes its
    // right-click through this same callback with the same viewport coordinates, so one
    // implementation serves the pane and the node.
    setContextMenu({ x, y, link: engineRef.current?.getLinkAt(x, y) ?? null });
    // Detect the pane's agent for the "Color scheme for <agent>" item; refresh
    // once so a just-started agent is offered without waiting for the next poll.
    setAgentForMenu(agentSchemeTracker.getDetectedAgentForTerminal(terminalId));
    void agentSchemeTracker.refreshNow().then(() =>
      setAgentForMenu(agentSchemeTracker.getDetectedAgentForTerminal(terminalId)),
    );
  }, [terminalId]);
  /**
   * The container the ENGINE is currently mounted in — the canvas node while relocated,
   * this pane's own div otherwise. Held in a ref so `openSnippetsMenu` below can read it
   * without taking a dependency on it: that callback is published into `surfaceChrome`,
   * where a fresh identity on every relocation would republish and wake every canvas node.
   */
  const engineHostRef = useRef<HTMLElement | null>(null);
  /**
   * Open the Snippets flyout at the terminal's CURSOR (plan/029 §6) — the keyboard
   * equivalent of right-clicking and picking Snippets.
   *
   * Anchored at the cursor rather than at a corner because that is where the user is
   * already looking, and because it is the point the inserted text will appear at.
   * `getCursorPixelPosition` is relative to the engine's container and returns null when
   * the cursor is scrolled out of view, so the container's own top-left is the fallback.
   */
  const openSnippetsMenu = useCallback(() => {
    const rect = engineHostRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cursor = engineRef.current?.getCursorPixelPosition() ?? null;
    setSnippetsMenu({
      x: rect.left + (cursor?.left ?? 0),
      y: rect.top + (cursor ? cursor.top + cursor.cellHeight : 0),
    });
  }, []);

  // Stable identities for the two pane-owned actions, so an absent prop does not publish a fresh
  // no-op closure on every render — `same()` compares these by reference, and a new function each
  // time would make every write a change and wake every canvas node.
  const restartSessionCb = useCallback(() => { onRestartSession?.(); }, [onRestartSession]);
  const dismissSessionClosedCb = useCallback(
    () => { onDismissSessionClosed?.(); },
    [onDismissSessionClosed],
  );
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
      // `plan/027` §1.4. The whole view state travels, not a flag: the overlay draws the real
      // bar from it. Published as the hook's own object — `same()` compares it FIELD BY FIELD,
      // exactly like `suggest`, because this wrapper is fresh on every render. It carries
      // `openSearch` along for the ride, which is harmless: the field the callers use is the
      // top-level one below, and `SearchViewState` — what a surface needs in order to DRAW —
      // deliberately does not name it.
      search,
      scrollToBottom: scrollToBottomCb,
      pickSuggestion: suggest.pick,
      openContextMenu: openContextMenuAt,
      restartSession: restartSessionCb,
      dismissSessionClosed: dismissSessionClosedCb,
      openSearch: search.openSearch,
      openSnippets: openSnippetsMenu,
    });
  }, [
    terminalId, atBottom, scrollToBottomCb, suggest.pick, openContextMenuAt, openSnippetsMenu,
    suggest.open, suggest.items, suggest.selectedIndex, suggest.focused, suggest.anchor,
    restartSessionCb, dismissSessionClosedCb,
    // Every published `search` sub-field, one at a time. The object itself is a fresh wrapper
    // each render, so listing it alone would either re-publish constantly (harmless only because
    // `same()` filters it) or, if `same()` ever forgot a field, publish a STALE closure the
    // overlay keeps calling. The two lists are the same contract read from two ends.
    search.open, search.query, search.caseSensitive, search.wholeWord, search.regex,
    search.result, search.focusToken, search.setQuery, search.toggleCaseSensitive,
    search.toggleWholeWord, search.toggleRegex, search.next, search.previous, search.close,
    search.openSearch,
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
  const { engineMounted, engineGeneration, host: relocationHost } = useSurfaceRelocation({
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
      setSnippetsMenu(null);
      setPathPicker(null);
      setSchemaPicker(null);
      // The SEARCH BAR is deliberately left open with its state intact (§8): it
      // holds user-typed query/caseSensitive/wholeWord/regex (now in
      // useTerminalSearch, `plan/027` §1.3) and the SearchAddon's highlights live on
      // the buffer and travel with term.element. Closing it would call
      // search.close(), which clears the highlights AND resets their query.
    },
    onAborted: () => {
      // design 012 §5.1's recovery contract. The engine is fully restored and the
      // terminal is still usable in its previous container; the surface-host
      // registration is left alone, so the canvas node shows an empty box.
      dispatch(addToast({ message: 'Could not move this terminal', type: 'error' }));
    },
  });

  // Kept current from the render that knows it; `openSnippetsMenu` (declared with the other
  // published callbacks, far above) reads it lazily at press time. Same shape as
  // `suggestRef.current = suggest` further up.
  engineHostRef.current = relocationHost ?? terminalRef.current;

  // The overlay's engine gate. Extracted to its own hook so its DEPENDENCIES can be tested —
  // they are the whole feature, and this component cannot be mounted under the root Jest config
  // (see `useOverlayChromeGate.ts` for the round trip that a missing one broke).
  useOverlayChromeGate({
    engineRef,
    overlaid: overlaidOnCanvas,
    host: relocationHost,
    engineGeneration,
    closePopup: () => suggestRef.current.close(),
  });

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
      fontWeight,
      fontWeightBold,
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
      // has already preventDefault'd the browser's native find dialog.
      // `openSearch` bumps the focus token as well as opening, so a repeat Ctrl+F
      // (bar already open, focus back in the terminal) pulls focus back to the input.
      // Safe to call on the captured `search` wrapper even though the wrapper itself is
      // rebuilt each render: every callback on it has a stable identity by construction,
      // which is the same property `surfaceChrome`'s no-op rule depends on.
      onOpenSearch: () => search.openSearch(),
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

  // Propagate font-weight changes (Settings > Appearance).
  useEffect(() => {
    engineRef.current?.setFontWeight(fontWeight ?? 'normal', fontWeightBold ?? 'bold');
  }, [fontWeight, fontWeightBold]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    openContextMenuAt(e.clientX, e.clientY);
  };

  /**
   * The Snippets item, built ONCE for both of its hosts: the right-click menu and the
   * `Ctrl+Shift+S` menu. Two call sites building their own would be two places for a
   * prop to be forgotten — and the toggle, the insert target and the dialog hook all
   * have to behave identically whichever way the flyout was opened.
   */
  const snippetsMenuItem = () => buildSnippetsMenuItem({
    snippets,
    viewMode: snippetsViewMode,
    insert: (text) => insertTextIntoTerminal(terminalId, text),
    onAddNew: openSnippetDialog,
    onToggleViewMode: () => dispatch(
      setSnippetsViewMode(snippetsViewMode === 'flat' ? 'folders' : 'flat'),
    ),
  });

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
      // Pane-tree actions, and ONLY while the surface is actually in its pane (`plan/021` R2).
      //
      // The menu became reachable from the canvas overlay, where these four are wrong in a way
      // the text actions are not: Copy/Paste/Clear act on the engine, which is the same engine
      // wherever it is drawn, but these act on a pane tree in a tab that is off screen. Picked
      // from the overlay, "New Pane Right" silently re-lays-out a background tab and spawns a
      // PTY, and nothing visible happens on the surface the user clicked.
      //
      // `relocationHost` is the accurate test — it is non-null exactly when the terminal is
      // drawn somewhere other than its pane — rather than `overlaidOnCanvas`, which would leave
      // these live on a focused ordinary node for the same reason.
      ...(paneId && !relocationHost ? [
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
      /**
       * The link under the right-click (Tam, 2026-08-21).
       *
       * FIRST in the text block, above Copy, because when there IS a link under the pointer it
       * is almost always what the right-click was for — Copy needs a selection you made
       * beforehand, this needs only the thing you are pointing at.
       *
       * Present only when a link was actually hit, rather than always-shown-and-disabled: a
       * greyed "Copy Link" on every right-click teaches people the feature is broken, and the
       * menu already varies its shape (the pane-tree items, the agent scheme, selection mode).
       *
       * Two labels from one hit, because they are different promises. `linkHit.kind` decides —
       * see `TerminalLinkHit`.
       */
      ...(contextMenu?.link ? [{
        label: contextMenu.link.kind === 'url' ? 'Copy Link' : 'Copy Path',
        icon: contextMenu.link.kind === 'url' ? '🔗' : '📄',
        title: contextMenu.link.kind === 'url'
          ? `Copy ${contextMenu.link.text} to the clipboard.`
          : `Copy the file path ${contextMenu.link.text} to the clipboard.`,
        click: () => engine?.copyLink(contextMenu.link!.text),
      }] : []),
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
      // plan/025 §2.7. Ungated — `paneId` is set on both surfaces (the canvas
      // overlay never renders its own TerminalDisplay; see the header comment
      // on usePaneMuteState above) — unlike the pane-tree items further up,
      // which act on a tab that can be off screen. Mute is per-pane DATA, so
      // it is correct wherever the surface happens to be drawn. Label reused
      // verbatim from PaneContextMenu so the two menus cannot drift apart.
      ...(paneId ? [
        {
          label: paneMuted ? 'Unmute Pane Notifications' : 'Mute Pane Notifications',
          icon: effectiveMuted ? '🔕' : '🔔',
          title: tabMuted ? 'This pane is also muted by its tab' : undefined,
          click: () => toggleMute(),
        },
      ] : []),
      { type: 'separator' as const },
      // plan/029 §6. Command History ABOVE Snippets (stated acceptance criterion).
      // Both ungated — they must work while a TUI/CLI is running (P1), same class
      // as Copy/Paste/Clear/Mute above: they act on the terminal's own PTY write
      // path via `insertTextIntoTerminal`, not on anything pane-tree-specific.
      buildCommandHistoryMenuItem({
        cwd: getCwdSnapshot(terminalId),
        insert: (command) => insertTextIntoTerminal(terminalId, command),
      }),
      snippetsMenuItem(),
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
      // `plan/027` R2. UNGATED, the same class as Copy/Paste/Clear and Mute above: search acts
      // on the ENGINE, which is the same engine wherever its surface happens to be drawn. It
      // must not join the `!relocationHost` block further up — that exists for pane-tree actions
      // which would silently re-lay-out an off-screen tab, and gating Find that way would remove
      // it from the canvas overlay, the one surface this requirement is about.
      //
      // The first accelerator in this menu with a macOS branch: plain Ctrl+F is not search on
      // macOS. The four existing literals are left as they are (out of scope).
      {
        label: 'Find…',
        icon: '🔍',
        accelerator: isMac ? 'Cmd+F' : 'Ctrl+F',
        title: 'Search this terminal, including its scrollback.',
        click: () => search.openSearch(),
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
      {search.open && <TerminalSearchBar search={search} />}
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
          onClose={closeContextMenu}
        />
      )}
      {/* plan/029 §6 — the same flyout the right-click menu carries, opened straight from
          the keyboard: the panel alone, at the cursor, with its search box focused. */}
      {snippetsMenu && (
        <ContextMenu
          x={snippetsMenu.x}
          y={snippetsMenu.y}
          items={[snippetsMenuItem()]}
          standaloneSubmenu={0}
          onClose={closeSnippetsMenu}
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
          onClose={closePathPicker}
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
          onClose={closeSchemaPicker}
        />
      )}
      {/* plan/029 §6 — opened by the Snippets flyout's "Add New Snippet" footer row.
          Create mode only here (`snippet={null}`); editing lives in the Settings
          panel (T7). Never dispatches itself — this component owns the choice of
          `addSnippet` vs. `updateSnippet`. */}
      <SnippetDialog
        isOpen={snippetDialogOpen}
        snippet={null}
        snippets={snippets}
        onSave={(snippet) => {
          dispatch(addSnippet(snippet));
          closeSnippetDialog();
        }}
        onCancel={closeSnippetDialog}
      />
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
