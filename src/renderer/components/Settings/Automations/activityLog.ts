/**
 * The activity log's display rules (mockup §06).
 *
 * A rule that does nothing looks exactly like a rule that is working perfectly and has correctly
 * stayed quiet. The log is what tells those two apart, so it records **decisions**, not just sends.
 * Nine identical *still above 25* lines are noise; a count with a **show them** is the same
 * information — so collapsing is display-only, the entries are all really there, and **Copy** takes
 * them expanded.
 *
 * Pure over the entries, with no clock of its own: every timestamp comes from the row that was
 * written, never from `Date.now()` at render. A log that re-derives anything at display time can
 * rewrite the past, which is the same mistake as looking a terminal's name up instead of storing it.
 */
import type { AutomationLogEntry, AutomationLogKind } from '../../../types/electron';

/** The word the log column shows, in the mockup's own vocabulary. */
export const LOG_KIND_LABEL: Record<AutomationLogKind, string> = {
    sent: 'sent',
    held: 'held',
    reArmed: 're-armed',
    noMatch: 'no match',
    failed: 'failed',
    enabled: 'enabled',
    disabled: 'disabled',
    saved: 'saved',
    testRun: 'test run',
    check: 'checked',
};

/** The row's colour class — `au-lg-*`, one per family rather than one per kind. */
export const LOG_KIND_CLASS: Record<AutomationLogKind, string> = {
    sent: 'sent',
    held: 'held',
    reArmed: 'rearm',
    noMatch: 'none',
    failed: 'err',
    enabled: 'life',
    disabled: 'life',
    saved: 'life',
    testRun: 'life',
    check: 'none',
};

/** The three filter chips over the log (mockup §06). */
export type LogFilter = 'all' | 'sent' | 'problems';

export function passesFilter(entry: AutomationLogEntry, filter: LogFilter): boolean {
    if (filter === 'all') return true;
    if (filter === 'sent') return entry.kind === 'sent';
    return entry.kind === 'failed';
}

/**
 * The kinds that may be folded: the quiet ones, and only those.
 *
 * **A `sent` or a `failed` row is never collapsed**, however many of them run together. Seven
 * identical *held* decisions are noise the reader wants summarised; seven identical *sent* rows are
 * seven messages that actually went to a terminal, and folding those would hide exactly the thing
 * the log exists to prove. The mockup only ever draws a collapsed `held`.
 */
const COLLAPSIBLE: ReadonlySet<AutomationLogKind> = new Set<AutomationLogKind>([
    'held',
    'check',
    'noMatch',
]);

/** Below this a run is shown in full — two rows is not a wall of text worth summarising. */
export const COLLAPSE_MIN = 3;

export interface LogRow {
    /** Stable across re-renders: the first entry's id, which is unique and never reused. */
    key: string;
    /** Every entry this row stands for, in order. One for an ordinary row. */
    entries: AutomationLogEntry[];
    count: number;
    first: AutomationLogEntry;
    last: AutomationLogEntry;
    collapsed: boolean;
}

/**
 * Fold consecutive quiet decisions about the **same terminal** into one row.
 *
 * Keyed on `(terminalId, kind)` rather than on the detail text, because that is what the mockup
 * draws: its collapsed row stands for seven *held* decisions whose details read `31`, `44`, `52`…
 * — different numbers, the same decision. Keying on the detail would fold almost nothing and the
 * feature would look broken on real data.
 *
 * The run breaks on a differing terminal even when the kind matches, because one rule watching
 * three terminals produces three interleaved stories and merging them would attribute a decision
 * to the wrong one.
 */
export function collapseRuns(entries: AutomationLogEntry[]): LogRow[] {
    const rows: LogRow[] = [];
    let run: AutomationLogEntry[] = [];

    const flush = () => {
        if (run.length === 0) return;
        const first = run[0];
        const last = run[run.length - 1];
        rows.push({
            key: String(first.id),
            entries: run,
            count: run.length,
            first,
            last,
            collapsed: run.length >= COLLAPSE_MIN,
        });
        run = [];
    };

    for (const entry of entries) {
        const head = run[0];
        const continues =
            head !== undefined
            && head.kind === entry.kind
            && (head.terminalId ?? null) === (entry.terminalId ?? null)
            && COLLAPSIBLE.has(entry.kind);
        if (continues) {
            run.push(entry);
        } else {
            flush();
            run = [entry];
        }
    }
    flush();
    return rows;
}

/** `09:09:32`, or `09:11–09:14` for a folded run. Locale-independent so a test can assert it. */
export function rowTime(row: LogRow): string {
    const from = clockTime(row.first.at);
    if (!row.collapsed) return from;
    // `first` and `last` are POSITIONAL: `collapseRuns` folds whatever order it was handed, and
    // `ActivityLogView` genuinely supports both directions — its header text and its
    // `aria-label` both flip on `newestFirst`. Reading them as earliest-then-latest therefore renders
    // a BACKWARDS range (`09:14–09:11`) the moment a caller passes newest-first. Only
    // `AutomationsPanel.showLog` calls this today and it hardcodes oldest-first, so the defect is
    // latent rather than live — but the prop it is latent behind is public.
    const earliest = Math.min(row.first.at, row.last.at);
    const latest = Math.max(row.first.at, row.last.at);
    return `${clockTime(earliest).slice(0, 5)}–${clockTime(latest).slice(0, 5)}`;
}

export function clockTime(at: number): string {
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** What a folded row says in place of a detail. */
export function collapsedDetail(row: LogRow): string {
    return `${row.count} identical decisions collapsed`;
}

/**
 * The text **Copy** puts on the clipboard — every entry, expanded.
 *
 * Collapsing is a display decision. A log pasted into a bug report with seven decisions replaced by
 * the words "7 identical decisions collapsed" has lost the timestamps that make it evidence.
 */
export function logCopyText(entries: AutomationLogEntry[]): string {
    return entries
        .map((e) => {
            const who = e.terminalId ?? '—';
            const name = e.terminalName ? ` ${e.terminalName}` : '';
            return `${clockTime(e.at)}\t${who}${name}\t${LOG_KIND_LABEL[e.kind]}\t${e.detail}`;
        })
        .join('\n');
}

/**
 * Merge freshly-arrived entries into the buffer, newest-or-oldest-first preserved, dropping
 * duplicates by id and holding the buffer at `limit`.
 *
 * The log subscribes **before** it fetches (§5.3), so the two streams overlap by design and the
 * merge has to be idempotent — hence the dedupe by id.
 *
 * **Ordering is by `id`, never by `at` (§3.1), and that is deliberate — not an assumption that the
 * two agree.** They do not always: `at` is stamped when the decision is made while the row is
 * appended afterwards, and the send path appends only once the send has been performed, so a `held`
 * decided 262ms AFTER a `sent` can be inserted before it and take the lower id. Measured live, and
 * visible on screen as `held` sitting above its own `sent`.
 *
 * `at` is still the wrong key despite that, for the reasons §3.1 gives: entries share a millisecond
 * (verbose mode writes several terminals per tick) and the wall clock can move BACKWARDS after an
 * NTP correction or a resume — `system:resume` is an event this app already handles. An id is
 * monotonic under both. The store pins this in `the_log_is_ordered_by_id_and_never_by_at`; this
 * module is the second surface that has to obey it, so the test below pins it here too.
 */
export function mergeEntries(
    existing: AutomationLogEntry[],
    incoming: AutomationLogEntry[],
    newestFirst: boolean,
    limit: number,
): AutomationLogEntry[] {
    const byId = new Map<number, AutomationLogEntry>();
    for (const e of existing) byId.set(e.id, e);
    for (const e of incoming) byId.set(e.id, e);
    const all = [...byId.values()].sort((a, b) => (newestFirst ? b.id - a.id : a.id - b.id));
    // ALWAYS keep the NEWEST `limit`, whichever way round they are being displayed.
    //
    // This used to `slice(0, limit)` unconditionally — "keep the front of the requested order" —
    // and the full log view is always oldest-first, so once the buffer reached 200 the front was
    // the 200 OLDEST ids and every newly arrived row was dropped by the merge that was supposed to
    // add it. The log froze at the moment it filled, which on a chatty rule is a minute or two, and
    // it then held rows the store itself had already pruned. Reading direction is a display
    // decision; which rows are worth keeping is not, and the answer is the same for both.
    return newestFirst ? all.slice(0, limit) : all.slice(-limit);
}
