/**
 * The grammar table, ported from `src-tauri/src/automation_engine/subst.rs`'s own tests
 * (`the_grammar_table`, `tokens_used_reports_what_validation_must_check`, and the dedicated rows
 * for `${}`, `${1x}`, `$12` vs `${12}`) — restated here as "what tokens does the scanner find",
 * since this side never resolves a token, only reports it.
 *
 * `automationTokenCases.json` is read by both this suite and Rust's `subst.rs`, so a future edit
 * to only one scanner goes red on the side that changed.
 */
import fixture from '../__fixtures__/automationTokenCases.json';
import { previewSubstitute, tokensUsed } from '../automationTokens';
import type { PreviewPart, Token } from '../automationTokens';

const group = (n: number): Token => ({ kind: 'group', n, text: `$${n}` });
const named = (name: string): Token => ({ kind: 'named', name, text: `\${${name}}` });

interface FixtureCase {
    input: string;
    tokens: Array<{ kind: 'group'; n: number } | { kind: 'named'; name: string }>;
}

const cases = (fixture as unknown as { cases: FixtureCase[] }).cases;

describe('tokensUsed — the shared grammar fixture', () => {
    it('has not shrunk to nothing', () => {
        // Rust asserts the same floor. It is not exact, so adding a grammar case is one-file work.
        expect(cases.length).toBeGreaterThanOrEqual(17);
    });

    it.each(cases.map((testCase) => [testCase.input, testCase] as const))('%s', (_input, testCase) => {
        const want = testCase.tokens.map((token) =>
            token.kind === 'group' ? group(token.n) : named(token.name));
        expect(tokensUsed(testCase.input)).toEqual(want);
    });
});

/**
 * Milestone M1 review, Important 1: `sample === null` (no example to read at all) and
 * `sample = {}` (a real match where every declared group legitimately did not participate) are
 * two different facts, and `previewSubstitute` used to render them identically — `sample[key] ??
 * ''` turned "I have nothing" and "this optional group is empty" into the same empty string.
 * These pin the two apart, by the `parts` shape rather than a flattened string.
 */
describe('previewSubstitute — a null sample is not the same fact as an empty one', () => {
    const groups = { count: 1, names: new Set<string>() };
    const text = (s: string): PreviewPart => ({ kind: 'text', text: s });
    const placeholder = (token: string): PreviewPart => ({ kind: 'placeholder', token });

    it('resolves a declared group from a real (possibly empty) sample', () => {
        expect(previewSubstitute('fix $1', groups, { '1': '17' })).toEqual({
            ok: true,
            parts: [text('fix 17')],
        });
    });

    it('a declared group ABSENT from a real sample resolves to an empty string, not a placeholder', () => {
        // `{}` IS a real sample — group 1 exists in the pattern but did not participate in this
        // particular match, which plan 032 §4.4 says substitutes to the empty string.
        expect(previewSubstitute('fix $1 tests', groups, {})).toEqual({
            ok: true,
            parts: [text('fix  tests')],
        });
    });

    it('a null sample marks every in-range token as a PLACEHOLDER instead of resolving it', () => {
        expect(previewSubstitute('fix $1 tests', groups, null)).toEqual({
            ok: true,
            parts: [text('fix '), placeholder('$1'), text(' tests')],
        });
    });

    it('a null sample still refuses a token beyond the pattern, exactly like a real one', () => {
        expect(previewSubstitute('fix $9', groups, null)).toEqual({
            ok: false,
            badToken: '$9',
        });
    });

    it('a bare token with a null sample is a single placeholder part, with no empty text either side', () => {
        expect(previewSubstitute('$1', groups, null)).toEqual({
            ok: true,
            parts: [placeholder('$1')],
        });
    });
});
