/**
 * §10.25 — the activity log's display rules.
 *
 * `collapseRuns` folds identical decisions into one row with a count, does **not** fold across a
 * differing terminal, and **Copy** takes them expanded. Collapsing is display-only; the entries are
 * all really there, and a log pasted into a bug report with seven decisions replaced by the words
 * "7 identical decisions collapsed" has lost the timestamps that made it evidence.
 */
import type { AutomationLogEntry, AutomationLogKind } from '../../../../types/electron';
import {
    COLLAPSE_MIN,
    collapseRuns,
    logCopyText,
    mergeEntries,
    passesFilter,
    rowTime,
} from '../activityLog';

let nextId = 1;

function entry(
    kind: AutomationLogKind,
    terminalId: string | null,
    detail = 'still above 25',
    at = 0,
): AutomationLogEntry {
    return {
        id: nextId++,
        ruleId: 'au-1',
        terminalId,
        terminalName: terminalId ? 'claude' : null,
        kind,
        detail,
        at,
    };
}

beforeEach(() => {
    nextId = 1;
});

describe('collapseRuns', () => {
    it('folds seven identical decisions into one row carrying count 7', () => {
        const rows = collapseRuns(
            Array.from({ length: 7 }, () => entry('held', 'tm-a')),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].count).toBe(7);
        expect(rows[0].collapsed).toBe(true);
        // The entries are all really there — that is what makes Copy able to expand them.
        expect(rows[0].entries).toHaveLength(7);
    });

    it('does not fold across a differing terminal', () => {
        // One rule watching three terminals produces three interleaved stories; merging them would
        // attribute a decision to the wrong one.
        const rows = collapseRuns([
            entry('held', 'tm-a'),
            entry('held', 'tm-a'),
            entry('held', 'tm-b'),
            entry('held', 'tm-b'),
        ]);
        expect(rows.map((r) => [r.first.terminalId, r.count])).toEqual([
            ['tm-a', 2],
            ['tm-b', 2],
        ]);
    });

    it('folds a run whose details differ, because the DECISION is what repeats', () => {
        // The mockup's own collapsed row stands for seven `held` decisions reading 31, 44, 52…
        // Keying on the detail text would fold almost nothing on real data.
        const rows = collapseRuns([
            entry('held', 'tm-a', 'read 31'),
            entry('held', 'tm-a', 'read 44'),
            entry('held', 'tm-a', 'read 52'),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].count).toBe(3);
    });

    it('never folds a sent or a failed row, however many run together', () => {
        // Seven identical *held* decisions are noise. Seven *sent* rows are seven messages that
        // actually reached a terminal, and hiding those would hide what the log exists to prove.
        for (const kind of ['sent', 'failed'] as AutomationLogKind[]) {
            const rows = collapseRuns(Array.from({ length: 7 }, () => entry(kind, 'tm-a')));
            expect(rows).toHaveLength(7);
            expect(rows.every((r) => !r.collapsed)).toBe(true);
        }
    });

    it('leaves a short run expanded', () => {
        const rows = collapseRuns(
            Array.from({ length: COLLAPSE_MIN - 1 }, () => entry('held', 'tm-a')),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].collapsed).toBe(false);
    });

    it('shows a time range for a folded run and a clock time for a single row', () => {
        const start = new Date(2026, 8, 4, 9, 11, 5).getTime();
        const end = new Date(2026, 8, 4, 9, 14, 40).getTime();
        const folded = collapseRuns([
            entry('held', 'tm-a', 'a', start),
            entry('held', 'tm-a', 'b', start + 1000),
            entry('held', 'tm-a', 'c', end),
        ]);
        expect(rowTime(folded[0])).toBe('09:11–09:14');
        expect(rowTime(collapseRuns([entry('sent', 'tm-a', 'x', start)])[0])).toBe('09:11:05');
    });
});

describe('Copy', () => {
    it('takes the entries expanded, not the collapsed rows', () => {
        const entries = Array.from({ length: 7 }, (_, i) =>
            entry('held', 'tm-a', `read ${i}`, new Date(2026, 8, 4, 9, 11, i).getTime()));
        const text = logCopyText(entries);
        expect(text.split('\n')).toHaveLength(7);
        expect(text).toContain('read 6');
        expect(text).not.toContain('collapsed');
    });

    it('writes a dash for an entry that belongs to no single terminal', () => {
        expect(logCopyText([entry('enabled', null, 'watching 2 terminals')])).toContain('\t—\t');
    });
});

describe('filters', () => {
    it('Sent only and Problems select exactly their own kinds', () => {
        const rows = [
            entry('sent', 'tm-a'),
            entry('held', 'tm-a'),
            entry('failed', 'tm-a'),
            entry('check', 'tm-a'),
        ];
        expect(rows.filter((e) => passesFilter(e, 'all'))).toHaveLength(4);
        expect(rows.filter((e) => passesFilter(e, 'sent')).map((e) => e.kind)).toEqual(['sent']);
        expect(rows.filter((e) => passesFilter(e, 'problems')).map((e) => e.kind)).toEqual([
            'failed',
        ]);
    });
});

describe('mergeEntries', () => {
    it('drops duplicates by id, so an event and a fetch may overlap', () => {
        // The log subscribes BEFORE it fetches, so the two streams overlap by design.
        const a = entry('sent', 'tm-a');
        const merged = mergeEntries([a], [a, entry('held', 'tm-a')], false, 200);
        expect(merged.map((e) => e.id)).toEqual([1, 2]);
    });

    it('holds the buffer at the limit, keeping the NEWEST rows either way round', () => {
        const many = Array.from({ length: 250 }, () => entry('held', 'tm-a'));
        // Oldest-first still DISPLAYS ascending — it just starts at 51, not at 1.
        const asc = mergeEntries([], many, false, 200);
        expect(asc).toHaveLength(200);
        expect([asc[0].id, asc[199].id]).toEqual([51, 250]);

        const desc = mergeEntries([], many, true, 200);
        expect(desc).toHaveLength(200);
        expect([desc[0].id, desc[199].id]).toEqual([250, 51]);
    });

    it('still takes new rows once the buffer is ALREADY full', () => {
        // The case a single-shot fill can never reach, and the one that mattered: the log view is
        // always oldest-first, so a buffer holding the oldest 200 forever meant every `sent`,
        // `failed` and `re-armed` row after the buffer filled was discarded by the merge that
        // existed to add it. The view froze silently, holding rows the store had already pruned.
        const first = mergeEntries([], Array.from({ length: 200 }, () => entry('held', 'tm-a')), false, 200);
        expect(first[199].id).toBe(200);

        const arrival = entry('sent', 'tm-a', 'read 27 — 27 > 25');
        const after = mergeEntries(first, [arrival], false, 200);
        expect(after).toHaveLength(200);
        expect(after[199].id).toBe(arrival.id);
        expect(after.some((e) => e.kind === 'sent')).toBe(true);
        // And the oldest is the one that gave way, which is what the store does too.
        expect(after[0].id).toBe(2);
    });
});
