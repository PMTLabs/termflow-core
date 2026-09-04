/**
 * Keeps the backend's `Terminal.display_label` in step with the tab/pane title this window shows.
 *
 * WHY A SECOND FIELD RATHER THAN REPAIRING `Terminal.name`
 * `updateTerminalName` is a stub that returns `true` and invokes nothing, so `Terminal.name` has
 * no live writer after spawn and is literally `Terminal-{shell}` for every renderer-created
 * terminal. Repairing it is deliberately out of scope: `name` is on the wire in `/api/terminals`
 * and is what MCP's `get_terminal_detail` returns, so changing what it HOLDS changes what agents
 * see. And if the stub is ever repaired, `name` gains three writers of two different
 * granularities — `renameTabProcesses` writes a TAB title to every leaf, `TerminalPane` writes a
 * PANE name to one from two call sites — and an auto-title writer beside them would let the
 * shell's next OSC title silently undo a user's pane rename.
 *
 * WHY THIS HANGS OFF THE STORE, NOT OFF A LIFECYCLE HOOK
 * The same reason `paneOwnership.ts` gives in its own header, and the shared differ they both use
 * lives in `leafValueDiff.ts`. A moved pane already has a mapping and takes `TerminalPane`'s reuse
 * path, so it never re-binds and no spawn hook fires for it.
 *
 * WHAT A LEAF'S LABEL IS
 * The pane's own name when it has one, else the title of the tab that owns it — which is exactly
 * what the user sees on the tab strip, and exactly what they will look for in the Automations
 * picker and in the activity log's Name column.
 *
 * Plan 028 §4.2.
 */
import type { PaneNode } from '../store/slices/panesSlice';
import { diffLeafValues, type LeafValues } from './leafValueDiff';

/** renderer leaf id -> the label the backend should hold for it. */
export type LeafLabels = LeafValues<string>;

interface TabTitles {
  id: string;
  title: string;
}

/**
 * Flatten every tab's pane tree into leaf -> label.
 *
 * A pane with a blank or whitespace-only name falls back to the tab title. A leaf with neither is
 * mapped to the EMPTY STRING and **not left out of the map**: leaving it out is what a leaf that has
 * left this window looks like, and `diffLeafValues` deliberately says nothing about those — so a
 * label the user CLEARED produced no push at all and the backend kept the stale one for the life of
 * the terminal. The empty string is the value that clears it: `set_display_label` stores a blank as
 * `None`, which is exactly the absence `label_at` needs in order to fall through to the next source.
 */
export function collectLeafLabels(
  treesByTabId: Record<string, PaneNode | null>,
  tabs: TabTitles[],
): LeafLabels {
  const titleByTabId = new Map(tabs.map((t) => [t.id, t.title]));
  const labels: LeafLabels = new Map();
  const walk = (node: PaneNode | null | undefined, tabId: string): void => {
    if (!node) return;
    if (node.type === 'terminal' && node.terminalId) {
      const paneName = node.name?.trim();
      labels.set(node.terminalId, paneName || titleByTabId.get(tabId)?.trim() || '');
    }
    node.children?.forEach((child) => walk(child, tabId));
  };
  for (const tabId of Object.keys(treesByTabId)) walk(treesByTabId[tabId], tabId);
  return labels;
}

/**
 * The label pushes this window owes the backend.
 *
 * **A leaf with no prior binding pushes once if it has a label to push** — unlike ownership, which
 * suppresses that case whatever the value. Labels are not a `create_terminal` parameter, so
 * suppressing every first push would mean a brand-new solo terminal that is never split and never
 * renamed has its label pushed NEVER, and every log line and picker row for it stays blank forever.
 * That is most first terminals.
 *
 * The one first sight worth suppressing is an EMPTY label: the backend's default already is no
 * label, so pushing it would be one invoke per unlabelled pane at every startup to assert what is
 * already true. A leaf that becomes empty LATER is a genuine clear and always pushes — that is the
 * whole reason `collectLeafLabels` maps it to `''` rather than dropping it.
 */
export function diffLabelChanges(
  previous: LeafLabels | null,
  next: LeafLabels,
): Array<{ rendererTerminalId: string; label: string }> {
  const worthAFirstPush = (id: string): boolean => (next.get(id) ?? '') !== '';
  return diffLeafValues(previous, next, worthAFirstPush).map(({ rendererTerminalId, value }) => ({
    rendererTerminalId,
    label: value,
  }));
}

/** The slice of the store this needs — structural, so no import of the store. */
interface LabelSyncStore {
  getState: () => {
    panes: { treesByTabId: Record<string, PaneNode | null> };
    tabs: { tabs: TabTitles[] };
  };
  subscribe: (listener: () => void) => () => void;
}

/**
 * The store `attachTerminalLabelSync` was given, so `reassertLabelAfterSpawn` can read it without
 * taking an import edge into the store graph. Null until bootstrap has run, which makes the
 * re-assert a safe no-op for anything created before then.
 */
let labelStore: LabelSyncStore | null = null;

/** The last map this window pushed, so the next store change diffs against it rather than re-sending. */
let lastLabels: LeafLabels | null = null;

function push(rendererTerminalId: string, label: string): void {
  window.electronAPI
    ?.setTerminalDisplayLabel?.(rendererTerminalId, label)
    ?.catch((e: unknown) => {
      console.warn(`Failed to push label ${label} for terminal ${rendererTerminalId}`, e);
    });
}

/**
 * Push a leaf's CURRENT label once its PTY is actually registered.
 *
 * The same race `reassertOwnerAfterSpawn` closes, for the same reason: the subscription below
 * fires on the tree change, but the backend can only label a terminal it has already registered,
 * and `spawn_terminal` registers LAST. `set_terminal_display_label` treats an unmatched leaf as a
 * successful no-op — it must, since the renderer fires off its own store lifecycle — and the
 * subscription has already advanced `lastLabels`, so no later change re-sends it. The label would
 * then be missing for the rest of the session.
 *
 * **Unconditional**, unlike the ownership re-assert, which skips when the owner it sent at spawn
 * is still current: no label was sent at spawn, so there is nothing that could already be right.
 */
export function reassertLabelAfterSpawn(rendererTerminalId: string): void {
  if (!labelStore) return;
  const state = labelStore.getState();
  const label = collectLeafLabels(state.panes.treesByTabId, state.tabs.tabs).get(
    rendererTerminalId,
  );
  // Nothing to assert, in either of two ways: no entry means the pane left this window or the tree
  // has not been committed yet, and an empty label means the backend's default is already right.
  if (!label) return;
  push(rendererTerminalId, label);
}

/**
 * Watch the pane trees and tab titles and push every label change to the backend.
 * Returns the store's unsubscribe.
 *
 * Best-effort and fire-and-forget: a failed push costs a blank Name column on a log line, never
 * the rename itself.
 */
export function attachTerminalLabelSync(store: LabelSyncStore): () => void {
  labelStore = store;
  lastLabels = null;
  // Trees and the tab array are immutable per change (RTK/immer), so two identity checks keep
  // every unrelated dispatch — every keystroke-driven action — down to two comparisons.
  let lastTrees: Record<string, PaneNode | null> | null = null;
  let lastTabs: TabTitles[] | null = null;

  return store.subscribe(() => {
    const { panes, tabs } = store.getState();
    if (panes.treesByTabId === lastTrees && tabs.tabs === lastTabs) return;
    lastTrees = panes.treesByTabId;
    lastTabs = tabs.tabs;

    const next = collectLeafLabels(panes.treesByTabId, tabs.tabs);
    const changes = diffLabelChanges(lastLabels, next);
    lastLabels = next;

    for (const change of changes) push(change.rendererTerminalId, change.label);
  });
}
