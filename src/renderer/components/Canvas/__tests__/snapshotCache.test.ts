import fs from 'fs';
import path from 'path';
import { SnapshotCache, SNAPSHOT_TTL_MS, isUsableSnapshot, stripAnsi } from '../snapshotCache';

const entry = (t: number) => ({ ansi: 'x', rows: 24, cols: 80, fetchedAt: t });

describe('SnapshotCache', () => {
  it('returns null before anything is cached', () => {
    expect(new SnapshotCache().get('tm-1')).toBeNull();
  });

  it('refreshes when nothing is cached', () => {
    expect(new SnapshotCache().shouldRefresh('tm-1', 0)).toBe(true);
  });

  it('does not refresh inside the TTL', () => {
    const c = new SnapshotCache();
    c.put('tm-1', entry(1000));
    expect(c.shouldRefresh('tm-1', 1000 + SNAPSHOT_TTL_MS - 1)).toBe(false);
  });

  it('refreshes once the TTL has elapsed', () => {
    const c = new SnapshotCache();
    c.put('tm-1', entry(1000));
    expect(c.shouldRefresh('tm-1', 1000 + SNAPSHOT_TTL_MS)).toBe(true);
  });

  it('evicts entries for terminals that are no longer visible', () => {
    const c = new SnapshotCache();
    c.put('tm-1', entry(0));
    c.put('tm-2', entry(0));
    c.evictAllBut(['tm-1']);
    expect(c.get('tm-1')).not.toBeNull();
    expect(c.get('tm-2')).toBeNull();
  });

  it('keeps the last good snapshot when a refresh fails', () => {
    const c = new SnapshotCache();
    c.put('tm-1', entry(0));
    c.markFailed('tm-1', 500);
    expect(c.get('tm-1')!.ansi).toBe('x');
  });

  it('backs off after a failure instead of hammering the API', () => {
    const c = new SnapshotCache();
    c.put('tm-1', entry(0));
    c.markFailed('tm-1', 500);
    expect(c.shouldRefresh('tm-1', 500 + SNAPSHOT_TTL_MS)).toBe(false);
    expect(c.shouldRefresh('tm-1', 500 + SNAPSHOT_TTL_MS * 4)).toBe(true);
  });

  // A success after a failure must clear the backoff, or one blip would hold a node at the
  // slow cadence until it left the screen and its entry was evicted.
  it('a successful put clears the backoff', () => {
    const c = new SnapshotCache();
    c.markFailed('tm-1', 0);
    c.put('tm-1', entry(0));
    expect(c.shouldRefresh('tm-1', SNAPSHOT_TTL_MS)).toBe(true);
  });

  // evictAllBut has to drop the failure record too. Leaving it behind means a terminal that
  // failed, scrolled off screen and came back is silently held in backoff with no entry to
  // show — a permanently blank node, refreshing at a quarter speed for no visible reason.
  it('eviction clears the failure record as well as the entry', () => {
    const c = new SnapshotCache();
    c.put('tm-1', entry(0));
    c.markFailed('tm-1', 0);
    c.evictAllBut([]);
    expect(c.shouldRefresh('tm-1', 1)).toBe(true);
  });

  it('evictAllBut([]) drops everything', () => {
    const c = new SnapshotCache();
    c.put('tm-1', entry(0));
    c.put('tm-2', entry(0));
    c.evictAllBut([]);
    expect(c.get('tm-1')).toBeNull();
    expect(c.get('tm-2')).toBeNull();
  });
});

/**
 * The silent-failure guard.
 *
 * `GET /api/terminals/:id/snapshot` is keyed by BACKEND PROCESS ID — `state.screen_snapshot(&id)`
 * looks the vt100 parser up by `pc-*`. Handed a renderer id it does not 404; it returns
 * **HTTP 200** with `{"snapshot": "", "rows": 0, "cols": 0}` (api_server.rs:992-995). Cached
 * as if valid, that blank would overwrite a good frame and then be held for the whole TTL — a
 * node that goes empty and stays empty, with nothing anywhere reporting an error.
 *
 * So "usable" is a rule rather than a truthiness check, and it lives here where it can be
 * tested, rather than inside the component's fetch callback where it cannot.
 */
describe('isUsableSnapshot', () => {
  it('accepts a real screen', () => {
    expect(isUsableSnapshot({ snapshot: 'hello', rows: 24, cols: 80 })).toBe(true);
  });

  it('rejects the 200-with-nothing response the API gives for an unknown id', () => {
    expect(isUsableSnapshot({ snapshot: '', rows: 0, cols: 0 })).toBe(false);
  });

  // Each field alone, because the real response fails all three at once and a check that
  // happened to test only one would look identical on that response.
  it('rejects a zero grid even when the blob is non-empty', () => {
    expect(isUsableSnapshot({ snapshot: 'x', rows: 0, cols: 80 })).toBe(false);
    expect(isUsableSnapshot({ snapshot: 'x', rows: 24, cols: 0 })).toBe(false);
  });

  it('rejects an empty blob even when the grid looks real', () => {
    expect(isUsableSnapshot({ snapshot: '', rows: 24, cols: 80 })).toBe(false);
  });

  it('rejects a missing or malformed payload', () => {
    expect(isUsableSnapshot(null)).toBe(false);
    expect(isUsableSnapshot(undefined)).toBe(false);
    expect(isUsableSnapshot({} as never)).toBe(false);
  });
});

/**
 * `stripAnsi` — and the reason it is tested at all.
 *
 * `plan/013`'s sample carried the ESC as a raw 0x1b control BYTE rather than the text `\x1b`.
 * The byte is invisible — in an editor, in a diff, and to any file-reading tool — so the pattern
 * reads as `/\[[0-9;?]*[ -/]*[@-~]/`, which matches a bare `[` and would chew ordinary text
 * (`arr[0]` -> `arr`) while leaving every real escape sequence in place. Copy it and it works;
 * retype what you can see and it does not. These assert the behaviour so neither form can be
 * mistaken for the other, and the `arr[0]` case below is the one that tells them apart.
 */
describe('stripAnsi', () => {
  const ESC = '\x1b';

  it('removes SGR colour runs', () => {
    expect(stripAnsi(`${ESC}[1;32mgreen${ESC}[0m`)).toBe('green');
  });

  it('removes cursor and erase sequences', () => {
    expect(stripAnsi(`${ESC}[2J${ESC}[H${ESC}[10;20Hx`)).toBe('x');
  });

  // What the endpoint appends after the screen: `input_modes_snapshot` re-asserts mouse
  // tracking, bracketed paste and focus reporting as private-mode sets.
  it('removes the private-mode sets the endpoint appends', () => {
    expect(stripAnsi(`text${ESC}[?1000h${ESC}[?2004h${ESC}[?1049l`)).toBe('text');
  });

  it('removes OSC strings terminated by BEL or ST', () => {
    expect(stripAnsi(`${ESC}]0;my title\x07shell`)).toBe('shell');
    expect(stripAnsi(`${ESC}]8;;http://x\x1b\\link`)).toBe('link');
  });

  it('leaves ordinary text alone — including brackets', () => {
    // The exact case the doc's ESC-less pattern would have destroyed.
    expect(stripAnsi('arr[0] = xs[i];')).toBe('arr[0] = xs[i];');
    expect(stripAnsi('plain')).toBe('plain');
  });

  it('keeps newlines, so the screen still has rows', () => {
    expect(stripAnsi(`a${ESC}[0m\nb`)).toBe('a\nb');
  });

  it('handles an empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});

/**
 * The wiring, derived from source — `CanvasMode` and `NodeSnapshot` cannot be mounted under the
 * root Jest config (Redux store, untransformed CSS imports, `@tauri-apps/api/event`, a real
 * `Terminal.open()` needing a canvas 2D context jsdom lacks).
 *
 * Everything above can be perfect and the tier still absent, or still leaking, if these lines go.
 * Substring matching rather than a built regex: a mis-escaped dynamic pattern matches nothing and
 * passes while checking nothing.
 */
describe('snapshot tier wiring', () => {
  const src = (f: string) => fs.readFileSync(path.resolve(__dirname, f), 'utf8');
  const MODE = src('../CanvasMode.tsx');
  const SNAP = src('../NodeSnapshot.tsx');

  it('renders the snapshot only for the culled set, never for every node', () => {
    // `{snapshotIds.has(id) && <NodeSnapshot/>}` is the guard. Rendering it unconditionally is
    // the resource leak `snapshotNodeIds` exists to prevent, and it would look perfectly fine
    // on screen — the cost is invisible until you count timers.
    expect(MODE).toContain('snapshotIds.has(n.terminalId) && <NodeSnapshot');
  });

  it('bounds the cache to what is on screen', () => {
    expect(MODE).toContain('snapshotCache.evictAllBut(');
  });

  it('resolves the BACKEND process id before fetching', () => {
    // The silent-failure trap: `/snapshot` handed a renderer id returns 200 with a blank screen.
    expect(SNAP).toContain('terminalService.getProcessId(terminalId)');
  });

  it('validates the response instead of trusting a 200', () => {
    expect(SNAP).toContain('isUsableSnapshot(snap)');
    // ...and treats a bad one as a failure, so the last good frame survives and the backoff arms.
    expect(SNAP).toContain('snapshotCache.markFailed');
  });

  it('goes through the token-carrying bridge, never a raw fetch', () => {
    expect(SNAP).toContain('getTerminalSnapshot');
    expect(SNAP).not.toContain('fetch(');
  });

  it('tears its timer down on unmount', () => {
    // A surviving timer would keep polling for a terminal that is no longer on the canvas, and
    // would setState into an unmounted tree.
    expect(SNAP).toContain('clearTimeout(timer.current)');
    expect(SNAP).toContain('cancelled = true');
  });
});
