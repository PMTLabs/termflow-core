// Import/export for Snippets (plan/029 §8). Service layer only: this module owns the
// two native dialogs, the §8.1 envelope and the §8.4 merge semantics, and returns a
// structured result. It deliberately does NOT touch Redux — the caller applies the
// returned `added` with a single `setSnippets`, which is also the single persist.
//
// Nothing here throws for an expected user-facing failure. A dismissed dialog is a
// normal outcome (`{ ok: 'cancelled' }`) and is kept distinct from a failure so a
// caller cannot report "Import failed" at somebody who simply pressed Escape.

import { type Snippet } from '../store/slices/settingsSlice';
import {
  SNIPPET_FORMAT_LABEL,
  convertForeignExport,
  convertTermFlowEntries,
  detectSnippetImportFormat,
  type ConversionResult,
  type SnippetImportFormat,
} from './snippetImportFormats';

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
      /** Which product wrote the file (plan/030 §4.1). Detected, never chosen by the user. */
      format: SnippetImportFormat;
      imported: number;
      skippedDuplicates: number;
      rejected: number;
      /** Valid records with no snippet representation — an InkSpoke app-control action, an
       *  encrypted `SendKeys`, an archived Rephlo command. Never `rejected`: the file is
       *  fine, these records simply are not snippets. Always 0 for a TermFlow import. */
      skippedUnsupported: number;
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

/**
 * The one message for "we do not read this file at all" (plan/030, AC 6). It names all
 * three formats rather than saying "not a TermFlow export", because with detection in
 * place that older wording would now be actively misleading: a real InkSpoke file IS
 * readable, and a user told otherwise would have no way to tell a genuine refusal from a
 * bug. Shared by the not-an-object case and the no-format-matched case — both mean the
 * same thing to the person reading it.
 */
const UNSUPPORTED_FORMAT_REASON =
  'That file is not a TermFlow, InkSpoke, or Rephlo export. Snippets import reads a TermFlow snippets export, an InkSpoke Command Mappings export, or a Rephlo commands export.';

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
 * Import from a user-picked `.json` file and return the records to append (§8.4, D9,
 * plan/030 §4).
 *
 * Order: detect the format, then — **for TermFlow only** — refuse an unknown version
 * before looking at any entry, then convert per record (a malformed one is dropped and
 * counted, it never fails the whole file), then skip exact-text duplicates, then mint a
 * fresh id for each survivor.
 *
 * The version gate is scoped to TermFlow deliberately, and saying so matters: neither
 * foreign format is version-gated at all. InkSpoke's own reader only warns on a newer
 * `SchemaVersion` and Rephlo's never branches on `version`, so refusing an unseen bump
 * would be stricter than the producers themselves — detection type-checks those fields
 * and nothing more.
 *
 * `imported + skippedDuplicates + rejected + skippedUnsupported` always equals the number
 * of records in the file — every record is accounted for in exactly one bucket. The
 * fourth term is always 0 for TermFlow, whose records are snippets by construction.
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
    return { ok: false, reason: UNSUPPORTED_FORMAT_REASON };
  }

  const envelope = parsed as Record<string, unknown>;
  const format = detectSnippetImportFormat(envelope);
  if (format === null) {
    return { ok: false, reason: UNSUPPORTED_FORMAT_REASON };
  }

  let conversion: ConversionResult;
  if (format === 'termflow') {
    // The version gate stays FIRST and stays inside this branch — a wrong-version TermFlow
    // file must get its own named refusal, not be handed to a foreign parser that would
    // report every record as malformed. Detection is loosest for TermFlow precisely so
    // that such a file lands here rather than falling through to "unsupported format".
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
    conversion = convertTermFlowEntries(envelope.snippets);
  } else {
    conversion = convertForeignExport(format, envelope);
  }

  // ── one merge stage, whatever the format ────────────────────────────────────────────
  // Seeded with the local texts, then grown as records are accepted, so a file that
  // repeats the same text twice imports it once and counts the second as a duplicate
  // rather than manufacturing a duplicate the user never had. Running this AFTER
  // conversion is what makes "duplicate" mean the same thing for all three formats: an
  // InkSpoke mapping is compared on the text it produces, not on its raw record.
  const seenTexts = new Set(existing.map((s) => s.text));

  const added: Snippet[] = [];
  let skippedDuplicates = 0;

  for (const draft of conversion.drafts) {
    if (seenTexts.has(draft.text)) {
      skippedDuplicates++;
      continue;
    }
    seenTexts.add(draft.text);
    added.push({
      ...draft,
      id: mintSnippetId(),
      // `isValidSnippet` deliberately does not check `createdAt`; a missing or
      // non-numeric one is defaulted here rather than costing an otherwise-good record.
      // `Number.isFinite`, not `typeof === 'number'` (D-05): `NaN`/`Infinity` are both
      // `typeof 'number'` but serialize to `null` and break `snippetSearch.ts`'s
      // `b.createdAt - a.createdAt` sort comparator. Foreign records have no `createdAt`
      // of their own and land on the same default by the same route.
      createdAt: Number.isFinite(draft.createdAt) ? (draft.createdAt as number) : Date.now(),
    });
  }

  return {
    ok: true,
    added,
    format,
    imported: added.length,
    skippedDuplicates,
    rejected: conversion.rejected,
    skippedUnsupported: conversion.skippedUnsupported,
  };
}

/**
 * One-line summary for the Settings panel's result row (§8.4 step 8, plan/030 §4.3).
 *
 * The original sentence is emitted verbatim and unconditionally; the two clauses added by
 * plan/030 only APPEND, and only when they have something to say. A TermFlow import
 * therefore reads exactly as it did before this feature existed — no "skipped 0
 * unsupported" noise on the overwhelmingly common path — while an InkSpoke or Rephlo
 * import gets the counts and the provenance it needs to be intelligible.
 */
export const describeImport = (r: {
  imported: number;
  skippedDuplicates: number;
  rejected: number;
  skippedUnsupported?: number;
  format?: SnippetImportFormat;
}): string => {
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [
    `Imported ${r.imported}, skipped ${plural(r.skippedDuplicates, 'duplicate')}, rejected ${r.rejected} malformed.`,
  ];
  const unsupported = r.skippedUnsupported ?? 0;
  if (unsupported > 0) parts.push(`Skipped ${plural(unsupported, 'unsupported record')}.`);
  if (r.format && r.format !== 'termflow') {
    parts.push(`Source: ${SNIPPET_FORMAT_LABEL[r.format]} export.`);
  }
  return parts.join(' ');
};
