import React, { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { patchSshPaneTag, type PaneNode } from '../../store/slices/panesSlice';
import { findLeafByTerminalId } from '../../store/slices/paneTreeOps';
import { useSurfaceHost } from '../../services/surfaceHosts';
import type { SshPromptReceipt, SshSessionView } from '../../types/ssh';
import { SshBrowserPaneShell } from './SshBrowserPaneShell';
import { readSshPaneTag, type SshBrowserTagPatch, type SshPaneTag } from './ssh066Contract';
import { publishSshCanvasVisible, publishSshPresentation, useSshCanvasVisible, useSshPresentation } from './sshPresentations';
import { useSshFileBrowser } from './useSshFileBrowser';

/**
 * Shared SSH composition for the two presentations of one terminal (plan 070 §4.1 A, gap G1).
 *
 * - The PANE presentation (`SshPaneSlot`, mounted by `TerminalPane`) is the owner. It runs the one
 *   file controller, publishes it with the tag-patch route, and stays laid out while Canvas hosts
 *   the terminal so returning has a real box. While `useSurfaceHost(terminalId)` is non-null it is
 *   inert: no prompt, banner action, edit notice, menu or dialog.
 * - The CANVAS presentation (`SshCanvasPresentation`, rendered by `NodeTerminal`) shows the same
 *   shell around the single registered `.terminal-display` host and reads the published
 *   controller. It never lists, subscribes, opens or closes a session itself.
 *
 * Everything is gated on the 066 tag: a leaf without one renders exactly today's DOM.
 */

/** The canonical leaf's tag, resolved by terminalId (never pane id). */
export function readSshTagForTerminal(treesByTabId: Record<string, PaneNode | null>, terminalId: string): SshPaneTag | undefined {
  const leaf = findLeafByTerminalId(treesByTabId, terminalId);
  return leaf ? readSshPaneTag(leaf) : undefined;
}

// A presentation with no pane owner to route through has nothing to patch.
const NOOP_PATCH = (_patch: SshBrowserTagPatch): void => {};

/** App-channel view for this terminal; an honest disconnected view before any session exists. */
function useSshView(terminalId: string, connectionId: string): SshSessionView {
  const session = useSelector((state: RootState) => state.sshSession.byTerminal[terminalId]?.session);
  return useMemo<SshSessionView>(() => session ?? { terminalId, connectionId, state: 'disconnected', gate: 'pending' },
    [session, terminalId, connectionId]);
}

/** Prompt actions route renderer → Rust for this terminal only; nothing is stored. */
function useSshShellActions(terminalId: string, view: SshSessionView) {
  return useMemo(() => ({
    onSecret: (secret: string, remember: boolean, receipt: SshPromptReceipt): Promise<void> => {
      const api = window.electronAPI;
      return api ? api.sshSessionSubmitSecret(terminalId, secret, remember, receipt) : Promise.reject(new Error('SSH is unavailable.'));
    },
    onTrust: (receipt: SshPromptReceipt): Promise<void> => {
      const api = window.electronAPI;
      return api ? api.sshSessionTrustHost(terminalId, true, receipt) : Promise.reject(new Error('SSH is unavailable.'));
    },
    onCancel: (): void => {
      const api = window.electronAPI;
      // A refused host key is answered on its own receipt. 070: a secret-prompt Cancel
      // goes through the launch coordinator (ssh_terminal_cancel_launch), never a PTY write.
      if (api && view.state === 'needs-hostkey') {
        api.sshSessionTrustHost(terminalId, false, { generation: view.generation, promptId: view.promptId }).catch(() => undefined);
      }
    },
  }), [terminalId, view]);
}

/**
 * Wraps a pane's terminal content. No tag (every local leaf; 066 tags an SSH leaf at creation): renders `children`
 * unchanged, so the DOM is byte-identical to today.
 */
export function SshPaneSlot({ terminalId, isTabActive, children }: {
  terminalId?: string; isTabActive: boolean; children: React.ReactNode;
}) {
  const sshTag = useSelector((state: RootState) => terminalId ? readSshTagForTerminal(state.panes.treesByTabId, terminalId) : undefined);
  if (!terminalId || !sshTag) return <>{children}</>;
  return <SshPaneOwner key={terminalId} terminalId={terminalId} sshTag={sshTag} isTabActive={isTabActive}>{children}</SshPaneOwner>;
}

function SshPaneOwner({ terminalId, sshTag, isTabActive, children }: {
  terminalId: string; sshTag: SshPaneTag; isTabActive: boolean; children: React.ReactNode;
}) {
  // Canvas owns interaction while it hosts this terminal (plan 070 §4.1 A).
  const canvasOwns = useSurfaceHost(terminalId) !== null;
  const dispatch = useDispatch();
  // The canonical tag on the leaf, by terminalId (066 patchSshPaneTag).
  const onPatchTag = useCallback((patch: SshBrowserTagPatch) => { dispatch(patchSshPaneTag({ terminalId, patch })); }, [dispatch, terminalId]);
  // The ONE controller (D51): active while ANY surface showing this terminal is visible (its
  // pane's tab, or a visible Canvas node), and re-listed when it goes from no visible surface to
  // a visible one. A hidden tab with no Canvas view still drops and re-lists on return (068 C1).
  // The grace absorbs the hand-over between the two surfaces, so entering Canvas never re-lists.
  const canvasVisible = useSshCanvasVisible(terminalId);
  const browserActive = useSurfaceVisibleWithGrace(isTabActive || canvasVisible);
  const browser = useSshFileBrowser({ terminalId, sshTag, surfaceActive: browserActive, onPatchTag });
  useLayoutEffect(() => publishSshPresentation(terminalId, { browser, onPatchTag }), [terminalId, browser, onPatchTag]);
  const view = useSshView(terminalId, sshTag.connectionId);
  const actions = useSshShellActions(terminalId, view);
  return <SshBrowserPaneShell terminalId={terminalId} sshTag={sshTag} surfaceActive={isTabActive && !canvasOwns}
    onPatchTag={onPatchTag} browserController={browser} interactive={!canvasOwns} view={view} terminal={children}
    // 066's SshLaunchNotice (TerminalPane) owns this terminal's host-key and secret prompts.
    sessionPrompts={false}
    onSecret={actions.onSecret} onTrust={actions.onTrust} onCancel={actions.onCancel} />;
}

/** How long the owner keeps its controller active after the last visible surface goes away. */
export const SSH_SURFACE_HIDE_GRACE_MS = 250;

/** True at once when `visible`; false only once `visible` has stayed false for the grace. */
function useSurfaceVisibleWithGrace(visible: boolean): boolean {
  const [held, setHeld] = useState(visible);
  useLayoutEffect(() => {
    if (visible) { setHeld(true); return undefined; }
    const timer = setTimeout(() => setHeld(false), SSH_SURFACE_HIDE_GRACE_MS);
    return () => clearTimeout(timer);
  }, [visible]);
  return visible || held;
}

/** The slot `NodeTerminal` renders for an SSH leaf; `terminal` is its `.terminal-display` wrapper. */
export interface SshCanvasShellProps {
  terminalId: string;
  sshTag: SshPaneTag;
  /** False while the node is culled or below the chip tier. Defaults to true. */
  visible?: boolean;
  /** The frozen browser allocation for the current collapse state, in CSS px. */
  browserWidth?: number;
  terminal: React.ReactNode;
}

export function SshCanvasPresentation({ terminalId, sshTag, visible = true, browserWidth, terminal }: SshCanvasShellProps) {
  const presentation = useSshPresentation(terminalId);
  useLayoutEffect(() => publishSshCanvasVisible(terminalId, visible), [terminalId, visible]);
  const view = useSshView(terminalId, sshTag.connectionId);
  const actions = useSshShellActions(terminalId, view);
  // `null` controller: with no pane owner there is nothing to show, and building one here would
  // be the second controller this composition exists to prevent.
  // `surfaceActive={visible}`: a culled, chip/group-tier or hidden node is not the visible surface,
  // so its menus, dialogs and chrome popover close and a dialog closing then never restores focus
  // into it (068 F5), exactly as for a pane whose tab is in the background.
  return <SshBrowserPaneShell terminalId={terminalId} sshTag={sshTag} surfaceActive={visible}
    onPatchTag={presentation?.onPatchTag ?? NOOP_PATCH} browserController={presentation?.browser ?? null}
    view={view} browserWidth={browserWidth} terminal={terminal}
    // D51: 066's SshLaunchNotice, portalled into this node's terminal slot, owns the host-key and
    // secret prompts and Reconnect here too (Canvas.css overlays it), exactly as in the pane.
    sessionPrompts={false}
    onSecret={actions.onSecret} onTrust={actions.onTrust} onCancel={actions.onCancel} />;
}
