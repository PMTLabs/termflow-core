import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { Disposable, PromptGate } from './types';
// import cycle is safe: cross-refs are call-time only (never at module load)
import { setWebGLGloballyDisabled } from './webgl';

// Cap on bytes buffered in pendingOutput while a hydration is in flight. The
// snapshot that ends hydration supersedes older output, so beyond the cap we
// drop the OLDEST chunks (keep the tail) instead of letting a pathological
// flood OOM the renderer.
export const HYDRATION_BUFFER_CAP_BYTES = 5_000_000;

// Cache for terminal instances to persist across tab switches.
// Behavior ported from the legacy renderer terminal component.
export interface TerminalCacheEntry {
  terminal: Terminal;
  // When true, this pane has an assigned agent color scheme and its colors are
  // "locked" to the applied theme: the engine's color-OSC guard swallows the
  // program's palette/fg/bg/cursor changes so the agent can't overwrite our
  // scheme (set by the renderer via setAgentColorLock; read in TerminalEngine).
  agentColorLocked?: boolean;
  // Declared now; consumed by Task 4 (R1 output delivery).
  processId?: string;
  fitAddon: FitAddon;
  // Search addon — created once with the terminal (create path) and reused across
  // remounts (like fitAddon). Disposed implicitly by terminal.dispose() in
  // cleanupTerminalCache; stored here only so a remount restores the engine ref
  // instead of double-loading a second addon onto the cached terminal.
  searchAddon: SearchAddon;
  webglAddon: WebglAddon | null;
  useWebGL: boolean;
  hydrating: boolean;
  pendingOutput: string[];
  // Running byte total of pendingOutput (kept in sync by the onData cap logic).
  pendingOutputBytes: number;
  // Declared now; consumed by Task 4 (R1 output delivery).
  lastHydratedProcessId?: string;
  disposables: Array<() => void>;
  /**
   * Teardowns for the four DOM listeners bound to the CURRENT container — the
   * only things in the engine tied to the container rather than to the terminal
   * (design 012 D6 / §5.5): click-to-focus, capture-phase zoom keydown,
   * Ctrl/Cmd+F, and modifier+wheel zoom.
   *
   * Split out of `disposables` so `relocateTo()` can tear down the OLD
   * container's bindings without touching the xterm/addon subscriptions, which
   * are bound to the surviving `Terminal` and must stay live across the move.
   * Keeping `boundTerm.onResize` alive is what makes relocation immune to the
   * orphaned-resize class documented by engine.remount-resize.test.ts:12-20.
   *
   * REQUIRED, not optional, mirroring `disposables` above: the compiler then
   * enforces both `terminalCache.set` literals instead of a `?? []` at the read
   * site. The ResizeObserver is deliberately NOT here — it has exactly one
   * owner, `TerminalEngine.resizeObserver` (design 012 D7).
   */
  containerDisposables: Array<() => void>;
  // Spec §17 R1: cache-lifetime bridge subscriptions. Created in mount (first time
  // for a cacheKey), disposed ONLY in cleanupTerminalCache/dispose — never in unmount().
  // Declared now; consumed by Task 4 (R1 output delivery).
  dataDisposable?: Disposable;
  exitDisposable?: Disposable;
  // Mirror-mode only (web monitor). lastSnapshot = the last snapshot string the
  // engine painted, so resync() can diff and skip a no-op repaint (no flicker).
  // lastDataAt = epoch ms of the most recent live chunk, so resync() can wait for
  // output to settle before reconciling (no mid-stream flicker).
  lastSnapshot?: string;
  lastDataAt?: number;
  // Dedupe bookkeeping for the dimension heal: the last size actually dispatched
  // to the backend (stamped by hydrate pre-resize + flushBackendResize). NOT a
  // heal gate — getSize is authoritative for "did the backend converge".
  lastSentSize?: { cols: number; rows: number };
  // Epoch ms of the most recent USER input (onData), so the alt-screen state heal
  // never reset()s the buffer while the user is mid-keystroke.
  lastInputAt?: number;
  // Monotonic generation for the hydration coroutine. Lives on the ENTRY (not
  // the engine) because the entry/gate is shared per cacheKey across engine
  // instances — a remount creates a new engine, and its hydration must cancel
  // any in-flight run from the previous instance.
  hydrationGeneration: number;
  // Live-output write coalescing (post-hydration). Rapid PTY chunks are buffered
  // here and flushed to xterm in one write per coalesce window, so a TUI's
  // multi-frame redraw (e.g. codex's "park cursor at top" frame + the real redraw)
  // renders together instead of painting the intermediate cursor position — the
  // per-keystroke cursor "flash". Lives on the ENTRY so it survives unmount (the
  // cache-lifetime onData sub keeps delivering to background tabs).
  liveWriteBuf?: string;
  liveWriteTimer?: ReturnType<typeof setTimeout>;
  // Epoch ms of the first chunk in the current coalesce burst, for the max-wait cap.
  liveWriteFirstAt?: number;
  // Backlog 011: prompt-input mark preserved across unmount/remount (the cached
  // Terminal and its buffer survive a tab switch, so the mark stays valid).
  captureMark?: { row: number; col: number } | null;
  // Backlog 011: prompt-gate state preserved across unmount/remount. `seen` =
  // this terminal's shell emits prompt-render OSCs (pwsh OSC 9;9 hook / unix
  // OSC 7); `armed` = a prompt has rendered since the last submit. Without
  // persistence a remount mid-CLI-session would forget the gate and capture
  // agent-CLI input again.
  promptGate?: PromptGate | null;
  // Enhanced keyboard protocol state, carried across remounts so a mid-session
  // protocol handshake (Kitty flags pushed once, Win32-Input-Mode's ?9001h sent
  // once per PTY session) isn't lost on a tab switch / pane split. Without this,
  // a fresh TerminalEngine (created per React mount) starts with empty state even
  // though the underlying cached Terminal/PTY session never re-sent the handshake.
  kbState?: import('./keyboardProtocol').KeyboardProtocolState;
  win32State?: import('./win32InputMode').Win32InputModeState;
  // Backlog 003 (protocol-state-lost-while-unmounted): cache-lifetime disposers for
  // the CSI/OSC handlers that mutate kbState/win32State (Kitty >u/<u/=u/>m, Win32
  // 9001 on ?h/?l, DECSTR). Registered once at Terminal creation in
  // TerminalEngine.mount(), disposed ONLY here — never in unmount() — so a one-shot
  // handshake that arrives while the pane is backgrounded is still observed.
  protocolDisposables?: Array<() => void>;
  // ED3 resize-wipe repair: epoch ms of the last background-reactivation
  // convergence resize (flushDeferredResizeOnActivation actually sending a new
  // size). A CSI-3J arriving within ED3_EXPECT_WINDOW_MS of this is treated as
  // codex's resize-triggered wipe, not a user/app-initiated clear.
  convergenceResizeAt?: number;
  // Monotonic generation for the repair coroutine, mirroring hydrationGeneration —
  // a second detected wipe before the first repair's fetch resolves cancels the
  // stale one's commit.
  edRepairGeneration: number;
}

export const terminalCache = new Map<string, TerminalCacheEntry>();

// Safety valve, not normal operation: tabs are expected to dispose() their
// entries on close, but ANY missed dispose (crash path, dropped exit event)
// previously stranded a live Terminal + 10k-line scrollback + two live bridge
// subscriptions forever. Beyond the cap we evict the least-recently-MOUNTED
// entries whose render element is no longer in the DOM (never a visible pane).
// An evicted background tab rehydrates from the backend snapshot on revisit —
// scrollback beyond the visible screen is the only loss.
export const MAX_TERMINAL_CACHE_ENTRIES = 50;

export const enforceCacheCap = (): void => {
  if (terminalCache.size <= MAX_TERMINAL_CACHE_ENTRIES) return;
  // Map iteration order = insertion order; mount() re-inserts its key, so the
  // front of the map is the least-recently-mounted.
  for (const [key, entry] of terminalCache) {
    if (terminalCache.size <= MAX_TERMINAL_CACHE_ENTRIES) break;
    if (entry.terminal.element?.isConnected) continue; // visible/live — never evict
    cleanupTerminalCache(key); // disposes terminal, addons, bridge subs
  }
};

// Route a paste through the cached xterm instance for `cacheKey` so the pasted text
// is normalized (CRLF/LF → CR) and wrapped in bracketed-paste markers
// (ESC[200~ … ESC[201~) — but ONLY when the foreground app enabled DECSET 2004.
// xterm emits the result via its onData event, which the engine forwards to
// bridge.write(attachedProcessId). This is what lets CLIs (Claude Code, Gemini)
// treat a multi-line paste as one literal block instead of submitting each line.
// Returns false if no terminal is mounted for that key (caller may fall back to a
// raw write).
export const pasteToTerminal = (cacheKey: string, text: string): boolean => {
  const cached = terminalCache.get(cacheKey);
  if (!cached) return false;
  cached.terminal.paste(text);
  return true;
};

// Function to clean up a cached terminal when tab is actually closed.
// Behavior ported from the legacy renderer terminal component.
export const cleanupTerminalCache = (terminalId: string) => {
  const cached = terminalCache.get(terminalId);
  if (cached) {
    console.log(`terminal-core/cache: Cleaning up cached terminal for ${terminalId}`);

    // Cancel any pending coalesced live-write flush so it can't fire against the
    // about-to-be-disposed terminal. The buffered tail is dropped (the terminal is
    // going away).
    if (cached.liveWriteTimer != null) {
      clearTimeout(cached.liveWriteTimer);
      cached.liveWriteTimer = undefined;
      cached.liveWriteBuf = '';
      cached.liveWriteFirstAt = undefined;
    }

    // Dispose WebGL addon first
    if (cached.webglAddon) {
      try {
        cached.webglAddon.dispose();
      } catch (e) {
        console.warn(`terminal-core/cache: Error disposing WebGL addon for ${terminalId}:`, e);
      }
    }

    cached.disposables.forEach(dispose => {
      try {
        dispose();
      } catch (e) {
        console.warn(`terminal-core/cache: Error disposing local disposable for ${terminalId}:`, e);
      }
    });

    // design 012 §5.5 site 7: the container listeners live in their own array
    // now, and a cache teardown must run them too or the four DOM listeners
    // outlive the terminal they were bound to.
    cached.containerDisposables.forEach(dispose => {
      try {
        dispose();
      } catch (e) {
        console.warn(`terminal-core/cache: Error disposing container disposable for ${terminalId}:`, e);
      }
    });

    // Spec §17 R1: dispose the cache-lifetime bridge subscriptions if present.
    if (cached.dataDisposable) {
      try {
        cached.dataDisposable.dispose();
      } catch (e) {
        console.warn(`terminal-core/cache: Error disposing data subscription for ${terminalId}:`, e);
      }
    }
    if (cached.exitDisposable) {
      try {
        cached.exitDisposable.dispose();
      } catch (e) {
        console.warn(`terminal-core/cache: Error disposing exit subscription for ${terminalId}:`, e);
      }
    }

    // Backlog 003: dispose the cache-lifetime protocol-state handlers.
    if (cached.protocolDisposables) {
      cached.protocolDisposables.forEach(dispose => {
        try {
          dispose();
        } catch (e) {
          console.warn(`terminal-core/cache: Error disposing protocol handler for ${terminalId}:`, e);
        }
      });
    }

    cached.terminal.dispose();
    terminalCache.delete(terminalId);
  }
};

// Function to reset WebGL for a terminal (recreates without WebGL).
// Behavior ported from the legacy renderer terminal component.
export const resetTerminalRendering = (terminalId: string): boolean => {
  const cached = terminalCache.get(terminalId);
  if (!cached) return false;

  console.log(`terminal-core/cache: Resetting rendering for ${terminalId}`);

  // Dispose WebGL addon if present
  if (cached.webglAddon) {
    try {
      cached.webglAddon.dispose();
    } catch (e) {
      console.warn(`terminal-core/cache: Error disposing WebGL during reset:`, e);
    }
    cached.webglAddon = null;
    cached.useWebGL = false;
  }

  // Force a refresh by clearing and re-fitting
  try {
    cached.terminal.refresh(0, cached.terminal.rows - 1);
    cached.fitAddon.fit();
  } catch (e) {
    console.warn(`terminal-core/cache: Error during rendering reset:`, e);
  }

  return true;
};

// Function to disable WebGL globally and reset all terminals.
// Behavior ported from the legacy renderer terminal component.
export const disableWebGLGlobally = () => {
  console.log('terminal-core/cache: Disabling WebGL globally for all terminals');
  setWebGLGloballyDisabled(true);

  // Reset all cached terminals
  terminalCache.forEach((cached, _terminalId) => {
    if (cached.webglAddon) {
      try {
        cached.webglAddon.dispose();
      } catch (e) {
        // Ignore
      }
      cached.webglAddon = null;
      cached.useWebGL = false;

      // Refresh the terminal
      try {
        cached.terminal.refresh(0, cached.terminal.rows - 1);
      } catch (e) {
        // Ignore
      }
    }
  });
};

// Re-enable WebGL (for new terminals only).
// Behavior ported from the legacy renderer terminal component.
export const enableWebGLGlobally = () => {
  console.log('terminal-core/cache: Re-enabling WebGL globally');
  setWebGLGloballyDisabled(false);
};

// Force every live WebGL terminal to re-upload its glyph atlas to the GPU.
//
// xterm's WebGL renderer draws text by sampling a texture atlas, and uploads that
// texture only when the CPU-side page version changes (GlyphRenderer:
// `atlas.pages[i].version !== _atlasTextures[i].version`). A system STANDBY resets
// the GPU device and discards the texture's CONTENTS, but leaves the CPU-side atlas
// object — and therefore its version — untouched. xterm has no way to notice, so it
// never re-uploads: background rectangles (which need no texture) keep drawing
// correctly while every glyph samples an empty texture. The pane comes back showing
// the right background colour and NO text.
//
// Nothing self-heals it either, because only a never-before-rasterized glyph bumps
// the version — every character already in the atlas stays invisible indefinitely.
// (The user-visible workaround was changing the color scheme, which reaches the same
// repair by a different road: applyColorSchemaToTerminals → xterm's _handleColorChange
// → _refreshCharAtlas → GlyphRenderer.setAtlas, which resets each texture version to -1.)
//
// clearTextureAtlas() clears each atlas page (version++) and requests a redraw, which
// is what forces the re-upload. Cost is one glyph re-rasterization pass, so this is
// only called on resume signals — see App.tsx (`system:resume` / `session:reconnect`).
//
// Terminals on the DOM renderer (WebGL disabled, or the addon already disposed by the
// context-loss handler in webgl.ts) have no addon and are skipped: they never had the
// problem. Guarded per entry like disableWebGLGlobally — one dead addon must not stop
// the rest of the panes from being repaired.
export const refreshGlyphAtlases = (): void => {
  terminalCache.forEach((cached, terminalId) => {
    if (!cached.webglAddon) return;
    try {
      cached.webglAddon.clearTextureAtlas();
    } catch (e) {
      console.warn(`terminal-core/cache: Error refreshing glyph atlas for ${terminalId}:`, e);
    }
  });
};

// Apply a color schema (xterm ITheme-shaped) to every live cached terminal,
// e.g. when the user changes the Settings color schema. Mirrors
// disableWebGLGlobally's "iterate the cache, mutate in place" shape.
export const applyColorSchemaGlobally = (theme: Record<string, string>): void => {
  terminalCache.forEach((cached) => {
    try {
      cached.terminal.options.theme = theme;
      cached.terminal.refresh(0, cached.terminal.rows - 1);
    } catch (e) {
      console.warn('terminal-core/cache: Error applying color schema:', e);
    }
  });
};

// Apply a color schema to a specific set of cached terminals only — e.g. a
// single tab's panes when that tab has a per-tab schema override. Same
// mutate-in-place shape as applyColorSchemaGlobally, filtered to terminalIds.
export const applyColorSchemaToTerminals = (theme: Record<string, string>, terminalIds: string[]): void => {
  for (const id of terminalIds) {
    const cached = terminalCache.get(id);
    if (!cached) continue;
    try {
      cached.terminal.options.theme = theme;
      cached.terminal.refresh(0, cached.terminal.rows - 1);
    } catch (e) {
      console.warn('terminal-core/cache: Error applying color schema:', e);
    }
  }
};

// Lock/unlock a pane's colors to its currently-applied theme. While locked, the
// engine's color-OSC guard (see colorGuard.ts + TerminalEngine) swallows the
// program's own palette/fg/bg/cursor changes, so an assigned agent color scheme
// is not overwritten by the agent's theming (e.g. Copilot). Mutate-in-place like
// applyColorSchemaToTerminals; a not-yet-cached terminal is skipped (the renderer
// re-asserts on the next apply once it mounts).
export const setAgentColorLock = (terminalIds: string[], locked: boolean): void => {
  for (const id of terminalIds) {
    const cached = terminalCache.get(id);
    if (cached) cached.agentColorLocked = locked;
  }
};
