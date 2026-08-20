/**
 * A WebGL context budget that is shared the way the CEILING is actually shared.
 *
 * ## The defect this exists for
 *
 * `MAX_GPU = 12` is enforced per JS realm, and `countActiveWebGLAddons()` can only see the
 * addons in ITS realm. The browser's ceiling is not per realm. Measured in Chromium:
 *
 *   - page 1 created 64 contexts and nothing failed — creation NEVER throws;
 *   - page 2 then allocated its own, and page 1 was silently cut to 16 surviving contexts.
 *
 * So the eviction is cross-page, the victim is the OLDEST context (someone's
 * longest-running terminal), and the only signal is that a terminal quietly stops painting
 * through WebGL. Two windows each honouring 12 request 24 against a ceiling near 16.
 *
 * That is the same failure PR #42 fixed for one window, at a scope that fix did not cover.
 * And it spans INSTANCES, not just windows: every TermFlow process on a machine shares one
 * WebView2 browser process and one `EBWebView` user-data-dir, so they also share an origin
 * — which is exactly why the ledger below lives in `localStorage`. A per-process counter,
 * or one derived from Tauri's window registry, would miss the sibling instance entirely.
 *
 * ## Why creation cannot simply be probed
 *
 * The obvious alternative is to allocate until it fails and count. It does not work, and
 * `devDiagnostics`' "contexts still available" probe is measuring something weaker than its
 * name suggests: allocation past the ceiling SUCCEEDS and evicts someone else's context
 * instead. A probe cannot see a ceiling that is enforced by eviction rather than refusal.
 *
 * ## Direction of failure
 *
 * Over-counting other windows makes this window too conservative — it paints on the DOM
 * renderer, which is slower but completely correct. Under-counting them hands out a context
 * that evicts a live terminal's. So every judgement call here rounds towards over-counting,
 * which is why a live holder heartbeats rather than relying on a long staleness window.
 */

/**
 * The ceiling to stay under, across every window and instance sharing the browser process.
 *
 * Chromium's limit sat at 16 surviving contexts in the measurement above. This is not a
 * number to tune upwards on the evidence of "it seemed fine": going over does not error, it
 * silently kills the oldest terminal's renderer, which is invisible until a user reports
 * that one pane stopped being smooth.
 */
export const GLOBAL_WEBGL_CEILING = 16;

/** `localStorage` key prefix. Shared origin, so this is namespaced deliberately. */
export const LEDGER_PREFIX = 'tf:webgl:';

/**
 * How long an entry is trusted without a refresh.
 *
 * A window holding contexts republishes on a timer well inside this, so a stale entry means
 * the window is GONE (crash, kill, reload) and its contexts died with it. Dropping it then
 * is correct. This is the one place staleness moves us towards under-counting, which is why
 * the heartbeat interval below is a third of it rather than just under it.
 */
export const STALE_MS = 30_000;

/** How often a window holding contexts refreshes its entry. */
export const HEARTBEAT_MS = 10_000;

export interface LedgerEntry {
  /** Contexts this window currently holds, including quarantined ones. */
  n: number;
  /** `Date.now()` at publication. */
  ts: number;
}

/* ------------------------------------------------------------------ pure arithmetic */

/**
 * Parse a stored value, rejecting anything malformed.
 *
 * Total and defensive on purpose: this reads storage written by a DIFFERENT PROCESS, which
 * may be a different TermFlow version with a different shape, or a half-written value. A
 * throw here would propagate into the render-policy path; a `null` just means "that window
 * does not count", which is the under-counting direction — so callers treat an unparseable
 * entry as present-but-unknown rather than absent (see `sumOthers`).
 */
export function parseEntry(raw: string | null | undefined): LedgerEntry | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return null;
    const { n, ts } = v as Record<string, unknown>;
    if (typeof n !== 'number' || typeof ts !== 'number') return null;
    if (!Number.isFinite(n) || !Number.isFinite(ts) || n < 0) return null;
    return { n: Math.floor(n), ts };
  } catch {
    return null;
  }
}

/**
 * Contexts held by windows OTHER than `selfKey`.
 *
 * `entries` is the raw `[key, value]` list so this stays pure and testable — the storage
 * read is the caller's job.
 *
 * An entry that is present but unparseable counts as `unknownCost` rather than 0. A sibling
 * that wrote something we cannot read is still holding contexts, and scoring it zero is the
 * one mistake that hands out a context which evicts a live terminal.
 */
export function sumOthers(
  entries: ReadonlyArray<readonly [string, string | null]>,
  selfKey: string,
  now: number,
  staleMs: number = STALE_MS,
  unknownCost = 1,
): number {
  let total = 0;
  for (const [key, raw] of entries) {
    if (!key.startsWith(LEDGER_PREFIX)) continue;
    if (key === selfKey) continue;
    const entry = parseEntry(raw);
    if (!entry) {
      total += unknownCost;
      continue;
    }
    // A future `ts` (clock skew between processes) is not staleness — trust it.
    if (now - entry.ts > staleMs) continue;
    total += entry.n;
  }
  return total;
}

/** Contexts this window may still allocate. Never negative. */
export function headroom(
  ownCount: number,
  otherCount: number,
  ceiling: number = GLOBAL_WEBGL_CEILING,
): number {
  return Math.max(0, ceiling - otherCount - ownCount);
}

/* ------------------------------------------------------------------ storage shell */

let selfId: string | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let lastPublished = -1;

/** The key this window writes. `null` until an identity is set. */
export function selfKey(): string | null {
  return selfId === null ? null : LEDGER_PREFIX + selfId;
}

/**
 * Name this window in the ledger. Called once per realm at startup.
 *
 * Until this is called the ledger is INERT — `publishOwnUsage` does nothing and
 * `otherWindowsUsage` returns 0 — so a host that never sets an identity (tests, the
 * headless/mirror embedders) behaves exactly as it did before this module existed.
 */
export function setLedgerWindowId(id: string): void {
  selfId = id;
  lastPublished = -1;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage can throw outright when blocked by policy
  }
}

/** Every ledger key currently in storage, paired with its raw value. */
function readAll(store: Storage): Array<readonly [string, string | null]> {
  const out: Array<readonly [string, string | null]> = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key && key.startsWith(LEDGER_PREFIX)) out.push([key, store.getItem(key)]);
  }
  return out;
}

/**
 * Record how many contexts this window holds.
 *
 * `force` bypasses the unchanged-value skip; the heartbeat uses it, because the POINT of a
 * heartbeat is to refresh `ts` when `n` has not moved.
 */
export function publishOwnUsage(n: number, force = false): void {
  const key = selfKey();
  const store = storage();
  if (!key || !store) return;
  if (!force && n === lastPublished) return;
  try {
    store.setItem(key, JSON.stringify({ n, ts: Date.now() } satisfies LedgerEntry));
    lastPublished = n;
  } catch {
    /* quota or private-mode failure: the ledger degrades to "this window is invisible to
       its siblings", which is the pre-existing behaviour, not a new fault. */
  }
}

/** Contexts held by every OTHER window and instance right now. */
export function otherWindowsUsage(now: number = Date.now()): number {
  const key = selfKey();
  const store = storage();
  if (!key || !store) return 0;
  try {
    return sumOthers(readAll(store), key, now);
  } catch {
    return 0;
  }
}

/**
 * Keep this window's entry fresh while it holds contexts, and drop it when it does not.
 *
 * Armed with a getter rather than a value because the count changes underneath it; the
 * alternative is publishing from every site that touches `entry.webglAddon`, and the site
 * that got forgotten would silently under-report this window to its siblings.
 */
export function startLedgerHeartbeat(getCount: () => number): void {
  if (heartbeat !== null) return;
  if (typeof setInterval !== 'function') return;
  heartbeat = setInterval(() => {
    const n = getCount();
    // Holding nothing needs no refresh: an entry that ages out contributes 0 to
    // `sumOthers`, which is exactly what a zero entry contributes. Skipping keeps a window
    // that never touches WebGL from writing to localStorage every ten seconds for the life
    // of the process. A DROP to zero is still published immediately by the demotion path —
    // this only declines to keep re-stating it.
    if (n === 0) return;
    publishOwnUsage(n, true);
  }, HEARTBEAT_MS);
  // Node/jsdom keep the process alive for a bare interval; this one must never do that.
  (heartbeat as unknown as { unref?: () => void }).unref?.();
}

export function stopLedgerHeartbeat(): void {
  if (heartbeat !== null) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

/**
 * Remove this window's entry — on teardown, so siblings reclaim its budget at once rather
 * than waiting out `STALE_MS`.
 */
export function clearOwnUsage(): void {
  const key = selfKey();
  const store = storage();
  if (!key || !store) return;
  try {
    store.removeItem(key);
  } catch {
    /* nothing to do; the entry ages out */
  }
  lastPublished = -1;
}

/** Test hygiene only. */
export function resetLedgerForTests(): void {
  stopLedgerHeartbeat();
  selfId = null;
  lastPublished = -1;
}
