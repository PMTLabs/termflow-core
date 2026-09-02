import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../../store';
import { findLeaf, findTabIdByTerminalId } from '../../store/slices/paneTreeOps';
import { setPaneMuted } from '../../store/slices/panesSlice';

/**
 * Notification-mute state for one pane, shared by the pane header bell
 * (`TerminalPane`), the pane context menu (`PaneContextMenu`), and the
 * terminal context menu (`TerminalDisplay`, reachable from both the tab pane
 * and the Canvas overlay) — three surfaces, one selector pair.
 *
 * `paneMuted` is this pane's own flag; `tabMuted` is its owning tab's flag,
 * which OVERRIDES it for notification purposes even though `toggle` only
 * ever flips the pane's own flag (tab mute is managed from the tab context
 * menu, not here). `effectiveMuted` is the OR of the two, and is what a bell
 * icon should actually show.
 *
 * Each selector is SELF-CONTAINED — it re-resolves the pane's/tab's identity
 * itself rather than composing off a value the other selector read — so it
 * can't read a stale `owningTabId` during an intermediate store-notification
 * pass (the pane tree and the tab list are two separate slices, notified
 * separately). This pair used to be duplicated verbatim in `TerminalPane`
 * and `PaneContextMenu`, each carrying this same constraint in its own
 * comment; a third copy in `TerminalDisplay` is how a future re-home would
 * have dropped it, which is why this is extracted here instead.
 *
 * Both flags read PRESENCE-OR-ABSENCE (`!!x.notifyMuted`), never a literal
 * `=== false` — the field is optional on both the pane leaf and the tab, and
 * its absence means "not muted".
 *
 * `paneId` is optional so `TerminalDisplay` — whose own `paneId` prop is
 * optional (`relocationHost`-hosted surfaces render with none) — can call
 * this unconditionally, as the Rules of Hooks require; with no id there is
 * nothing to look up, so it reads as unmuted and `toggle` is a no-op.
 */
export function usePaneMuteState(
  paneId: string | undefined,
  terminalId?: string,
): { paneMuted: boolean; tabMuted: boolean; effectiveMuted: boolean; toggle: () => void } {
  const dispatch = useDispatch();

  const paneMuted = useSelector((state: RootState) => {
    if (!paneId) return false;
    for (const tid of Object.keys(state.panes.treesByTabId)) {
      const leaf = findLeaf(state.panes.treesByTabId[tid], paneId);
      if (leaf) return !!leaf.notifyMuted;
    }
    return false;
  });

  const tabMuted = useSelector((state: RootState) => {
    if (!terminalId) return false;
    const tid = findTabIdByTerminalId(state.panes.treesByTabId, terminalId);
    return !!(tid && state.tabs.tabs.find(t => t.id === tid)?.notifyMuted);
  });

  const toggle = () => {
    if (!paneId) return;
    dispatch(setPaneMuted({ paneId, muted: !paneMuted }));
  };

  return { paneMuted, tabMuted, effectiveMuted: tabMuted || paneMuted, toggle };
}
