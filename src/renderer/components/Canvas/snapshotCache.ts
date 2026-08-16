/**
 * Tier-2 snapshot bookkeeping — `plan/013` Task 10.
 *
 * `GET /api/terminals/:id/snapshot` (api_server.rs:979) returns a styled ANSI blob of the
 * VISIBLE SCREEN from the backend's own vt100 parser. Written into a terminal of the same size
 * it reproduces that screen exactly. Zero WebGL contexts, so this tier scales to any number of
 * nodes — which is the whole point of having it: `MAX_GPU` is 12 and a workspace can hold
 * hundreds.
 *
 * Use `/snapshot`, never `/output`: the latter replays a lossy ring buffer through a FRESH
 * parser and is not "what the user is looking at".
 */

export const SNAPSHOT_TTL_MS = 2000;
/** After a failure, wait this multiple of the TTL before trying again. */
const FAILURE_BACKOFF = 4;

export interface SnapshotEntry {
  ansi: string;
  rows: number;
  cols: number;
  fetchedAt: number;
}

/** The endpoint's payload shape (`types/electron.d.ts` `TerminalSnapshot`). */
export interface SnapshotResponse {
  snapshot: string;
  rows: number;
  cols: number;
}

/**
 * Is this response a real screen, or the API's silent "no".
 *
 * `/snapshot` is keyed by **backend process id** — `state.screen_snapshot(&id)` looks the parser
 * up by `pc-*`. Handed a renderer id (`tm-*`) it does not 404. It logs a warning server-side and
 * returns **HTTP 200** with `{"snapshot": "", "rows": 0, "cols": 0}` (api_server.rs:992-995).
 *
 * A truthiness check on the response object passes that. The blank would be cached as a valid
 * frame, overwrite the last good one, and be held for the full TTL — a node that goes empty and
 * stays empty with nothing, anywhere, reporting an error. So the caller treats a false here as a
 * FAILURE: back off, and keep whatever frame it already had.
 */
export function isUsableSnapshot(r: SnapshotResponse | null | undefined): boolean {
  if (!r) return false;
  if (typeof r.snapshot !== 'string' || r.snapshot.length === 0) return false;
  return r.rows > 0 && r.cols > 0;
}

/**
 * Strip ANSI so the blob can be shown as plain text.
 *
 * Two families, because the payload contains both: CSI (`ESC [ … final`), which covers the SGR
 * colour runs from `contents_formatted()` and the private-mode sets `input_modes_snapshot`
 * appends; and OSC (`ESC ] … BEL` or `ESC ] … ESC \`), which carries titles and OSC-8 hyperlinks.
 *
 * **The ESC is not optional and its absence is not loud.** `plan/013`'s sample for this task
 * lost the literal ESC somewhere between editor and document and shipped `/\[[0-9;?]*…/`, which
 * matches a bare `[` — it would have left every real escape sequence intact while eating
 * ordinary text like `arr[0]`. Written with `\x1b` and covered by tests, including that exact
 * case.
 */
export function stripAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // Remaining two-byte escapes (charset selection, keypad mode) that carry no CSI/OSC body.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()#][0-9A-Za-z]|\x1b[=><]/g, '');
}

export class SnapshotCache {
  private entries = new Map<string, SnapshotEntry>();
  private failedAt = new Map<string, number>();

  get(id: string): SnapshotEntry | null {
    return this.entries.get(id) ?? null;
  }

  put(id: string, entry: SnapshotEntry): void {
    this.entries.set(id, entry);
    // Clearing the backoff is the point of putting: one blip would otherwise hold this node at
    // quarter cadence until it left the screen.
    this.failedAt.delete(id);
  }

  /** Record a failed fetch WITHOUT discarding the last good frame — a stale screen is a far
   *  better answer than a blank one, and the node is small enough that staleness is invisible. */
  markFailed(id: string, now: number): void {
    this.failedAt.set(id, now);
  }

  shouldRefresh(id: string, now: number): boolean {
    const failed = this.failedAt.get(id);
    if (failed !== undefined && now - failed < SNAPSHOT_TTL_MS * FAILURE_BACKOFF) return false;
    const e = this.entries.get(id);
    if (!e) return true;
    return now - e.fetchedAt >= SNAPSHOT_TTL_MS;
  }

  /** Drop everything not currently on screen — snapshots are cheap to refetch.
   *
   *  The failure record goes with the entry. Left behind, a terminal that failed, scrolled off
   *  screen and came back would be held in backoff with no entry to display: a blank node,
   *  refreshing at a quarter speed, for a reason that expired long ago. */
  evictAllBut(ids: string[]): void {
    const keep = new Set(ids);
    for (const id of Array.from(this.entries.keys())) {
      if (!keep.has(id)) this.entries.delete(id);
    }
    for (const id of Array.from(this.failedAt.keys())) {
      if (!keep.has(id)) this.failedAt.delete(id);
    }
  }
}

export const snapshotCache = new SnapshotCache();
