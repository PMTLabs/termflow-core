/**
 * The grammar table, ported from `src-tauri/src/automation_engine/subst.rs`'s own tests
 * (`the_grammar_table`, `tokens_used_reports_what_validation_must_check`, and the dedicated rows
 * for `${}`, `${1x}`, `$12` vs `${12}`) — restated here as "what tokens does the scanner find",
 * since this side never resolves a token, only reports it.
 *
 * This is the mechanism that keeps the two scanners agreeing: there is no shared JSON fixture for
 * the grammar itself (unlike `automationValidationCases.json`), so the same table, hand-copied to
 * both languages, is what a future edit to one side's `scan` has to also break here to go
 * unnoticed.
 */
import { previewSubstitute, tokensUsed } from '../automationTokens';
import type { PreviewPart, Token } from '../automationTokens';

const group = (n: number): Token => ({ kind: 'group', n, text: `$${n}` });
const named = (name: string): Token => ({ kind: 'named', name, text: `\${${name}}` });

describe('tokensUsed — the shared grammar table', () => {
    const table: Array<[string, Token[]]> = [
        ['plain text', []],
        ['$0', [group(0)]],
        ['$1', [group(1)]],
        ['fix $1 in $2', [group(1), group(2)]],
        ['${file}', [named('file')]],
        ['$$1', []], // escaped: NOT a token
        ['$$', []],
        ['cost $5', [group(5)]],
        ['$x', []], // `$` before a non-token is literal
        ['$', []], // trailing `$` is literal
        ['a$1b', [group(1)]], // no delimiter needed
        ['cost ${} here', []], // empty braces name nothing: literal text
        ['${1x}', [named('1x')]], // not purely digits -> a named lookup
        ['$12', [group(1)]], // ONE digit; the `2` is a literal, not part of the token
        ['${12}', [group(12)]], // braces -> two-digit group
        ['fix $1 in ${file}, not $$1 and not $x', [group(1), named('file')]],
    ];

    it.each(table)('%s', (input, want) => {
        expect(tokensUsed(input)).toEqual(want);
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
