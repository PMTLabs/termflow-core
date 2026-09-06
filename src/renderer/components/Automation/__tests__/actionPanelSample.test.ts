/**
 * A direct test for `sampleFromPattern` (`ActionPanel.tsx`) — milestone M1 review, Important 1.
 *
 * This is the ONLY sample source in production: `AuInspector.tsx` passes no `sample` prop, and
 * every existing `ActionPanel` test pins a literal one instead, so before this file this function
 * ran for every real user and was asserted nowhere.
 *
 * The bug it pins: `sampleFromPattern` used to return `{}` whenever it had nothing to derive a
 * worked example from — indistinguishable, at `previewSubstitute`, from a pattern that DOES have a
 * real match where a declared group legitimately did not participate. `sayPattern` is a
 * best-effort paraphraser over a fixed vocabulary that returns `null` for anything outside it, and
 * `\S` is not on that list (`\s` is) — so the plan's own flagship example,
 * `FAILED (\d+) tests in (\S+)`, produced no worked example at all, and every token in the preview
 * silently rendered as an empty string for a message that would actually type real values.
 */
import { sampleFromPattern } from '../panels/ActionPanel';

describe('sampleFromPattern', () => {
    it("derives every declared group from the pattern's own worked example", () => {
        // The percentage preset's own shape — `sayPattern` can word it, and its worked example
        // (`63%`) actually matches.
        const sample = sampleFromPattern('(\\d+)%', 'brackets');
        expect(sample).not.toBeNull();
        expect(sample!['0']).toMatch(/^\d+%$/);
        expect(sample!['1']).toMatch(/^\d+$/);
    });

    it('derives a NAMED group the same way as a numbered one', () => {
        const sample = sampleFromPattern('(\\w+):(?<value>\\d+)', 'brackets');
        expect(sample).not.toBeNull();
        expect(sample!.value).toMatch(/^\d+$/);
        expect(sample!['1']).toMatch(/^\w+$/);
    });

    it('returns null — not {} — for a pattern sayPattern cannot paraphrase', () => {
        // The plan's own flagship example (§1.1/§4.4). `\S` is not in `sayPattern`'s escape table
        // (`\s` is), so `sayPattern` bails with `null` and there is nothing to run the pattern
        // against. `null` here — as opposed to `{}` — is what lets `previewSubstitute` tell "no
        // sample at all" apart from "declared, but legitimately empty".
        const sample = sampleFromPattern('FAILED (\\d+) tests in (\\S+)', 'brackets');
        expect(sample).toBeNull();
    });

    it('returns null for a pattern that does not compile', () => {
        expect(sampleFromPattern('(unterminated', 'brackets')).toBeNull();
    });

    it('returns null for an empty pattern', () => {
        expect(sampleFromPattern('', 'brackets')).toBeNull();
    });
});
