import { PaneNode } from '../../../store/slices/panesSlice';
import type { KeyboardProtocolStateData, PromptGate } from '@termflow/terminal-core';

/** Where, within a target pane, a drop will land. */
export type DropZone = 'top' | 'bottom' | 'left' | 'right' | 'center';

/** The pane being dragged. */
export interface PaneDragSource {
  terminalId: string;
  sourcePaneId: string;
  sourceTabId: string;
  name?: string;
  shellType?: string;
}

/** The resolved drop target under the cursor. */
export interface PaneDropTarget {
  tabId: string;
  paneId: string;
  zone: DropZone;
  rect: { left: number; top: number; width: number; height: number };
}

export interface PaneDragState {
  source: PaneDragSource;
  pointer: { x: number; y: number };
  target: PaneDropTarget | null;
  /** True once the cursor has left this window's bounds (detach candidate). */
  outsideWindow: boolean;
}

/** A live terminal carried across windows during detach / cross-window drop. */
export interface DetachTerminal {
  terminalId: string;
  processId: string;
  shellType?: string;
  name?: string;
  // Per-pane zoom level, carried so the pane keeps its zoom when moved to another
  // window (a separate renderer/store). Omitted when at the default 100%.
  zoom?: number;
  // Backlog 011 prompt-gate state, carried so the new window's TerminalEngine
  // knows the shell already proved itself hooked before this pane arrived —
  // without it, a still-running agent CLI (e.g. claude) has its composer input
  // wrongly captured into command history in the new window (no OSC 9;9/7 will
  // ever arrive there while the agent CLI owns the pty).
  promptGate?: PromptGate | null;
  // Keyboard-protocol state the running app negotiated with the SOURCE window,
  // carried for the same reason as promptGate: it is announced once per session
  // and lives only in that renderer's heap. Without it the new window sends
  // legacy bytes to a session expecting records — on Windows, ConPTY's
  // Win32-Input-Mode (`?9001h`, asserted for every session) is what makes Escape
  // reach an agent CLI at all; a TUI's Kitty flags (`CSI >u`) cover Shift+Enter /
  // Ctrl+C on every platform. Both omitted when the source had nothing active.
  win32InputMode?: true;
  keyboardProtocol?: KeyboardProtocolStateData;
  // Last-known working directory (spec 045 §3.3), carried because the snapshot map
  // is module-local to a renderer — the destination window starts with an empty one.
  // Without this, a shell that reports no cwd via OSC (cmd/WSL/bash) and exits in the
  // new window before its first refresh tick restarts at the profile default, even
  // though the source window knew exactly where it was.
  cwd?: string;
}

export interface DetachPayload {
  kind: 'tab' | 'pane';
  /** Tab id to use for the reconstructed tab in the new window. */
  tabId: string;
  tabTitle: string;
  paneTree: PaneNode;
  terminals: DetachTerminal[];
  cursor?: { x: number; y: number };
  // The fields below carry a whole-tab detach's Tab-level appearance state
  // (icon, title lock, colors) across to the destination window — it's the
  // SAME tab, just relocated, so these must survive the move.
  //
  // `tabIcon` and `titleIsCustom` are set only by buildTabDetachPayload (kind: 'tab'): a pane
  // split off into its own tab gets a NEW identity, so a custom title lock and an icon chosen
  // for a different tab would be claims about it that nobody made.
  //
  // `titleColor` is the exception, and is set for BOTH kinds. It is a group appearance rather
  // than an identity, and every title naming this terminal wears it — so a pane that arrived in
  // a new window wearing default styling would read as having silently left its group.
  tabIcon?: string;
  titleIsCustom?: boolean;
  titleColor?: string;
  colorSchemaId?: string;
  // Tab-level notification mute — a persistent user setting, so it must survive a
  // whole-tab move like the fields above. (Pane-level mute already rides along on
  // the PaneNode tree.) Only set for kind: 'tab'.
  notifyMuted?: boolean;
  // Plan 045 R8: whether the destination tab should show the Administrator badge.
  // Set for BOTH kinds like `titleColor` (it names a fact about the terminal, not
  // an identity choice) — but derived differently per kind: `sourceTab?.elevated`
  // for a whole-tab move (kind: 'tab'), the detached leaf's own `PaneNode.elevated`
  // for a single-pane move (kind: 'pane'), since a pane's new tab has no source
  // Tab record of its own to read. Dropping this on either path leaves a still-
  // elevated terminal running in a tab whose strip no longer shows the badge.
  elevated?: boolean;
}
