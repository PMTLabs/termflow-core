// Import/export for Snippets (plan/029 §8). Service layer only: this module owns the
// two native dialogs, the §8.1 envelope and the §8.4 merge semantics, and returns a
// structured result. It deliberately does NOT touch Redux — the caller applies the
// returned `added` with a single `setSnippets`, which is also the single persist.
//
// Nothing here throws for an expected user-facing failure. A dismissed dialog is a
// normal outcome (`{ ok: 'cancelled' }`) and is kept distinct from a failure so a
// caller cannot report "Import failed" at somebody who simply pressed Escape.

import { isValidSnippet, type Snippet } from '../store/slices/settingsSlice';

/** The only envelope version this build reads/writes (§8.1). */
export const SNIPPETS_EXPORT_VERSION = 1;

/** §8.1 on-disk shape. Versioned so a future field cannot silently corrupt an old file. */
export interface SnippetsExportFile {
  version: number;
  exportedAt: number;
  snippets: Snippet[];
}

/**
 * Three outcomes, discriminated on `ok`. Branch with an explicit comparison —
 * `result.ok === true` / `=== false` / `=== 'cancelled'`. A bare `if (result.ok)`
 * is a trap: `'cancelled'` is truthy, so it would land in the success branch.
 */
export type SnippetExportResult =
  | { ok: true; path: string }
  | { ok: false; reason: string }
  | { ok: 'cancelled' };

/** Same three-outcome shape as {@link SnippetExportResult}; compare `ok` explicitly. */
export type SnippetImportResult =
  | {
      ok: true;
      /** The records to append — fresh ids, duplicates and malformed entries already removed. */
      added: Snippet[];
      imported: number;
      skippedDuplicates: number;
      rejected: number;
    }
  | { ok: false; reason: string }
  | { ok: 'cancelled' };

/**
 * A fresh id per incoming record (D9): a file from another machine can collide with a
 * local id, and re-minting unconditionally is what makes import always safe to click.
 *
 * Local to this module rather than `utils/id.ts` — `generateId`'s prefix union there is
 * a closed set of tab/pane/terminal kinds and a snippet is none of those. The counter
 * guarantees uniqueness inside one import even if two records land in the same
 * millisecond with the same random suffix.
 */
let snippetIdSeq = 0;
const mintSnippetId = (): string =>
  `sn-${Date.now().toString(36)}${(snippetIdSeq++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * A Tauri command rejects with the raw `Err(String)` (a plain string), while a bridge
 * or plugin failure rejects with an `Error`. Both must reach the UI readably.
 */
const reasonFrom = (e: unknown, fallback: string): string => {
  const raw = typeof e === 'string' ? e : e instanceof Error ? e.message : '';
  return raw.trim() || fallback;
};

const describeVersion = (v: unknown): string => {
  if (v === undefined) return 'missing';
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
};

/**
 * Export every snippet to a user-picked `.json` file (§8.1). No selection UI in v1.
 * The save dialog defaults its filename to `termflow-snippets.json`.
 */
export async function exportSnippets(snippets: Snippet[]): Promise<SnippetExportResult> {
  const api = window.electronAPI;
  if (!api?.pickSnippetsExportPath || !api?.exportSnippetsFile) {
    return { ok: false, reason: 'Exporting snippets is not available in this host.' };
  }

  let path: string | null;
  try {
    path = await api.pickSnippetsExportPath();
  } catch (e) {
    return { ok: false, reason: reasonFrom(e, 'Could not open the save dialog.') };
  }
  if (!path) return { ok: 'cancelled' };

  const envelope: SnippetsExportFile = {
    version: SNIPPETS_EXPORT_VERSION,
    exportedAt: Date.now(),
    snippets,
  };

  try {
    await api.exportSnippetsFile(path, JSON.stringify(envelope, null, 2));
  } catch (e) {
    return { ok: false, reason: reasonFrom(e, 'Could not write the snippets file.') };
  }
  return { ok: true, path };
}

/**
 * Import from a user-picked `.json` file and return the records to append (§8.4, D9).
 *
 * Order is load-bearing: refuse an unknown version *before* looking at any entry, then
 * validate per entry (a malformed record is dropped and counted, it never fails the
 * whole file), then mint a fresh id, then skip exact-text duplicates.
 *
 * `imported + skippedDuplicates + rejected` always equals the number of entries in the
 * file — every record is accounted for in exactly one bucket.
 */
export async function importSnippets(existing: Snippet[]): Promise<SnippetImportResult> {
  const api = window.electronAPI;
  if (!api?.pickSnippetsImportPath || !api?.importSnippetsFile) {
    return { ok: false, reason: 'Importing snippets is not available in this host.' };
  }

  let path: string | null;
  try {
    path = await api.pickSnippetsImportPath();
  } catch (e) {
    return { ok: false, reason: reasonFrom(e, 'Could not open the file picker.') };
  }
  if (!path) return { ok: 'cancelled' };

  let raw: string;
  try {
    raw = await api.importSnippetsFile(path);
  } catch (e) {
    // Extension and 5 MB-cap refusals from the Rust side land here, already phrased
    // for a human; pass them through rather than replacing them with a generic line.
    return { ok: false, reason: reasonFrom(e, 'Could not read the snippets file.') };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'That file is not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'That file is not a TermFlow snippets export.' };
  }

  const envelope = parsed as Record<string, unknown>;
  if (envelope.version !== SNIPPETS_EXPORT_VERSION) {
    // Named, not parsed hopefully (§8.1) — a newer file may use fields this build
    // would silently drop, so refusing is the honest outcome.
    return {
      ok: false,
      reason: `Unsupported snippets file version ${describeVersion(envelope.version)}. This version of TermFlow reads version ${SNIPPETS_EXPORT_VERSION}.`,
    };
  }
  if (!Array.isArray(envelope.snippets)) {
    return { ok: false, reason: 'That file has no "snippets" list.' };
  }

  // Seeded with the local texts, then grown as records are accepted, so a file that
  // repeats the same text twice imports it once and counts the second as a duplicate
  // rather than manufacturing a duplicate the user never had.
  const seenTexts = new Set(existing.map((s) => s.text));

  const added: Snippet[] = [];
  let skippedDuplicates = 0;
  let rejected = 0;

  for (const entry of envelope.snippets) {
    if (!isValidSnippet(entry)) {
      rejected++;
      continue;
    }
    if (seenTexts.has(entry.text)) {
      skippedDuplicates++;
      continue;
    }
    seenTexts.add(entry.text);
    added.push({
      ...entry,
      id: mintSnippetId(),
      // `isValidSnippet` deliberately does not check `createdAt`; a missing or
      // non-numeric one is defaulted here rather than costing an otherwise-good record.
      // `Number.isFinite`, not `typeof === 'number'` (D-05): `NaN`/`Infinity` are both
      // `typeof 'number'` but serialize to `null` and break `snippetSearch.ts`'s
      // `b.createdAt - a.createdAt` sort comparator.
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
    });
  }

  return { ok: true, added, imported: added.length, skippedDuplicates, rejected };
}

/** One-line summary for the Settings panel's result row (§8.4 step 8). */
export const describeImport = (r: {
  imported: number;
  skippedDuplicates: number;
  rejected: number;
}): string =>
  `Imported ${r.imported}, skipped ${r.skippedDuplicates} duplicate${r.skippedDuplicates === 1 ? '' : 's'}, rejected ${r.rejected} malformed.`;
