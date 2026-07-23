import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SearchAddon } from '@xterm/addon-search';
import type { ISearchOptions } from '@xterm/addon-search';
import { KeyboardProtocolState, encodeKey } from './keyboardProtocol';
import { Win32InputModeState, encodeWin32Key, scanWin32ModeSequences } from './win32InputMode';
import { HeuristicCapture, decideSuggestKey } from './commandCapture';
import type { SuggestPopupState } from './commandCapture';
import {
  EndedRegionTracker,
  registerEndedRegionTracker,
  unregisterEndedRegionTracker,
} from './endedRegions';

import type {
  TerminalBridge,
  TerminalEngineOptions,
  TerminalSearchOptions,
  TerminalSearchResult,
  ContextMenuActions,
} from './types';
import { terminalCache, HYDRATION_BUFFER_CAP_BYTES } from './cache';
import { shouldBlockColorOsc, COLOR_OSC_CODES } from './colorGuard';
import {
  cleanupTerminalCache,
  enforceCacheCap,
  resetTerminalRendering,
  disableWebGLGlobally,
  enableWebGLGlobally,
} from './cache';
import {
  loadWebGLAddon,
  isWebGLGloballyDisabled,
} from './webgl';

// Platform-native default font stacks. Cross-platform correctness matters here:
// each OS must resolve to ITS OWN crisp system monospace, not another platform's
// font or a coarse generic. Every stack leads with `ui-monospace` (the OS system
// monospace — SF Mono on macOS, Cascadia/Consolas on Windows) then names that
// platform's guaranteed fonts explicitly as a hard guarantee. The prior single
// stack led with fonts absent from a stock macOS install (MesloLGS NF, Cascadia
// Code, Consolas) and fell through to Courier New / generic monospace, which
// WKWebView renders coarsely (the "not smooth on macOS" report). MesloLGS NF
// stays in each chain (not first) so an installed Nerd font still supplies
// powerline/prompt glyphs via per-glyph fallback while the system font handles
// normal text. Pure (platform passed in) so it is unit-testable.
export function defaultFontFamily(isMac: boolean, isWindows: boolean): string {
  if (isMac) {
    // SF Mono / Menlo / Monaco all ship with macOS; Menlo is the guaranteed catch.
    return 'ui-monospace, "SF Mono", Menlo, Monaco, "MesloLGS NF", monospace';
  }
  if (isWindows) {
    // Consolas ships with every Windows; Cascadia Mono/Code come with Windows Terminal.
    return 'ui-monospace, Consolas, "Cascadia Mono", "Cascadia Code", "MesloLGS NF", "Courier New", monospace';
  }
  // Linux / other: common libre monospace faces, then generic.
  return 'ui-monospace, "DejaVu Sans Mono", "Liberation Mono", "JetBrains Mono", "MesloLGS NF", monospace';
}

// Full 16-color theme — copied byte-for-byte from TerminalDisplay.tsx:301-322.
// Exported so hosts (e.g. the monitor) can reuse the exact main-app ANSI palette
// for color parity while overriding only background/cursor for their own cohesion.
export const DEFAULT_THEME: Record<string, string> = {
  background: '#000000',
  foreground: '#f2f2f2',
  cursor: '#ffffff',
  cursorAccent: '#000000',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#959595',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;
const DEFAULT_FONT_SIZE = 14;

// Match-highlight colors for the search addon. #RRGGBB only (the addon forbids
// alpha). matchOverviewRuler / activeMatchColorOverviewRuler are required fields.
const SEARCH_DECORATIONS = {
  matchBackground: '#515c0a',
  matchBorder: '#c2c20a',
  matchOverviewRuler: '#c2c20a',
  activeMatchBackground: '#9e6a03',
  activeMatchBorder: '#ffb454',
  activeMatchColorOverviewRuler: '#ffb454',
};

// xterm disables the legacy "windows wrapping heuristic" once it knows the PTY is a
// ConPTY on build >= 21376 (the build that gained proper VT passthrough/reflow). That
// heuristic — "a line whose last cell is non-whitespace is a soft-wrapped continuation"
// — falsely marks full-width TUI lines (codex/ratatui borders + backgrounds fill the
// last column) as wrapped, breaking borders, the input background, and the cursor.
// When the host can't supply the real OS build, assume a modern ConPTY so the heuristic
// stays OFF (this app targets modern Windows). 22000 = Windows 11 21H2 RTM (>= 21376).
const FALLBACK_WINDOWS_BUILD = 22000;

// Mirror-mode (web monitor) drift-correction: only reconcile against the backend
// snapshot once live output has been quiet for this long, so resync() never
// repaints mid-stream.
const RESYNC_SETTLE_MS = 700;

// Coalesce backend PTY resizes during a window drag. xterm resizes visually on
// every fit (immediate), but each BACKEND resize makes the PTY repaint at the new
// size — on Windows ConPTY that repaint is appended into xterm, so a drag that
// fires dozens of resizes duplicates on-screen lines (the banner/prompt appear
// many times). Debouncing sends only the FINAL size once the drag settles.
const BACKEND_RESIZE_DEBOUNCE_MS = 120;

// Cap how long the initial measuring fit waits for the real terminal font. A
// missing/slow font must never block terminal creation; after this we fit with
// whatever metrics are available and let the watchdog/ResizeObserver correct later.
const FONT_READY_TIMEOUT_MS = 1500;

// Layer 2: idle UI-authoritative dimension watchdog.
const HEAL_INTERVAL_MS = 1000;          // idle watchdog cadence (matches mirror cadence)
const HEAL_SETTLE_MS = RESYNC_SETTLE_MS; // reuse the 700ms output-quiet gate
const HEAL_MAX_CONSECUTIVE_MISMATCH = 5; // give up re-pushing if the backend never converges
// Suppression window applied after a repaint-inducing event (e.g. backend pipeline jiggle).
// Task 7 sets TerminalEngine.suppressHealUntil = Date.now() + REPAINT_SETTLE_MS.
const REPAINT_SETTLE_MS = 600;

// Debounce the live in-place search refresh (the onWriteParsed → refreshSearch
// path). refreshSearch runs findNext over the whole scrollback to keep the
// N-of-M counter + highlights fresh; firing it on every parsed write would burn
// CPU during heavy streaming (build logs, cat of a big file). Coalescing to a
// trailing refresh keeps the counter responsive without per-chunk re-searches.
const SEARCH_REFRESH_DEBOUNCE_MS = 150;

// Debounce-coalesce live PTY output into one xterm write per burst. A TUI redraw can
// arrive as several chunks AND span more than one "frame": codex draws (leaving the
// cursor parked mid-screen) and then sends a SEPARATE cursor-reposition frame. Writing
// each chunk — or flushing on a fixed clock that can cut between the redraw and the
// reposition — lets xterm paint the intermediate cursor position (the "flash", seen e.g.
// on held backspace). Debouncing on idle keeps the whole burst together so only the
// final cursor renders, like a native terminal. The MAX cap bounds latency so a
// continuous stream (cat a big file) still flushes smoothly instead of stalling.
// IDLE must sit ABOVE xterm's own ~16ms paint-coalescing (else it splits frames xterm
// would have grouped) yet BELOW the key-repeat interval (~33ms, so held-key bursts stay
// separate and each flushes on its own trailing reposition). 24ms hits that band.
const LIVE_WRITE_IDLE_MS = 24;
const LIVE_WRITE_MAX_MS = 64;

// Backlog 011: window after a suggestion accept during which Enter keydowns are
// swallowed. Covers OS key auto-repeat (~30ms interval after a ~500ms delay)
// without noticeably delaying a deliberate follow-up Enter.
const ACCEPT_ENTER_GUARD_MS = 300;

const clampFontSize = (px: number): number =>
  Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, px));

// First family token of a CSS font-family list (keeps quotes), e.g. '"MesloLGS NF"'.
function firstFontFamily(family: string): string {
  return (family.split(',')[0] ?? family).trim();
}

// Deterministic fallback cache-key counter for engines constructed without a
// cacheKey (no cross-mount reuse). Real callers always pass cacheKey, so this
// has no production effect — it just avoids a non-deterministic random key.
let anonCacheKeySeq = 0;

/**
 * Decide what Ctrl+C should do (backlog 005). 'copy' when smart routing is on AND
 * there is a selection; otherwise 'sigint' (the classic interrupt). Pure so it is
 * unit-testable without an xterm instance.
 */
export function decideCtrlC(hasSelection: boolean, smartEnabled: boolean): 'copy' | 'sigint' {
  return smartEnabled && hasSelection ? 'copy' : 'sigint';
}

/**
 * Choose the text a copy gesture should act on. The live xterm selection wins when
 * present. Otherwise — and ONLY while an app holds mouse tracking on — fall back to
 * the selection we retained during the drag: under mouse tracking xterm clears the
 * live selection on the very pty input (a mouse move, or the right-click that opens
 * the context menu) that precedes the copy, so by copy time the live selection is
 * already empty. In a normal shell the live selection is authoritative, so a retained
 * value is ignored (it would otherwise leave Copy stale-enabled after the user moved
 * on). Pure so it is unit-testable without an xterm instance.
 */
export function pickCopyText(live: string, retained: string, mouseTrackingActive: boolean): string {
  if (live) return live;
  return mouseTrackingActive ? retained : '';
}

// "Selection mode" support. Under a mouse-tracking CLI (Claude/Copilot) xterm forwards
// mouse drags to the app instead of selecting, and Shift+drag does NOT force a local
// selection in the Tauri WebView (the Shift modifier never reaches xterm's mousedown).
// So we SUSPEND the app's mouse capture: writing these DECRSTs to xterm flips
// areMouseEventsActive off, which re-enables xterm's SelectionService — then a plain
// drag selects locally. Resets every tracking + encoding variant; resetting one that
// wasn't set is a harmless no-op.
export const MOUSE_DISABLE_SEQ =
  '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l';

/**
 * Re-enable the mouse tracking that was active before selection mode suspended it,
 * with SGR(1006) encoding (the modern default these CLIs use). Best-effort restore
 * keyed off `term.modes.mouseTrackingMode`. Pure so it is unit-testable.
 */
export function mouseModeEnableSeq(mode: 'none' | 'x10' | 'vt200' | 'drag' | 'any'): string {
  const track =
    mode === 'any' ? '\x1b[?1003h' :
    mode === 'drag' ? '\x1b[?1002h' :
    mode === 'vt200' ? '\x1b[?1000h' :
    mode === 'x10' ? '\x1b[?9h' : '';
  return track ? `${track}\x1b[?1006h` : '';
}

// Backlog 005 refinement: mashing Ctrl+C means "interrupt", even with a selection.
// When this many presses land within the window, force SIGINT (override smart-copy).
export const CTRL_C_BURST_WINDOW_MS = 2000;
export const CTRL_C_BURST_COUNT = 3;

/**
 * True when at least `count` Ctrl+C presses fall within `windowMs` ending at `now`
 * — a burst the user means as "interrupt", which overrides smart-copy. Pure so it
 * is unit-testable without an xterm instance.
 */
export function isCtrlCBurst(
  timestamps: number[],
  now: number,
  windowMs = CTRL_C_BURST_WINDOW_MS,
  count = CTRL_C_BURST_COUNT,
): boolean {
  return timestamps.filter((t) => now - t < windowMs).length >= count;
}

// Known POSIX/readline-style shell profile ids (see compute_available_shells in
// src-tauri/src/pty_manager.rs): 'bash', 'zsh', 'fish', 'cygwin', 'git-bash', and
// any 'wsl'/'wsl-<distro>' id. A WHITELIST, not "everything except cmd/powershell/
// pwsh" — this app also uses ambiguous placeholder shellType values ('default',
// set e.g. by StateManager.resetToDefaultLayout and TerminalPane's fallback chain
// before shell profiles finish loading; 'settings') that do NOT mean "an
// unrecognized POSIX shell". 'default' in particular very often resolves to a
// real PowerShell session (PowerShell 7 is pushed first with is_default:true in
// compute_available_shells), so defaulting unknown ids to POSIX would misfire the
// shim into PowerShell. Unrecognized/ambiguous ids simply don't get the shim,
// same as before this feature existed.
const POSIX_SHELL_RE = /^(bash|zsh|fish|sh|cygwin|git-bash|wsl(-.*)?)$/i;

/**
 * True for shells that read raw VT bytes via their own readline-style line editor
 * (bash, zsh, Git Bash, WSL) — the shells the word-delete shim below targets.
 * False for native Windows console apps (cmd.exe, PowerShell/pwsh), which already
 * get correct word-delete via Win32-Input-Mode + their own native keybindings
 * (PSReadLine's BackwardKillWord/KillWord) and must NOT be shimmed — sending raw
 * ESC-prefixed bytes there would be read as literal Escape + character keystrokes
 * instead of a chord — and false for anything unrecognized (safer default: an
 * unresolved/ambiguous shellType is far more likely to be a disguised Windows
 * console shell in this app than a genuine unlisted POSIX one). Pure so it is
 * unit-testable.
 */
export function isPosixShell(shellType: string | undefined): boolean {
  return !!shellType && POSIX_SHELL_RE.test(shellType);
}

/**
 * Decide the byte sequence for Ctrl+Backspace/Ctrl+Delete word-delete on a plain
 * POSIX/readline shell prompt. A VT-byte shell (bash, zsh) can't distinguish
 * Ctrl+Backspace from a literal Ctrl+H — both encode to the same byte (0x08), a
 * documented ConPTY/terminal limitation — so without this shim it just backspaces
 * one character instead of a word. Win32-Input-Mode and the Kitty protocol already
 * relay these chords with full modifier fidelity to shells that read them natively
 * (PSReadLine, Kitty-protocol TUIs), so this only fires when neither applies.
 * Sequences match readline's own defaults (`M-DEL`/`M-d`) and the same word-boundary
 * semantics as the existing Alt+Arrow word-nav shim (`M-b`/`M-f`) — not unix-word-
 * rubout's whitespace-only boundary. Pure so it is unit-testable without an xterm
 * instance.
 */
export function decideWordDeleteShim(
  key: string,
  mods: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean },
  isNormalBuffer: boolean,
  protocolActive: boolean,
  shellType: string | undefined,
): string | null {
  if (!isNormalBuffer || protocolActive) return null;
  if (!mods.ctrlKey || mods.altKey || mods.shiftKey || mods.metaKey) return null;
  if (!isPosixShell(shellType)) return null;
  if (key === 'Backspace') return '\x1b\x7f'; // Meta+Backspace -> readline backward-kill-word
  if (key === 'Delete') return '\x1bd'; // Meta+d -> readline kill-word
  return null;
}

export interface PathLinkMatch {
  /** 0-based start index within the line string. */
  start: number;
  /** 0-based end index (exclusive). */
  end: number;
  /** The file path WITHOUT the :line:col suffix. */
  path: string;
  line?: number;
  col?: number;
}

// Bounded, ReDoS-safe matcher for file paths in terminal output (backlog 003).
// Four alternatives, each with an optional :line(:col) suffix:
//   1. Windows-abs: C:\foo\bar OR C:/foo/bar (tools/agent logs print either
//      separator). The `(?<![A-Za-z])` guard keeps a URL scheme's single letter
//      before `://` (the `p` in `http://`) from being read as a `p:` drive.
//   2. Anchored relative: ./foo, ../foo, .\foo (either separator) — the leading
//      dot-slash signals user intent, so no file extension is required.
//   3. POSIX-abs: /foo/bar — but only at a real boundary. The `(?<![\w.:/\\-])`
//      lookbehind stops the `/` *inside* `origin/develop` (or `http://host/p`)
//      from starting a bogus absolute-path match.
//   4. Bare relative: seg/seg/…/name.ext. The final segment MUST be a strict
//      `name.ext` (dot-separated word groups, no consecutive dots) so git refs
//      (feature/audit-x, origin/develop) AND range expressions (a...b) — none of
//      which form a real filename — are NOT mistaken for files. Folder-only paths
//      need the anchored form (./folder) to be detected.
// Negated/anchored char classes keep every branch free of unbounded backtracking.
const PATH_RE =
  /(?:(?<![A-Za-z])[A-Za-z]:[\\/][^\s:*?"<>|]+|\.{1,2}[\\/][^\s:*?"<>|]+|(?<![\w.:/\\-])\/[^\s:*?"<>|]+|[\w.-]+(?:[\\/][\w.-]+)*[\\/][\w-]+(?:\.[\w-]+)+)(?::(\d+)(?::(\d+))?)?/g;

// Strip trailing punctuation that terminals / markdown / tool logs place right
// AFTER a path but that isn't part of it — e.g. the `)` in `Write(C:\a\b.md)` or
// a sentence-final `.`/`,`. Closing brackets are only stripped when UNBALANCED
// within the path itself, so a genuine `dir/file(1).txt` keeps its parens.
function trimPathTrailing(path: string): string {
  let end = path.length;
  for (;;) {
    const ch = path[end - 1];
    if (ch === undefined) break;
    if ('.,;!?"\'`'.includes(ch)) {
      end--;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const open = ch === ')' ? '(' : ch === ']' ? '[' : '{';
      const body = path.slice(0, end);
      const opens = body.split(open).length - 1;
      const closes = body.split(ch).length - 1;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return path.slice(0, end);
}

/** Find file-path links (with optional :line:col) in one line of terminal text. */
export function findPathLinks(text: string): PathLinkMatch[] {
  const out: PathLinkMatch[] = [];
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(text)) !== null) {
    const whole = m[0];
    const line = m[1] ? parseInt(m[1], 10) : undefined;
    const col = m[2] ? parseInt(m[2], 10) : undefined;
    // Strip the :line:col suffix from the path body.
    let pathLen = whole.length;
    if (m[1]) {
      const suffix = ':' + m[1] + (m[2] ? ':' + m[2] : '');
      pathLen = whole.length - suffix.length;
    }
    // Trim trailing wrapper/sentence punctuation only when there's no :line:col
    // suffix — a suffix already terminates the match before any such char.
    const rawPath = whole.slice(0, pathLen);
    const path = m[1] ? rawPath : trimPathTrailing(rawPath);
    out.push({ start: m.index, end: m.index + path.length, path, line, col });
  }
  return out;
}

// A logical line can span many buffer rows when it soft-wraps. Cap how many rows
// get stitched together per hover so a pathological single line (e.g. `cat` of a
// minified file) can't turn every provideLinks call into a huge walk.
const MAX_WRAPPED_LINK_ROWS = 64;

export interface WrappedLineInfo {
  /** 0-based buffer row where the logical line starts. */
  firstRow: number;
  /** The logical line with wrapped continuation rows joined. */
  text: string;
  /** rowStarts[i] = index in `text` where buffer row (firstRow + i) begins. */
  rowStarts: number[];
}

interface LinkableBufferLine {
  isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

/**
 * Stitch the full logical line containing buffer row `row` (0-based). A row with
 * `isWrapped` continues the PREVIOUS row (real xterm semantics), so walk back to
 * the line start, then join forward across continuations. Interior rows keep
 * trailing spaces (they are real characters of the logical line); only the final
 * row is right-trimmed. Returns null for a missing row or a line over the cap.
 */
export function collectWrappedLine(
  buffer: { getLine(n: number): LinkableBufferLine | undefined },
  row: number,
  maxRows = MAX_WRAPPED_LINK_ROWS,
): WrappedLineInfo | null {
  if (!buffer.getLine(row)) return null;
  let first = row;
  let guard = maxRows;
  while (first > 0 && buffer.getLine(first)?.isWrapped) {
    if (--guard <= 0) return null;
    first--;
  }
  const rowStarts: number[] = [];
  let text = '';
  for (let r = first; r - first < maxRows; r++) {
    const line = buffer.getLine(r);
    if (!line) break; // a line shouldn't vanish mid-walk, but stop cleanly
    rowStarts.push(text.length);
    if (buffer.getLine(r + 1)?.isWrapped) {
      text += line.translateToString(false);
    } else {
      text += line.translateToString(true);
      return { firstRow: first, text, rowStarts };
    }
  }
  return null; // hit the cap (or a hole) before the logical line ended
}

/**
 * Map a [start, endExclusive) character range in a stitched logical line back to
 * xterm 1-based buffer coordinates (range end is inclusive of the last cell).
 * Equals the old single-row mapping (`{x: start+1}` / `{x: end}`) when the line
 * occupies one row.
 */
export function wrappedBufferRange(
  info: WrappedLineInfo,
  start: number,
  endExclusive: number,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const locate = (idx: number): { x: number; y: number } => {
    let r = info.rowStarts.length - 1;
    while (r > 0 && info.rowStarts[r] > idx) r--;
    return { x: idx - info.rowStarts[r] + 1, y: info.firstRow + r + 1 };
  };
  return { start: locate(start), end: locate(endExclusive - 1) };
}

/**
 * Framework-agnostic terminal engine. Owns xterm construction, addon wiring,
 * fit/resize handling, keyboard handling and the cross-mount instance cache.
 *
 * This is a behavior-for-behavior port of the construction / mount-reattach /
 * lifecycle / keyboard portions of the legacy renderer `TerminalDisplay.tsx`.
 *
 * NOTE (scope): `attach()` wires the cache-lifetime output-delivery subscription
 * (bridge.onData/onExit) and snapshot hydration (spec §17 R1). Those subscriptions
 * live on the cache ENTRY and are disposed only by cleanupTerminalCache()/dispose(),
 * never by unmount() — preserving background-tab output delivery.
 */
export class TerminalEngine {
  private readonly bridge: TerminalBridge;
  private readonly opts: TerminalEngineOptions;
  private readonly cacheKey: string;

  // The backend processId this engine writes input/resize to. Set by attach().
  private attachedProcessId: string | null = null;

  private container: HTMLElement | null = null;
  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private searchAddon: SearchAddon | null = null;
  /** Marks the scrollback an ended program produced. All region logic lives in
   *  the tracker; this class only forwards events and owns its lifetime. */
  private endedRegions: EndedRegionTracker | undefined;
  // Enhanced keyboard protocol state (Kitty + modifyOtherKeys); see keyboardProtocol.ts.
  private kbState = new KeyboardProtocolState();
  // Win32-Input-Mode (ConPTY-offered, Windows-only); see win32InputMode.ts.
  private win32State = new Win32InputModeState();
  private enhancedKbEnabled(): boolean {
    return this.opts.enhancedKeyboard ? this.opts.enhancedKeyboard() : true;
  }
  private protocolActive(): boolean {
    return (
      this.enhancedKbEnabled() &&
      (this.kbState.activeFlags() !== 0 || this.kbState.snapshot().modifyOtherKeys >= 1)
    );
  }
  // Deliberately orthogonal to protocolActive() (see design 043 "Why full-session
  // activation"): ConPTY offers Win32-Input-Mode for every Windows session, not
  // just TUIs, so folding this into protocolActive() would silently disable the
  // command-suggest popup (suggestionsAllowed() requires !protocolActive() at a
  // plain shell prompt) on every Windows machine.
  private win32InputModeActive(): boolean {
    return this.isWindowsPlatform() && this.enhancedKbEnabled() && this.win32State.isActive();
  }
  // Backlog 011 — command capture + suggest popup interception state.
  private capture: HeuristicCapture | null = null;
  private suggestState: SuggestPopupState = 'closed';
  private lastEmittedInput = '';
  // When a mark is invalidated while typed input may still be pending on the
  // line (Ctrl+L redraw, resize reflow, self-heal), a re-mark would sit
  // MID-command and Enter would store a tail fragment ("atus"). Skip capturing
  // until the next submit instead — a clean miss beats storing garbage.
  private suppressUntilSubmit = false;
  // Backlog 011 prompt gate. `promptOscSeen`: this terminal's shell emits
  // prompt-render OSCs (pty_manager's injected pwsh hook emits OSC 9;9 at every
  // prompt render; unix shells OSC 7). Once seen, capture marks are planted ONLY
  // while `promptArmed` — a prompt has rendered since the last submit. While an
  // agent CLI / REPL (claude, codex, gemini, bare python) owns the pty, no shell
  // prompt renders, so its input can never reach history or open the popup.
  // This is the load-bearing suppression on Windows, where terminal-mode
  // sniffing fails: ConPTY asserts DECSET 1004 for EVERY session, and codex
  // asserts no discriminating mode at all at its composer.
  private promptOscSeen = false;
  private promptArmed = false;
  // Mirror every promptOscSeen/promptArmed change into the cache entry immediately
  // (not just at unmount) — a cross-window detach reads this cache entry mid-session,
  // before this engine ever unmounts, and needs the CURRENT gate, not a stale one.
  private setPromptGate(seen: boolean, armed: boolean): void {
    this.promptOscSeen = seen;
    this.promptArmed = armed;
    const entry = terminalCache.get(this.cacheKey);
    if (entry) entry.promptGate = { seen, armed };
  }
  // Keys typed while disarmed may be shell type-ahead that PSReadLine echoes at
  // the NEXT prompt render; a mark planted after that echo would sit mid-line
  // and Enter would capture a tail fragment. Arming skips one command instead
  // (clean-miss rule). Cleared by Enter/Ctrl+C, which flush the pending line.
  private sawInputWhileDisarmed = false;
  // Set on suggestion accept; swallows the keydown auto-repeat tail of the
  // accept gesture so holding (Shift+)Enter can't insert AND run the command.
  private lastAcceptAt = 0;
  // The active search query + options, so onWriteParsed can re-run it in place.
  private activeSearch: { query: string; opts: TerminalSearchOptions } | null = null;
  private resizeObserver: ResizeObserver | null = null;

  // Pending post-activation/font-change fit timer; cleared on re-schedule and
  // unmount so a fit can't fire against a torn-down or re-created mount.
  private fitTimer: ReturnType<typeof setTimeout> | null = null;

  // Debounce for backend PTY resizes (see BACKEND_RESIZE_DEBOUNCE_MS). xterm's
  // own resize is immediate; only the bridge.resize() call is coalesced. Cleared
  // on unmount so it can't fire against a torn-down mount.
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingResize: { cols: number; rows: number } | null = null;
  // True while a bridge.resize() round-trip is outstanding (set by flushBackendResize
  // and the hydrate pre-resize, cleared when it settles). The heal skips while set —
  // flushBackendResize nulls pendingResize BEFORE awaiting, so pendingResize alone
  // leaves a gap where a heal tick could schedule a racing second resize.
  private resizeInFlight = false;

  // Layer 2: idle dimension heal watchdog.
  private healing = false;
  private healTimer: ReturnType<typeof setInterval> | null = null;
  private healMismatchCount = 0;
  // Watchdog event-listener teardown — owned by startHealWatchdog/stopHealWatchdog,
  // NOT pushed to this.disposables (remount-safe: start is idempotent via stop first).
  private healKick: (() => void) | null = null;
  private healFontKickTimer: ReturnType<typeof setTimeout> | null = null;
  // Bumped on every scheduleBackendResize so a heal that began before a resize can
  // detect the change after its await and abort.
  private resizeEpoch = 0;
  // Global suppression after a backend pipeline-healed jiggle (which resizes EVERY
  // terminal's PTY). Static so one event quiets all engines.
  static suppressHealUntil = 0;

  // Debounce for the live search refresh (see SEARCH_REFRESH_DEBOUNCE_MS).
  // Cleared on unmount so a refresh can't fire against a torn-down mount.
  private searchRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  // Last match count from the addon. Lets refreshSearch tell "user dismissed an
  // existing match" (count>0 but selection cleared → stop re-forcing it) apart
  // from "no match yet" (count===0 → keep live-searching so a match that scrolls
  // into view from new output still gets highlighted).
  private lastSearchResultCount = 0;

  // Mirror mode only: user zoom multiplier on top of fit-to-pane. 1 = fit (whole
  // terminal visible); >1 = zoomed in (pane scrolls to the rest). Ctrl +/-/0.
  private userZoom = 1;

  // Windows detection for the ConPTY 1004-noise exemption; sniffed when the
  // host doesn't pass isWindows, matching the isMac pattern.
  private isWindowsPlatform(): boolean {
    return (
      this.opts.isWindows ??
      (typeof navigator !== 'undefined' && !!navigator.platform?.includes('Win'))
    );
  }

  private isMacPlatform(): boolean {
    return (
      this.opts.isMac ??
      (typeof navigator !== 'undefined' && !!navigator.platform?.includes('Mac'))
    );
  }

  // Resolved font family: an explicit host override, else this platform's native
  // default stack (defaultFontFamily). isMac wins over isWindows so a mac never
  // gets the Windows stack. Used both to configure xterm and to prime the
  // font-ready fit below.
  private resolvedFontFamily(): string {
    return (
      this.opts.fontFamily ?? defaultFontFamily(this.isMacPlatform(), this.isWindowsPlatform())
    );
  }

  // Backlog 003: a detected link only opens on modifier+click (Ctrl on Win/Linux,
  // Cmd on macOS) so a plain click still selects text. macOS is sniffed when isMac
  // isn't passed, matching the zoom-modifier logic.
  private hasOpenModifier(event: MouseEvent): boolean {
    const isMac =
      this.opts.isMac ??
      (typeof navigator !== 'undefined' && !!navigator.platform?.includes('Mac'));
    return isMac ? event.metaKey : event.ctrlKey;
  }

  // Backlog 005 refinement: wall-clock timestamps of recent Ctrl+C keydowns, used
  // to detect a rapid burst (3 within 2s) that forces SIGINT over smart-copy.
  private ctrlCTimestamps: number[] = [];

  // Last non-empty selection captured WHILE an app held mouse tracking. Under mouse
  // tracking xterm wipes the live selection on any pty input — including the very
  // mouse move / right-click that precedes a copy — so the live selection is gone by
  // the time the context menu runs. We snapshot it during the drag (onSelectionChange)
  // and serve copy from it via pickCopyText(). Only consulted while mouse tracking is
  // active, so normal-shell copy behavior is byte-identical to before.
  private retainedSelection = '';
  // Triple-review finding (docs/review/051): keys whose keydown was already
  // claimed by an earlier UI shortcut in attachCustomKeyEventHandler (zoom, the
  // post-accept repeat guard, popup navigation). Their matching keyup must not
  // reach the Kitty/Win32 encoders below — unlike xterm's legacy default (a
  // no-op on keyup), those encoders DO forward keyup as a release record when
  // their protocol's event-reporting is active, so an unclaimed keyup would
  // leak an unmatched release to the app for a press it was never shown. Ctrl+C's
  // keyup is a deliberate, documented exception (see the smart-routing block
  // below), so it's intentionally not tracked here.
  private uiClaimedKeydownKeys = new Set<string>();

  // "Selection mode" (user-toggled): true while we've suspended the app's mouse capture
  // so a plain drag selects locally. savedMouseMode is the tracking mode to restore when
  // the user turns it back off. See setSelectionMode / MOUSE_DISABLE_SEQ.
  private selectionModeOn = false;
  private savedMouseMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any' = 'none';

  // LOCAL disposables — re-created on every mount(), torn down by unmount().
  // These hold the xterm event subscriptions (onData/onResize/onTitleChange),
  // the click-to-focus listener and the capture-phase zoom listener. They do
  // NOT include the cache-lifetime bridge subs (those are Task 4 / R1, disposed
  // only by dispose()/cleanupTerminalCache).
  private disposables: Array<() => void> = [];

  constructor(bridge: TerminalBridge, opts: TerminalEngineOptions = {}) {
    this.bridge = bridge;
    this.opts = opts;
    // Without a cacheKey there is no cross-mount reuse; key off a deterministic
    // sequence so the cache map still works (every mount creates a fresh entry).
    this.cacheKey = opts.cacheKey ?? `__anon_${++anonCacheKeySeq}`;
  }

  // ---------------------------------------------------------------------------
  // mount — create-or-reattach the xterm instance into `container`.
  // Ports TerminalDisplay.tsx:242-630 (minus the hydration effect / Task 4).
  // ---------------------------------------------------------------------------
  mount(container: HTMLElement): void {
    // A mount() without a prior unmount() (legit pattern: pane moved to a new
    // container) must not strand the old ResizeObserver — it would keep firing
    // fit() against the abandoned container forever.
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    this.container = container;
    this.disposables = [];

    let cached = terminalCache.get(this.cacheKey);
    let term: Terminal | undefined;
    let fit: FitAddon | undefined;
    let search: SearchAddon | undefined;
    // Set only when the reattach fit below actually ran. That fit is the one whose
    // onResize event is orphaned (no listener is wired yet), so it is the only one
    // whose size must be re-delivered to the backend at the end of mount().
    let didReattachFit = false;

    // Adopt enhanced-keyboard-protocol state from a prior mount on this same
    // cacheKey (review 046/047: TerminalEngine is a fresh JS object per React
    // mount, so without this a remount permanently loses Kitty/Win32-Input-Mode
    // state the underlying PTY session already negotiated — ConPTY sends
    // ?9001h exactly once per session, it never repeats). Must happen before
    // the CSI handlers below reassign kbState.getScreen, which is safe on an
    // adopted (pre-existing) instance — it just rebinds the closure.
    if (cached?.kbState) this.kbState = cached.kbState;
    if (cached?.win32State) this.win32State = cached.win32State;

    const fontSize = this.opts.fontSize ?? DEFAULT_FONT_SIZE;

    // --- Reattach path (TerminalDisplay.tsx:251-289) ---
    if (cached && cached.terminal.element) {
      term = cached.terminal;
      fit = cached.fitAddon;
      search = cached.searchAddon;

      // Keep font size in sync when reusing.
      if (fontSize) {
        term.options.fontSize = fontSize;
      }

      // Dispose the previous mount's local event handlers before re-wiring.
      cached.disposables.forEach((dispose) => dispose());

      try {
        const existingElement = term.element;
        if (existingElement) {
          // Move the existing render element into the new container, then re-fit.
          container.appendChild(existingElement);
          fit.fit();
          didReattachFit = true;
        } else {
          terminalCache.delete(this.cacheKey);
          cached = undefined;
          term = undefined;
          fit = undefined;
        }
      } catch (e) {
        console.warn('terminal-core/engine: Could not reattach terminal:', e);
        terminalCache.delete(this.cacheKey);
        cached = undefined;
        term = undefined;
        fit = undefined;
      }
    }

    // --- Create path (TerminalDisplay.tsx:291-419) ---
    if (!cached || !cached.terminal.element) {
      const isWindows =
        this.opts.isWindows ??
        (typeof navigator !== 'undefined' && !!navigator.platform?.includes('Win'));

      // xterm ConPTY compatibility (replaces the deprecated/removed `windowsMode`).
      // portable-pty's NativePtySystem is ConPTY on Windows, so the backend is always
      // 'conpty'; pairing it with the real build number lets xterm disable the legacy
      // wrapping heuristic on modern builds (>= 21376) — the fix for codex/ratatui — while
      // still keeping ConPTY scrollback-on-resize handling (which only needs backend set).
      const wb = this.opts.windowsBuildNumber;
      const windowsPty: { backend: 'conpty'; buildNumber: number } | undefined = isWindows
        ? { backend: 'conpty', buildNumber: wb && wb > 0 ? wb : FALLBACK_WINDOWS_BUILD }
        : undefined;

      term = new Terminal({
        fontFamily: this.resolvedFontFamily(),
        fontSize,
        lineHeight: this.opts.lineHeight ?? 1.1,
        theme: this.opts.theme ?? DEFAULT_THEME,
        // Cursor: block on macOS (matching Terminal.app/iTerm2's default box
        // cursor, per user request), slim bar elsewhere (the Windows-Terminal
        // look requested earlier). Note the DECSCUSR interplay: TUIs like codex
        // re-send ESC[0 q on every keystroke, which restarts xterm's blink phase —
        // the cursor stays solid while typing and resumes blinking when idle. That
        // matches Windows Terminal's own behavior, so it's accepted rather than
        // avoided. ESC[0 q falls back to these options, so codex inherits them too.
        cursorBlink: true,
        cursorStyle: this.isMacPlatform() ? 'block' : 'bar',
        // macOS Option-as-Meta (e.g. Option+P -> ESC p). Host opts in; no-op elsewhere.
        macOptionIsMeta: this.opts.macOptionIsMeta ?? false,
        scrollback: this.opts.scrollback ?? 10000,
        // LOAD-BEARING: required for unicode.activeVersion='11' (wide-char/emoji).
        allowProposedApi: true,
        // convertEol MUST be false for a real PTY (see source comment 327-332).
        convertEol: false,
        allowTransparency: false,
        letterSpacing: 0,
        fontWeight: 'normal',
        fontWeightBold: 'bold',
        drawBoldTextInBrightColors: true,
        // Shell/tool prompts routinely paint a background color (e.g. the stock
        // Debian/Ubuntu zsh prompt's `%K{blue}%n@%m%k`) against whatever the active
        // color schema's plain foreground happens to be, with no idea what schema is
        // in use. Several bundled schemas (Nord, Solarized, One Dark, Monokai, …)
        // pair a light-ish "blue" with a similarly light foreground, making that text
        // unreadable. Rather than hand-tuning every schema's palette (which trades
        // this bug for making "blue" nearly invisible as normal foreground text),
        // let xterm dynamically darken/lighten the foreground only when the actual
        // rendered pair falls below the target contrast ratio.
        //
        // MUST stay modest. xterm forces ANY cell whose contrast can't reach the
        // target up to pure white/black — killing its hue. On a not-quite-black
        // background the max achievable contrast is capped (e.g. Sunset #3B2C35
        // tops out at 13.1:1, Nord at 12.5:1), so a high value like 14 makes EVERY
        // colored cell unreachable and collapses the whole palette to white. 4.5
        // (WCAG AA) is reachable by every color on every bundled scheme, so it only
        // gently lifts the few low-contrast pairs and never desaturates the palette.
        //
        // This is NOT the dim-text lever. xterm halves this target for SGR-dim text
        // (`minimumContrastRatio / (isDim() ? 2 : 1)`), so pushing it up to brighten
        // dim output would wreck colors long before it helped. Dim-text legibility
        // instead comes from each scheme's brightened `foreground` (dim renders as a
        // fixed 50% blend of foreground toward background, landing ~4.2-4.8:1 on the
        // dark schemes on its own). See docs/guides/001-terminal-color-contrast.md.
        minimumContrastRatio: 4.5,
        ...(windowsPty ? { windowsPty } : {}),
      });

      // Addons in order: Fit -> WebLinks -> Unicode11, then activate v11.
      fit = new FitAddon();
      // Pass a handler so URLs open via the host (Tauri shell), NOT the default
      // window.open() which is a no-op in the Tauri WebView. Gate on the modifier
      // (Ctrl on Win/Linux, Cmd on macOS) so a plain click only selects text.
      const webLinks = new WebLinksAddon((event, uri) => {
        if (this.hasOpenModifier(event)) this.opts.openExternal?.(uri);
      });
      const unicode11 = new Unicode11Addon();
      const searchAddon = new SearchAddon();

      term.loadAddon(fit);
      term.loadAddon(webLinks);
      term.loadAddon(unicode11);
      term.loadAddon(searchAddon);
      term.unicode.activeVersion = '11';
      search = searchAddon;

      // Open into the DOM (required before WebGL addon).
      try {
        term.open(container);
      } catch (error) {
        console.error('terminal-core/engine: Error opening terminal:', error);
        return;
      }

      // CRITICAL: fit IMMEDIATELY after open to get the correct size BEFORE data.
      // NOTE: backend resize is DEFERRED to attach() — here we only size xterm
      // locally; the term.onResize handler (wired below) forwards to
      // bridge.resize once attachedProcessId is set.
      // Mirror mode skips this entirely — hydrate() will size the xterm to the
      // backend's reported dimensions, so a container-fit here would only flash
      // the wrong size and fire a spurious resize.
      if (!this.opts.mirror) {
        try {
          if (container.offsetWidth > 50) {
            fit.fit();
            const dims = fit.proposeDimensions();
            if (dims && dims.cols > 10) {
              // local-only: xterm already sized by fit.fit().
            } else {
              term.resize(80, 24);
            }
          } else {
            // Container too small or hidden — background init fallback.
            term.resize(80, 24);
          }
        } catch (error) {
          console.warn('terminal-core/engine: Error during initial fit:', error);
          term.resize(80, 24);
        }
      }

      // Load WebGL addon AFTER open (respects the global-disabled flag).
      const webglAddon = loadWebGLAddon(term, this.cacheKey);

      // Store a fresh cache entry. Preserve Task-4 fields' shape.
      terminalCache.set(this.cacheKey, {
        terminal: term,
        processId: cached?.processId,
        fitAddon: fit,
        searchAddon,
        webglAddon,
        useWebGL: webglAddon !== null,
        hydrating: false,
        pendingOutput: [],
        pendingOutputBytes: 0,
        disposables: [],
        hydrationGeneration: 0,
      });

      // Additional delayed settle-fit (R7 timing: 100ms after open). Skipped in
      // mirror mode (backend size is authoritative, not the container's).
      if (!this.opts.mirror) {
        const settleTimer = setTimeout(() => {
          try {
            fit?.fit();
          } catch (error) {
            console.warn('terminal-core/engine: Error fitting terminal:', error);
          }
        }, 100);
        this.disposables.push(() => clearTimeout(settleTimer));

        // Root-cause fix A: re-fit once the real font is loaded so the AUTHORITATIVE
        // size (and the PTY size derived from it) uses true cell metrics, not the
        // fallback font's wider cell. Guarded so it can't fit a torn-down mount.
        void this.ensureFontReady().then(() => {
          if (!this.container) return;
          try { fit?.fit(); } catch (e) {
            console.warn('terminal-core/engine: font-ready re-fit failed:', e);
          }
        });
      }
    }

    if (!term || !fit || !search) {
      console.error('terminal-core/engine: Failed to create or reuse terminal');
      return;
    }

    this.term = term;
    this.fitAddon = fit;
    this.searchAddon = search;

    // --- Event wiring (TerminalDisplay.tsx:425-510) ---
    // Capture into locals so the closures don't depend on `this.term` being
    // non-null at call time.
    const boundTerm = term;

    // Marks the scrollback an ended program produced (per-mount, like the
    // subscriptions below). Constructed before the OSC handlers that feed it, and
    // registered so a scheme change can repaint it without a React re-render.
    // Debounce resize handling: a window drag fires dozens of onResize events, each
    // rebuilding every region's per-row decorations — coalesce to the gesture's end.
    this.endedRegions = new EndedRegionTracker(boundTerm, { debounceMs: 100 });
    registerEndedRegionTracker(this.cacheKey, this.endedRegions);

    // Backlog 011: heuristic command capture (per-mount, like the subscriptions).
    // Restore a mark saved by a previous unmount — the cached Terminal's buffer
    // survives tab switches, so mid-typed input keeps its prompt-start position.
    this.capture = new HeuristicCapture(boundTerm, {
      onCommandSubmitted: (cmd) => this.opts.onCommandSubmitted?.(cmd),
    });
    const prevMark = terminalCache.get(this.cacheKey)?.captureMark;
    if (prevMark) this.capture.restoreMark(prevMark);
    // Restore the prompt gate too — a remount mid-CLI-session must not forget
    // that no prompt has rendered (or agent-CLI input would be captured again).
    // A brand-new cache entry (first mount of this cacheKey in THIS window, e.g.
    // after a cross-window detach/reattach) has no promptGate yet — opts.initialPromptGate
    // carries the source window's live gate through the detach handoff instead.
    const prevGate = terminalCache.get(this.cacheKey)?.promptGate ?? this.opts.initialPromptGate;
    if (prevGate) {
      // Route through setPromptGate (not a direct field assignment) so the cache
      // entry actually receives the restored gate too — attach()'s cache-entry
      // rebuild right after this reads the cache, not these instance fields, and
      // would otherwise re-persist a stale/null promptGate for the next hop.
      this.setPromptGate(prevGate.seen, prevGate.armed);
    }

    const dataDisposable = boundTerm.onData((data) => {
      // Stamp the most-recent user-input time so the alt-screen heal never reset()s
      // the buffer mid-keystroke (Task 6: RESYNC_SETTLE_MS input-quiet gate).
      const _e = terminalCache.get(this.cacheKey);
      if (_e) _e.lastInputAt = Date.now();
      // Diagnostics (source TerminalDisplay.tsx:427-429): user input + cursor state.
      this.opts.onDiag?.(() => {
        const buf = boundTerm.buffer.active;
        return `[TERM-DIAG] onData ${JSON.stringify(data)} | xterm=${boundTerm.cols}x${boundTerm.rows} cursor=(${buf.cursorX},${buf.cursorY})`;
      });
      // Backlog 011: command capture reads the pre-echo cursor, so route BEFORE
      // the write reaches the PTY.
      this.routeCaptureData(data);
      if (this.attachedProcessId) {
        // Fire-and-forget: swallow rejection (e.g. PTY already exited) so it
        // never surfaces as an uncaught promise rejection.
        Promise.resolve(this.bridge.write(this.attachedProcessId, data)).catch((e: unknown) => {
          this.opts.onDiag?.(() => `[TERM-DIAG] write after exit ignored: ${e}`);
        });
      }
    });

    const resizeDisposable = boundTerm.onResize(({ cols, rows }) => {
      // Diagnostics (source TerminalDisplay.tsx:435): xterm-reported resize.
      this.opts.onDiag?.(() => `[TERM-DIAG] xterm.onResize -> ${cols}x${rows}`);
      // A COLUMN widen leaves region markers stale (reflow-larger fires no
      // CircularList events) so the tracker re-anchors them from logical lines; a
      // ROW-only (vertical) resize must still repaint so the wash tracks the new
      // viewport height (without rows here it would drift above the live prompt).
      this.endedRegions?.onResize(cols, rows);
      // Backlog 011: reflow shifts absolute buffer rows, making the capture mark
      // untranslatable. Drop the capture (clean miss) and close the popup rather
      // than risk recording a fragment or anchoring the popup to a stale cell.
      if (this.capture?.hasMark()) {
        this.capture.cancel();
        this.suppressUntilSubmit = true;
        this.emitInputLine('');
      }
      // Debounce the backend resize: a window drag fires many of these, and each
      // backend resize repaints the PTY (duplicating lines on Windows ConPTY).
      this.scheduleBackendResize(cols, rows);
    });

    const titleDisposable = boundTerm.onTitleChange((title) => {
      this.opts.onTitleChange?.(title);
    });

    // Live search refresh (backlog 006): when the search bar is open (activeSearch
    // set), re-run the query in place after each parsed write so the N-of-M counter
    // and highlights track new output without moving the selected match. Cheap when
    // no search is active (refreshSearch early-returns). Per-mount, disposed on unmount.
    const writeParsedDisposable = boundTerm.onWriteParsed(() => {
      this.scheduleSearchRefresh();
      // Backlog 011: the shell's echo just landed — refresh the captured input line.
      this.refreshInputLine();
    });

    // Backlog 011: a viewport scrolled AWAY from the bottom detaches the popup
    // from its prompt row — dismiss it (the next echo re-opens it with a fresh
    // anchor). xterm's onScroll also fires on ordinary output-driven buffer
    // scroll, where the viewport stays pinned to the bottom (viewportY == baseY)
    // and the popup stays correctly anchored — do NOT dismiss for those.
    const scrollDisposable = boundTerm.onScroll(() => {
      if (this.suggestState === 'closed') return;
      const buf = boundTerm.buffer.active;
      if (buf.viewportY >= buf.baseY) return;
      this.emitInputLine('');
    });

    // Track the live match count so refreshSearch can distinguish "user dismissed
    // an existing match" from "no match yet" (see lastSearchResultCount).
    const searchResultsDisposable = search.onDidChangeResults((e) => {
      this.lastSearchResultCount = e.resultCount;
    });

    // Retain the selection while an app holds mouse tracking. There xterm clears the
    // live selection on the next pty input (mouse move, or the right-click that opens
    // the context menu), so we snapshot it here — during/at the end of the drag, while
    // it is still alive — and the context-menu copy reads it via pickCopyText(). In a
    // normal shell the live selection persists, so we skip retaining (keeps Copy from
    // staying stale-enabled after the user moves on).
    const selectionDisposable = boundTerm.onSelectionChange(() => {
      if (boundTerm.modes.mouseTrackingMode === 'none') return;
      const sel = boundTerm.getSelection();
      if (sel) this.retainedSelection = sel;
    });

    // --- Enhanced keyboard protocols (Kitty + modifyOtherKeys) ---
    // Track the active screen buffer (Kitty keeps independent main/alt stacks),
    // then register parser handlers for the enable/disable/query sequences. They
    // no-op when the kill-switch is off, so behavior stays byte-identical to legacy.
    this.kbState.getScreen = () =>
      boundTerm.buffer.active.type === 'alternate' ? 'alt' : 'main';
    const registerCsi = (
      id: { prefix?: string; final: string },
      fn: (params: (number | number[])[]) => boolean,
    ) => {
      if (!boundTerm.parser) return; // defensive: degrade if no parser (state tracking off)
      const d = boundTerm.parser.registerCsiHandler(id, (params) => {
        if (!this.enhancedKbEnabled()) return false; // legacy: ignore (xterm ignores too)
        return fn(params as (number | number[])[]);
      });
      this.disposables.push(() => d.dispose());
    };
    const csiParam = (params: (number | number[])[], i: number, dflt: number): number => {
      const v = params[i];
      const n = Array.isArray(v) ? v[0] : v;
      return typeof n === 'number' && n >= 0 ? n : dflt;
    };
    registerCsi({ prefix: '>', final: 'u' }, (p) => { this.kbState.pushFlags(csiParam(p, 0, 0)); return true; });
    registerCsi({ prefix: '<', final: 'u' }, (p) => { this.kbState.popFlags(csiParam(p, 0, 1)); return true; });
    registerCsi({ prefix: '=', final: 'u' }, (p) => { this.kbState.setFlags(csiParam(p, 0, 0), csiParam(p, 1, 1)); return true; });
    registerCsi({ prefix: '?', final: 'u' }, () => {
      if (this.attachedProcessId) {
        Promise.resolve(this.bridge.write(this.attachedProcessId, this.kbState.queryResponse()))
          .catch((e: unknown) => this.opts.onDiag?.(() => `[TERM-DIAG] kb query write ignored: ${e}`));
      }
      return true;
    });
    registerCsi({ prefix: '>', final: 'm' }, (p) => {
      if (csiParam(p, 0, -1) === 4) { this.kbState.setModifyOtherKeys(csiParam(p, 1, 0)); return true; }
      // Param-less `CSI > m` resets ALL XTMODKEYS resources incl. modifyOtherKeys
      // (a common TUI exit path) — without this the level would stay stuck after
      // the app is gone, suppressing command suggestions forever.
      if (p.length === 0) { this.kbState.setModifyOtherKeys(0); return false; }
      return false; // not modifyOtherKeys -> let xterm handle
    });
    // DECSTR soft reset (`CSI ! p`): full keyboard-protocol reset. Some TUIs exit
    // via soft reset instead of popping their Kitty flags.
    if (boundTerm.parser) {
      const decstr = boundTerm.parser.registerCsiHandler(
        { intermediates: '!', final: 'p' },
        () => {
          this.kbState.reset();
          if (this.isWindowsPlatform()) this.win32State.disable();
          return false; // observe only — xterm performs its own soft reset
        },
      );
      this.disposables.push(() => decstr.dispose());
      // Kitty spec: the alt screen's flag stack is empty on entry and does not
      // survive exit. Observe DECSET/DECRST 1049/1047/47 (alt-screen switches)
      // and clear the alt stack so a crashed TUI can't leak flags.
      const isAltScreenParam = (params: (number | number[])[]): boolean =>
        params.some((v) => {
          const n = Array.isArray(v) ? v[0] : v;
          return n === 1049 || n === 1047 || n === 47;
        });
      // Win32-Input-Mode (Windows-only): ConPTY sends CSI ?9001h unconditionally at
      // the start of every session (confirmed live on a plain pwsh tab) — folded
      // into the same ?h/?l handler as the alt-screen check above, gated on
      // isWindowsPlatform() so win32State can never flip on off-Windows even if a
      // stray ?9001h somehow appeared in a byte stream. See design 043 / plan 044.
      const isWin32InputModeParam = (params: (number | number[])[]): boolean =>
        params.some((v) => (Array.isArray(v) ? v[0] : v) === 9001);
      const altEnter = boundTerm.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
        if (isAltScreenParam(params as (number | number[])[])) this.kbState.clearAltStack();
        if (this.isWindowsPlatform() && isWin32InputModeParam(params as (number | number[])[])) {
          this.win32State.enable();
        }
        return false; // observe only — xterm handles the actual mode switch
      });
      const altExit = boundTerm.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
        if (isAltScreenParam(params as (number | number[])[])) this.kbState.clearAltStack();
        if (this.isWindowsPlatform() && isWin32InputModeParam(params as (number | number[])[])) {
          this.win32State.disable();
        }
        return false;
      });
      this.disposables.push(() => altEnter.dispose(), () => altExit.dispose());

      // Prompt-render heal (backlog 011): the shell emits OSC 9;9 (PowerShell —
      // injected by pty_manager for cwd tracking) or OSC 7 (unix shells) every
      // time it renders a prompt; a TUI never renders the shell prompt. If
      // Kitty/modifyOtherKeys state is still set when a prompt renders, the app
      // exited without cleaning up (claude/copilot exit paths vary) — reset so
      // enhanced-key encoding and command suggestions return to plain-prompt
      // behavior. Observe-only: cwd parsing stays in the Rust pipeline.
      const promptOscHeal = (): boolean => {
        // Every rendered prompt closes one command's span and opens the next —
        // the boundary the ended-region marks are anchored to. Recorded first,
        // so it is independent of whether the heal branches below fire.
        this.endedRegions?.onPrompt();
        if (this.kbState.activeFlags() !== 0 || this.kbState.snapshot().modifyOtherKeys !== 0) {
          this.kbState.reset();
        }
        // A killed CLI can leave focus-event reporting (DECSET 1004) stuck on,
        // which would suppress suggestions forever. A prompt render proves the
        // app is gone — flip the mode off inside xterm (local state only; the
        // DECRST is not forwarded to the pty).
        if (boundTerm.modes.sendFocusMode) boundTerm.write('\x1b[?1004l');
        // Prompt gate: a prompt rendered, so typed input belongs to the shell
        // again. Keys seen while disarmed may be type-ahead that echoes at THIS
        // prompt — skip one command rather than risk a mid-line mark fragment.
        const wasArmed = this.promptArmed;
        this.setPromptGate(true, true);
        if (!wasArmed) {
          if (this.sawInputWhileDisarmed) {
            this.sawInputWhileDisarmed = false;
            this.suppressUntilSubmit = true;
          }
        }
        return false;
      };
      const osc9 = boundTerm.parser.registerOscHandler(9, (data: string) => {
        // OSC 9 is overloaded (9;9=cwd, 9;4=progress, notifications): only the
        // cwd form is a prompt signal — progress can be emitted by a LIVE TUI.
        if (data.startsWith('9;')) return promptOscHeal();
        return false;
      });
      const osc7 = boundTerm.parser.registerOscHandler(7, () => promptOscHeal());
      this.disposables.push(() => osc9.dispose(), () => osc7.dispose());

      // Agent color-scheme guard: while a pane has an assigned agent color
      // (cache.agentColorLocked), swallow the program's own color-control OSCs so
      // our applied theme wins the race deterministically — an agent (e.g. Copilot)
      // that sets its palette/fg/bg shortly after launch would otherwise clobber it.
      // These custom handlers run before xterm's built-ins; returning true blocks
      // the default color change. Queries (`?`) pass through (shouldBlockColorOsc).
      for (const code of COLOR_OSC_CODES) {
        const colorGuard = boundTerm.parser.registerOscHandler(code, (data: string) =>
          shouldBlockColorOsc(terminalCache.get(this.cacheKey)?.agentColorLocked ?? false, data),
        );
        this.disposables.push(() => colorGuard.dispose());
      }
    }

    // --- Keyboard: attachCustomKeyEventHandler (R7 + source 445-504) ---
    boundTerm.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown') {
        const isModifier = ['Control', 'Shift', 'Alt', 'Meta'].includes(event.key);
        if (!isModifier) {
          this.retainedSelection = '';
        }
      }
      // Suppress the matching keyup for a keydown a UI shortcut already claimed
      // below (see uiClaimedKeydownKeys) — must run before the Kitty/Win32
      // encoder blocks, which unlike xterm's legacy default DO forward keyup.
      if (event.type === 'keyup' && this.uiClaimedKeydownKeys.has(event.key)) {
        this.uiClaimedKeydownKeys.delete(event.key);
        event.preventDefault();
        event.stopPropagation();
        return false;
      }
      // Zoom shortcuts — xterm can swallow these, so handle directly.
      if (event.ctrlKey && event.type === 'keydown') {
        if (event.key === '=' || event.key === '+' || event.code === 'NumpadAdd') {
          event.preventDefault();
          event.stopPropagation();
          this.uiClaimedKeydownKeys.add(event.key);
          this.handleZoom('in');
          return false;
        }
        if (
          event.key === '-' ||
          event.key === '_' ||
          event.code === 'Minus' ||
          event.code === 'NumpadSubtract'
        ) {
          event.preventDefault();
          event.stopPropagation();
          this.uiClaimedKeydownKeys.add(event.key);
          this.handleZoom('out');
          return false;
        }
        if (event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0') {
          event.preventDefault();
          event.stopPropagation();
          this.uiClaimedKeydownKeys.add(event.key);
          this.handleZoom('reset');
          return false;
        }
      }

      // Backlog 011: swallow the keydown auto-repeat tail of a suggestion accept.
      // The first (Shift+)Enter accepts and synchronously closes the popup; a
      // held key's repeat would then fall through to the LF shim / xterm's Enter
      // and RUN the just-inserted command the user only asked to insert.
      if (
        event.type === 'keydown' &&
        event.key === 'Enter' &&
        Date.now() - this.lastAcceptAt < ACCEPT_ENTER_GUARD_MS
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.uiClaimedKeydownKeys.add(event.key);
        return false;
      }

      // Command-suggest popup (backlog 011): while the popup is open, a small key
      // set drives it INSTEAD of the shell. Must run before the Shift+Enter LF
      // shim and the enhanced-key encoder so navigation never leaks to the PTY.
      // suggestionsAllowed() is defense-in-depth — the popup should already be
      // closed when a protocol/alt-screen activates.
      if (
        this.suggestState !== 'closed' &&
        event.type === 'keydown' &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        this.suggestionsAllowed()
      ) {
        const action = decideSuggestKey(this.suggestState, event.key, event.shiftKey);
        if (action) {
          event.preventDefault();
          event.stopPropagation();
          this.uiClaimedKeydownKeys.add(event.key);
          this.opts.onSuggestAction?.(action);
          return false;
        }
      }

      // Scroll keys: at a plain prompt on the normal buffer, plain PageUp/PageDown
      // scroll the viewport by a page and End jumps back to the live bottom when
      // scrolled up (at the bottom End still reaches the shell as end-of-line).
      // Gated off the alternate screen (vim/less own these keys) and off active
      // keyboard protocols (the app owns them — e.g. Claude Code's input editor
      // uses End). Must run BEFORE the Kitty/Win32 encoder blocks: on Windows the
      // Win32-Input-Mode encoder would otherwise consume the keydown and forward
      // it to the PTY, where PSReadLine's ScrollDisplay* actions cannot move an
      // xterm viewport — which is exactly why these keys did nothing before.
      if (
        event.type === 'keydown' &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        !event.metaKey &&
        (event.key === 'PageUp' || event.key === 'PageDown' || event.key === 'End') &&
        boundTerm.buffer.active.type === 'normal' &&
        !this.protocolActive()
      ) {
        const buf = boundTerm.buffer.active;
        const scrolledUp = buf.viewportY < buf.baseY;
        // The uiClaimedKeydownKeys check keeps a held End claimed across auto-
        // repeat: the first press scrolls to the bottom synchronously, so repeat
        // keydowns see scrolledUp=false and would otherwise fall through to the
        // Kitty/Win32 encoders — while the eventual keyup stays swallowed by the
        // claim, leaving the PTY with presses and no release (review 053 F1).
        if (event.key !== 'End' || scrolledUp || this.uiClaimedKeydownKeys.has(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          this.uiClaimedKeydownKeys.add(event.key);
          if (event.key === 'End') {
            boundTerm.scrollToBottom();
          } else {
            boundTerm.scrollPages(event.key === 'PageUp' ? -1 : 1);
          }
          return false;
        }
      }

      // Shift+Enter → soft newline. Emit LF (0x0A) instead of the CR (0x0D) xterm
      // would otherwise send: Claude Code inserts a newline on LF (a bare CR submits),
      // and Gemini CLI's universal newline is Ctrl+J — which IS LF — so one sequence
      // covers both. In a plain shell the tty still treats LF as accept-line, so the
      // line submits exactly like Enter (no regression).
      if (
        event.type === 'keydown' &&
        event.key === 'Enter' &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        // When a protocol is active, fall through so the encoder sends the real
        // (distinguishable) Shift+Enter the app expects, instead of the LF shim.
        !this.protocolActive() &&
        !this.win32InputModeActive()
      ) {
        event.preventDefault();
        event.stopPropagation();
        // Backlog 011: the LF shim bypasses onData, so feed the capture directly —
        // at a plain prompt Shift+Enter submits the line exactly like Enter.
        this.routeCaptureData('\n');
        if (this.attachedProcessId) {
          Promise.resolve(this.bridge.write(this.attachedProcessId, '\n')).catch((e: unknown) => {
            this.opts.onDiag?.(() => `[TERM-DIAG] write after exit ignored: ${e}`);
          });
        }
        return false;
      }

      // Copy with Ctrl+Shift+C.
      if (event.ctrlKey && event.shiftKey && event.key === 'C') {
        const selection = boundTerm.getSelection();
        if (selection) {
          this.writeClipboard(selection);
        }
        this.retainedSelection = '';
        return false;
      }

      // Paste with Ctrl+Shift+V.
      if (event.ctrlKey && event.shiftKey && event.key === 'V') {
        this.readClipboard()
          .then((text) => {
            if (!text) return;
            if (this.opts.onPaste) {
              this.opts.onPaste(text);
            } else {
              this.paste(text);
            }
          })
          .catch((err) => {
            console.error('terminal-core/engine: Failed to read clipboard:', err);
          });
        return false;
      }

      // Ctrl+C (no shift): smart routing (backlog 005). When enabled AND text is
      // selected, copy the selection (and clear it) instead of sending SIGINT;
      // otherwise fall through (return true) so xterm emits 0x03 as before.
      // Refinement: 3 presses within 2s = "interrupt" — force SIGINT even with a
      // selection, so mashing Ctrl+C always kills the process (Win/Linux escape hatch).
      if (event.ctrlKey && !event.shiftKey && event.key === 'c' && event.type === 'keydown') {
        // keyup/keypress of Ctrl+C fall through to the encoder below so a flag-2
        // release event is still emitted; the burst/copy logic stays keydown-only.
        const now = Date.now();
        this.ctrlCTimestamps.push(now);
        // Keep only presses within the burst window (bounds memory + defines the burst).
        this.ctrlCTimestamps = this.ctrlCTimestamps.filter((t) => now - t < CTRL_C_BURST_WINDOW_MS);
        const burst = isCtrlCBurst(this.ctrlCTimestamps, now);
        if (!burst && decideCtrlC(boundTerm.hasSelection(), this.opts.smartCopy?.() ?? false) === 'copy') {
          this.writeClipboard(boundTerm.getSelection());
          boundTerm.clearSelection();
          this.retainedSelection = '';
          this.opts.onCopy?.();
          return false;
        }
        // Send path. A 3-press burst is the guaranteed-interrupt escape hatch:
        // always raw \x03. Otherwise fall through to the shared enhanced-encoding
        // block below, which emits the protocol-encoded Ctrl+C when a protocol is
        // active (else the handler's default return sends legacy \x03).
        if (burst) return true;
      }

      // macOS: Cmd+Left/Cmd+Right = jump to start/end of line. macOS keyboards have
      // no physical Home/End key, so every native macOS terminal (Terminal.app,
      // iTerm2) treats Cmd+Arrow as that OS-wide text-editing convention; xterm.js
      // only reads e.key, so it never sees this and just moves the cursor one
      // column.
      //
      // At a plain shell prompt (normal buffer, no enhanced keyboard protocol),
      // sending the legacy Home/End VT sequence (\x1b[H / \x1b[F) does NOT work
      // out of the box: bash's readline binds it via terminfo, but zsh's ZLE does
      // NOT bind khome/kend by default (verified live — a vanilla zsh answers with
      // a bell, i.e. "unbound key"), so most macOS users would see this silently
      // fail. Ctrl+A / Ctrl+E (beginning-of-line / end-of-line) are readline/ZLE's
      // actual built-in emacs-keymap defaults, needing zero shell configuration —
      // this is also exactly what Terminal.app/iTerm2 send for Cmd+Left/Right.
      //
      // Full-screen TUIs (vim/less on the alternate screen, or any app that has
      // negotiated Kitty/modifyOtherKeys) DO understand the real Home/End
      // sequence — vim reads khome/kend from terminfo directly, and an enhanced-
      // protocol app (e.g. Claude Code's input editor, which already relies on a
      // literal End keypress — see the scroll-key block above) expects the actual
      // functional key, not Ctrl+A/E. So only the plain-prompt case gets the
      // Ctrl+A/E shim; everything else gets the real Home/End sequence.
      if (
        event.type === 'keydown' &&
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
        (this.opts.isMac ??
          (typeof navigator !== 'undefined' && !!navigator.platform?.includes('Mac')))
      ) {
        event.preventDefault();
        event.stopPropagation();
        const home = event.key === 'ArrowLeft';
        const plainPrompt = boundTerm.buffer.active.type === 'normal' && !this.protocolActive();
        const seq = plainPrompt
          ? home
            ? '\x01'
            : '\x05'
          : boundTerm.modes.applicationCursorKeysMode
            ? home
              ? '\x1bOH'
              : '\x1bOF'
            : home
              ? '\x1b[H'
              : '\x1b[F';
        // Bypasses onData like the Shift+Enter/Win32 shims above — route into
        // capture first (routeCaptureData treats ESC-prefixed sequences and
        // Ctrl+A/E as non-marking, matching how a literal Home/End keypress —
        // or Ctrl+A/E typed directly — is already handled).
        this.routeCaptureData(seq);
        if (this.attachedProcessId) {
          Promise.resolve(this.bridge.write(this.attachedProcessId, seq)).catch((e: unknown) => {
            this.opts.onDiag?.(() => `[TERM-DIAG] cmd-arrow home/end write ignored: ${e}`);
          });
        }
        return false;
      }

      // macOS: Option+Left/Option+Right = move by word, at a plain shell prompt.
      // A TUI with an enhanced keyboard protocol active already gets this via the
      // Kitty/modifyOtherKeys encoder below (CSI 1;3D / CSI 1;3C) and interprets
      // it itself — this branch is deliberately gated off while a protocol is
      // active so that path is untouched. At a PLAIN prompt (no protocol), the
      // key falls through to xterm's own legacy default, which emits that same
      // CSI 1;3 form — but bash/zsh's default readline bindings don't recognize
      // it without extra .inputrc config. `ESC b` / `ESC f` (Meta+b / Meta+f) is
      // readline's actual built-in default for backward-word/forward-word (the
      // same convention Terminal.app/iTerm2 use), so send that instead.
      if (
        event.type === 'keydown' &&
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
        !this.protocolActive() &&
        (this.opts.isMac ??
          (typeof navigator !== 'undefined' && !!navigator.platform?.includes('Mac')))
      ) {
        event.preventDefault();
        event.stopPropagation();
        const seq = event.key === 'ArrowLeft' ? '\x1bb' : '\x1bf';
        this.routeCaptureData(seq);
        if (this.attachedProcessId) {
          Promise.resolve(this.bridge.write(this.attachedProcessId, seq)).catch((e: unknown) => {
            this.opts.onDiag?.(() => `[TERM-DIAG] option-arrow word-nav write ignored: ${e}`);
          });
        }
        return false;
      }

      // Ctrl+Backspace / Ctrl+Delete word-delete, at a plain POSIX/readline shell
      // prompt (bash, zsh, Git Bash, WSL). A VT-byte shell can't distinguish
      // Ctrl+Backspace from a literal Ctrl+H (both are 0x08) — a documented ConPTY/
      // terminal limitation — so without this it just backspaces one character.
      // Win32-Input-Mode (PowerShell/cmd) and the Kitty protocol (TUIs) already
      // relay these chords with full modifier fidelity to shells that read them
      // natively, so decideWordDeleteShim only returns non-null for the shells
      // that can't use either path.
      if (event.type === 'keydown') {
        const shimSeq = decideWordDeleteShim(
          event.key,
          { ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey },
          boundTerm.buffer.active.type === 'normal',
          this.protocolActive(),
          this.opts.shellType?.(),
        );
        if (shimSeq !== null) {
          event.preventDefault();
          event.stopPropagation();
          // Win32-Input-Mode stays active for the whole Windows session regardless
          // of shellType (ConPTY announces it once, session-wide) — without this
          // claim, the matching keyup would fall through to that encoder below and
          // leak a stray Kd=0 release record to a shell that never asked for one.
          this.uiClaimedKeydownKeys.add(event.key);
          this.routeCaptureData(shimSeq);
          if (this.attachedProcessId) {
            Promise.resolve(this.bridge.write(this.attachedProcessId, shimSeq)).catch((e: unknown) => {
              this.opts.onDiag?.(() => `[TERM-DIAG] word-delete shim write ignored: ${e}`);
            });
          }
          return false;
        }
      }

      // Enhanced keyboard protocols: encode the key ourselves when an app has
      // enabled Kitty/modifyOtherKeys and suppress xterm's legacy emission.
      // encodeKey returns null for plain text / IME / unhandled keys -> xterm path.
      if (this.enhancedKbEnabled()) {
        const seq = encodeKey(event, this.kbState.snapshot());
        if (seq !== null) {
          event.preventDefault();
          event.stopPropagation();
          if (this.attachedProcessId) {
            Promise.resolve(this.bridge.write(this.attachedProcessId, seq)).catch((e: unknown) => {
              this.opts.onDiag?.(() => `[TERM-DIAG] kb write ignored: ${e}`);
            });
          }
          return false;
        }
      }

      // Win32-Input-Mode: ConPTY offers this for every Windows session (not just
      // TUIs), so once active it becomes the default encoding for this pane.
      // Internal workflow review (docs/review/052) caught a real regression here:
      // gating on win32InputModeActive() alone is not enough. Kitty's encodeKey
      // deliberately returns null (not "encode nothing", but "defer to legacy")
      // for bare/unmodified letters, digits, Enter/Tab/Backspace, and functional
      // keys even while Kitty is active — the block above only wins when it
      // returns a real sequence. Without the explicit !this.protocolActive()
      // check, this block would hijack every one of those "deferred to legacy"
      // keys into a Win32-Input-Mode record instead, breaking basic typing for
      // any Windows console app that pushes ANY Kitty flag. Verified live via a
      // reproduction test before this fix landed (handled=false, a bare 'a'
      // encoded as a Win32 record) and after (handled=true, true legacy
      // passthrough, matching the Shift+Enter shim's established pattern).
      if (this.win32InputModeActive() && !this.protocolActive()) {
        const seq = encodeWin32Key(event, true);
        if (seq !== null) {
          event.preventDefault();
          event.stopPropagation();
          // Review 046/047: this write bypasses onData, the only other path that
          // feeds command-suggest capture — route BEFORE the write reaches the
          // PTY, same ordering rule as the existing onData path and the
          // Shift+Enter LF-shim.
          const captureSentinel = this.win32CaptureSentinel(event);
          if (captureSentinel !== null) this.routeCaptureData(captureSentinel);
          if (this.attachedProcessId) {
            Promise.resolve(this.bridge.write(this.attachedProcessId, seq)).catch((e: unknown) => {
              this.opts.onDiag?.(() => `[TERM-DIAG] win32 kb write ignored: ${e}`);
            });
          }
          return false;
        }
      }

      return true;
    });

    // File-path links (backlog 003). Registered per-mount (like the onData/onResize
    // subs above) so the CURRENT engine owns the provider — its `this.opts.openPath`
    // reflects the live host callbacks/processId, and it's disposed on unmount and
    // re-registered on remount. (The cached Terminal would otherwise keep a provider
    // bound to a stale engine instance after a tab switch.)
    const pathLinkDisposable = boundTerm.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        // Wrapped-line aware: a long path that soft-wraps continues on further
        // buffer rows (isWrapped), so stitch the full logical line before
        // matching — a single row would only ever see the path's first fragment.
        const info = collectWrappedLine(boundTerm.buffer.active, bufferLineNumber - 1);
        if (!info) { callback(undefined); return; }
        const matches = findPathLinks(info.text);
        if (matches.length === 0) { callback(undefined); return; }
        callback(matches.map((mt) => ({
          // Map string offsets back to 1-based buffer coords; the range may span
          // several rows (end is inclusive of the last cell).
          range: wrappedBufferRange(info, mt.start, mt.end),
          text: mt.path,
          activate: (event) => {
            // Require the modifier (Ctrl on Win/Linux, Cmd on macOS); a plain click
            // only selects text. Custom link providers fire on plain click otherwise.
            // Pass the click coords so the host can anchor a multi-candidate picker.
            if (this.hasOpenModifier(event)) {
              this.opts.openPath?.(mt.path, mt.line, mt.col, event.clientX, event.clientY);
            }
          },
        })));
      },
    });

    this.disposables.push(
      () => dataDisposable.dispose(),
      () => resizeDisposable.dispose(),
      () => titleDisposable.dispose(),
      () => writeParsedDisposable.dispose(),
      () => scrollDisposable.dispose(),
      () => searchResultsDisposable.dispose(),
      () => selectionDisposable.dispose(),
      () => pathLinkDisposable.dispose(),
    );

    // --- Refresh the cache entry with current term/fit + new local disposables.
    // Preserve WebGL + Task-4 fields from any existing entry (source 520-533).
    const existingCache = terminalCache.get(this.cacheKey);
    // delete-then-set moves this key to the END of the Map's insertion order —
    // that order IS the LRU order enforceCacheCap() evicts from.
    terminalCache.delete(this.cacheKey);
    terminalCache.set(this.cacheKey, {
      terminal: term,
      processId: existingCache?.processId,
      fitAddon: fit,
      searchAddon: search,
      webglAddon: existingCache?.webglAddon ?? null,
      useWebGL: existingCache?.useWebGL ?? false,
      hydrating: existingCache?.hydrating ?? false,
      pendingOutput: existingCache?.pendingOutput ?? [],
      pendingOutputBytes: existingCache?.pendingOutputBytes ?? 0,
      lastHydratedProcessId: existingCache?.lastHydratedProcessId,
      // The last size actually dispatched to the backend MUST survive the entry
      // swap: it is the dedup key for the mount-end backend-size reconcile below
      // (and for hydrate's :1962 sync). Dropping it made every remount look like
      // "never sent", which would fire a redundant ConPTY resize on every tab
      // switch — exactly the repaint storm 035 warns about.
      lastSentSize: existingCache?.lastSentSize,
      disposables: this.disposables,
      dataDisposable: existingCache?.dataDisposable,
      exitDisposable: existingCache?.exitDisposable,
      hydrationGeneration: existingCache?.hydrationGeneration ?? 0,
      // Carry the coalesce buffer/timer across the entry swap so a remount mid-output
      // doesn't strand buffered live chunks (the timer re-gets the entry by key).
      liveWriteBuf: existingCache?.liveWriteBuf,
      liveWriteTimer: existingCache?.liveWriteTimer,
      liveWriteFirstAt: existingCache?.liveWriteFirstAt,
      // Backlog 011: mark survives the entry swap (live capture owns it now).
      captureMark: existingCache?.captureMark ?? null,
      promptGate: existingCache?.promptGate ?? null,
      // Enhanced keyboard protocol state — see the adoption comment at the top
      // of mount(). Writing `this.kbState`/`this.win32State` back here (rather
      // than existingCache's) is correct in both cases: if we adopted the cached
      // instance above, this is a no-op re-write of the same object; if this is
      // a genuinely fresh terminal, it seeds the cache with the fresh instance.
      kbState: this.kbState,
      win32State: this.win32State,
    });
    enforceCacheCap();

    // --- Click-to-focus (source 535-542) ---
    const clickHandler = () => {
      boundTerm.focus();
    };
    container.addEventListener('click', clickHandler);
    this.disposables.push(() => {
      container.removeEventListener('click', clickHandler);
    });

    // --- Capture-phase zoom listener (source 544-582) ---
    // Dual path: this fires in the CAPTURE phase and stopsPropagation, so the
    // custom key handler above does NOT also fire -> exactly +1 per keypress.
    // OS-aware modifier: Cmd on macOS, Ctrl elsewhere.
    const isMac =
      this.opts.isMac ??
      (typeof navigator !== 'undefined' && !!navigator.platform?.includes('Mac'));
    const zoomModifier = (event: KeyboardEvent | WheelEvent): boolean =>
      isMac ? event.metaKey : event.ctrlKey;

    const zoomHandler = (event: KeyboardEvent) => {
      if (!zoomModifier(event)) return;
      const key = event.key;
      const code = event.code;

      if (key === '=' || key === '+' || code === 'Equal' || code === 'NumpadAdd') {
        event.preventDefault();
        event.stopPropagation();
        this.handleZoom('in');
        return;
      }
      if (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract') {
        event.preventDefault();
        event.stopPropagation();
        this.handleZoom('out');
        return;
      }
      if (key === '0' || code === 'Digit0' || code === 'Numpad0') {
        event.preventDefault();
        event.stopPropagation();
        this.handleZoom('reset');
        return;
      }
    };
    container.addEventListener('keydown', zoomHandler, true);
    this.disposables.push(() => {
      container.removeEventListener('keydown', zoomHandler, true);
    });

    // Ctrl+F (Win/Linux) / Cmd+F (macOS) opens the host search overlay. Intercept in
    // the CAPTURE phase so we preventDefault the browser's native find-in-page dialog
    // before it opens, and only while THIS pane is focused (the listener is on the
    // pane container). Shift/Alt excluded so Ctrl+Shift+F etc. pass through.
    const searchKeyHandler = (event: KeyboardEvent) => {
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      if (!modifier || event.shiftKey || event.altKey) return;
      if (event.key === 'f' || event.key === 'F' || event.code === 'KeyF') {
        event.preventDefault();
        event.stopPropagation();
        this.opts.onOpenSearch?.();
      }
    };
    container.addEventListener('keydown', searchKeyHandler, true);
    this.disposables.push(() => {
      container.removeEventListener('keydown', searchKeyHandler, true);
    });

    // --- Modifier + mouse-wheel zoom (capture, non-passive so preventDefault
    // actually blocks the WebView's native page zoom + xterm scrollback). Routes
    // through the same handleZoom path as the keys. ---
    const wheelZoomHandler = (event: WheelEvent) => {
      if (!zoomModifier(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY < 0) this.handleZoom('in');
      else if (event.deltaY > 0) this.handleZoom('out');
    };
    container.addEventListener('wheel', wheelZoomHandler, { passive: false, capture: true });
    this.disposables.push(() => {
      container.removeEventListener('wheel', wheelZoomHandler, true);
    });

    // Focus the terminal (source 589). Gated by autoFocus (default true) so grid
    // panes that aren't selected don't steal focus from each other on mount.
    // Click-to-focus (above) is unaffected.
    if (this.opts.autoFocus !== false) {
      boundTerm.focus();
    }

    // rAF settle-fit after DOM updates (source 592-596). Skipped in mirror mode.
    if (!this.opts.mirror && typeof requestAnimationFrame === 'function') {
      const rafId = requestAnimationFrame(() => {
        try {
          if (this.container) fit?.fit();
        } catch (e) {
          console.warn('terminal-core/engine: rAF settle-fit failed:', e);
        }
      });
      this.disposables.push(() => cancelAnimationFrame(rafId));
    }

    // --- ResizeObserver: rAF-debounced fit (source 598-621) ---
    if (typeof ResizeObserver === 'function') {
      if (this.opts.mirror) {
        // Mirror: the GRID stays pinned to the backend; on pane resize we only
        // re-fit the FONT (zoom-to-fit) so the whole terminal stays visible. Works
        // per-pane, so grid view fits every cell independently.
        const ro = new ResizeObserver(() => {
          if (typeof requestAnimationFrame !== 'function') {
            this.applyMirrorFit();
            return;
          }
          requestAnimationFrame(() => this.applyMirrorFit());
        });
        ro.observe(container);
        this.resizeObserver = ro;
      } else {
        const resizeObserver = new ResizeObserver(() => {
          if (typeof requestAnimationFrame !== 'function') return;
          requestAnimationFrame(() => {
            const el = this.container;
            if (el && el.offsetWidth > 50 && el.offsetHeight > 50) {
              try {
                const dims = fit?.proposeDimensions();
                // Diagnostics (source TerminalDisplay.tsx:606-609): observer-driven fit.
                this.opts.onDiag?.(
                  () => `[TERM-DIAG] ResizeObserver | xterm=${this.term?.cols}x${this.term?.rows}`,
                );
                if (dims && dims.cols > 10 && dims.rows > 5) {
                  fit?.fit();
                }
              } catch (error) {
                console.warn('terminal-core/engine: Failed to fit terminal:', error);
              }
            }
          });
        });
        resizeObserver.observe(container);
        this.resizeObserver = resizeObserver;
      }
    }

    // Reconcile the BACKEND size with the size xterm already adopted on REATTACH.
    //
    // The reattach fit (:655) runs BEFORE the onResize listener above is wired
    // (:895) — the previous mount's was disposed at :648 — so its resize event is
    // ORPHANED and scheduleBackendResize() never runs. That is the pane-collapse
    // reflow bug: the survivor's xterm is correct but the PTY keeps the old width,
    // so the shell wraps output to stale dims. No later fit can recover it
    // (FitAddon.fit() no-ops once xterm already matches), and a same-pid attach()
    // can't either (hydrate() early-returns at :1885).
    //
    // Scoped to didReattachFit on purpose: the CREATE path's backend sizing is
    // deliberately owned by hydrate(), not by any fit here — see :768-771
    // ("backend resize is DEFERRED to attach()"). hydrate() cannot early-return on
    // the create path because the fresh cache entry stored above (:799) omits
    // lastHydratedProcessId, so its early-return check (:1885) never matches and
    // hydrate() always runs its own resize logic there. The create path therefore
    // has no orphaned event to reconcile; only reattach's fit runs before any
    // listener is wired.
    //
    // Deliver the size that fit ALREADY computed — no second fit — through the
    // existing 120ms debounce. Deduped against lastSentSize (carried across the
    // entry swap above), so an unchanged-size remount (a plain tab switch) sends
    // nothing. The !resizeInFlight && !pendingResize guard is copied verbatim from
    // hydrate()'s (:2005), where it prevents a genuine Task-4 fix D double-send
    // race because that `this` is the SAME engine instance that set those fields
    // earlier in its own lifecycle. Here, mount() runs on a freshly constructed
    // per-React-mount engine, so both fields (:487, :492) are still their initial
    // false — the guard is vacuous at this call site. Kept anyway: harmless, and
    // correct insurance if this logic is ever moved somewhere the fields could
    // already be set.
    //
    // Ordering-safe: mount() runs before attach(), but flushBackendResize() reads
    // attachedProcessId at call time (:2166) and the debounce fires after attach().
    if (didReattachFit && !this.opts.mirror && boundTerm.cols > 0 && boundTerm.rows > 0
        && !this.resizeInFlight && !this.pendingResize) {
      const sent = terminalCache.get(this.cacheKey)?.lastSentSize;
      if (!sent || sent.cols !== boundTerm.cols || sent.rows !== boundTerm.rows) {
        this.scheduleBackendResize(boundTerm.cols, boundTerm.rows);
      }
    }

    // Start the idle dimension heal watchdog (non-mirror only; idempotent).
    this.startHealWatchdog();
  }

  // ---------------------------------------------------------------------------
  // attach — spec §17 R1 (the keystone correctness task).
  //
  // Wires CACHE-LIFETIME output delivery (bridge.onData/onExit) and runs snapshot
  // hydration. The subscriptions are stored on the cache ENTRY (entry.dataDisposable
  // / entry.exitDisposable), NOT in the engine's local `disposables` array, so they
  // survive unmount() and are torn down ONLY by cleanupTerminalCache()/dispose().
  // This reproduces the legacy single module-level pty:data listener that delivered
  // output to every cached terminal regardless of React lifecycle — so inactive but
  // still-mounted background tabs keep receiving output.
  //
  // Ports TerminalDisplay.tsx:36-63 (live write/exit) + 646-740 (hydration).
  // ---------------------------------------------------------------------------
  attach(processId: string): void {
    // Backlog 011: a different backend process means a fresh prompt — a mark
    // from the previous shell must never leak into the new one's capture. After
    // a remount `attachedProcessId` is null, so fall back to the cache entry's
    // recorded pid (mount() restores the cached mark before attach() runs).
    const suggestCacheEntry = terminalCache.get(this.cacheKey);
    const prevProcessId = this.attachedProcessId ?? suggestCacheEntry?.processId;
    if (prevProcessId && prevProcessId !== processId) {
      this.capture?.cancel();
      if (suggestCacheEntry) {
        suggestCacheEntry.captureMark = null;
      }
      this.suggestState = 'closed';
      this.lastEmittedInput = '';
      this.suppressUntilSubmit = false; // new shell -> fresh prompt, capture may resume
      // New shell: its own prompt hook re-proves itself (fresh gate state).
      this.setPromptGate(false, false);
      this.sawInputWhileDisarmed = false;
      // Review 046/047: a new processId is a new PTY session with its own
      // independent protocol handshake — carrying over the old session's
      // Kitty/Win32-Input-Mode state would be wrong (stale flags, or a
      // Win32-Input-Mode flag the new session hasn't actually reasserted yet).
      // Safe now that mount() persists this state across remounts (Task 3):
      // without this reset, that persistence would leak state across processes.
      this.kbState.reset();
      if (this.isWindowsPlatform()) this.win32State.disable();
    }
    const entry = terminalCache.get(this.cacheKey);
    if (!entry) {
      // attach() before mount() — nothing to deliver into. Record the id so a
      // later mount path / input routing can still target the backend.
      this.attachedProcessId = processId;
      return;
    }

    // --- Idempotency (R1 #4) ----------------------------------------------------
    // If we're already fully wired to THIS processId (subscribed + hydrated), and
    // attach() is called again, it's a no-op: don't re-subscribe, don't re-hydrate.
    const alreadySubscribed = entry.dataDisposable != null;
    if (
      alreadySubscribed &&
      this.attachedProcessId === processId &&
      entry.lastHydratedProcessId === processId
    ) {
      return;
    }

    // In-flight no-op: a fresh hydration to THIS SAME processId is already running
    // (hydrating === true and we're already targeting it). Re-running would fire a
    // redundant pre-hydration resize + getSnapshot whose result is thrown away by
    // the generation-guard. The common trigger is the wrapper's [terminalId] and
    // [processId] effects both calling attach(processId) on first mount. Skip it.
    // Guarded by attachedProcessId === processId so a re-target (different pid)
    // still falls through to dispose+resubscribe+rehydrate, and the legitimate
    // first attach (attachedProcessId undefined) is never skipped.
    if (this.attachedProcessId === processId && entry.hydrating) {
      return;
    }

    // If the processId changed since the prior attach (detach / re-target), dispose
    // the previous cache-lifetime subscriptions before re-subscribing, and clear the
    // hydration marker so we re-hydrate against the new process.
    if (alreadySubscribed && entry.processId !== processId) {
      this.selectionModeOn = false;
      this.savedMouseMode = 'none';
      try {
        entry.dataDisposable?.dispose();
      } catch (e) {
        console.warn('terminal-core/engine: Error disposing prior data sub:', e);
      }
      try {
        entry.exitDisposable?.dispose();
      } catch (e) {
        console.warn('terminal-core/engine: Error disposing prior exit sub:', e);
      }
      entry.dataDisposable = undefined;
      entry.exitDisposable = undefined;
      entry.lastHydratedProcessId = undefined;
    }

    this.attachedProcessId = processId;
    entry.processId = processId;

    // --- Subscribe BEFORE hydrating (R1 #5) ------------------------------------
    // Set hydrating=true FIRST (synchronously) so any chunk that arrives the instant
    // we subscribe — or mid-hydration — buffers into pendingOutput instead of racing
    // the snapshot. Only subscribe if not already subscribed (idempotent re-attach to
    // the SAME processId after a re-hydrate path won't double-subscribe).
    const needsSubscribe = entry.dataDisposable == null;
    if (needsSubscribe) {
      entry.hydrating = true;

      // R1 #2/#3/#7: re-`get` the entry AT CALL TIME — the mount-reuse path replaces
      // the entry OBJECT, so a captured reference would write to a stale terminal.
      const dataDisposable = this.bridge.onData(processId, (data) => {
        const current = terminalCache.get(this.cacheKey);
        if (!current) return;
        // Stamp the arrival time so mirror-mode resync() can wait for output to
        // settle before reconciling (entry-level, so it's correct even though
        // this subscription out-lives the engine that created it — R1).
        current.lastDataAt = Date.now();
        // Diagnostics (source TerminalDisplay.tsx:41): raw incoming bytes, capped.
        this.opts.onDiag?.(
          () => `[TERM-OUT] (${data.length}b) ${JSON.stringify(data.slice(0, 1500))}`,
        );
        if (current.hydrating) {
          current.pendingOutput.push(data);
          current.pendingOutputBytes += data.length;
          // Tail-keep cap — O(1) per chunk via the running total.
          while (
            current.pendingOutputBytes > HYDRATION_BUFFER_CAP_BYTES &&
            current.pendingOutput.length > 1
          ) {
            current.pendingOutputBytes -= current.pendingOutput.shift()!.length;
          }
        } else {
          // Debounce-coalesce: buffer and (re)arm a short idle timer so a whole redraw
          // burst — including a trailing cursor-reposition frame — flushes as ONE write
          // (no intermediate cursor flash). Capped at LIVE_WRITE_MAX_MS from the first
          // buffered chunk so a continuous stream never stalls. See flushLiveWrites.
          current.liveWriteBuf = (current.liveWriteBuf ?? '') + data;
          const now = Date.now();
          if (current.liveWriteFirstAt == null) current.liveWriteFirstAt = now;
          if (current.liveWriteTimer != null) clearTimeout(current.liveWriteTimer);
          const delay = Math.max(
            0,
            Math.min(LIVE_WRITE_IDLE_MS, LIVE_WRITE_MAX_MS - (now - current.liveWriteFirstAt)),
          );
          current.liveWriteTimer = setTimeout(() => this.flushLiveWrites(), delay);
        }
      });

      // R1 #3: exit banner exactly once (each engine subscribes once).
      const exitDisposable = this.bridge.onExit(processId, (code) => {
        const current = terminalCache.get(this.cacheKey);
        if (!current) return;
        // Flush any buffered live output FIRST so the exit banner lands after it.
        this.flushLiveWrites();
        current.terminal.write(`\r\n[Process exited with code ${code}]\r\n`);
      });

      entry.dataDisposable = dataDisposable;
      entry.exitDisposable = exitDisposable;
    } else {
      // Re-attaching to the same processId where subscriptions survived but we still
      // need to (re)hydrate: ensure the buffer gate is up before hydration runs.
      entry.hydrating = true;
    }

    // --- Hydration (R1 #6) — port TerminalDisplay.tsx:646-740 -------------------
    void this.hydrate(processId);
  }

  // Snapshot hydration coroutine. Kept hydrating=true through its awaits so live
  // chunks buffer; drops/drains pendingOutput at the very end. Guards against a
  // re-attach mid-hydration via a per-call `cancelled` flag (mirrors source 660/684)
  // PLUS the `entry.hydrating` gate. Always re-`get`s the entry at the synchronous
  // commit points so the mount-reuse swap can't strand writes on a stale terminal.
  private async hydrate(processId: string): Promise<void> {
    const startEntry = terminalCache.get(this.cacheKey);
    if (!startEntry) return;

    // R1 #6 guard: already hydrated for this processId → skip (clear the gate we set).
    if (startEntry.lastHydratedProcessId === processId) {
      startEntry.hydrating = false;
      return;
    }

    // Bump the ENTRY's generation: any in-flight run (from this engine or a
    // previous instance on the same cacheKey) is now cancelled. Note: "cancelled"
    // means the stale run will skip its COMMIT — side effects it already fired
    // (e.g. its pre-hydration bridge.resize) are not rolled back.
    const myGeneration = startEntry.hydrationGeneration + 1;
    startEntry.hydrationGeneration = myGeneration;
    // Re-get at call time: the mount-refresh path swaps the entry OBJECT (carrying
    // hydrationGeneration forward), and the delete-and-recreate path resets it to 0
    // — either way a stale run's myGeneration no longer matches, which is exactly
    // the cancellation we want.
    const cancelled = () =>
      (terminalCache.get(this.cacheKey)?.hydrationGeneration ?? -1) !== myGeneration;

    const terminal = startEntry.terminal;
    const cols = terminal.cols;
    const rows = terminal.rows;

    try {
      // Pre-align the backend's authoritative screen to our viewport BEFORE
      // snapshotting (REQUIRED — source 668-676). Ignore errors like the source.
      // Mirror mode MUST NOT resize the shared PTY (another client owns it); it
      // adopts the backend's size from the snapshot response below instead.
      if (!this.opts.mirror && cols > 0 && rows > 0) {
        this.resizeInFlight = true;
        try {
          await this.bridge.resize(processId, cols, rows);
          const e = terminalCache.get(this.cacheKey);
          if (e) e.lastSentSize = { cols, rows };
        } catch (e) {
          console.warn(
            `terminal-core/engine: pre-hydration resize failed for ${this.cacheKey}:`,
            e,
          );
        } finally {
          this.resizeInFlight = false;
        }
        // Size-aware: drop the pending debounced resize ONLY if it's a redundant
        // duplicate of what we just sent; if a refit scheduled a DIFFERENT size
        // during the await, flush THAT instead of discarding it (root-cause fix B).
        this.reconcilePendingBackendResize(cols, rows);
      }

      let snapshot = '';
      let snapCols = 0;
      let snapRows = 0;
      if (typeof this.bridge.getSnapshot === 'function') {
        const result = await this.bridge.getSnapshot(processId, cols, rows);
        snapshot = result?.snapshot || '';
        snapCols = result?.cols ?? 0;
        snapRows = result?.rows ?? 0;
      }

      if (cancelled()) {
        return;
      }

      // SYNCHRONOUS commit (no awaits) so no live chunk interleaves. Re-`get` the
      // entry — the mount-reuse path may have swapped the entry object.
      const entry = terminalCache.get(this.cacheKey);
      if (!entry) return;
      const term = entry.terminal;

      if (snapshot) {
        // Mirror mode: size the xterm to the backend's reported dimensions so the
        // snapshot — and the live output that follows, which is laid out for that
        // same geometry — renders with the exact column/row alignment the backend
        // intended (no wrapping or cut-off from a size mismatch).
        if (
          this.opts.mirror &&
          snapCols > 0 &&
          snapRows > 0 &&
          (term.cols !== snapCols || term.rows !== snapRows)
        ) {
          term.resize(snapCols, snapRows);
        }
        // Authoritative cumulative screen — replace any pre-hydration paint and DROP
        // buffered chunks (already reflected in the snapshot); re-applying would dupe.
        // "Already reflected" is true for screen CONTENT only: one-shot protocol
        // handshakes are mode side-effects a snapshot never reproduces, and these
        // dropped bytes never transit the xterm parser, so the CSI handler can't
        // see them. ConPTY sends ?9001h (Win32-Input-Mode) exactly once, as the
        // FIRST chunk of every Windows session — it reliably lands in this dropped
        // window, and losing it sticks the whole session on legacy encoding (live
        // bug: every fresh Windows tab lost the handshake). Apply it before the drop.
        if (this.isWindowsPlatform()) {
          const verdict = scanWin32ModeSequences(entry.pendingOutput.join(''));
          if (verdict === 'enable') this.win32State.enable();
          else if (verdict === 'disable') this.win32State.disable();
        }
        term.reset();
        term.write(snapshot);
        entry.pendingOutput = [];
        entry.pendingOutputBytes = 0;
        // Record what we painted so mirror resync() can diff against it.
        entry.lastSnapshot = snapshot;
        // Zoom-to-fit the freshly-sized grid into the pane.
        this.applyMirrorFit();
      } else {
        // Empty snapshot (brand-new terminal w/ no captured output): do NOT reset —
        // that would blank live output — keep what's painted and FLUSH the buffer.
        const pendingText = entry.pendingOutput.join('');
        entry.pendingOutput = [];
        entry.pendingOutputBytes = 0;
        if (pendingText) {
          term.write(pendingText);
        }
      }
      entry.lastHydratedProcessId = processId;
      // A refit during the getSnapshot await may have changed our size after the
      // pre-hydration resize; if so, push the CURRENT size (deduped against
      // lastSentSize so an unchanged size never triggers a redundant ConPTY repaint).
      // Guard: skip when a resize is already in-flight or pending — the flush from
      // reconcilePendingBackendResize already covers this case and stamping
      // lastSentSize happens async in .then(), so a missing stamp here would otherwise
      // trigger a duplicate resize (the double-send race, Task 4 fix D).
      if (!this.opts.mirror && term.cols > 0 && term.rows > 0 && !this.resizeInFlight && !this.pendingResize) {
        const sent = entry.lastSentSize;
        if (!sent || sent.cols !== term.cols || sent.rows !== term.rows) {
          this.scheduleBackendResize(term.cols, term.rows);
        }
      }
    } catch (error) {
      // Snapshot failed → degrade to plain-text history replay (source 708-729).
      // hydrating is still true here, so live chunks keep buffering and are flushed
      // (appended) afterwards.
      console.warn(
        `terminal-core/engine: Snapshot hydration failed for ${this.cacheKey}, falling back to history replay:`,
        error,
      );
      let historyText = '';
      try {
        if (typeof this.bridge.getHistory === 'function') {
          const history = await this.bridge.getHistory(processId, 1000, 0);
          historyText = history.raw;
        }
      } catch (fallbackError) {
        console.warn(
          `terminal-core/engine: History fallback also failed for ${this.cacheKey}:`,
          fallbackError,
        );
      }

      if (cancelled()) {
        return;
      }

      const entry = terminalCache.get(this.cacheKey);
      if (!entry) return;
      const term = entry.terminal;

      if (historyText) {
        term.reset();
        term.write(historyText);
      }
      const pendingText = entry.pendingOutput.join('');
      entry.pendingOutput = [];
      entry.pendingOutputBytes = 0;
      // Mirror source 727-729: only append pending that isn't already a suffix of raw.
      if (pendingText && !historyText.endsWith(pendingText)) {
        term.write(pendingText);
      }
      entry.lastHydratedProcessId = processId;
    } finally {
      // Lower the gate only if this run is still the current one — a newer attach()
      // owns the gate now and will lower it itself.
      if (!cancelled()) {
        const entry = terminalCache.get(this.cacheKey);
        if (entry) {
          entry.hydrating = false;
        }
        // Anchor the first ended-program span HERE: hydration has just replayed
        // the backend's SNAPSHOT (a rendered screen — OSC sequences are consumed
        // by the backend's parser and are NOT in it), so the prompt already on
        // screen never reached our OSC handler. Without an anchor, a program
        // launched from that prompt is detected with no span to attach to and its
        // output is never marked. Everything below this line is new output, which
        // is the best boundary available when no prompt was observed.
        this.endedRegions?.openSpanHere();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------
  setActive(active: boolean): void {
    // Re-fit on activation with a 50ms settle (source 228-240 / R7).
    if (active && this.fitAddon) {
      if (this.fitTimer) clearTimeout(this.fitTimer);
      this.fitTimer = setTimeout(() => {
        this.fitTimer = null;
        try {
          this.fitAddon?.fit();
        } catch (error) {
          console.warn('terminal-core/engine: Failed to fit terminal on activation:', error);
        }
      }, 50);
    }
  }

  setTheme(theme: Record<string, string>): void {
    if (!this.term) return;
    this.term.options.theme = theme;
  }

  setFontSize(px: number): void {
    if (!this.term) return;
    this.term.options.fontSize = px;
    // Re-fit after font size change with a 50ms settle (source 217-225 / R7).
    if (this.fitAddon) {
      if (this.fitTimer) clearTimeout(this.fitTimer);
      this.fitTimer = setTimeout(() => {
        this.fitTimer = null;
        try {
          this.fitAddon?.fit();
        } catch (e) {
          console.warn('terminal-core/engine: fit after font change failed:', e);
        }
      }, 50);
    }
  }

  focus(): void {
    this.term?.focus();
  }

  fit(): void {
    this.fitAddon?.fit();
  }

  // Resolve once the real terminal font is loaded (so the authoritative fit measures
  // true cell width, not a wider fallback → wrong column count), or after a hard
  // timeout so a slow/missing font never blocks creation. Root-cause fix A.
  private ensureFontReady(): Promise<void> {
    if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
    const px = this.opts.fontSize ?? DEFAULT_FONT_SIZE;
    const fam = firstFontFamily(this.resolvedFontFamily());
    const ready = Promise.all([
      document.fonts.ready,
      Promise.resolve(document.fonts.load(`${px}px ${fam}`)).catch(() => undefined),
    ]).then(() => undefined);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, FONT_READY_TIMEOUT_MS));
    return Promise.race([ready, timeout]);
  }

  // Flush the coalesced live-output buffer to xterm in a single write (see
  // LIVE_WRITE_COALESCE_MS). Re-`get`s the entry by cacheKey so it's correct even
  // after a mount-reuse entry swap and even though the onData sub out-lives this engine.
  private flushLiveWrites(): void {
    const entry = terminalCache.get(this.cacheKey);
    if (!entry) return;
    if (entry.liveWriteTimer != null) {
      clearTimeout(entry.liveWriteTimer);
      entry.liveWriteTimer = undefined;
    }
    entry.liveWriteFirstAt = undefined;
    const buf = entry.liveWriteBuf;
    entry.liveWriteBuf = '';
    if (buf) entry.terminal.write(buf);
  }

  // Coalesce rapid xterm resizes into a single backend PTY resize at the final
  // size (see BACKEND_RESIZE_DEBOUNCE_MS).
  private scheduleBackendResize(cols: number, rows: number): void {
    this.resizeEpoch++;
    this.pendingResize = { cols, rows };
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.flushBackendResize(), BACKEND_RESIZE_DEBOUNCE_MS);
  }

  // Send the pending backend resize NOW. Called by the debounce timer, and also on
  // unmount so a drag interrupted by a tab switch / pane move doesn't leave the PTY
  // at a stale size (remount won't re-fit when xterm is already the right size, so
  // the PTY would wrap output at the old width). Reads attachedProcessId at call
  // time so a resize scheduled before attach lands on the right (current) process.
  private flushBackendResize(): void {
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    const pending = this.pendingResize;
    this.pendingResize = null;
    if (!pending || !this.attachedProcessId) return;
    this.resizeInFlight = true;
    const pid = this.attachedProcessId;
    Promise.resolve(this.bridge.resize(pid, pending.cols, pending.rows))
      .then(() => {
        const e = terminalCache.get(this.cacheKey);
        if (e) e.lastSentSize = { cols: pending.cols, rows: pending.rows };
      })
      .catch((e: unknown) => {
        this.opts.onDiag?.(() => `[TERM-DIAG] resize flush ignored: ${e}`);
      })
      .finally(() => { this.resizeInFlight = false; });
  }

  // Lightweight backend-size fetch for the dimension heal. Prefers bridge.getSize
  // (cheap stored-value read); falls back to getSnapshot meta when not present.
  private async getBackendSize(pid: string): Promise<{ cols: number; rows: number } | null> {
    try {
      if (typeof this.bridge.getSize === 'function') return await this.bridge.getSize(pid);
      if (typeof this.bridge.getSnapshot === 'function') {
        const s = await this.bridge.getSnapshot(pid, this.term?.cols ?? 0, this.term?.rows ?? 0);
        return { cols: s?.cols ?? 0, rows: s?.rows ?? 0 };
      }
    } catch { /* transient — next tick retries */ }
    return null;
  }

  // Idle, UI-authoritative dimension heal (+ optional alt-screen state reconcile).
  // Settle-gated; resizes ONLY on a real getSize≠xterm mismatch, via the existing
  // 120ms debounce. The boot desync is fixed by Tasks 3-4; this is the safety net.
  private async healOnce(): Promise<void> {
    const term = this.term;
    const pid = this.attachedProcessId;
    if (!term || !pid || this.opts.mirror) return;
    const entry = terminalCache.get(this.cacheKey);
    if (!entry || entry.terminal !== term) return;           // own the cache entry
    if (entry.hydrating || this.healing || this.pendingResize || this.resizeInFlight) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const c = this.container;
    if (!c || c.offsetParent === null || c.offsetWidth <= 50) return; // pane visible
    if (Date.now() < TerminalEngine.suppressHealUntil) return;        // post-jiggle
    if (entry.lastDataAt && Date.now() - entry.lastDataAt < HEAL_SETTLE_MS) return; // settled

    this.healing = true;
    const epochBefore = this.resizeEpoch;
    const uiCols = term.cols, uiRows = term.rows;
    try {
      const size = await this.getBackendSize(pid);
      if (!size || size.cols <= 0 || size.rows <= 0) return;
      // Re-validate after the await.
      if (this.attachedProcessId !== pid) return;
      const e2 = terminalCache.get(this.cacheKey);
      if (!e2 || e2.terminal !== term || e2.hydrating) return;
      if (this.pendingResize || this.resizeInFlight) return;
      if (this.resizeEpoch !== epochBefore) return;        // a resize happened during await
      if (term.cols !== uiCols || term.rows !== uiRows) return; // size changed during await
      if (size.cols !== uiCols || size.rows !== uiRows) {
        if (this.healMismatchCount >= HEAL_MAX_CONSECUTIVE_MISMATCH) return; // avoid hot loop
        this.healMismatchCount++;
        this.scheduleBackendResize(uiCols, uiRows);          // existing 120ms debounce
        return;                                              // screen heal waits for dims to agree
      }
      this.healMismatchCount = 0;
      await this.maybeHealScreenState(pid, entry);           // Task 6 (no-op until enabled)
    } catch { /* swallow */ }
    finally { this.healing = false; }
  }

  // Alt-screen state reconcile (Layer 3). Opt-in: healScreenState must be true.
  // Repaints the VISIBLE alt-screen from the backend snapshot when settled + input-quiet
  // + dims already agree + snapshot changed. Never touches the main/scrollback buffer.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async maybeHealScreenState(_pid: string, _entry: ReturnType<typeof terminalCache.get>): Promise<void> {
    if (!this.opts.healScreenState) return;
    await this.reconcileSnapshot('normal');
  }

  // Start the per-engine idle heal watchdog. Idempotent (calls stopHealWatchdog first,
  // which removes any previously registered listeners). Non-mirror only; started in
  // mount(), torn down in unmount(). Remount-safe: the listeners are owned by
  // healKick/healFontKickTimer, NOT this.disposables, so a mount()-without-unmount()
  // (pane moved to a new container) never orphans old listeners.
  // Only starts when bridge.getSize is available — the heal is a no-op without it,
  // and skipping the interval avoids runAllTimersAsync infinite loops in unit tests.
  private startHealWatchdog(): void {
    if (this.opts.mirror) return;
    if (typeof this.bridge.getSize !== 'function') return;
    this.stopHealWatchdog(); // idempotent: removes old listeners before re-registering
    this.healTimer = setInterval(() => { void this.healOnce(); }, HEAL_INTERVAL_MS);
    this.healKick = () => { void this.healOnce(); };
    window.addEventListener('focus', this.healKick);
    document.addEventListener('visibilitychange', this.healKick);
    // One-shot boot kick once the font is ready (the highest-value moment).
    // Capture the current kick so a double-mount that clears healKick (via
    // stopHealWatchdog) won't re-arm a timer for the superseded watchdog.
    const kick = this.healKick;
    void this.ensureFontReady().then(() => {
      if (this.healKick !== kick) return; // a remount superseded this watchdog
      this.healFontKickTimer = setTimeout(() => {
        this.healFontKickTimer = null;
        this.healKick?.();
      }, 150);
    });
  }

  // Stop the idle heal watchdog: clear interval, remove event listeners, cancel
  // the font-ready kick timer. All state is owned here (not in this.disposables)
  // so this is safe to call at any time, including before a remount.
  private stopHealWatchdog(): void {
    if (this.healTimer) { clearInterval(this.healTimer); this.healTimer = null; }
    if (this.healKick) {
      window.removeEventListener('focus', this.healKick);
      document.removeEventListener('visibilitychange', this.healKick);
      this.healKick = null;
    }
    if (this.healFontKickTimer !== null) {
      clearTimeout(this.healFontKickTimer);
      this.healFontKickTimer = null;
    }
  }

  // Drop a pending debounced resize without sending it. Used after hydration's
  // synchronous pre-hydration resize already synced the PTY to the current size:
  // letting the debounced one fire would be a redundant ConPTY repaint right after
  // the snapshot was applied, which can re-duplicate the just-restored screen.
  private cancelPendingBackendResize(): void {
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this.pendingResize = null;
  }

  // Hydrate's pre-resize already synced the PTY to (expectedCols,expectedRows).
  // Drop a pending debounced resize ONLY when it equals that size (redundant repaint);
  // if it differs — e.g. a font-load refit scheduled the corrected size during the
  // await — flush it so the correction is never lost.
  private reconcilePendingBackendResize(expectedCols: number, expectedRows: number): void {
    const pending = this.pendingResize;
    if (!pending) return;
    if (pending.cols === expectedCols && pending.rows === expectedRows) {
      this.cancelPendingBackendResize();
    } else {
      this.flushBackendResize();
    }
  }

  // Paste text into this terminal THROUGH xterm so it gets bracketed-paste markers
  // (when the foreground app enabled DECSET 2004) and CRLF/LF → CR normalization.
  // xterm emits the result via onData → bridge.write(attachedProcessId). Routing
  // raw clipboard text straight to the PTY (the previous behavior) skipped the
  // markers, so multi-line pastes were submitted line-by-line by CLIs.
  /** The renderer's detection saw a non-shell program in this terminal. Tolerant
   *  by design: the 2s poll is a good yes/no predicate over a span, even though
   *  it is far too coarse to place a boundary. */
  markProgramActive(): void {
    this.endedRegions?.markProgramActive();
  }

  /** Colours for the ended-program marks, pre-blended by the renderer against the
   *  pane's scheme background — xterm's decoration colours take no alpha. */
  setEndedRegionColors(wash: string | undefined, rail: string | undefined): void {
    this.endedRegions?.setColors(wash, rail);
  }

  paste(text: string): void {
    this.term?.paste(text);
  }

  // --- Backlog 011: command capture + suggest popup -------------------------

  /** Capture/popup allowed only at a plain shell prompt. */
  private suggestionsAllowed(): boolean {
    if (!this.term) return false;
    if (this.term.buffer.active.type === 'alternate') return false;
    if (this.protocolActive()) return false;
    // An app holding mouse tracking (copilot/opencode) owns the terminal even
    // without alt-screen or a keyboard protocol — a plain prompt never tracks the
    // mouse. This also self-clears on app exit (apps DECRST their mouse modes).
    if (this.term.modes.mouseTrackingMode !== 'none') return false;
    // Focus-event reporting (DECSET 1004) marks an interactive app on macOS/
    // Linux (claude enables it in unrecognized terminals where it enables
    // nothing else). On Windows it discriminates NOTHING: ConPTY asserts 1004
    // for EVERY session (a plain `cmd /c ping` gets ?1004h at ~74ms), so
    // honoring it there would kill suggestions at plain prompts. Windows agent
    // CLIs are covered by the prompt gate (routeCaptureData).
    if (!this.isWindowsPlatform() && this.term.modes.sendFocusMode) return false;
    return this.opts.commandSuggestions?.() ?? true;
  }

  // Set of DOM `key` values that must NOT plant a capture mark under
  // Win32-Input-Mode — mirrors routeCaptureData's existing ESC-sequence
  // exclusion for functional/nav keys in legacy mode (see its `beginsInput`
  // check below), since those keys never reach routeCaptureData as marking
  // input today.
  private static readonly WIN32_CAPTURE_NONMARKING = new Set([
    'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete',
    'Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
    'Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock',
  ]);

  /** The legacy sentinel byte(s) to feed routeCaptureData() for this key, under
   *  Win32-Input-Mode — never written to the PTY, only used so command-suggest
   *  keeps tracking input the same way it does in legacy mode (review 046/047:
   *  the Win32 write bypasses onData, the only other path that calls
   *  routeCaptureData). Returns null to skip the call entirely (matches legacy's
   *  "ESC sequence that isn't Up/Down/paste -> no mark" behavior). Shift+Enter
   *  deliberately does NOT return '\r' here: under Win32-Input-Mode it's a
   *  genuine newline-insert (PowerShell/PSReadLine), not submit, so capture must
   *  not treat it as line-end either. */
  private win32CaptureSentinel(e: KeyboardEvent): string | null {
    if (e.type !== 'keydown') return null;
    if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.shiftKey) return '\r';
    if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'c') return '\x03';
    if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'l') return '\x0c';
    if (e.key === 'ArrowUp' && !e.ctrlKey && !e.altKey && !e.shiftKey) return '\x1b[A';
    if (e.key === 'ArrowDown' && !e.ctrlKey && !e.altKey && !e.shiftKey) return '\x1b[B';
    if (TerminalEngine.WIN32_CAPTURE_NONMARKING.has(e.key)) return null;
    return [...e.key].length === 1 ? e.key : '\x08'; // Tab/Backspace/other -> any non-empty, non-special marker
  }

  /** Route typed input (pre-echo) into the capture heuristic. */
  private routeCaptureData(data: string): void {
    const capture = this.capture;
    if (!capture || data.length === 0) return;
    if (!this.suggestionsAllowed()) {
      capture.cancel();
      this.emitInputLine('');
      return;
    }
    if (data === '\r' || data === '\n') {
      // Prompt gate: Enter consumes the prompt (and flushes any pending line);
      // the next prompt render (OSC 9;9 / OSC 7) re-arms.
      this.setPromptGate(this.promptOscSeen, false);
      this.sawInputWhileDisarmed = false;
      if (this.suppressUntilSubmit) {
        // The mark was invalidated mid-line (Ctrl+L / resize / self-heal): this
        // command can't be read reliably — skip it, then resume cleanly.
        this.suppressUntilSubmit = false;
        capture.cancel();
      } else {
        capture.submit();
      }
      this.emitInputLine('');
      return;
    }
    if (data.includes('\r') || data.includes('\n')) {
      // Multi-line / immediate-execute paste: the echo hasn't landed yet, so the
      // line can't be read reliably — documented v1 limitation (OSC 133 upgrade
      // path). Cancel so no stale mark corrupts the next capture.
      this.setPromptGate(this.promptOscSeen, false);
      this.sawInputWhileDisarmed = false;
      capture.cancel();
      this.emitInputLine('');
      return;
    }
    if (data === '\x03') {
      // Ctrl+C abandons the line — a fresh empty prompt follows, so capture can
      // resume immediately. It also discards any disarmed type-ahead.
      capture.cancel();
      this.suppressUntilSubmit = false;
      this.sawInputWhileDisarmed = false;
      this.emitInputLine('');
      return;
    }
    if (data === '\x0c') {
      // Ctrl+L clears the screen but readline redraws the prompt WITH any
      // pending input — a re-mark would land mid-command, so skip this one.
      // (Bare ESC deliberately does NOT cancel: vi-mode command mode keeps the
      // line, and popup dismissal is handled by the key interception.)
      capture.cancel();
      this.suppressUntilSubmit = true;
      this.emitInputLine('');
      return;
    }
    if (data.startsWith('\x1b')) {
      // Multi-byte ESC sequences (F-keys, Ctrl+Arrow word-nav, Home/End) are
      // never typed text — planting a mark for them risks a stale mark at an
      // untouched prompt. Exceptions that DO begin input: bracketed paste and
      // Up/Down history recall (the shell echoes the recalled command).
      const beginsInput =
        data.startsWith('\x1b[200~') ||
        data === '\x1b[A' ||
        data === '\x1b[B' ||
        data === '\x1bOA' ||
        data === '\x1bOB';
      if (!beginsInput) return;
    }
    // Prompt gate: in a shell that emits prompt-render OSCs, input arriving
    // with NO prompt rendered since the last submit is being read by an app
    // (agent CLI, REPL) — never mark it, so it can't reach history or open the
    // popup. Hookless shells (cmd, remote ssh) never set promptOscSeen and keep
    // the ungated heuristic.
    if (this.promptOscSeen && !this.promptArmed) {
      this.sawInputWhileDisarmed = true;
      return;
    }
    // Any other input marks where prompt input begins: printable chars, Up/Down
    // recall, Tab (completion), backspace, bracketed-paste chunks. The pre-echo
    // cursor sits at the prompt end, so the mark is correct for all of them.
    // noteUserKey is a no-op when a mark already exists. While suppressed
    // (invalidated mark, input possibly still on the line) never re-mark — the
    // cursor sits mid-command and Enter would store a fragment.
    if (!this.suppressUntilSubmit) capture.noteUserKey();
  }

  /** After the shell echoes, read the current input line and notify the host. */
  private refreshInputLine(): void {
    const capture = this.capture;
    if (!capture?.hasMark()) return;
    if (!this.suggestionsAllowed()) {
      capture.cancel();
      this.emitInputLine('');
      return;
    }
    // untilCursor: live filtering matches what's left of the cursor, so mid-line
    // edits don't filter on stale text right of the cursor.
    const text = capture.getCurrentInput(true);
    if (text === null) {
      // Invalid mark (screen cleared / prompt redrawn / cursor above the mark):
      // self-heal, and skip capturing until the next submit — typed input may
      // still be pending on the redrawn line, so a re-mark would sit mid-command
      // and Enter would store a tail fragment.
      capture.cancel();
      this.suppressUntilSubmit = true;
      this.emitInputLine('');
      return;
    }
    this.emitInputLine(text);
  }

  private emitInputLine(text: string): void {
    if (text === this.lastEmittedInput) return;
    this.lastEmittedInput = text;
    this.opts.onInputLineChanged?.(text);
  }

  /** Host tells the engine the popup's current state (drives key interception). */
  setSuggestPopupState(state: SuggestPopupState): void {
    this.suggestState = state;
  }

  /** Insert a history command at the prompt: move the cursor to the end of the
   *  typed input (Right × suffix, covering mid-line cursors), erase the WHOLE
   *  input with DELs, then write the command. Shell-agnostic; does NOT run it. */
  insertCommand(command: string): void {
    if (!this.attachedProcessId || !this.term) return;
    const total = Array.from(this.capture?.getCurrentInput() ?? '').length;
    const before = this.capture?.charsBeforeCursor(this.term.cols) ?? 0;
    const suffix = Math.max(0, total - before);
    const payload = '\x1b[C'.repeat(suffix) + '\x7f'.repeat(total) + command;
    // Pre-set the dedupe to the inserted command: its echo must NOT re-emit
    // onInputLineChanged (which would instantly reopen the just-closed popup
    // with the other commands this one prefixes).
    this.lastEmittedInput = command;
    // Swallow the accept gesture's keydown auto-repeat tail (see key handler).
    this.lastAcceptAt = Date.now();
    Promise.resolve(this.bridge.write(this.attachedProcessId, payload)).catch((e: unknown) => {
      this.opts.onDiag?.(() => `[TERM-DIAG] insertCommand write ignored: ${e}`);
    });
  }

  /** Cursor position in px relative to the terminal container, for anchoring the
   *  popup. null when unmounted, when render dimensions are unavailable, or when
   *  the cursor row is scrolled out of view (host falls back to a corner anchor). */
  getCursorPixelPosition(): { left: number; top: number; cellHeight: number } | null {
    const term = this.term;
    if (!term || !this.container) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cell = (term as any)._core?._renderService?.dimensions?.css?.cell;
    const cw: unknown = cell?.width;
    const ch: unknown = cell?.height;
    if (typeof cw !== 'number' || typeof ch !== 'number' || cw <= 0 || ch <= 0) return null;
    const buf = term.buffer.active;
    // cursorY is relative to baseY (the bottom page), NOT the scrolled viewport.
    const visibleRow = buf.baseY + buf.cursorY - buf.viewportY;
    if (visibleRow < 0 || visibleRow > term.rows - 1) return null;
    return { left: buf.cursorX * cw, top: visibleRow * ch, cellHeight: ch };
  }

  // ---------------------------------------------------------------------------
  // resync — MIRROR MODE drift-correction (web monitor). No-op otherwise.
  //
  // A monitor hydrates a FLATTENED snapshot into the normal buffer, so live
  // deltas that depend on prior terminal STATE — alt-screen enter/exit (copilot,
  // vim), full clears, cursor-relative redraws — can drift the view away from the
  // backend (e.g. "exit copilot in the desktop app, monitor still shows its old
  // paint"). This reconciles against the backend's authoritative snapshot, but
  // ONLY when output has SETTLED (no live chunk for RESYNC_SETTLE_MS, so it never
  // repaints mid-stream) AND the snapshot actually CHANGED since the last paint
  // (diff-skip, so an idle screen never flickers). Host drives it on a timer.
  // ---------------------------------------------------------------------------
  async resync(): Promise<void> {
    return this.reconcileSnapshot('mirror');
  }

  // Shared snapshot drift-correction. mode='mirror' adopts the backend's size and
  // applies the mirror fit (web monitor). mode='normal' repaints the VISIBLE
  // alt-screen only, preserves the UI size, and never touches the main buffer.
  private async reconcileSnapshot(mode: 'mirror' | 'normal'): Promise<void> {
    if (mode === 'mirror' && !this.opts.mirror) return;
    if (!this.attachedProcessId) return;
    if (typeof this.bridge.getSnapshot !== 'function') return;
    const processId = this.attachedProcessId;
    const entry = terminalCache.get(this.cacheKey);
    // Skip while an initial hydration runs, while unmounted, or mid-stream.
    if (!entry || entry.hydrating || !this.container) return;
    if (entry.lastDataAt && Date.now() - entry.lastDataAt < RESYNC_SETTLE_MS) return;

    const term = entry.terminal;
    if (mode === 'normal') {
      // Alt-screen only (no scrollback to lose), and the user must be input-quiet
      // (we are about to reset() the buffer).
      if (term.buffer.active.type !== 'alternate') return;
      if (entry.lastInputAt && Date.now() - entry.lastInputAt < RESYNC_SETTLE_MS) return;
    }

    let result;
    try {
      result = await this.bridge.getSnapshot(processId, term.cols, term.rows);
    } catch {
      return; // transient — the next tick retries
    }

    // Re-validate after the await: still attached + mounted + not hydrating, and
    // no live chunk arrived during the fetch (else defer so we don't clobber it).
    const cur = terminalCache.get(this.cacheKey);
    if (!cur || cur.hydrating || !this.container || this.attachedProcessId !== processId) {
      return;
    }
    if (cur.lastDataAt && Date.now() - cur.lastDataAt < RESYNC_SETTLE_MS) return;
    if (mode === 'normal') {
      const t0 = cur.terminal;
      if (t0.buffer.active.type !== 'alternate') return;
      if (cur.lastInputAt && Date.now() - cur.lastInputAt < RESYNC_SETTLE_MS) return;
    }

    const snapshot = result?.snapshot || '';
    if (!snapshot || snapshot === cur.lastSnapshot) return; // unchanged → no repaint

    const t = cur.terminal;
    if (mode === 'mirror') {
      if (
        result.cols > 0 &&
        result.rows > 0 &&
        (t.cols !== result.cols || t.rows !== result.rows)
      ) {
        t.resize(result.cols, result.rows);
      }
    } else {
      // normal: only repaint when dimensions already agree (dimension heal first).
      if (result.cols > 0 && result.rows > 0 && (t.cols !== result.cols || t.rows !== result.rows)) return;
    }
    t.reset();
    t.write(snapshot);
    cur.lastSnapshot = snapshot;
    if (mode === 'mirror') this.applyMirrorFit();
  }

  // ---------------------------------------------------------------------------
  // MIRROR fit-to-pane + user zoom. The grid stays pinned to the backend; we only
  // scale the FONT so the whole grid fits the pane (userZoom = 1), or larger when
  // the user has zoomed in (userZoom > 1) — at which point the host's scrollable
  // pane reveals the overflow. Font-scaling (not CSS transform) keeps text crisp,
  // selection accurate, and the scroll area matching the visual size. Works the
  // same for every pane in grid view (each pane is its own engine). No-op off mirror.
  // ---------------------------------------------------------------------------
  applyMirrorFit(): void {
    if (!this.opts.mirror || !this.term || !this.fitAddon || !this.container) return;
    const term = this.term;
    const cols = term.cols;
    const rows = term.rows;
    if (cols <= 0 || rows <= 0) return;
    if (this.container.clientWidth <= 0 || this.container.clientHeight <= 0) return;

    let proposed;
    try {
      proposed = this.fitAddon.proposeDimensions();
    } catch {
      return;
    }
    if (!proposed || !proposed.cols || !proposed.rows) return;

    // `proposed` = cols/rows that fit the pane AT THE CURRENT FONT, so the font that
    // makes the backend grid exactly fill the pane is current * min(fitCol, fitRow).
    // Derived from the live measurement each call, so it both shrinks and grows back.
    const current = (term.options.fontSize as number) || DEFAULT_FONT_SIZE;
    const base = this.opts.fontSize ?? DEFAULT_FONT_SIZE;
    const fitFactor = Math.min(proposed.cols / cols, proposed.rows / rows);
    // Cap the fit at the base font — never enlarge a small terminal past normal size.
    const fitFont = Math.min(base, current * fitFactor);
    const target = Math.max(
      FONT_SIZE_MIN,
      Math.min(FONT_SIZE_MAX, Math.round(fitFont * this.userZoom)),
    );
    if (target !== current) {
      // Only the font changes — cols/rows stay pinned to the backend grid.
      term.options.fontSize = target;
    }
  }

  // Ctrl/Cmd +/-/0 (and modifier+wheel) routing.
  //  1. If the host provides onZoom, it owns the zoom level (the desktop app's
  //     per-surface zoom) — we just report the direction and let it feed back a
  //     new effective font size. The font-size *number* setting is untouched.
  //  2. Else in mirror mode this adjusts the fit zoom (pane scrolls past fit).
  //  3. Else it falls back to the legacy onFontSizeChange (font-size) behavior.
  private handleZoom(direction: 'in' | 'out' | 'reset'): void {
    if (this.opts.onZoom) {
      this.opts.onZoom(direction);
      return;
    }
    if (this.opts.mirror) {
      if (direction === 'reset') {
        this.userZoom = 1;
      } else {
        const step = direction === 'in' ? 1.15 : 1 / 1.15;
        this.userZoom = Math.max(0.5, Math.min(4, this.userZoom * step));
      }
      this.applyMirrorFit();
      return;
    }
    const current = (this.term?.options.fontSize as number) || DEFAULT_FONT_SIZE;
    if (direction === 'reset') {
      this.opts.onFontSizeChange?.(DEFAULT_FONT_SIZE);
    } else {
      this.opts.onFontSizeChange?.(clampFontSize(current + (direction === 'in' ? 1 : -1)));
    }
  }

  clear(): void {
    this.term?.clear();
  }

  // True when the viewport is pinned to the live tail — same check the End-key
  // handler and refreshSearch use internally. true (not false) before mount, so
  // a host UI's "scroll to bottom" button defaults to hidden rather than shown.
  isScrolledToBottom(): boolean {
    if (!this.term) return true;
    const buf = this.term.buffer.active;
    return buf.viewportY >= buf.baseY;
  }

  // Jumps the viewport back to the live tail. Deliberately does not also focus
  // the terminal — callers (a mouse-clicked button) compose that explicitly,
  // e.g. `engine.scrollToBottom(); engine.focus();`.
  scrollToBottom(): void {
    this.term?.scrollToBottom();
  }

  getSelection(): string {
    return this.term?.getSelection() ?? '';
  }

  // True while an app holds mouse tracking on (Claude/Copilot etc.). There xterm
  // forwards mouse drags to the app instead of selecting AND wipes any selection on
  // the next pty input, which is why copy needs the retained-selection fallback.
  private mouseTrackingActive(): boolean {
    return !!this.term && this.term.modes.mouseTrackingMode !== 'none';
  }

  // The text a copy gesture should act on: the live selection, or — under mouse
  // tracking — the selection retained during the drag (see retainedSelection).
  private effectiveSelection(): string {
    return pickCopyText(this.getSelection(), this.retainedSelection, this.mouseTrackingActive());
  }

  // Whether the context menu's Copy item should be enabled. Unlike getSelection(),
  // this stays true under mouse tracking after xterm has cleared the live selection,
  // so right-click → Copy works on the text the user selected with Shift+drag.
  hasCopyableSelection(): boolean {
    return this.effectiveSelection().length > 0;
  }

  // True while an app holds mouse tracking — the menu uses this to offer selection mode.
  isMouseTrackingActive(): boolean {
    return this.mouseTrackingActive();
  }

  // Lazy reconcile: if an app re-enabled mouse tracking while we believed we were
  // pausing it, our pause was overridden — drop the stale latch so the menu reflects
  // reality and a later toggle re-pauses cleanly. Called on read and before toggling.
  private reconcileSelectionMode(): void {
    if (this.selectionModeOn && this.term && this.term.modes.mouseTrackingMode !== 'none') {
      this.selectionModeOn = false;
      this.savedMouseMode = 'none';
    }
  }

  isSelectionMode(): boolean {
    this.reconcileSelectionMode();
    return this.selectionModeOn;
  }

  /**
   * Toggle "selection mode": suspend the app's mouse capture so a plain drag selects
   * text locally (otherwise mouse-tracking CLIs like Claude/Copilot grab the drag and
   * Shift+drag doesn't force a local selection in the WebView). Restores the app's
   * tracking when turned off. The restore re-asserts the saved mode, which clears the
   * live selection (xterm clears on the protocol change) — by design the user copies
   * BEFORE turning it off. See MOUSE_DISABLE_SEQ / mouseModeEnableSeq.
   */
  setSelectionMode(on: boolean): void {
    if (!this.term) return;
    this.reconcileSelectionMode();
    if (on === this.selectionModeOn) return;
    if (on) {
      this.savedMouseMode = this.term.modes.mouseTrackingMode;
      if (this.savedMouseMode !== 'none') this.term.write(MOUSE_DISABLE_SEQ);
    } else if (this.savedMouseMode !== 'none') {
      this.term.write(mouseModeEnableSeq(this.savedMouseMode));
    }
    this.selectionModeOn = on;
  }

  // ---------------------------------------------------------------------------
  // unmount — remove from DOM + run LOCAL disposables only.
  // DO NOT dispose the terminal (preserved via cacheKey for history).
  // DO NOT dispose the cache-lifetime data/exit subs (those are Task 4 / R1).
  // ---------------------------------------------------------------------------
  unmount(): void {
    if (this.selectionModeOn) {
      this.setSelectionMode(false);
    }
    this.retainedSelection = '';
    // Backlog 011: capture is per-mount (bound to the mounted Terminal), but the
    // mark outlives it in the cache entry — mid-typed input survives a tab switch.
    // (promptGate is kept in sync continuously by setPromptGate, not just here.)
    const suggestEntry = terminalCache.get(this.cacheKey);
    if (suggestEntry) {
      suggestEntry.captureMark = this.capture?.getMark() ?? null;
    }
    this.capture = null;
    this.suggestState = 'closed';
    this.lastEmittedInput = '';
    this.suppressUntilSubmit = false;

    if (this.fitTimer) {
      clearTimeout(this.fitTimer);
      this.fitTimer = null;
    }
    // Flush (don't drop) any pending backend resize so the PTY isn't left at a
    // stale size when a drag is interrupted by this unmount (tab switch / pane move).
    this.flushBackendResize();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.stopHealWatchdog();
    this.disposables.forEach((dispose) => dispose());
    this.disposables = [];
    this.container = null;
    // Clear the active query AND its decorations. The SearchAddon lives on the
    // cached terminal, so highlights drawn before this unmount would otherwise stay
    // stranded on screen after a remount (tab switch back) — the bar reopens closed,
    // so nothing would clear them. clearSearch() nulls activeSearch + clearDecorations.
    this.clearSearch();
    // Same reasoning as the search highlights above: the decorations live on the
    // CACHED terminal, so they would stay stranded after a remount. Disposed HERE
    // (in unmount), never inside clearSearch — a Ctrl+F clear must not wipe them.
    this.endedRegions?.dispose();
    this.endedRegions = undefined;
    unregisterEndedRegionTracker(this.cacheKey);
    // Intentionally keep this.term / this.fitAddon references — the cache still
    // owns the live instance, and a later mount() reattaches it.
  }

  // ---------------------------------------------------------------------------
  // dispose — full teardown incl. cache removal (disposes EVERYTHING, including
  // Task 4's cache-lifetime subscriptions, via cleanupTerminalCache).
  // ---------------------------------------------------------------------------
  dispose(): void {
    this.unmount();
    cleanupTerminalCache(this.cacheKey);
    this.term = null;
    this.fitAddon = null;
    this.attachedProcessId = null;
  }

  // ---------------------------------------------------------------------------
  // context menu actions (R8: diagnostics toggle stays in the main-app wrapper)
  // ---------------------------------------------------------------------------
  getContextMenuActions(): ContextMenuActions {
    return {
      copy: () => {
        const selection = this.effectiveSelection();
        if (selection) this.writeClipboard(selection);
        this.retainedSelection = '';
      },
      paste: () => {
        void this.readClipboard()
          .then((text) => {
            if (!text) return;
            if (this.opts.onPaste) {
              this.opts.onPaste(text);
            } else {
              this.paste(text);
            }
          })
          .catch((err) => {
            console.error('terminal-core/engine: Failed to paste:', err);
          });
      },
      clear: () => {
        this.term?.clear();
      },
      selectAll: () => {
        this.term?.selectAll();
      },
      resetRendering: () => {
        resetTerminalRendering(this.cacheKey);
      },
      toggleWebGL: () => {
        if (isWebGLGloballyDisabled()) {
          enableWebGLGlobally();
        } else {
          disableWebGLGlobally();
        }
      },
    };
  }

  // Passthrough to webgl.ts (spec §17 R8) — lets the wrapper render the right
  // "Enable/Disable WebGL" menu label.
  isWebGLGloballyDisabled(): boolean {
    return isWebGLGloballyDisabled();
  }

  // Escape hatch — the wrapper occasionally needs the raw Terminal.
  get terminal(): Terminal {
    if (!this.term) {
      throw new Error('terminal-core/engine: terminal accessed before mount()');
    }
    return this.term;
  }

  // ---------------------------------------------------------------------------
  // Search (backlog 006). Thin wrappers over @xterm/addon-search so the host
  // never imports the addon. All calls pass SEARCH_DECORATIONS, which both draws
  // the highlights AND enables the onDidChangeResults event used for "N of M".
  // ---------------------------------------------------------------------------
  private toSearchOptions(
    opts: TerminalSearchOptions,
    incremental: boolean,
  ): ISearchOptions {
    return {
      caseSensitive: opts.caseSensitive ?? false,
      wholeWord: opts.wholeWord ?? false,
      regex: opts.regex ?? false,
      incremental,
      decorations: SEARCH_DECORATIONS,
    };
  }

  // Search forward. `incremental` true = as-you-type (extend current match, don't
  // advance); false = "Next" (advance to the following match). Empty query clears.
  searchNext(query: string, opts: TerminalSearchOptions, incremental = false): boolean {
    if (!this.searchAddon) return false;
    if (!query) {
      this.clearSearch();
      return false;
    }
    this.activeSearch = { query, opts };
    return this.searchAddon.findNext(query, this.toSearchOptions(opts, incremental));
  }

  // Search backward ("Previous"). Empty query clears. (addon: incremental is
  // ignored by findPrevious, so it is always false here.)
  searchPrevious(query: string, opts: TerminalSearchOptions): boolean {
    if (!this.searchAddon) return false;
    if (!query) {
      this.clearSearch();
      return false;
    }
    this.activeSearch = { query, opts };
    return this.searchAddon.findPrevious(query, this.toSearchOptions(opts, false));
  }

  // Clear all highlights + selection and forget the active query. Also cancels any
  // pending debounced refresh so it can't fire after the search (or mount) is gone.
  clearSearch(): void {
    if (this.searchRefreshTimer) {
      clearTimeout(this.searchRefreshTimer);
      this.searchRefreshTimer = null;
    }
    this.activeSearch = null;
    this.lastSearchResultCount = 0;
    this.searchAddon?.clearDecorations();
  }

  // Coalesce the live refresh: onWriteParsed fires per parsed chunk, so during
  // heavy streaming we debounce to a single trailing refreshSearch instead of
  // re-searching the whole scrollback on every write. Cheap no-op when no search
  // is active, so we don't arm a timer for the common (no-search) case.
  private scheduleSearchRefresh(): void {
    if (!this.activeSearch) return;
    if (this.searchRefreshTimer) clearTimeout(this.searchRefreshTimer);
    this.searchRefreshTimer = setTimeout(() => {
      this.searchRefreshTimer = null;
      this.refreshSearch();
    }, SEARCH_REFRESH_DEBOUNCE_MS);
  }

  // Re-run the active query in place (incremental) — driven by onWriteParsed so
  // live output keeps the counter/highlights fresh without moving the selection.
  // No-op when no search is active.
  //
  // findNext re-selects the active match and scrolls it into view as a side
  // effect. On live output (agent still printing) that yanks the viewport back
  // up to the first match every write. So we snapshot the viewport before the
  // re-search and restore it after: stay pinned to the bottom if we were
  // following output, otherwise hold the exact scroll position. Only an explicit
  // Next/Prev (searchNext/searchPrevious) should move the viewport.
  refreshSearch(): void {
    if (!this.activeSearch || !this.searchAddon || !this.term) return;
    // If the user dismissed an EXISTING match (had results, then cleared the
    // selection by clicking in the terminal), don't re-force it on live output —
    // respect that they moved on. But when there's no match yet (count === 0),
    // keep refreshing so a match that scrolls into view from new output still
    // gets highlighted. A fresh type / Next / Prev re-arms via searchNext.
    if (this.lastSearchResultCount > 0 && !this.term.hasSelection()) return;
    const buffer = this.term.buffer.active;
    const prevViewportY = buffer.viewportY;
    const wasAtBottom = prevViewportY >= buffer.baseY;
    const { query, opts } = this.activeSearch;
    this.searchAddon.findNext(query, this.toSearchOptions(opts, true));
    if (wasAtBottom) this.term.scrollToBottom();
    else this.term.scrollToLine(prevViewportY);
  }

  // Subscribe to result-count changes (the "N of M" feed). Forwards the addon's
  // onDidChangeResults. Returns a disposable; safe to call after mount().
  onSearchResults(cb: (r: TerminalSearchResult) => void): { dispose(): void } {
    if (!this.searchAddon) return { dispose() {} };
    return this.searchAddon.onDidChangeResults((e) =>
      cb({ resultIndex: e.resultIndex, resultCount: e.resultCount }),
    );
  }

  // Subscribe to at-bottom/scrolled-away-from-bottom transitions, for a host UI's
  // "scroll to bottom" button. Forwards xterm's own onScroll directly (same
  // delegation pattern as onSearchResults above) rather than maintaining a
  // separate callback registry. Safe to call after mount(); a no-op disposable
  // before mount (no term to subscribe to).
  onScrollPosition(cb: (atBottom: boolean) => void): { dispose(): void } {
    if (!this.term) return { dispose() {} };
    return this.term.onScroll(() => {
      const buf = this.term!.buffer.active;
      cb(buf.viewportY >= buf.baseY);
    });
  }

  // ---------------------------------------------------------------------------
  // clipboard helpers — defensive so non-browser hosts (and jsdom) don't throw.
  // ---------------------------------------------------------------------------
  private writeClipboard(text: string): void {
    // Prefer the host-injected native writer (Tauri) to avoid the WebView popup.
    if (this.opts.writeClipboard) {
      this.opts.writeClipboard(text);
      return;
    }
    const clip =
      typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clip?.writeText) {
      clip.writeText(text).catch((err) => {
        console.error('terminal-core/engine: Failed to copy selection:', err);
      });
    }
  }

  private async readClipboard(): Promise<string> {
    // Prefer the host-injected native reader (Tauri) to avoid the WebView popup.
    if (this.opts.readClipboard) {
      return this.opts.readClipboard();
    }
    const clip =
      typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clip?.readText) {
      return clip.readText();
    }
    return '';
  }
}
