// Backlog 011: in-memory command-history index for the suggestion popup.
// Hydrated once at startup from the SQLite-backed store; matching happens
// synchronously here (the list is small — capped at HYDRATE_LIMIT entries).
// Persistence is fire-and-forget: failures degrade to session-only history.
//
// Stream 4: suggestions are additionally re-ranked by the CURRENT working directory.
// Commands previously run in the same directory (or its ancestors/descendants) rank
// above unrelated global history. Directory affinity is loaded asynchronously and
// cached per normalized dir (match() stays synchronous); with no cwd or no cached
// affinity, ranking is the original global recency/prefix order — never worse.

const HYDRATE_LIMIT = 2000;
const DEFAULT_MATCH_LIMIT = 8;

/** Normalize a directory for stable comparison/keying: backslashes → forward slashes,
 *  drop trailing slashes (but PRESERVE the POSIX root `/`), and lowercase Windows
 *  paths (drive-letter or UNC `//server/share`) since they are case-insensitive. POSIX
 *  paths keep their case. Empty/absent → ''. */
function normalizeDir(dir?: string | null): string {
  if (!dir) return '';
  const trimmed = dir.trim();
  let d = trimmed.replace(/\\/g, '/').replace(/\/+$/, '');
  if (d === '') return trimmed.startsWith('/') ? '/' : ''; // preserve POSIX root
  if (/^[a-zA-Z]:/.test(d) || d.startsWith('//')) d = d.toLowerCase(); // Windows drive / UNC
  return d;
}

/** Affinity of a command's recorded directory `dir` to the current `cwd`:
 *  3 = exact same directory, 2 = command ran in a descendant (subdir) of cwd,
 *  1 = command ran in an ancestor (parent) of cwd, 0 = unrelated. Both args must
 *  already be normalized. Root-aware: `/` is an ancestor of every absolute POSIX path. */
function dirAffinity(cwd: string, dir: string): number {
  if (!cwd || !dir) return 0;
  if (dir === cwd) return 3;
  const cwdPrefix = cwd === '/' ? '/' : cwd + '/';
  const dirPrefix = dir === '/' ? '/' : dir + '/';
  if (dir.startsWith(cwdPrefix)) return 2; // command ran in a subdir of cwd
  if (cwd.startsWith(dirPrefix)) return 1; // command ran in a parent of cwd
  return 0;
}

class CommandHistoryService {
  private commands: string[] = []; // most-recent-first
  // normalized dir → (command → best affinity weight for that dir). Populated by
  // ensureDirLoaded and read synchronously by match. Any mutation (record/remove/
  // hydrate) clears the whole cache and bumps `cacheGen`, so a slow in-flight load
  // that started before the mutation is dropped instead of writing stale data, and a
  // record in a subdir correctly invalidates a cached ancestor/descendant dir too.
  private affinityCache = new Map<string, Map<string, number>>();
  private loadingDirs = new Set<string>();
  private cacheGen = 0;

  private invalidateAffinity(): void {
    this.affinityCache.clear();
    this.cacheGen++;
  }

  async hydrate(): Promise<void> {
    try {
      this.commands = (await window.electronAPI?.loadCommandHistory?.(HYDRATE_LIMIT)) ?? [];
    } catch (e) {
      console.error('commandHistoryService: hydrate failed', e);
      this.commands = [];
    }
    // Another window may have recorded commands since our last load; drop any cached
    // directory affinity so ranking reflects the freshly hydrated global list.
    this.invalidateAffinity();
  }

  /** Record a submitted command. Always updates the global history; when `cwd` is
   *  known, also records per-directory usage (Stream 4) and invalidates that dir's
   *  cached affinity so the fresh usage is reflected the next time the popup opens. */
  record(command: string, cwd?: string): void {
    const cmd = command.trim();
    if (!cmd) return;
    this.commands = [cmd, ...this.commands.filter((c) => c !== cmd)];
    try {
      void window.electronAPI?.addCommandHistory?.(cmd);
    } catch (e) {
      console.error('commandHistoryService: persist failed', e);
    }
    const norm = normalizeDir(cwd);
    if (norm) {
      try {
        void window.electronAPI?.addCommandDirUsage?.(cmd, norm);
      } catch (e) {
        console.error('commandHistoryService: persist dir-usage failed', e);
      }
    }
    // Recording in `norm` also changes the affinity of its ancestors/descendants (a
    // command in c:/repo/sub affects ranking when cwd is c:/repo), so invalidate the
    // whole cache — not just `norm`. Cheap: reloaded lazily per dir on the next open.
    this.invalidateAffinity();
  }

  /** Remove one command everywhere (Shift+Delete on a suggestion): in-memory index +
   *  persisted store (which cascades to per-directory usage). Fire-and-forget like
   *  record(). Invalidates the affinity cache so no stale weight lingers. */
  remove(command: string): void {
    this.commands = this.commands.filter((c) => c !== command);
    this.invalidateAffinity();
    try {
      void window.electronAPI?.deleteCommandHistory?.(command);
    } catch (e) {
      console.error('commandHistoryService: delete failed', e);
    }
  }

  /** Load and cache directory affinity for `cwd` (Stream 4). Call this when the cwd is
   *  known (e.g. as the popup is about to open) so match() has the data synchronously.
   *  No-op for an empty cwd, an already-cached dir, or one already loading. */
  async ensureDirLoaded(cwd?: string): Promise<void> {
    const norm = normalizeDir(cwd);
    if (!norm || this.affinityCache.has(norm) || this.loadingDirs.has(norm)) return;
    this.loadingDirs.add(norm);
    const gen = this.cacheGen; // drop this load if a mutation invalidates the cache meanwhile
    try {
      const rows = (await window.electronAPI?.loadCommandDirUsage?.(norm)) ?? [];
      const weights = new Map<string, number>();
      for (const r of rows) {
        const w = dirAffinity(norm, normalizeDir(r.dir));
        if (w > 0 && w > (weights.get(r.command) ?? 0)) weights.set(r.command, w);
      }
      // Only commit if no record/remove/hydrate happened since we started — otherwise
      // this snapshot may be stale (e.g. missing a command just recorded in this dir).
      if (gen === this.cacheGen) this.affinityCache.set(norm, weights);
    } catch (e) {
      console.error('commandHistoryService: dir-usage load failed', e);
      if (gen === this.cacheGen) this.affinityCache.set(norm, new Map()); // cache the miss
    } finally {
      this.loadingDirs.delete(norm);
    }
  }

  /** Prefix matches first (case-insensitive), then substring matches; the exact
   *  already-typed command is excluded. When a cwd is supplied AND its affinity is
   *  cached (see ensureDirLoaded), candidates are stable-re-ranked so directory-relevant
   *  commands come first (exact dir > descendant > ancestor > unrelated), preserving the
   *  prefix/recency order within the same affinity. */
  match(input: string, opts?: { cwd?: string; limit?: number }): string[] {
    const typed = input.trim();
    const q = typed.toLowerCase();
    if (!q) return [];
    const limit = opts?.limit ?? DEFAULT_MATCH_LIMIT;
    const norm = normalizeDir(opts?.cwd);
    const weights = norm ? this.affinityCache.get(norm) : undefined;

    // Gather ALL matches (the list is capped at HYDRATE_LIMIT, so this is bounded and
    // cheap) BEFORE ranking — otherwise an exact-directory command that sits far down
    // the global-recency order would be truncated away before affinity could promote it.
    type Cand = { cmd: string; bucket: number; order: number };
    const prefix: Cand[] = [];
    const substr: Cand[] = [];
    for (let i = 0; i < this.commands.length; i++) {
      const c = this.commands[i];
      if (c === typed) continue; // already fully typed → nothing to suggest
      const lc = c.toLowerCase();
      if (lc.startsWith(q)) prefix.push({ cmd: c, bucket: 0, order: i });
      else if (lc.includes(q)) substr.push({ cmd: c, bucket: 1, order: i });
    }

    let all = [...prefix, ...substr];
    if (weights && weights.size > 0) {
      all = all.slice().sort((a, b) => {
        const wa = weights.get(a.cmd) ?? 0;
        const wb = weights.get(b.cmd) ?? 0;
        if (wa !== wb) return wb - wa;                 // higher directory affinity first
        if (a.bucket !== b.bucket) return a.bucket - b.bucket; // prefix before substring
        return a.order - b.order;                      // then most-recent first
      });
    }
    return all.slice(0, limit).map((c) => c.cmd);
  }

  /** Test hook. */
  __reset(): void {
    this.commands = [];
    this.affinityCache.clear();
    this.loadingDirs.clear();
  }
}

export const commandHistoryService = new CommandHistoryService();
