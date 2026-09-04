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
    expect(rankSnippet(s({ id: 'a', label: 'deploy x', text: 'y', createdAt: 0 }), ['deploy'])).toBe(0);
    expect(rankSnippet(s({ id: 'a', label: 'x deploy', text: 'y', createdAt: 0 }), ['deploy'])).toBe(1);
    expect(rankSnippet(s({ id: 'a', label: 'x', text: 'y deploy', createdAt: 0 }), ['deploy'])).toBe(2);
    expect(rankSnippet(s({ id: 'a', text: 'y', createdAt: 0 }), [])).toBe(3);
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

  it('never returns an empty string for whitespace-only text', () => {
    expect(snippetDisplayLabel(s({ id: 'a', text: '   \n  \n\t', createdAt: 0 }))).not.toBe('');
    expect(snippetDisplayLabel(s({ id: 'a', text: '', createdAt: 0 }))).not.toBe('');
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
