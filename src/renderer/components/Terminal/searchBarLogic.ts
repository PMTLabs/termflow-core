import type { TerminalSearchResult } from '@termflow/terminal-core';

// "N of M" label. resultIndex is zero-based (-1 when no match); resultCount is 0
// when nothing matches. Clamps a negative index to 0 so the label never shows
// "0 of 5" as "-1...".
export function formatMatchCount(r: TerminalSearchResult): string {
  if (r.resultCount === 0) return '0 of 0';
  const shown = r.resultIndex < 0 ? 0 : r.resultIndex + 1;
  return `${shown} of ${r.resultCount}`;
}

// Whether the query is safe to run. Empty is "valid" (the engine just clears).
// In regex mode an unparseable pattern is invalid, so the UI can flag it instead
// of letting the addon throw.
export function isQueryValid(query: string, regex: boolean): boolean {
  if (query === '') return true;
  if (!regex) return true;
  try {
    // eslint-disable-next-line no-new
    new RegExp(query);
    return true;
  } catch {
    return false;
  }
}
