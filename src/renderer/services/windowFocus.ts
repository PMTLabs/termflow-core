// Tracks whether THIS renderer's OS window is focused (Stream 1). Used by the
// NotificationService to (a) decide whether to request an OS notification and
// (b) route to the notified tab when the user returns to the window.
//
// Window-local by design: the authoritative "is any TermFlow window focused" check for
// gating OS notifications is done app-wide in the Rust backend (which can see every
// window). This getter only reflects the current window.
import { getCurrentWindow } from '@tauri-apps/api/window';

let focused = true;
let started = false;
const listeners = new Set<(focused: boolean) => void>();

export function isWindowFocused(): boolean {
  return focused;
}

/** Subscribe to focus changes for this window. Returns an unsubscribe fn. */
export function onWindowFocusChange(cb: (focused: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Begin tracking focus. Idempotent; a no-op in non-Tauri hosts (stays "focused"). */
export async function startWindowFocusTracking(): Promise<void> {
  if (started) return;
  started = true;
  try {
    const w = getCurrentWindow();
    focused = await w.isFocused();
    await w.onFocusChanged(({ payload }) => {
      focused = payload;
      for (const cb of listeners) cb(payload);
    });
  } catch {
    /* not a tauri window / event API unavailable → leave focused=true */
  }
}

/** Test-only reset. */
export function __resetWindowFocus(): void {
  focused = true;
  started = false;
  listeners.clear();
}
