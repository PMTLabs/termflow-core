// Plan 029 §4.6 — pure search/ranking module for the Snippets flyout submenu.
// No DOM, no Redux: everything here is exhaustively unit-testable data-in/data-out.

import type { Snippet } from '../store/slices/settingsSlice';

const DISPLAY_LABEL_MAX = 60;

/** Split a raw query into `#tag` filters and remaining search words. Case-insensitive:
 *  both tags and words are lower-cased on the way out so callers never need to. A bare
 *  `#` (no tag text) is dropped rather than treated as a filter or a word. Repeated tags
 *  collapse (order of first occurrence kept); word order is preserved as typed. */
export function parseSnippetQuery(query: string): { tags: string[]; words: string[] } {
  const tags: string[] = [];
  const words: string[] = [];
  const seenTags = new Set<string>();
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (token.startsWith('#')) {
      const tag = token.slice(1).toLowerCase();
      if (tag && !seenTags.has(tag)) {
        seenTags.add(tag);
        tags.push(tag);
      }
    } else {
      words.push(token.toLowerCase());
    }
  }
  return { tags, words };
}

/** Rank tier for a single snippet against parsed words (lower is better): 0 = label
 *  starts with a word, 1 = label contains a word, 2 = only the text contains a word,
 *  3 = no word match (only relevant when `words` is empty, i.e. tag-only/empty query). */
export function rankSnippet(s: Snippet, words: string[]): number {
  if (words.length === 0) return 3;
  const label = (s.label ?? '').toLowerCase();
  const text = s.text.toLowerCase();
  let bestTier = 3;
  for (const w of words) {
    let tier: number;
    if (label.startsWith(w)) tier = 0;
    else if (label.includes(w)) tier = 1;
    else if (text.includes(w)) tier = 2;
    else continue; // this word doesn't match at all — matchesWords() already excluded it
    if (tier < bestTier) bestTier = tier;
  }
  return bestTier;
}

function matchesAllTags(s: Snippet, tags: string[]): boolean {
  if (tags.length === 0) return true;
  const itemTags = (s.tags ?? []).map((t) => t.toLowerCase());
  return tags.every((t) => itemTags.includes(t));
}

function matchesAllWords(s: Snippet, words: string[]): boolean {
  if (words.length === 0) return true;
  const label = (s.label ?? '').toLowerCase();
  const text = s.text.toLowerCase();
  return words.every((w) => label.includes(w) || text.includes(w));
}

/** Filter + rank snippets against a raw query. Every parsed tag must be present (AND);
 *  every parsed word must appear in `label` or `text` (AND). Empty query (no tags, no
 *  words) returns every snippet, unfiltered, in input order. Ranking: label-prefix >
 *  label-substring > text-substring, ties broken by `createdAt` descending. */
export function filterSnippets(snippets: Snippet[], query: string): Snippet[] {
  const { tags, words } = parseSnippetQuery(query);
  if (tags.length === 0 && words.length === 0) return [...snippets];

  const matched = snippets.filter((s) => matchesAllTags(s, tags) && matchesAllWords(s, words));
  return matched
    .map((s, index) => ({ s, index, tier: rankSnippet(s, words) }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.s.createdAt !== b.s.createdAt) return b.s.createdAt - a.s.createdAt; // newest first
      return a.index - b.index; // stable
    })
    .map((r) => r.s);
}

/** Menu-row label: the snippet's own `label` when non-blank, else the first non-empty
 *  line of `text`, truncated to ~60 chars with an ellipsis. Never returns '' — a
 *  whitespace-only/empty `text` falls back to a placeholder. */
export function snippetDisplayLabel(s: Snippet): string {
  const label = s.label?.trim();
  if (label) return label;

  const firstLine = s.text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
  if (!firstLine) return '(empty snippet)';
  if (firstLine.length <= DISPLAY_LABEL_MAX) return firstLine;
  return firstLine.slice(0, DISPLAY_LABEL_MAX - 1).trimEnd() + '…';
}

/** Derived, de-duplicated, sorted folder vocabulary. Absent/'' folder is "unfiled" and
 *  is excluded — there is no folder registry (D6), only what items currently carry. */
export function snippetFolders(snippets: Snippet[]): string[] {
  const set = new Set<string>();
  for (const s of snippets) {
    const f = s.folder?.trim();
    if (f) set.add(f);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Derived, de-duplicated, sorted tag vocabulary across all snippets (§4.6 — no tag
 *  registry, items are the only source of truth). */
export function allSnippetTags(snippets: Snippet[]): string[] {
  const set = new Set<string>();
  for (const s of snippets) {
    for (const t of s.tags ?? []) {
      const trimmed = t.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
