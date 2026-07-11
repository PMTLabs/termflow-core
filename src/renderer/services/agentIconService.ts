// Resolves an executable's icon to a data URL for the AgentChip, reusing the
// existing `get_executable_icon` Tauri command (Windows PowerShell/.NET, macOS
// osascript, Linux freedesktop). Extraction shells out to an OS helper (~100-300ms),
// so we cache per unique exe path: each path is resolved at most once per session.
//
// A curated override (CURATED_AGENT_ICONS) takes priority for known agents whose
// binary embeds no usable icon (e.g. `agy` = the Antigravity CLI) — those bypass
// native extraction entirely and work even when the exe path is unknown.
import { CURATED_AGENT_ICONS } from './agentIcons';

const cache = new Map<string, Promise<string | null>>();

/**
 * Resolve an executable's icon as an image data URL, once per unique path.
 *
 * A rejected bridge call — the command returns `Err` on a platform/agent with no
 * icon (e.g. a non-Windows binary with no themed icon), or extraction fails — maps
 * to `null` so the chip falls back to its running-dot. Never rejects.
 *
 * Only a *successful* (non-null) result is pinned in the cache. A `null` result is
 * evicted once it settles, so a later exe-change or a new pane retries — mirroring
 * the Rust `get_executable_icon` memo, which caches only `Ok` (failures stay
 * retryable). A stable "no icon" is cheap to recompute (the Linux path is a pure
 * filesystem lookup); pinning it would instead permanently strand a merely transient
 * failure (e.g. the helper momentarily blocked) on the dot for the whole session.
 */
export function getAgentIcon(exe: string | null, label?: string | null): Promise<string | null> {
  // Curated override wins: a proper bundled icon for a known agent, independent of
  // the exe path (so it shows even when the OS won't report the executable).
  if (label) {
    const curated = CURATED_AGENT_ICONS[label.toLowerCase()];
    if (curated) return Promise.resolve(curated);
  }
  if (!exe) return Promise.resolve(null);
  let p = cache.get(exe);
  if (!p) {
    const api = window.electronAPI?.getExecutableIcon;
    p = api
      ? api(exe)
          .then((url) => url ?? null)
          .catch(() => null)
      : Promise.resolve(null);
    cache.set(exe, p);
    const pending = p;
    // Evict our own entry if it resolved to null (don't clobber a successor promise).
    void pending.then((url) => {
      if (url == null && cache.get(exe) === pending) cache.delete(exe);
    });
  }
  return p;
}

/** Test-only: drop the session cache so each test starts clean. */
export function __clearAgentIconCache(): void {
  cache.clear();
}
