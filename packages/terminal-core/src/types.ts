import type { Terminal } from '@xterm/xterm';

export interface TerminalSnapshot { snapshot: string; rows: number; cols: number }
export interface Disposable { dispose(): void }

// Backlog 011 prompt gate (see TerminalEngine's promptOscSeen/promptArmed doc
// comment). Shared shape for the cache entry, engine options, and the
// cross-window detach handoff — one type, not a repeated inline literal.
export interface PromptGate { seen: boolean; armed: boolean }

// VS Code-style search modifiers. Map 1:1 onto @xterm/addon-search ISearchOptions.
export interface TerminalSearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

// Emitted by the engine's onSearchResults so the host can render "N of M".
// resultIndex is zero-based; resultCount is 0 when there are no matches.
export interface TerminalSearchResult {
  resultIndex: number;
  resultCount: number;
}

export interface TerminalBridge {
  onData(processId: string, cb: (data: string) => void): Disposable;
  onExit(processId: string, cb: (exitCode: number) => void): Disposable;
  write(processId: string, data: string): void | Promise<void>;
  resize(processId: string, cols: number, rows: number): void | Promise<void>;
  getSnapshot?(processId: string, cols: number, rows: number): Promise<TerminalSnapshot>;
  getHistory?(processId: string, lines: number, offset: number): Promise<{ raw: string }>;
  // Lightweight backend-size fetch for the dimension auto-heal. Reads the stored
  // PTY size only (no snapshot render). Optional: engines fall back to getSnapshot
  // meta when a bridge doesn't implement it.
  getSize?(processId: string): Promise<{ cols: number; rows: number }>;
}

export interface TerminalEngineOptions {
  theme?: Record<string, string>;
  fontFamily?: string;
  fontSize?: number;       // default 14
  lineHeight?: number;     // default 1.1
  scrollback?: number;     // default 10000
  enableWebGL?: boolean;   // default false
  // Also gates the ConPTY 1004-noise exemption: Windows ConPTY asserts DECSET
  // 1004 (focus reporting) for EVERY session, so sendFocusMode discriminates
  // nothing there and must not suppress command suggestions. When omitted, the
  // engine sniffs navigator.platform.
  isWindows?: boolean;
  // Windows OS build number (e.g. 26200), used for xterm's `windowsPty.buildNumber`
  // so ConPTY's wrapping/reflow heuristics match the real backend. On builds >= 21376
  // xterm disables the legacy "last non-whitespace cell => wrapped line" heuristic that
  // corrupts full-width TUIs (codex/ratatui). Host should pass the real value; when
  // omitted/0 the engine assumes a modern ConPTY (see FALLBACK_WINDOWS_BUILD).
  windowsBuildNumber?: number;
  cacheKey?: string;       // terminalId — cross-mount reuse
  // When false, mount() does NOT focus the terminal (click-to-focus still works).
  // Default true preserves the main app's focus-on-mount. Set false for grid
  // panes that aren't the selected one, so they don't steal focus from each other.
  autoFocus?: boolean;     // default true
  // Viewer/mirror mode (default false). For a SECONDARY viewer of a PTY that is
  // owned and sized by another client (e.g. the web monitor watching a terminal
  // the desktop app drives). When true the engine:
  //   - never fits the xterm to its container (no initial/settle/rAF fit, no
  //     ResizeObserver) — the backend's size is authoritative, not the pane's;
  //   - skips the pre-hydration bridge.resize (must not reflow the shared PTY);
  //   - resizes the xterm to the snapshot's reported cols/rows before writing,
  //     so its layout matches the backend exactly (no wrap/cut-off).
  // The host should also make bridge.resize a no-op (defense in depth).
  mirror?: boolean;        // default false
  // macOS: treat the Option key as Meta, so Option+<key> sends an ESC-prefixed
  // (Meta) sequence — e.g. Option+P -> "\x1bp" — instead of composing a special
  // character (π). This is xterm's `macOptionIsMeta`: the exact "Option as Meta"
  // behavior terminal apps (Claude Code, readline M-… bindings, emacs) expect.
  // Default false (xterm default); no effect off macOS.
  macOptionIsMeta?: boolean; // default false
  // macOS uses Cmd (metaKey) as the zoom modifier instead of Ctrl. When omitted,
  // the engine sniffs navigator.platform. Affects the Ctrl/Cmd +/-/0 keys and
  // Ctrl/Cmd+wheel zoom gestures only.
  isMac?: boolean;
  // Per-surface zoom hook. When provided, Ctrl/Cmd +/-/0 and Ctrl/Cmd+wheel route
  // here (the host owns the zoom level — e.g. the desktop app's per-pane zoom)
  // INSTEAD of mutating the font size via onFontSizeChange. Omit it (the web
  // monitor) to keep the legacy mirror/font-size zoom behavior.
  onZoom?(direction: 'in' | 'out' | 'reset'): void;
  onFontSizeChange?(px: number): void;
  onTitleChange?(title: string): void;
  onPaste?(text: string): void;
  // Optional native clipboard injection. When provided (e.g. the Tauri app passing
  // its native clipboard), the engine uses these for context-menu copy/paste and
  // Ctrl+Shift+C/V instead of navigator.clipboard — which prompts the WebView
  // "wants to see clipboard" permission popup. Web hosts (the monitor) omit them
  // and fall back to navigator.clipboard.
  readClipboard?(): Promise<string>;
  writeClipboard?(text: string): void;
  // Backlog 005: live getter for whether smart Ctrl+C routing is enabled (read on
  // every Ctrl+C so the toggle takes effect without a remount). Host gates platform.
  smartCopy?(): boolean;
  // Called after a smart-copy so the host can show a transient "Copied" indicator.
  onCopy?(): void;
  // Backlog 003: open a clicked web link / file path. Injected by the host because
  // terminal-core has no Tauri/IPC access. openPath receives the raw matched path
  // (host resolves relative paths against the terminal cwd) + optional line/col.
  openExternal?(url: string): void;
  // x/y are the click's viewport coordinates so the host can position a picker
  // there when a relative path resolves to multiple candidate files on disk.
  openPath?(path: string, line?: number, col?: number, x?: number, y?: number): void;
  // Diagnostics sink. The engine passes a thunk so the (potentially expensive)
  // message is only built when the host has diagnostics enabled — matches the
  // main app's `termDiag(() => string)` signature. Zero cost when omitted/off.
  onDiag?(build: () => string): void;
  // Fired when Ctrl+F (Win/Linux) / Cmd+F (macOS) is pressed while this pane is
  // focused. The host opens its search overlay in response. The engine has already
  // called preventDefault() so the browser's native find dialog never opens.
  onOpenSearch?(): void;
  // Opt-in alt-screen state reconcile (Layer 3). Default false. When true, a
  // settle-gated + input-quiet + drift-triggered reconcile repaints the VISIBLE
  // alt-screen from the backend snapshot (never the main buffer / scrollback).
  healScreenState?: boolean;
  // Enhanced keyboard protocols (Kitty + modifyOtherKeys). Read live each keypress
  // so the Settings toggle takes effect without remount. Default: enabled.
  enhancedKeyboard?: () => boolean;
  // Backlog 011 — command history suggestions. Live getter (no remount) for the
  // Settings toggle; when it returns false, capture and popup are fully disabled.
  commandSuggestions?: () => boolean;
  // Prompt-gate state carried across a cross-window detach/reattach, whose
  // fresh terminalCache entry (a separate window's JS heap) has no promptGate of
  // its own yet. Only consulted on this cacheKey's first-ever mount in this
  // window (a cache entry with its own promptGate always wins).
  initialPromptGate?: PromptGate | null;
  // Current prompt input changed (shell echo applied). '' means "no input /
  // submitted / suppressed" — the host closes the popup on it.
  onInputLineChanged?(text: string): void;
  // A command was submitted with Enter at a plain prompt (already redacted).
  onCommandSubmitted?(command: string): void;
  // A popup-navigation key was intercepted while the popup is open. The host
  // owns the popup state and calls engine.setSuggestPopupState in response.
  onSuggestAction?(action: import('./commandCapture').SuggestAction): void;
}

// NOTE (spec §17 R8): NO `toggleDiagnostics` here — diagnostics stays in the main-app wrapper.
export interface ContextMenuActions {
  copy(): void; paste(): void; clear(): void; selectAll(): void;
  resetRendering(): void; toggleWebGL(): void;
}

export type { Terminal };
