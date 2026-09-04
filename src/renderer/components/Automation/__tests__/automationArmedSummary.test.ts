/**
 * `armedMenuLabel`'s exact words, at every count that changes them.
 *
 * That the two menus AGREE is already pinned in `automationArmedSurfaces.test.tsx`, which compares
 * the accordion's header text with the flyout parent's label for equality — so neither can be
 * renamed alone. What an agreement assertion cannot see is what the shared answer SAYS: it stays
 * green while both surfaces read `Automation` for two rules, or the empty string for none. The only
 * assertion that touched the wording was `not.toMatch(/\(0\)/)` on the zero case, and a mutant
 * returning `'Automation'`, `'Rules'` or `''` passes it. `Automations` against `Automation` is
 * precisely the drift this function was extracted to prevent, so the words are asserted literally
 * here rather than by pattern.
 */
import { armedMenuLabel } from '../automationArmedSummary';

describe('armedMenuLabel', () => {
    // A table over all three branches, plus one count past the plural's boundary so a mutant
    // cannot special-case `2` into passing.
    it.each<[number, string]>([
        [0, 'Automations'],
        [1, 'Automation'],
        [2, 'Automations (2)'],
        [5, 'Automations (5)'],
    ])('labels %i armed rules "%s"', (count, expected) => {
        expect(armedMenuLabel(count)).toBe(expected);
    });
});
