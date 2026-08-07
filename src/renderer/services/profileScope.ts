/**
 * Renderer-side view of the backend's profile identity.
 *
 * Two instances of TermFlow share one WebView2 user-data folder, so they share
 * ONE localStorage: without scoping, `--profile work` would read and overwrite
 * the default profile's tabs, layouts and API token. The backend owns the
 * identity (see `src-tauri/src/profile.rs`); this module caches it and derives
 * the storage keys from it.
 *
 * The default profile keeps the ORIGINAL, unsuffixed keys, so an existing user's
 * saved state loads exactly as before.
 */

export const DEFAULT_SCOPE = 'default';

export interface ProfileInfo {
  /** Profile name, e.g. `default`, `work`, `elevated`. */
  name: string;
  /** True when this instance runs elevated (Windows: high integrity). */
  elevated: boolean;
  /** Storage discriminator: `name`, plus `.high` when elevated. */
  scope: string;
  isDefault: boolean;
}

let current: ProfileInfo = {
  name: DEFAULT_SCOPE,
  elevated: false,
  scope: DEFAULT_SCOPE,
  isDefault: true,
};

/** Suffix a storage key with the scope, leaving the default profile untouched. */
export function scopedKey(base: string, scope: string = current.scope): string {
  return !scope || scope === DEFAULT_SCOPE ? base : `${base}:${scope}`;
}

export function stateKeyFor(scope: string): string {
  return scopedKey('auto-terminal-state', scope);
}

export function layoutsKeyFor(scope: string): string {
  return scopedKey('auto-terminal-layouts', scope);
}

export function apiTokenKeyFor(scope: string): string {
  return scopedKey('api_token', scope);
}

/** The live keys for this instance. */
export const stateKey = (): string => stateKeyFor(current.scope);
export const layoutsKey = (): string => layoutsKeyFor(current.scope);
export const apiTokenKey = (): string => apiTokenKeyFor(current.scope);

export function currentProfile(): ProfileInfo {
  return current;
}

/**
 * Ask the backend which profile this window belongs to.
 *
 * MUST be awaited before the bridge or `App` is loaded: `App` registers unload,
 * visibility and interval saves the moment it mounts, and the bridge writes the
 * API token as soon as its config request resolves — a late scope means those
 * land on the default profile's keys.
 *
 * Falls back to the default scope (today's keys) if the command is unavailable,
 * which is the browser/monitor case.
 */
export async function initProfileScope(
  invoke?: (cmd: string) => Promise<unknown>,
): Promise<ProfileInfo> {
  if (!invoke) return current;
  try {
    const info = (await invoke('get_profile')) as ProfileInfo | undefined;
    if (info && typeof info.scope === 'string') {
      current = info;
    }
  } catch (e) {
    console.warn('profileScope: could not resolve the profile; using the default keys', e);
  }
  return current;
}

/** Test seam. Production code sets the scope only via `initProfileScope`. */
export function __setProfileForTests(info: Partial<ProfileInfo>): void {
  current = { ...current, ...info };
}
