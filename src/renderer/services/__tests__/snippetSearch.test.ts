import {
  parseSnippetQuery,
  filterSnippets,
  rankSnippet,
  snippetDisplayLabel,
  snippetFolders,
  allSnippetTags,
} from '../snippetSearch';
import type { Snippet } from '../../store/slices/settingsSlice';

function s(partial: Partial<Snippet> & { id: string; text: string; createdAt: number }): Snippet {
  return { ...partial };
}

describe('parseSnippetQuery', () => {
  const cases: Array<[string, { tags: string[]; words: string[] }]> = [
    ['', { tags: [], words: [] }],
    ['   ', { tags: [], words: [] }],
    ['git', { tags: [], words: ['git'] }],
    ['#docker', { tags: ['docker'], words: [] }],
    ['#Docker restart', { tags: ['docker'], words: ['restart'] }],
    ['restart #docker', { tags: ['docker'], words: ['restart'] }],
    ['#docker #docker', { tags: ['docker'], words: [] }], // repeated tag collapses
    ['#docker #git build up', { tags: ['docker', 'git'], words: ['build', 'up'] }],
    ['#', { tags: [], words: [] }], // bare # dropped
    ['# git', { tags: [], words: ['git'] }],
    ['GIT STATUS', { tags: [], words: ['git', 'status'] }], // case-insensitive
  ];

  it.each(cases)('parses %j', (query, expected) => {
    expect(parseSnippetQuery(query)).toEqual(expected);
  });
});

describe('filterSnippets', () => {
  const base = { text: 'some body text', createdAt: 0 };

  it('empty query returns everything, unfiltered, in input order', () => {
    const items = [s({ id: 'a', ...base }), s({ id: 'b', ...base }), s({ id: 'c', ...base })];
    expect(filterSnippets(items, '').map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(filterSnippets(items, '   ').map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('word-only query matches label or text', () => {
    const items = [
      s({ id: 'a', label: 'Deploy prod', text: 'irrelevant', createdAt: 0 }),
      s({ id: 'b', text: 'kubectl deploy staging', createdAt: 0 }),
      s({ id: 'c', text: 'nothing here', createdAt: 0 }),
    ];
    expect(filterSnippets(items, 'deploy').map((x) => x.id).sort()).toEqual(['a', 'b']);
  });

  it('#tag only filters by tag, ignoring text/label content', () => {
    const items = [
      s({ id: 'a', text: 'x', tags: ['git'], createdAt: 0 }),
      s({ id: 'b', text: 'y', tags: ['docker'], createdAt: 0 }),
      s({ id: 'c', text: 'z', createdAt: 0 }),
    ];
    expect(filterSnippets(items, '#git').map((x) => x.id)).toEqual(['a']);
  });

  it('#tag plus words requires both', () => {
    const items = [
      s({ id: 'a', text: 'deploy now', tags: ['git'], createdAt: 0 }),
      s({ id: 'b', text: 'deploy now', tags: ['docker'], createdAt: 0 }),
      s({ id: 'c', text: 'nothing', tags: ['git'], createdAt: 0 }),
    ];
    expect(filterSnippets(items, '#git deploy').map((x) => x.id)).toEqual(['a']);
  });

  it('two tags require AND, not OR', () => {
    const items = [
      s({ id: 'a', text: 'x', tags: ['git', 'docker'], createdAt: 0 }),
      s({ id: 'b', text: 'x', tags: ['git'], createdAt: 0 }),
      s({ id: 'c', text: 'x', tags: ['docker'], createdAt: 0 }),
    ];
    expect(filterSnippets(items, '#git #docker').map((x) => x.id)).toEqual(['a']);
  });

  it('a tag that matches nothing returns empty', () => {
    const items = [s({ id: 'a', text: 'x', tags: ['git'], createdAt: 0 })];
    expect(filterSnippets(items, '#nope')).toEqual([]);
  });

  it('is case-insensitive for both tags and words', () => {
    const items = [s({ id: 'a', label: 'Deploy Prod', text: 'x', tags: ['Docker'], createdAt: 0 })];
    expect(filterSnippets(items, '#DOCKER deploy').map((x) => x.id)).toEqual(['a']);
    expect(filterSnippets(items, '#docker DEPLOY').map((x) => x.id)).toEqual(['a']);
  });

  it('ranks label-prefix > label-substring > text-substring', () => {
    const items = [
      s({ id: 'text-only', text: 'this has deploy inside', createdAt: 0 }),
      s({ id: 'label-substr', label: 'the deploy script', text: 'x', createdAt: 0 }),
      s({ id: 'label-prefix', label: 'deploy script', text: 'x', createdAt: 0 }),
    ];
    expect(filterSnippets(items, 'deploy').map((x) => x.id)).toEqual([
      'label-prefix',
      'label-substr',
      'text-only',
    ]);
  });

  it('ties within the same rank break by createdAt descending', () => {
    const items = [
      s({ id: 'old', label: 'deploy old', text: 'x', createdAt: 100 }),
      s({ id: 'new', label: 'deploy new', text: 'x', createdAt: 300 }),
      s({ id: 'mid', label: 'deploy mid', text: 'x', createdAt: 200 }),
    ];
    expect(filterSnippets(items, 'deploy').map((x) => x.id)).toEqual(['new', 'mid', 'old']);
  });

  it('rankSnippet is directly testable per tier', () => {
    // One assertion per rung of plan/030 §3's ladder. Every fixture is built so that only
    // ONE rung can fire: the rungs above it are checked in order and must all miss, or the
    // assertion would pass for the wrong reason.
    expect(rankSnippet(s({ id: 'a', label: 'deploy x', text: 'y', createdAt: 0 }), ['deploy'])).toBe(0);
    expect(rankSnippet(s({ id: 'a', label: 'x deploy', text: 'y', createdAt: 0 }), ['deploy'])).toBe(1);
    expect(rankSnippet(s({ id: 'a', label: 'x', text: 'y deploy', createdAt: 0 }), ['deploy'])).toBe(2);
    // Rung 3 — tag only. 'deploy' appears in neither 'x' nor 'y'.
    expect(
      rankSnippet(s({ id: 'a', label: 'x', text: 'y', tags: ['deploy'], createdAt: 0 }), ['deploy']),
    ).toBe(3);
    // Rung 4 — initials only. 'ch' is not a substring of 'context handoff' (the two
    // letters are not adjacent there), so rungs 0-2 genuinely miss before this fires.
    expect(rankSnippet(s({ id: 'a', text: 'context handoff', createdAt: 0 }), ['ch'])).toBe(4);
    // Rung 5 — nothing matched, and the empty-words case that shares the sentinel.
    expect(rankSnippet(s({ id: 'a', label: 'x', text: 'y', createdAt: 0 }), ['zzz'])).toBe(5);
    expect(rankSnippet(s({ id: 'a', text: 'y', createdAt: 0 }), [])).toBe(5);
  });

  it('a better rung on ANY word wins, even when another word matched worse', () => {
    // rankSnippet takes the MINIMUM across words. A mutant using the last word's tier, or
    // the maximum, returns 4 here instead of 0.
    const item = s({ id: 'a', label: 'deploy prod', text: 'context handoff', createdAt: 0 });
    expect(rankSnippet(item, ['deploy', 'ch'])).toBe(0);
    expect(rankSnippet(item, ['ch', 'deploy'])).toBe(0);
  });
});

describe('filterSnippets — initials and tag matching (plan/030 P0)', () => {
  const handoff = s({ id: 'h', text: 'run the context handoff now', createdAt: 10 });
  const other = s({ id: 'o', text: 'restart the database', createdAt: 20 });
  const items = [handoff, other];

  // The two acceptance criteria, stated as they were written.
  it('AC: a snippet containing "context handoff" is found by "context"', () => {
    expect(filterSnippets(items, 'context').map((x) => x.id)).toEqual(['h']);
  });

  it('AC: the same snippet is found by its initials "ch"', () => {
    expect(filterSnippets(items, 'ch').map((x) => x.id)).toEqual(['h']);
  });

  it('AC: a query matching no field at all returns nothing', () => {
    expect(filterSnippets(items, 'zzz')).toEqual([]);
    // 'hc' is 'ch' reversed — the initials run is contiguous and ORDERED, so this must
    // miss. Without that, initials matching would degenerate into "contains these letters".
    expect(filterSnippets(items, 'hc')).toEqual([]);
  });

  it('AC: clearing the query restores the unfiltered list, in input order', () => {
    expect(filterSnippets(items, '').map((x) => x.id)).toEqual(['h', 'o']);
  });

  it('initials must be CONTIGUOUS words, not any two words that happen to start c and h', () => {
    // 'copy the handoff' has initials 'cth'. A substring test on 'ch' correctly misses;
    // a SUBSEQUENCE test would wrongly match, which is the whole difference between
    // "initials" and "contains these letters in order".
    //
    // The body deliberately contains no literal 'ch' either — 'check the handoff' would
    // have matched at rung 2 via the word 'check' and proved nothing about rung 4.
    const spaced = s({ id: 'sp', text: 'copy the handoff', createdAt: 0 });
    expect(spaced.text).not.toContain('ch'); // the fixture's own premise, pinned
    expect(filterSnippets([spaced], 'ch')).toEqual([]);
  });

  it('initials are found mid-body, not only at the start', () => {
    const buried = s({ id: 'b', text: 'first line\nplease do a context handoff now', createdAt: 0 });
    expect(filterSnippets([buried], 'ch').map((x) => x.id)).toEqual(['b']);
  });

  it('initials match the label as well as the text', () => {
    const labelled = s({ id: 'l', label: 'context handoff', text: 'irrelevant body', createdAt: 0 });
    expect(filterSnippets([labelled], 'ch').map((x) => x.id)).toEqual(['l']);
  });

  it('initials do NOT run across the label/text seam', () => {
    // label 'Cat' -> 'c', text 'house' -> 'h'. Joining the two fields before taking
    // initials would make this answer to 'ch'; indexing them separately must not.
    const seam = s({ id: 'seam', label: 'Cat', text: 'house', createdAt: 0 });
    expect(filterSnippets([seam], 'ch')).toEqual([]);
  });

  it('punctuation splits words, so a hyphenated phrase still yields its initials', () => {
    const hyphen = s({ id: 'hy', text: 'context-handoff', createdAt: 0 });
    expect(filterSnippets([hyphen], 'ch').map((x) => x.id)).toEqual(['hy']);
  });

  it('a mark INSIDE a word does not split it, even where NFC cannot compose it', () => {
    // 'q\u0308uick handoff' - q followed by a combining diaeresis. NO precomposed character
    // for that pair exists, so normalising cannot rescue it and the \p{M} continuation
    // class is the only thing holding the word together. Without it the mark reads as a
    // separator, the word becomes 'q' + 'uick', and the initials are 'quh' not 'qh'.
    //
    // Deliberately NOT 'naive-with-diaeresis': that one DOES compose, so normalize('NFC')
    // alone would rescue it and this test would still pass with \p{M} deleted - pinning
    // nothing. The fixture has to be a sequence normalisation cannot reach.
    const marked = s({ id: 'm', text: 'q\u0308uick handoff', createdAt: 0 });
    expect(marked.text.normalize('NFC')).toHaveLength(marked.text.length); // NFC can't compose it
    expect(filterSnippets([marked], 'qh').map((x) => x.id)).toEqual(['m']);
    expect(filterSnippets([marked], 'qu')).toEqual([]);
  });

  it('the same phrase searches the same however it is encoded', () => {
    // The other half of the class, and \p{M} does NOT help here: a mark on a word's
    // FIRST letter is skipped by codePointAt(0), which takes the base letter. Decomposed
    // 'Ecole-with-acute' therefore starts 'e' while the composed spelling starts '\u00e9'.
    // Same visible phrase, different initials, and a query that finds one and misses the
    // other. normalize('NFC') on the haystack is what makes these two rows agree.
    const nfc = s({ id: 'nfc', text: '\u00c9cole handoff', createdAt: 0 });
    const nfd = s({ id: 'nfd', text: 'E\u0301cole handoff', createdAt: 0 });
    expect(nfc.text).not.toBe(nfd.text); // genuinely different bytes...
    expect(nfc.text.normalize('NFC')).toBe(nfd.text.normalize('NFC')); // ...same phrase
    expect(filterSnippets([nfc], '\u00e9h').map((x) => x.id)).toEqual(['nfc']);
    expect(filterSnippets([nfd], '\u00e9h').map((x) => x.id)).toEqual(['nfd']);
  });

  it('a decomposed QUERY matches too - both sides are normalised, or neither', () => {
    // Needle-side half of the same class. Pasting an accented query from a document can
    // hand us 'e' + U+0301; the initials hold '\u00e9', so without normalising the needle
    // this misses while the identical-looking composed query hits.
    const item = s({ id: 'e', text: '\u00c9cole handoff', createdAt: 0 });
    expect(filterSnippets([item], 'e\u0301h').map((x) => x.id)).toEqual(['e']);
  });

  it('a text of only punctuation has no initials and matches nothing', () => {
    const punct = s({ id: 'p', text: '--- ... ---', createdAt: 0 });
    expect(filterSnippets([punct], 'ab')).toEqual([]);
  });

  it('a case-equivalent query matches whichever case is typed (U+0130 expands on lowercase)', () => {
    // 'İ' (U+0130) lower-cases to 'i' + U+0307 — a lowercase EXPANSION, which NFC cannot
    // recompose because no precomposed 'i with dot above' exists. The haystack's initial
    // is the bare 'i' (codePointAt(0) of the token), so a needle that keeps the combining
    // dot could never match it: 'ih' found this snippet and 'İH' did not, for the same
    // word in the same case-insensitive search. NFC alone does not catch it — the É/é
    // fixtures below pass either way, which is why this one has to exist.
    const item = s({ id: 'ist', text: 'İstanbul Handoff', createdAt: 0 });
    expect(item.text.toLowerCase()).not.toContain('ih'); // so only the initials rung can fire
    expect(filterSnippets([item], 'ih').map((x) => x.id)).toEqual(['ist']);
    expect(filterSnippets([item], 'İH').map((x) => x.id)).toEqual(['ist']);
  });

  it('initials scan only the head of a long body — substring still reaches the rest', () => {
    // The scan limit is a bound on a cost that is otherwise O(total library bytes) on one
    // keystroke. Nothing becomes unfindable: the phrase past the cap is still found by
    // typing the phrase, which is what this pins.
    const filler = 'x '.repeat(1200); // 2400 chars, past INITIALS_SCAN_LIMIT
    const buried = s({ id: 'b', text: filler + 'context handoff', createdAt: 0 });
    expect(buried.text.indexOf('context handoff')).toBeGreaterThan(2000);
    expect(filterSnippets([buried], 'ch')).toEqual([]);
    expect(filterSnippets([buried], 'context').map((x) => x.id)).toEqual(['b']);
  });

  it('a bare word matches PART of a tag, not merely the whole tag', () => {
    // Every other tag fixture queries the COMPLETE tag, so `tag === word` passes them all
    // and the promised substring behaviour goes unpinned.
    const tagged = s({ id: 'part', text: 'echo hello', tags: ['InkSpoke'], createdAt: 0 });
    expect(filterSnippets([tagged], 'ink').map((x) => x.id)).toEqual(['part']);
  });

  it('a bare word matches a tag, so an import source tag is findable by name', () => {
    const tagged = s({ id: 't', text: 'echo hello', tags: ['InkSpoke'], createdAt: 0 });
    const untagged = s({ id: 'u', text: 'echo hello there', createdAt: 0 });
    expect(filterSnippets([tagged, untagged], 'inkspoke').map((x) => x.id)).toEqual(['t']);
  });

  it('a tag match ranks BELOW a text match, not above it', () => {
    const byText = s({ id: 'by-text', text: 'deploy the thing', createdAt: 0 });
    const byTag = s({ id: 'by-tag', text: 'unrelated', tags: ['deploy'], createdAt: 0 });
    expect(filterSnippets([byTag, byText], 'deploy').map((x) => x.id)).toEqual(['by-text', 'by-tag']);
  });

  it('an initials match ranks BELOW every substring match', () => {
    const byInitials = s({ id: 'by-initials', text: 'context handoff', createdAt: 0 });
    const byText = s({ id: 'by-text', text: 'the ch marker', createdAt: 0 });
    expect(filterSnippets([byInitials, byText], 'ch').map((x) => x.id)).toEqual([
      'by-text',
      'by-initials',
    ]);
  });

  it('orders the two NEW rungs against each other: tag beats initials', () => {
    // The adjacent pair. Every other ordering test pits a new rung against an OLD one, so
    // swapping rungs 3 and 4 with each other would leave them all green.
    const byTag = s({ id: 'by-tag', text: 'unrelated body', tags: ['ch'], createdAt: 0 });
    const byInitials = s({ id: 'by-initials', text: 'context handoff', createdAt: 0 });
    expect(filterSnippets([byInitials, byTag], 'ch').map((x) => x.id)).toEqual([
      'by-tag',
      'by-initials',
    ]);
    // ...and directly, so the ladder's numbers are pinned and not just their order.
    expect(rankSnippet(byTag, ['ch'])).toBe(3);
    expect(rankSnippet(byInitials, ['ch'])).toBe(4);
  });

  it('multiple words still AND together across the widened rungs', () => {
    // 'ch' by initials AND 'database' by text — only the snippet with both survives.
    const both = s({ id: 'both', text: 'context handoff for the database', createdAt: 0 });
    const onlyOne = s({ id: 'one', text: 'context handoff for the cache', createdAt: 0 });
    expect(filterSnippets([both, onlyOne], 'ch database').map((x) => x.id)).toEqual(['both']);
  });

  it('never serves a stale or query-contaminated initials result', () => {
    // Named for what it actually pins. It does NOT prove the WeakMap is consulted — an
    // implementation with no cache at all passes every line below, and that is fine,
    // because caching is a performance choice whose only behavioural contract is
    // "indistinguishable from not caching". These are the ways a cache could break that
    // contract: drifting between passes, keying on the query, or outliving its subject.
    expect(filterSnippets(items, 'ch').map((x) => x.id)).toEqual(['h']);
    expect(filterSnippets(items, 'ch').map((x) => x.id)).toEqual(['h']);
    // A different query in between must not poison the entry.
    expect(filterSnippets(items, 'zzz')).toEqual([]);
    expect(filterSnippets(items, 'ch').map((x) => x.id)).toEqual(['h']);
    // An edited snippet is a NEW object, so it must be re-derived rather than served the
    // old text's initials. This is the one that would fail if the cache were keyed on
    // something stable across an edit, such as the snippet's id.
    const edited = { ...handoff, id: handoff.id, text: 'restart the database' };
    expect(filterSnippets([edited], 'ch')).toEqual([]);
    expect(filterSnippets([edited], 'rtd').map((x) => x.id)).toEqual(['h']);
  });
});

describe('snippetDisplayLabel', () => {
  it('uses label when non-blank', () => {
    expect(snippetDisplayLabel(s({ id: 'a', label: 'My Label', text: 'ignored', createdAt: 0 }))).toBe(
      'My Label',
    );
  });

  it('falls back to first line of text when label is blank/absent', () => {
    expect(snippetDisplayLabel(s({ id: 'a', label: '  ', text: 'first line\nsecond', createdAt: 0 }))).toBe(
      'first line',
    );
    expect(snippetDisplayLabel(s({ id: 'a', text: 'first line\nsecond', createdAt: 0 }))).toBe('first line');
  });

  it('skips leading blank lines to find the first real line', () => {
    expect(snippetDisplayLabel(s({ id: 'a', text: '\n\n  \nreal first', createdAt: 0 }))).toBe(
      'real first',
    );
  });

  it('truncates a very long first line with an ellipsis, cap ~60 chars', () => {
    const longLine = 'x'.repeat(120);
    const out = snippetDisplayLabel(s({ id: 'a', text: longLine, createdAt: 0 }));
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back to the "(empty snippet)" placeholder for whitespace-only text', () => {
    // B-06: `not.toBe('')` also passes for `' '` or the literal string `'undefined'` —
    // neither is what the implementation actually returns for an empty snippet.
    expect(snippetDisplayLabel(s({ id: 'a', text: '   \n  \n\t', createdAt: 0 }))).toBe('(empty snippet)');
    expect(snippetDisplayLabel(s({ id: 'a', text: '', createdAt: 0 }))).toBe('(empty snippet)');
  });
});

describe('snippetFolders', () => {
  it('excludes unfiled (absent or empty string) and de-duplicates, sorted', () => {
    const items = [
      s({ id: 'a', text: 'x', folder: 'Git', createdAt: 0 }),
      s({ id: 'b', text: 'x', folder: 'Docker', createdAt: 0 }),
      s({ id: 'c', text: 'x', folder: 'Git', createdAt: 0 }),
      s({ id: 'd', text: 'x', folder: '', createdAt: 0 }),
      s({ id: 'e', text: 'x', createdAt: 0 }),
    ];
    expect(snippetFolders(items)).toEqual(['Docker', 'Git']);
  });

  it('empty input returns empty list', () => {
    expect(snippetFolders([])).toEqual([]);
  });
});

describe('allSnippetTags', () => {
  it('de-duplicates and sorts across all items', () => {
    const items = [
      s({ id: 'a', text: 'x', tags: ['git', 'ci'], createdAt: 0 }),
      s({ id: 'b', text: 'x', tags: ['docker'], createdAt: 0 }),
      s({ id: 'c', text: 'x', tags: ['git'], createdAt: 0 }),
      s({ id: 'd', text: 'x', createdAt: 0 }),
    ];
    expect(allSnippetTags(items)).toEqual(['ci', 'docker', 'git']);
  });

  it('empty input returns empty list', () => {
    expect(allSnippetTags([])).toEqual([]);
  });
});
