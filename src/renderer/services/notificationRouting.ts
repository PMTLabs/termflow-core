// Decides what a click on an OS notification should do to this window.
//
// Kept as a pure function, separate from the App.tsx listener, because the decision has
// three distinct outcomes that are easy to conflate — and conflating two of them is
// exactly how this went wrong before:
//
//   ignore      not ours by either test; do not react at all, not even to take focus
//   focus-only  we raised it, but the tab is gone; raise the window, change nothing
//   activate    we hold the tab; raise the window and open it
//
// THE TAB IS THE IDENTITY, not the window. The window label in the payload only records
// where the tab lived when the notification was raised, and a tab can be dragged to
// another window (detach.ts) in the seconds or hours before the user clicks. Deciding
// purely on the label meant the originating window focused itself and showed nothing
// while the window actually holding the tab ignored the event — the click silently did
// the wrong thing. So ownership is checked FIRST, and the label is only the tiebreaker
// that lets the originating window raise itself when the tab is simply gone.
//
// `setActiveTab` does not validate its payload (tabsSlice.ts): handed an unknown id it
// marks every tab inactive and points activeTabId at nothing, blanking the UI. macOS
// notifications persist in Notification Center indefinitely, so a click naming a
// long-closed tab is routine rather than exotic.

export interface ActivationPayload {
  windowLabel: string;
  tabId: string;
}

export type ActivationDecision =
  | { kind: 'ignore'; reason: 'window-mismatch' }
  | { kind: 'focus-only'; reason: 'tab-closed' | 'no-tab-id' }
  | { kind: 'activate'; tabId: string };

export function resolveActivation(
  payload: ActivationPayload,
  currentWindowLabel: string,
  tabs: ReadonlyArray<{ id: string }>,
): ActivationDecision {
  // Ownership first: whoever holds the tab serves the click, whichever window raised it.
  if (payload.tabId && tabs.some((t) => t.id === payload.tabId)) {
    return { kind: 'activate', tabId: payload.tabId };
  }
  // We don't hold it. Only the window that raised the notification may still react, and
  // only by surfacing itself — it has nowhere to navigate to.
  if (payload.windowLabel !== currentWindowLabel) {
    return { kind: 'ignore', reason: 'window-mismatch' };
  }
  if (!payload.tabId) {
    return { kind: 'focus-only', reason: 'no-tab-id' };
  }
  return { kind: 'focus-only', reason: 'tab-closed' };
}
