import { PaneNode } from '../../../store/slices/panesSlice';
import type { PromptGate } from '@termflow/terminal-core';

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
  // SAME tab, just relocated, so these must survive the move. Only ever set
  // by buildTabDetachPayload (kind: 'tab'); a pane split off into its own tab
  // (kind: 'pane') has no prior Tab to inherit these from.
  tabIcon?: string;
  titleIsCustom?: boolean;
  titleColor?: string;
  colorSchemaId?: string;
}
