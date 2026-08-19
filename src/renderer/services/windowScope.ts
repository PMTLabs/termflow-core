/**
 * Renderer-side view of this OS window's identity.
 *
 * Every window of one instance shares a WebView2 origin, and therefore ONE
 * localStorage. Before this module, `StateManager` wrote the whole session to a
 * single profile-scoped key from every window — a blind overwrite, so the last
 * window to save (an autosave tick, a visibility change, or explicitly the
 * window you just closed) replaced every other window's tabs. On the next start
 * one window restored whatever had survived. See plan 018.
 *
 * The backend owns the identity (`src-tauri/src/window_registry.rs`); this
 * module caches it and derives the session key from it.
 *
 * Scope boundary — only the AUTO-SAVED SESSION is per-window:
 *   * session state (`auto-terminal-state`)  → per window
 *   * saved layouts (`auto-terminal-layouts`) → per instance; a named layout is
 *     a user library, and fragmenting it per window would hide layouts from the
 *     window that did not save them
 *   * API token (`api_token`)                 → per instance
 */

import { stateKeyFor, currentProfile } from './profileScope';

/**
 * The window that owns the pre-existing, unsuffixed key.
 *
 * Slot 0 keeps today's key names so a single-window user's saved session loads
 * byte-identically after this ships — the same backward-compatibility trick the
 * profile scoping used for the default profile. Must match
 * `window_registry::SLOT_ZERO_ID`.
 */
export const SLOT_ZERO_ID = 'w0';

/**
 * Separates the window dimension from the profile-scoped base.
 *
 * Deliberately NOT `:`, which the profile scope already uses. With one
 * separator, a default-profile window whose id was `work` would derive exactly
 * `auto-terminal-state:work` — the WORK profile's slot-0 key — and the two
 * instances would read and overwrite each other's session. Backend ids are
 * 32-char hex today, so that is unreachable in practice; a distinct separator
 * makes it unreachable by construction instead of by coincidence.
 */
export const WINDOW_SEPARATOR = '#';

let current: string = SLOT_ZERO_ID;
/** False until the backend has answered, so a failure is distinguishable. */
let resolved = false;

export function currentWindowId(): string {
  return current;
}

export function isSlotZero(): boolean {
  return current === SLOT_ZERO_ID;
}

/** Did the backend actually answer? Used only for diagnostics. */
export function windowScopeResolved(): boolean {
  return resolved;
}

/**
 * The localStorage key holding THIS window's auto-saved session.
 *
 * Composed here rather than inside `profileScope` so that module stays a pure
 * function of the profile and there is no import cycle.
 */
export function sessionStateKey(): string {
  const base = stateKeyFor(currentProfile().scope);
  return isSlotZero() ? base : `${base}${WINDOW_SEPARATOR}${current}`;
}

/**
 * The prefix every session key for THIS PROFILE starts with.
 *
 * Used by the orphan sweep, which must never touch a sibling profile's keys —
 * deleting those would be the same class of bug this module exists to fix.
 */
export function sessionKeyPrefix(): string {
  return stateKeyFor(currentProfile().scope);
}

/**
 * Does `key` hold a session belonging to this profile, and if so, whose?
 *
 * Returns the windowId, or `null` when the key belongs to another profile or is
 * not a session key at all.
 */
export function windowIdFromSessionKey(key: string): string | null {
  const prefix = sessionKeyPrefix();
  if (key === prefix) return SLOT_ZERO_ID;
  if (!key.startsWith(`${prefix}${WINDOW_SEPARATOR}`)) return null;
  const rest = key.slice(prefix.length + WINDOW_SEPARATOR.length);
  // A profile scope is itself a `:` suffix, so anything still carrying one
  // belongs to a different profile, not to a window of ours.
  return rest.length === 0 || rest.includes(':') ? null : rest;
}

/**
 * Ask the backend which window this renderer is.
 *
 * MUST be awaited before the bridge or `App` loads, for exactly the reason
 * `initProfileScope` must be: `App` registers unload, visibility and interval
 * saves the moment it mounts, and a late id means those first saves land on
 * slot 0's key — silently merging this window into another's session.
 *
 * Falls back to slot 0 when the command is unavailable (browser/monitor mode,
 * or an older backend), which is exactly today's single-key behaviour.
 */
export async function initWindowScope(
  invoke?: (cmd: string) => Promise<unknown>,
): Promise<string> {
  if (!invoke) return current;
  try {
    const id = await invoke('get_window_session_id');
    if (typeof id === 'string' && id.length > 0) {
      current = id;
      resolved = true;
    }
  } catch (e) {
    // The backend refuses rather than guessing when it cannot identify the
    // window, so this is reachable. Slot 0 is the safe landing: it means this
    // window shares the main session rather than silently losing its own.
    console.warn('windowScope: could not resolve this window; using the slot-0 key', e);
  }
  return current;
}

/** Test seam. Production code sets the id only via `initWindowScope`. */
export function __setWindowForTests(id: string): void {
  current = id;
  resolved = id !== SLOT_ZERO_ID;
}
