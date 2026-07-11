/**
 * Session-wide cache of real executable icons (base64 PNG data URLs), keyed by
 * the binary's path. Shared by the New Tab profile flyout and the tab strip so a
 * given shell's icon is only extracted once. Falls back to `null` (callers show
 * an emoji) while loading or when extraction isn't available (e.g. non-Windows).
 */
const cache = new Map<string, string>();
const failed = new Set<string>();
const pending = new Map<string, Promise<string | null>>();

/** Synchronously read an already-loaded icon, or undefined if not cached yet. */
export function getCachedIcon(path?: string): string | undefined {
  return path ? cache.get(path) : undefined;
}

/** Load (and cache) a binary's icon. De-dupes concurrent requests per path. */
export function loadIcon(path?: string): Promise<string | null> {
  if (!path) return Promise.resolve(null);
  const hit = cache.get(path);
  if (hit) return Promise.resolve(hit);
  if (failed.has(path)) return Promise.resolve(null);
  const inflight = pending.get(path);
  if (inflight) return inflight;

  const req = (async () => {
    try {
      const url = await window.electronAPI?.getExecutableIcon?.(path);
      if (url) {
        cache.set(path, url);
        return url;
      }
      failed.add(path);
      return null;
    } catch {
      failed.add(path);
      return null;
    } finally {
      pending.delete(path);
    }
  })();
  pending.set(path, req);
  return req;
}
