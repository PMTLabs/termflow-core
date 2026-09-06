/**
 * Task 28 — one clause's verdict, and the shared fixture that pins it to the Rust mirror.
 *
 * `automation_engine/eval.rs` reads the same JSON through `include_str!` and asserts the same
 * answers, so a rule edited on one side and not the other goes red on the other. That is the only
 * thing that makes a second Kleene implementation survivable: the editor now draws a per-clause
 * verdict beside each row and the engine decides whether the rule fires, and two surfaces
 * describing one rule is the defect this milestone kept having to repair.
 *
 * This file also asserts what the fixture deliberately cannot: that every operator, every source
 * spelling and all three answers actually APPEAR in it. A fixture that covers whatever someone
 * remembered to add pins the two implementations only where they were already the same.
 */
import fixture from '../__fixtures__/automationClauseCases.json';
import type { AutomationClause } from '../../../types/electron';
import type { AutomationCompareOp, AutomationTextOp } from '../../../types/electron';
import { NUM_OP_LABELS, TEXT_OP_LABELS } from '../automationDerive';
import { clauseTruth, coerceNumber } from '../automationClauseTruth';
import type { Truth } from '../automationClauseTruth';

interface FixtureCase {
    name: string;
    why?: string;
    caps: Record<string, string>;
    clause: AutomationClause;
    expected: Truth;
}

const cases = (fixture as unknown as { cases: FixtureCase[] }).cases;

describe('automationClauseTruth — the shared fixture', () => {
    it('has not shrunk to nothing', () => {
        // A fixture with no cases passes every comparison by having nothing to compare. The Rust
        // side asserts the same floor.
        expect(cases.length).toBeGreaterThanOrEqual(40);
    });

    it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
        expect(clauseTruth(testCase.clause, testCase.caps)).toBe(testCase.expected);
    });

    it('covers every operator the editor can build', () => {
        // **DERIVED from the label tables, never hand-typed.** Both are `Record<Op, string>`, so a
        // new operator fails `tsc` on a missing key and then fails here for having no fixture case
        // — the one place a comparator cannot be added to both implementations unpinned.
        const textOps = new Set<string>();
        const numOps = new Set<string>();
        for (const c of cases) {
            if ('number' in c.clause.test) numOps.add(c.clause.test.number.op);
            else textOps.add(c.clause.test.text.op);
        }
        expect([...textOps].sort()).toEqual((Object.keys(TEXT_OP_LABELS) as AutomationTextOp[]).sort());
        expect([...numOps].sort()).toEqual((Object.keys(NUM_OP_LABELS) as AutomationCompareOp[]).sort());
    });

    it('covers every token spelling and all three answers', () => {
        const sources = new Set(
            cases.map((c) => (c.clause.source === 'whole'
                ? 'whole'
                : 'group' in c.clause.source ? 'group' : 'named')),
        );
        expect([...sources].sort()).toEqual(['group', 'named', 'whole']);
        // `unknown` is the one a reader gets wrong, so a fixture with no `unknown` case would be
        // pinning the two implementations everywhere except where they differ.
        expect([...new Set(cases.map((c) => c.expected))].sort()).toEqual(['false', 'true', 'unknown']);
    });
});

/**
 * `coerce` is the half of this that a bare `Number()` gets wrong, and the fixture reaches it only
 * through a clause. These are the same rules stated directly, so a failure names the coercion
 * rather than the comparison that used it.
 *
 * Rust is the authority: `raw.trim().parse::<f64>().ok().filter(|v| v.is_finite())`.
 */
describe('coerceNumber — Rust f64 parsing, not JavaScript Number', () => {
    it.each([
        ['63', 63],
        ['  42  ', 42],
        ['+1.5e2', 150],
        ['-4', -4],
        ['5.', 5],
        ['.5', 0.5],
    ])('reads %p as %p', (raw, want) => {
        expect(coerceNumber(raw as string)).toBe(want);
    });

    it.each([
        [''],
        ['   '],
        ['0x10'],
        ['1_000'],
        ['12a'],
        ['1e400'],
        ['Infinity'],
        ['inf'],
        ['nan'],
        ['.'],
        ['1,5'],
    ])('refuses %p', (raw) => {
        expect(coerceNumber(raw as string)).toBeNull();
    });
});
