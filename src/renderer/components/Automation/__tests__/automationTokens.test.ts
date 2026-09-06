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
import { tokensUsed } from '../automationTokens';
import type { Token } from '../automationTokens';

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
