/**
 * plan/029 §7.1 — the seven enumeration sites in SettingsPage.tsx. A category
 * missed at even one of them is silently dead: it compiles, it type-checks, and it
 * simply never shows up (or, worse, crashes `snapshotCategory` at runtime while
 * `tsc` stays clean — the `isTracked` trap).
 *
 * Sites 1, 2 and 4 are read out of the union / the record / the array — real
 * source, not hand-copied here. Site 5 is the trap: a SECOND, hand-maintained copy
 * of the category union inside the deep-link `isCategory()` guard, the easiest of
 * the seven to forget when a category is added. This file derives all four sets
 * from source and asserts they are exactly equal, so both a missing entry and a
 * stray extra one fail — a test that only checks `'snippets' appears somewhere`
 * would pass even if site 5 (or any other site) silently drifted.
 */
import path from 'path';
import { readSource } from '../../../utils/readSource';

const SETTINGS = readSource(path.resolve(__dirname, '..', 'SettingsPage.tsx'));

/** Site 1: `type SettingsCategory = 'a' | 'b' | ...;` */
function siteUnion(): string[] {
    const m = /type SettingsCategory =([^;]+);/.exec(SETTINGS);
    if (!m) throw new Error('site 1 (SettingsCategory union) not found in source');
    return m[1]
        .split('|')
        .map((s) => s.trim().replace(/^'|'$/g, ''))
        .filter(Boolean);
}

/** Site 2: `const CATEGORY_LABELS: Record<SettingsCategory, string> = { ... };` */
function siteLabels(): string[] {
    const m = /const CATEGORY_LABELS: Record<SettingsCategory, string> = \{([\s\S]+?)\};/.exec(SETTINGS);
    if (!m) throw new Error('site 2 (CATEGORY_LABELS) not found in source');
    const keys = [...m[1].matchAll(/(\w+):\s*'/g)].map((mm) => mm[1]);
    if (keys.length === 0) throw new Error('site 2 matched zero keys — regex is broken, not the source');
    return keys;
}

/** Site 4: `const categories: {...}[] = [ { id: 'x', ... }, ... ];` */
function siteCategoriesArray(): string[] {
    const start = SETTINGS.indexOf('const categories: { id: SettingsCategory');
    if (start === -1) throw new Error('site 4 (categories array) not found in source');
    // Scoped to the array literal itself, not the whole rest of the file: cut at the
    // closing `];` that ends the `const categories = [...]` statement.
    const arrayEnd = SETTINGS.indexOf('\n    ];', start);
    if (arrayEnd === -1) throw new Error('site 4 array close `];` not found');
    const body = SETTINGS.slice(start, arrayEnd);
    const ids = [...body.matchAll(/id: '(\w+)'/g)].map((mm) => mm[1]);
    if (ids.length === 0) throw new Error('site 4 matched zero ids — regex is broken, not the source');
    return ids;
}

/** Site 5: the duplicate union inside the deep-link `isCategory()` guard. */
function siteDeepLinkUnion(): string[] {
    const start = SETTINGS.indexOf("const isCategory = (c: string): c is SettingsCategory =>");
    if (start === -1) throw new Error('site 5 (deep-link isCategory) not found in source');
    const end = SETTINGS.indexOf(';', start);
    const body = SETTINGS.slice(start, end);
    const ids = [...body.matchAll(/c === '(\w+)'/g)].map((mm) => mm[1]);
    if (ids.length === 0) throw new Error('site 5 matched zero ids — regex is broken, not the source');
    return ids;
}

const sorted = (a: string[]) => [...a].sort();

describe('SettingsPage category enumeration sites (plan/029 §7.1)', () => {
    it('found real, non-empty sets at all four source-derived sites', () => {
        // Guards against every helper above passing vacuously against an empty match.
        expect(siteUnion().length).toBeGreaterThan(5);
        expect(siteLabels().length).toBeGreaterThan(5);
        expect(siteCategoriesArray().length).toBeGreaterThan(5);
        expect(siteDeepLinkUnion().length).toBeGreaterThan(5);
    });

    it('site 2 (CATEGORY_LABELS) agrees with site 1 (the union)', () => {
        expect(sorted(siteLabels())).toEqual(sorted(siteUnion()));
    });

    it('site 4 (categories array ids) agrees with site 1 (the union)', () => {
        expect(sorted(siteCategoriesArray())).toEqual(sorted(siteUnion()));
    });

    it('site 5 (deep-link isCategory, the easiest to drift) agrees with site 1 (the union)', () => {
        expect(sorted(siteDeepLinkUnion())).toEqual(sorted(siteUnion()));
    });

    it("includes 'snippets' at every site (plan/029)", () => {
        expect(siteUnion()).toContain('snippets');
        expect(siteLabels()).toContain('snippets');
        expect(siteCategoriesArray()).toContain('snippets');
        expect(siteDeepLinkUnion()).toContain('snippets');
    });

    // Mutation-check for the isTracked exclusion (§7.1): "Snippets persists per
    // mutation and has no Save button, so it must be excluded". Deleting the clause
    // must turn this test red.
    it("isTracked() excludes 'snippets' (site 3)", () => {
        const m = /const isTracked = \(c: SettingsCategory\): c is TrackedCategory =>([\s\S]+?);/.exec(SETTINGS);
        if (!m) throw new Error('site 3 (isTracked) not found in source');
        expect(m[1]).toContain("c !== 'snippets'");
    });

    it('renderActiveCategory() (site 6) has a case for snippets', () => {
        expect(SETTINGS).toMatch(/case 'snippets': return <SnippetsPanel/);
    });
});
