import { store } from '../store';
import { addTab, setActiveTab } from '../store/slices/tabsSlice';
import { CANVAS_SHELL_TYPE } from './tabKinds';

/**
 * Canvas Mode's entry points.
 *
 * Canvas Mode is a PLACE, not a lens: one more tab in the strip, which you switch to and
 * away from like any other, leaving every other tab working normally underneath. This
 * amends `design/010` D1 (a full-surface overlay over a still-mounted tab DOM) — see
 * `backlog/007` §4 for the decision and its knock-on effects.
 *
 * The MECHANISM is untouched by that change. Terminals still relocate into node hosts
 * through the surface registry, driven by `CanvasMode` being MOUNTED — and it mounts
 * exactly when its tab is the active one, which is the same mount/unmount edge the
 * overlay had. `012` §6.5 RC1-RC5 are unaffected.
 *
 * Modelled on `openSettings.ts`, deliberately: both are single-instance screen tabs, and
 * having them behave differently would be a surprise with no reason behind it.
 */

/**
 * The tab to return to when the canvas is toggled off. Remembered rather than derived,
 * so toggling twice puts you back where you were rather than at whatever tab happens to
 * sit first in the strip — a workspace with a dozen tabs makes that difference obvious.
 */
let returnToTabId: string | null = null;

function findCanvasTabId(): string | null {
  const { tabs } = store.getState().tabs;
  return tabs.find((t) => t.shellType === CANVAS_SHELL_TYPE)?.id ?? null;
}

/** True when the canvas tab exists AND is the one on screen. */
export function isCanvasTabActive(): boolean {
  const { tabs, activeTabId } = store.getState().tabs;
  const tab = tabs.find((t) => t.id === activeTabId);
  return tab?.shellType === CANVAS_SHELL_TYPE;
}

/**
 * Show the canvas: activate the existing canvas tab, or create it.
 *
 * Single-instance, like Settings — a second canvas tab would mount a second `CanvasMode`,
 * and two of them would register two hosts for the same terminalId, which `surfaceHosts`
 * explicitly forbids.
 */
export function openCanvasTab(): void {
  if (isCanvasTabActive()) return;

  const { activeTabId } = store.getState().tabs;
  const existing = findCanvasTabId();
  // Captured BEFORE the switch, and only when we are actually leaving somewhere — so a
  // second `openCanvasTab()` while already on the canvas cannot overwrite the return
  // target with the canvas tab itself.
  if (activeTabId && activeTabId !== existing) returnToTabId = activeTabId;

  if (existing) {
    store.dispatch(setActiveTab(existing));
    return;
  }

  store.dispatch(
    addTab({
      id: `tab-canvas-${Date.now()}`,
      title: 'Canvas',
      shellType: CANVAS_SHELL_TYPE,
      icon: '🗺️',
    }),
  );
}

/**
 * Leave the canvas for the tab it was opened from.
 *
 * Deliberately does NOT close the canvas tab. It is a tab: it stays until the user closes
 * it, the same as Settings, and re-entering it is then free rather than a fresh mount of
 * every node host.
 *
 * No-ops when there is nowhere to go — a workspace whose only tab is the canvas would
 * otherwise be asked to activate a tab that does not exist.
 */
export function leaveCanvasTab(): void {
  if (!isCanvasTabActive()) return;

  const { tabs } = store.getState().tabs;
  const remembered = returnToTabId && tabs.some((t) => t.id === returnToTabId)
    ? returnToTabId
    : null;
  // The remembered tab can have been closed while the canvas was on screen, so fall back
  // to any other tab rather than stranding the user on the canvas.
  const target = remembered ?? tabs.find((t) => t.shellType !== CANVAS_SHELL_TYPE)?.id ?? null;
  if (!target) return;

  returnToTabId = null;
  store.dispatch(setActiveTab(target));
}

/** The `toggleCanvasMode` shortcut: go to the canvas, or come back from it. */
export function toggleCanvasTab(): void {
  if (isCanvasTabActive()) leaveCanvasTab();
  else openCanvasTab();
}

/** Test-only: drop the remembered return tab so cases cannot leak into each other. */
export function __resetCanvasReturnForTest(): void {
  returnToTabId = null;
}
