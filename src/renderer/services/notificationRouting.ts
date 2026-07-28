// Decides what a click on an OS notification should do to this window.
//
// Kept as a pure function, separate from the App.tsx listener, because the decision has
// three distinct outcomes that are easy to conflate — and conflating two of them is
// exactly how this went wrong before:
//
//   ignore      the event belongs to another window; do not even take focus
//   focus-only  it is ours, but the tab is gone; raise the window, change nothing
//   activate    it is ours and the tab is live; raise the window and open the tab
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
  if (payload.windowLabel !== currentWindowLabel) {
    return { kind: 'ignore', reason: 'window-mismatch' };
  }
  if (!payload.tabId) {
    return { kind: 'focus-only', reason: 'no-tab-id' };
  }
  if (!tabs.some((t) => t.id === payload.tabId)) {
    return { kind: 'focus-only', reason: 'tab-closed' };
  }
  return { kind: 'activate', tabId: payload.tabId };
}
