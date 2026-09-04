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

/** The rung meaning "this word matched nothing". One past the last real tier, so adding a
 *  tier is a single-line change here rather than a hunt for scattered `3`s. */
const NO_MATCH_TIER = 5;

/**
 * Shortest query word that may match by initials (plan/030 D2) — a pure short-circuit,
 * NOT a filter, and the distinction is worth stating because it is easy to mis-test.
 *
 * Every character of a field's initials is by construction also a character OF that
 * field, so a one-letter word that matches the initials necessarily matches the field as
 * a substring too, and `wordTier` has already returned rung 2 or better before it ever
 * reaches `matchesInitials`. Dropping this constant changes no result anywhere; it only
 * saves computing (and caching) the initials of a whole library on a single keystroke.
 * Do not write a test asserting it changes what comes back — such a test passes vacuously.
 */
const MIN_INITIALS_QUERY_LENGTH = 2;

/**
 * First character of every word in `s`, joined: `'context handoff'` → `'ch'`, and
 * `'please do a context handoff now'` → `'pdachn'`. A "word" starts with a letter or a
 * digit and continues through letters, digits and COMBINING MARKS, so punctuation splits
 * the way a reader would expect (`context-handoff` is two words, not one).
 *
 * The `\p{M}` in the continuation class is load-bearing, not decoration. Without it a
 * decomposed (NFD) string breaks mid-word: `'naïve handoff'` written as `n a i ◌̈ v e` has
 * its combining diaeresis treated as a separator, splitting `naïve` into `nai` + `ve` and
 * yielding `nvh` where the reader plainly means `nh`. Text arrives decomposed from macOS
 * filesystems and from some clipboards, so this is a real input, not a hypothetical one.
 * A mark can never START a word, which is why the first class excludes it.
 *
 * `codePointAt` rather than `[0]` so an astral first letter survives as one character
 * instead of half a surrogate pair.
 *
 * Scripts written without spaces (Chinese, Japanese) yield one initial per run rather
 * than per word, because nothing in the string marks where the words are. That is a known
 * limit of the technique, not a defect: those snippets remain findable by substring.
 */
function computeWordInitials(s: string): string {
  const words = s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu);
  if (!words) return '';
  return words.map((w) => String.fromCodePoint(w.codePointAt(0) as number)).join('');
}

/**
 * `[labelInitials, textInitials]`, memoised per Snippet OBJECT.
 *
 * Safe to key on identity: `label` and `text` are immutable for a given object, because
 * every reducer that edits a snippet goes through Immer and therefore hands back a NEW
 * object. A stale entry is unreachable, and a deleted snippet's entry frees itself.
 *
 * Worth doing at all because the flyout re-filters on every keystroke, and without a
 * cache each one would rescan the full body of every snippet in the library.
 *
 * Kept as two strings rather than one joined string on purpose: joining would run the
 * label's initials into the text's, so a snippet labelled `Cat` with body `house` would
 * answer to `ch`. Nothing in either field should be able to match across that seam.
 */
const initialsCache = new WeakMap<Snippet, readonly [string, string]>();

function snippetInitials(s: Snippet): readonly [string, string] {
  let cached = initialsCache.get(s);
  if (!cached) {
    cached = [computeWordInitials(s.label ?? ''), computeWordInitials(s.text)] as const;
    initialsCache.set(s, cached);
  }
  return cached;
}

function matchesTag(s: Snippet, w: string): boolean {
  return (s.tags ?? []).some((t) => t.toLowerCase().includes(w));
}

function matchesInitials(s: Snippet, w: string): boolean {
  if (w.length < MIN_INITIALS_QUERY_LENGTH) return false;
  const [labelInitials, textInitials] = snippetInitials(s);
  return labelInitials.includes(w) || textInitials.includes(w);
}

/**
 * The ladder, and the ONLY place it is written down (plan/030 §3). Lower is better:
 *
 *   0  label starts with the word
 *   1  label contains it
 *   2  text contains it
 *   3  a tag contains it
 *   4  the word-initials of the label or the text contain it
 *   5  no match
 *
 * `rankSnippet` and `matchesAllWords` are both defined in terms of this, so the set of
 * things that COUNT as a match and the order they sort in cannot drift apart — widening
 * one without the other is what makes a new rung either unreachable or unsorted.
 *
 * `label`/`text` are passed in already lower-cased because the caller looks at every word
 * against the same snippet and there is no reason to re-case per word.
 */
function wordTier(s: Snippet, label: string, text: string, w: string): number {
  if (label.startsWith(w)) return 0;
  if (label.includes(w)) return 1;
  if (text.includes(w)) return 2;
  if (matchesTag(s, w)) return 3;
  if (matchesInitials(s, w)) return 4;
  return NO_MATCH_TIER;
}

/** Best (lowest) tier this snippet achieves across the parsed words — see {@link wordTier}
 *  for the rungs. Returns {@link NO_MATCH_TIER} when `words` is empty, i.e. for the
 *  tag-only and empty queries, where ranking by word is meaningless. */
export function rankSnippet(s: Snippet, words: string[]): number {
  if (words.length === 0) return NO_MATCH_TIER;
  const label = (s.label ?? '').toLowerCase();
  const text = s.text.toLowerCase();
  let bestTier = NO_MATCH_TIER;
  for (const w of words) {
    const tier = wordTier(s, label, text, w);
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
  return words.every((w) => wordTier(s, label, text, w) < NO_MATCH_TIER);
}

/** Filter + rank snippets against a raw query. Every parsed `#tag` must be present (AND,
 *  exact); every parsed word must match the snippet on some rung of {@link wordTier} —
 *  label, text, a tag, or word-initials — again AND, so a second word narrows rather than
 *  widens. Empty query (no tags, no words) returns every snippet, unfiltered, in input
 *  order. Ranking is the best rung any single word reaches, ties broken by `createdAt`
 *  descending. */
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
