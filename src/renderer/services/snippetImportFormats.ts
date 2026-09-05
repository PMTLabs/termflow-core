// plan/030 §4 — the three snippet import formats, and nothing else.
//
// Pure translation: JSON in, `DraftSnippet[]` plus two reject counters out. No dialogs, no
// Redux, no id minting, no de-duplication. Everything downstream of "what does this record
// mean" lives in `snippetPorting.ts` and runs identically for all three formats, which is
// what stops "duplicates are compared on exact text" from quietly holding for one of them
// and not the others.
//
// The foreign formats were read off their producers' source, not guessed:
//   InkSpoke  src/InkSpoke.Core/WakeWord/VoiceCommandBundleService.cs
//   Rephlo    Rephlo.UI/Services/CommandExportService.cs

import { isValidSnippet, type Snippet } from '../store/slices/settingsSlice';

/** Which product wrote the file. Detected, never asked for — see {@link detectSnippetImportFormat}. */
export type SnippetImportFormat = 'termflow' | 'inkspoke' | 'rephlo';

/** Tag stamped on every snippet imported from the corresponding product (plan/030 §0). */
export const INKSPOKE_TAG = 'InkSpoke';
export const REPHLO_TAG = 'Rephlo';

/** Human name for a format, for a user-facing result line. */
export const SNIPPET_FORMAT_LABEL: Record<SnippetImportFormat, string> = {
  termflow: 'TermFlow',
  inkspoke: 'InkSpoke',
  rephlo: 'Rephlo',
};

/**
 * A record that has been understood but not yet admitted: it has text, and may carry a
 * label/folder/tags, but has no `id` and no settled `createdAt` yet. Deliberately as wide
 * as `Partial<Snippet>` so the TermFlow branch can pass a whole validated entry through
 * with `{ ...entry }` and keep any field this build does not know about — dropping unknown
 * fields on re-import would be a silent, one-way change to somebody's library.
 */
export type DraftSnippet = Partial<Snippet> & { text: string };

export interface ConversionResult {
  drafts: DraftSnippet[];
  /** Records that claimed to be of this format but could not be read. */
  rejected: number;
  /** Records read fine but with no snippet representation — see plan/030 D4/D5/D7.
   *  Counted apart from `rejected` because calling these malformed would tell the user
   *  their export file is broken when it is perfectly well-formed. */
  skippedUnsupported: number;
}

/* ── shared shape helpers ─────────────────────────────────────────────────────────── */

const asRecord = (x: unknown): Record<string, unknown> | null =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;

/** Trimmed, or `undefined` when absent/blank. For DISPLAY fields (label, folder) only. */
const trimmedOrUndefined = (x: unknown): string | undefined => {
  if (typeof x !== 'string') return undefined;
  const t = x.trim();
  return t.length > 0 ? t : undefined;
};

/**
 * A string with something in it, returned **verbatim** — otherwise `undefined`.
 *
 * Untrimmed on purpose: this reads snippet BODIES, and trailing whitespace or a final
 * newline is content the user typed. Trimming here would also silently change what the
 * exact-text duplicate check downstream compares.
 *
 * Takes ONE candidate, not a list of spellings. It used to accept several so a caller
 * could try `Text` then `text`; that shape is what let the case-tolerance be applied to
 * the body and forgotten on the encryption flags. Spelling is `paramField`'s job now, and
 * leaving the variadic form here would keep advertising the mistake.
 */
const nonBlankString = (candidate: unknown): string | undefined =>
  typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : undefined;

/* ── detection ────────────────────────────────────────────────────────────────────── */

/**
 * Which product wrote this envelope, or `null` for "none of ours" (plan/030 §4.1).
 *
 * Order is load-bearing, and **our own marker is checked first**. A `snippets` array is
 * TermFlow's signature, so a file carrying one is ours to interpret no matter what else it
 * carries — which is what guarantees a wrong-version TermFlow export reaches its own named
 * version refusal in `snippetPorting.ts`. Testing the foreign formats first let an
 * envelope holding BOTH `snippets` and `commands` be swallowed as an empty Rephlo import,
 * silently ignoring the snippets and skipping the version gate entirely.
 *
 * Each foreign format is then keyed on its records array **plus** a corroborating version
 * field, so an unrelated file that merely happens to have a `commands` key is reported as
 * unsupported rather than parsed as Rephlo and reported as "rejected 40 malformed".
 *
 * The final clause catches a TermFlow envelope with no records array at all — a bare
 * `{ version }` — so that too gets the version message rather than "unsupported format".
 *
 * Both foreign checks are tolerant of a version they have never seen: InkSpoke's own
 * reader only warns on a newer `SchemaVersion`, and Rephlo's never branches on `version`
 * at all. Refusing a future minor bump would be stricter than the producers themselves.
 *
 * Every discriminator is read as an OWN property. JSON members always are, but this
 * function is exported and testable, and an inherited `commands`/`version` answering for a
 * field the envelope never carried would be a detection result nothing in the file
 * justifies.
 */
export function detectSnippetImportFormat(
  envelope: Record<string, unknown>,
): SnippetImportFormat | null {
  const own = (key: string): boolean => Object.prototype.hasOwnProperty.call(envelope, key);
  const ownArray = (key: string): boolean => own(key) && Array.isArray(envelope[key]);

  if (ownArray('snippets')) return 'termflow';
  if (ownArray('Mappings') && typeof envelope.SchemaVersion === 'number' && own('SchemaVersion')) {
    return 'inkspoke';
  }
  if (ownArray('commands') && typeof envelope.version === 'string' && own('version')) {
    return 'rephlo';
  }
  if (own('version')) return 'termflow';
  return null;
}

/* ── TermFlow ─────────────────────────────────────────────────────────────────────── */

/**
 * TermFlow's own entries. The envelope's version gate and the `snippets`-is-an-array check
 * stay in `snippetPorting.ts`, where they produce their own distinct user-facing messages;
 * by the time this runs the array is known good and only the records are in question.
 *
 * `{ ...entry }` rather than a field-by-field copy: see {@link DraftSnippet}.
 */
export function convertTermFlowEntries(entries: unknown[]): ConversionResult {
  const drafts: DraftSnippet[] = [];
  let rejected = 0;
  for (const entry of entries) {
    if (!isValidSnippet(entry)) {
      rejected++;
      continue;
    }
    drafts.push({ ...entry });
  }
  return { drafts, rejected, skippedUnsupported: 0 };
}

/* ── InkSpoke ─────────────────────────────────────────────────────────────────────── */

/**
 * One params field, looked up the way InkSpoke's own deserializer looks it up.
 *
 * InkSpoke sets `PropertyNameCaseInsensitive = true`, so `Text`, `text` and `TEXT` are all
 * the same field to it — and the reference export really does contain both a lowercase
 * `text` and a lowercase `url` sitting beside PascalCase siblings. So a reader here that
 * enumerates spellings is wrong twice over: it covers two of the infinitely many a
 * case-insensitive writer may emit, and — the part that actually bites — it invites the
 * tolerance to be applied to the CONTENT keys while the SECRET keys stay strict. A payload
 * spelled `{"text": "<ciphertext>", "isSecret": true}` would then have its body read and
 * its encryption flag missed, and the ciphertext would be imported: precisely the outcome
 * D5 exists to prevent, reached through the guard rather than around it.
 *
 * Every read of a params field goes through here — body, URL, and both encryption tells —
 * so the tolerance cannot be present at one site and absent at the next.
 *
 * **Last occurrence wins, in document order** — NOT exact-case-first, which is what this
 * used to do and was wrong. When two keys of an object both fold to the same field,
 * System.Text.Json applies them in the order they appear and the later one survives; it
 * does not privilege the exactly-spelled one. So for
 * `{"Text":"…","IsSecret":false,"isSecret":true}` InkSpoke sees `true`, and an exact-first
 * reader saw `false` — i.e. it disagreed with the producer about whether a payload was
 * encrypted, in the direction that imports ciphertext.
 *
 * `Object.keys` is own-enumerable only, so an inherited or prototype-borne key can never
 * answer for a field the payload does not carry. Unlike the same choice in
 * `detectSnippetImportFormat` — which is exported and genuinely reachable with a
 * prototyped object — this one is unobservable: `params` is always `JSON.parse` output,
 * and `for..in` differs from `Object.keys` on such an object only if somebody has added an
 * ENUMERABLE property to `Object.prototype`. Mutation confirms the swap survives. It is
 * kept for intent, not for a defect it currently prevents, so do not write a test for it.
 */
function paramFields(params: Record<string, unknown>, name: string): unknown[] {
  const wanted = name.toLowerCase();
  const found: unknown[] = [];
  for (const key of Object.keys(params)) {
    if (key.toLowerCase() === wanted) found.push(params[key]);
  }
  return found;
}

/** The value the producer would end up with — see {@link paramFields}. Use this for
 *  CONTENT, where agreeing with the producer is the whole point. */
function paramField(params: Record<string, unknown>, name: string): unknown {
  const found = paramFields(params, name);
  return found.length > 0 ? found[found.length - 1] : undefined;
}

/** `ActionParamsJson` is DOUBLE-encoded — a JSON string holding JSON — so it needs a
 *  second parse. One record in the reference export holds the bare empty string, which is
 *  not parseable and must land in `rejected` rather than throwing. */
function parseActionParams(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** `Id` → `Name`, skipping any group that is missing either. `Groups` is optional, and a
 *  mapping may carry no `GroupId` key at all (it is omitted, not null, when unset), so an
 *  unresolvable id simply means "unfiled" — never a rejection. */
function inkSpokeGroupNames(groups: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(groups)) return map;
  for (const g of groups) {
    const record = asRecord(g);
    if (!record) continue;
    const id = typeof record.Id === 'string' ? record.Id : undefined;
    const name = trimmedOrUndefined(record.Name);
    if (id && name) map.set(id, name);
  }
  return map;
}

/**
 * Does this action's payload hold ciphertext rather than text (plan/030 D5)?
 *
 * Two independent tells, and either is enough. `IsSecret` is the flag InkSpoke sets, and a
 * `Nonce` is present only because something was encrypted with it — treating the pair as
 * one class means a file that carries one without the other is still refused.
 *
 * Refusing is the only correct answer: the payload is Base64 AES-256-GCM, and the key
 * lives in the OS credential store on the machine that wrote it (DPAPI CurrentUser on
 * Windows), never in the export. There is nothing to decrypt with, so importing would
 * create a snippet that types ciphertext into a terminal.
 *
 * Asked of EVERY payload, not just `SendKeys`. Only `SendKeysParams` declares these two
 * fields today, so on a file InkSpoke itself wrote the extra check can never fire — but
 * the class here is "a payload that says it is encrypted", not "a SendKeys payload", and
 * a guard that has to be re-derived at each new call site is the guard that gets left off
 * the next one. Gating it on the action type also made the plainly-stated rule "encrypted
 * payloads are never imported" quietly untrue for a hand-edited file.
 */
function holdsEncryptedPayload(params: Record<string, unknown>): boolean {
  // ANY occurrence, not the one the producer would have kept — the deliberate asymmetry
  // with `paramField`, and the reason `paramFields` is exposed at all.
  //
  // Content must agree with the producer; safety must not DEPEND on agreeing. Reading
  // `{"IsSecret":false,"isSecret":true}` the producer's way happens to refuse, but the
  // reversed spelling `{"isSecret":true,"IsSecret":false}` would then be imported — and
  // being wrong there costs a terminal full of ciphertext, while being wrong the other way
  // costs one honestly-counted `skippedUnsupported` on a file nobody can produce anyway.
  // When a payload contradicts itself about whether it is a secret, believe the half that
  // says it is.
  return (
    paramFields(params, 'IsSecret').some(Boolean) ||
    paramFields(params, 'Nonce').some((n) => trimmedOrUndefined(n) !== undefined)
  );
}

/**
 * InkSpoke Command Mappings → drafts (plan/030 §4.2).
 *
 * Only `SendKeys` and `OpenUrl` carry anything insertable. The six app-control actions
 * (`OpenApp`/`CloseApp`/`ForceCloseApp`/`BringToFront`/`SendToBack`/`HideApp`) hold an app
 * path and nothing else, and `KeyCombo`/`OpenFile` are likewise not text — all of them are
 * counted as unsupported, not malformed.
 *
 * `SendEnterAfter` is never read at all — no code here touches it. That is deliberate and
 * not an oversight: a TermFlow snippet inserts text and never submits it, a product rule
 * that predates this importer, so there is no behaviour for the field to select between.
 *
 * `IsEnabled: false` and `IsParameterized: true` mappings ARE imported. Both carry real
 * text the user wrote, and a snippet has no enabled state for the first to be lost to; a
 * parameterised phrase simply arrives with its `{text}` placeholder intact.
 */
export function convertInkSpokeExport(envelope: Record<string, unknown>): ConversionResult {
  const mappings = Array.isArray(envelope.Mappings) ? envelope.Mappings : [];
  const groupNames = inkSpokeGroupNames(envelope.Groups);

  const drafts: DraftSnippet[] = [];
  let rejected = 0;
  let skippedUnsupported = 0;

  for (const entry of mappings) {
    const mapping = asRecord(entry);
    if (!mapping) {
      rejected++;
      continue;
    }

    // Case-insensitive because InkSpoke's own reader is (`Enum.TryParse(.., true, ..)`),
    // even though its writer always emits exact PascalCase member names.
    const action = typeof mapping.ActionType === 'string' ? mapping.ActionType.toLowerCase() : null;
    if (action === null) {
      rejected++;
      continue;
    }
    const isSendKeys = action === 'sendkeys';
    if (!isSendKeys && action !== 'openurl') {
      skippedUnsupported++;
      continue;
    }

    const params = parseActionParams(mapping.ActionParamsJson);
    if (!params) {
      rejected++;
      continue;
    }
    if (holdsEncryptedPayload(params)) {
      skippedUnsupported++;
      continue;
    }

    // Case variants are real: the reference export contains one `text` and one `url`
    // beside PascalCase siblings. `paramField` is the single place that tolerance lives —
    // see its comment for why enumerating spellings here was the wrong shape.
    const text = nonBlankString(paramField(params, isSendKeys ? 'Text' : 'Url'));
    if (text === undefined) {
      rejected++;
      continue;
    }

    const groupId = typeof mapping.GroupId === 'string' ? mapping.GroupId : undefined;
    drafts.push({
      text,
      label: trimmedOrUndefined(mapping.SpokenPhrase),
      folder: groupId ? groupNames.get(groupId) : undefined,
      tags: [INKSPOKE_TAG],
    });
  }

  return { drafts, rejected, skippedUnsupported };
}

/* ── Rephlo ───────────────────────────────────────────────────────────────────────── */

/**
 * Rephlo Commands → drafts (plan/030 §4.2).
 *
 * `instruction` is the body — the prompt text the user wrote and would want to paste.
 * `fixedContentAppend` is NOT included (plan/030 D6): Rephlo never sends it to the model,
 * it is concatenated at output-delivery time, and it is a separate field the user fills in
 * for a different purpose.
 *
 * `description` has no home on a `Snippet` and is dropped. Recorded here so the loss is a
 * decision rather than an oversight.
 *
 * Archived commands are skipped, not imported (plan/030 D7). Both of Rephlo's export paths
 * include them — neither filters `IsArchived` — so a "selected" export can carry a command
 * the user has already thrown away.
 */
export function convertRephloExport(envelope: Record<string, unknown>): ConversionResult {
  const commands = Array.isArray(envelope.commands) ? envelope.commands : [];

  const drafts: DraftSnippet[] = [];
  let rejected = 0;
  let skippedUnsupported = 0;

  for (const entry of commands) {
    // Also catches a literal `null` element, which Rephlo's own importer treats as an
    // "empty command entry" error rather than a crash.
    const command = asRecord(entry);
    if (!command) {
      rejected++;
      continue;
    }
    // `=== true`, not truthiness, and it matters for the bucket claim rather than for any
    // real file: Rephlo serialises this from a C# bool, so only a hand-edited export can
    // carry anything else — and truthiness put `isArchived: "false"` into
    // `skippedUnsupported`, i.e. reported "not a snippet" for a record that plainly is
    // not archived. A value that is not `true` is not an archive marker.
    if (command.isArchived === true) {
      skippedUnsupported++;
      continue;
    }

    const text = nonBlankString(command.instruction);
    if (text === undefined) {
      rejected++;
      continue;
    }

    drafts.push({
      text,
      label: trimmedOrUndefined(command.name),
      folder: trimmedOrUndefined(command.groupName),
      tags: [REPHLO_TAG],
    });
  }

  return { drafts, rejected, skippedUnsupported };
}

/** Dispatch for the two foreign formats. TermFlow is not here: its envelope needs the
 *  version gate in `snippetPorting.ts` first, and that gate must stay ahead of any record. */
export function convertForeignExport(
  format: Exclude<SnippetImportFormat, 'termflow'>,
  envelope: Record<string, unknown>,
): ConversionResult {
  return format === 'inkspoke' ? convertInkSpokeExport(envelope) : convertRephloExport(envelope);
}
