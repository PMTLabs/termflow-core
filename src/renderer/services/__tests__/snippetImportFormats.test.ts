/**
 * plan/030 §4 — format detection and per-record translation for the three snippet import
 * formats.
 *
 * Fixtures here are SYNTHETIC. They mirror the structure of the real InkSpoke and Rephlo
 * exports — including every anomaly those files actually contain — but carry none of their
 * content: the real files hold personal prompts, private URLs and two AES-256-GCM
 * credential blobs, and none of that belongs in a repository. Where a fixture exists to
 * reproduce a specific real-world quirk, the comment says which.
 */
import {
  INKSPOKE_TAG,
  REPHLO_TAG,
  convertInkSpokeExport,
  convertRephloExport,
  convertTermFlowEntries,
  detectSnippetImportFormat,
  type ConversionResult,
} from '../snippetImportFormats';

/* ── helpers ──────────────────────────────────────────────────────────────────────── */

/** An InkSpoke mapping. `params` is stringified for you — the real field is DOUBLE-encoded. */
const mapping = (
  overrides: Record<string, unknown>,
  params?: Record<string, unknown> | string,
): Record<string, unknown> => ({
  Id: 'id-1',
  SpokenPhrase: 'do the thing',
  ActionType: 'SendKeys',
  ActionParamsJson: typeof params === 'string' ? params : JSON.stringify(params ?? { Text: 'body' }),
  IsEnabled: true,
  IsParameterized: false,
  ...overrides,
});

const inkSpokeFile = (
  mappings: unknown[],
  groups: unknown[] = [],
): Record<string, unknown> => ({
  SchemaVersion: 2,
  ExportedAt: '2026-09-04T21:40:20.2782551Z',
  SourcePlatform: 'windows',
  Groups: groups,
  Mappings: mappings,
  Favorites: [],
  Vocabulary: [],
});

const rephloFile = (commands: unknown[]): Record<string, unknown> => ({
  version: '1.3',
  exportedAt: '2026-09-04T21:42:39.1374288Z',
  commands,
});

const command = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'A command',
  instruction: 'do a thing carefully',
  executionMode: 'Combination',
  isDefault: false,
  hideFromContextMenu: false,
  isArchived: false,
  ...overrides,
});

/** Every record must land in exactly one bucket — the cheapest guard against a counting
 *  bug, and the property plan/030 §4.3's four-term invariant is built on. */
const expectFullyAccounted = (r: ConversionResult, total: number): void => {
  expect(r.drafts.length + r.rejected + r.skippedUnsupported).toBe(total);
};

/* ── detection ────────────────────────────────────────────────────────────────────── */

describe('detectSnippetImportFormat', () => {
  it('recognises each of the three formats', () => {
    expect(detectSnippetImportFormat(inkSpokeFile([]))).toBe('inkspoke');
    expect(detectSnippetImportFormat(rephloFile([]))).toBe('rephlo');
    expect(detectSnippetImportFormat({ version: 1, exportedAt: 0, snippets: [] })).toBe('termflow');
  });

  it('routes a TermFlow file with a WRONG or MISSING version to termflow, not to null', () => {
    // Load-bearing: these two must reach the version gate in snippetPorting and get their
    // own named refusal. If detection sent them to null they would be reported as an
    // unrecognised format, which is a different and less honest thing to tell the user.
    expect(detectSnippetImportFormat({ version: 2, snippets: [] })).toBe('termflow');
    expect(detectSnippetImportFormat({ version: 99 })).toBe('termflow');
    expect(detectSnippetImportFormat({ snippets: [] })).toBe('termflow');
  });

  it('needs the corroborating version field, not just the records array', () => {
    // An unrelated file that merely has a `commands` key must be reported as unsupported,
    // NOT parsed as Rephlo and reported as "rejected N malformed".
    expect(detectSnippetImportFormat({ commands: ['ls', 'cd'] })).toBeNull();
    expect(detectSnippetImportFormat({ Mappings: [{}] })).toBeNull();
    // ...and the version field has to be the right TYPE, since both foreign formats and
    // TermFlow all spell it differently on purpose.
    expect(detectSnippetImportFormat({ commands: [], version: 1 })).toBe('termflow');
    expect(detectSnippetImportFormat({ Mappings: [], SchemaVersion: '2' })).toBeNull();
  });

  it('is forward-tolerant of a newer foreign schema version', () => {
    // Both producers are: InkSpoke's reader only warns on a newer SchemaVersion, Rephlo's
    // never branches on version at all. Being stricter than the producer would refuse
    // files that are in fact perfectly readable.
    expect(detectSnippetImportFormat({ ...inkSpokeFile([]), SchemaVersion: 99 })).toBe('inkspoke');
    expect(detectSnippetImportFormat({ ...rephloFile([]), version: '9.9' })).toBe('rephlo');
    // ...and backward-tolerant: Rephlo 1.1 predates isArchived entirely.
    expect(detectSnippetImportFormat({ ...rephloFile([]), version: '1.1' })).toBe('rephlo');
  });

  it('returns null for anything else', () => {
    expect(detectSnippetImportFormat({})).toBeNull();
    expect(detectSnippetImportFormat({ foo: 1, bar: [] })).toBeNull();
    expect(detectSnippetImportFormat({ items: [] })).toBeNull();
  });
});

/* ── InkSpoke ─────────────────────────────────────────────────────────────────────── */

describe('convertInkSpokeExport', () => {
  it('imports a SendKeys mapping with its phrase, group and source tag', () => {
    const r = convertInkSpokeExport(
      inkSpokeFile(
        [mapping({ SpokenPhrase: 'apply guideline', GroupId: 'g1' }, { Text: 'Use Sonnet.' })],
        [{ Id: 'g1', Name: 'Prompt Shortcut', IsEnabled: true, SortOrder: 0 }],
      ),
    );
    expect(r.drafts).toEqual([
      {
        text: 'Use Sonnet.',
        label: 'apply guideline',
        folder: 'Prompt Shortcut',
        tags: [INKSPOKE_TAG],
      },
    ]);
    expectFullyAccounted(r, 1);
  });

  it('reads the lowercase `text` and `url` key variants the real file contains', () => {
    // Not hypothetical: the reference export has one SendKeys spelled `text` and one
    // OpenUrl spelled `url`. InkSpoke itself reads them (PropertyNameCaseInsensitive).
    const r = convertInkSpokeExport(
      inkSpokeFile([
        mapping({ Id: 'a' }, { text: '{last}' }),
        mapping({ Id: 'b', ActionType: 'OpenUrl' }, { url: 'https://example.test' }),
      ]),
    );
    expect(r.drafts.map((d) => d.text)).toEqual(['{last}', 'https://example.test']);
    expectFullyAccounted(r, 2);
  });

  it('accepts a lower-cased ActionType, as InkSpoke’s own Enum.TryParse does', () => {
    const r = convertInkSpokeExport(inkSpokeFile([mapping({ ActionType: 'sendkeys' })]));
    expect(r.drafts).toHaveLength(1);
  });

  it('NEVER imports an encrypted payload, flagged either way', () => {
    // plan/030 D5. The text is Base64 AES-256-GCM and the key is in the OS credential
    // store on the machine that wrote the file, so there is nothing to decrypt with.
    // Two independent tells, because a file carrying one without the other is still
    // ciphertext: importing it would type gibberish into a terminal.
    const r = convertInkSpokeExport(
      inkSpokeFile([
        mapping({ Id: 'flagged' }, { Text: 'Y2lwaGVy', IsSecret: true, Nonce: 'bm9uY2U=' }),
        mapping({ Id: 'nonce-only' }, { Text: 'Y2lwaGVy', Nonce: 'bm9uY2U=' }),
        mapping({ Id: 'flag-only' }, { Text: 'Y2lwaGVy', IsSecret: true }),
      ]),
    );
    expect(r.drafts).toEqual([]);
    expect(r.skippedUnsupported).toBe(3);
    expect(r.rejected).toBe(0); // an encrypted record is not MALFORMED
    expectFullyAccounted(r, 3);
  });

  it('imports a SendKeys whose IsSecret is explicitly false', () => {
    // The negative half of the pair above — without this, a converter that skipped every
    // SendKeys would pass the encryption test and nothing would notice.
    const r = convertInkSpokeExport(
      inkSpokeFile([mapping({}, { Text: 'plain', IsSecret: false, Nonce: null })]),
    );
    expect(r.drafts.map((d) => d.text)).toEqual(['plain']);
    expect(r.skippedUnsupported).toBe(0);
  });

  it('rejects an unparseable ActionParamsJson without failing the file', () => {
    // The reference export contains one mapping whose ActionParamsJson is the bare empty
    // string. The valid records around it must still import.
    const r = convertInkSpokeExport(
      inkSpokeFile([
        mapping({ Id: 'good-1' }, { Text: 'first' }),
        mapping({ Id: 'empty' }, ''),
        mapping({ Id: 'not-json' }, 'this is not json'),
        mapping({ Id: 'scalar' }, '123'), // parses, but not to an object
        mapping({ Id: 'good-2' }, { Text: 'second' }),
      ]),
    );
    expect(r.drafts.map((d) => d.text)).toEqual(['first', 'second']);
    expect(r.rejected).toBe(3);
    expectFullyAccounted(r, 5);
  });

  it('counts every non-text action as unsupported, not malformed', () => {
    const r = convertInkSpokeExport(
      inkSpokeFile(
        ['OpenApp', 'CloseApp', 'ForceCloseApp', 'BringToFront', 'SendToBack', 'HideApp',
          'KeyCombo', 'OpenFile'].map((ActionType, i) =>
          mapping({ Id: `a${i}`, ActionType }, { AppIdentifier: 'auto', AppDisplayName: '' }),
        ),
      ),
    );
    expect(r.drafts).toEqual([]);
    expect(r.skippedUnsupported).toBe(8);
    expect(r.rejected).toBe(0);
    expectFullyAccounted(r, 8);
  });

  it('classifies an unsupported action by its TYPE, before ever looking at its params', () => {
    // Order matters (plan/030 §4.2 step 3 before step 4): a CloseApp with unreadable
    // params is still "not a snippet", not "your file is malformed". Reordering the two
    // checks would silently move this record from one bucket to the other.
    const r = convertInkSpokeExport(
      inkSpokeFile([mapping({ Id: 'app', ActionType: 'CloseApp' }, '')]),
    );
    expect(r.skippedUnsupported).toBe(1);
    expect(r.rejected).toBe(0);
  });

  it('rejects a structurally broken mapping, one record at a time', () => {
    const r = convertInkSpokeExport(
      inkSpokeFile([
        null,
        'a string',
        mapping({ ActionType: 42 }),
        mapping({}, { Text: '   ' }), // blank body is not a snippet
        mapping({}, { SomethingElse: 'x' }), // SendKeys with no text key at all
        mapping({ Id: 'survivor' }, { Text: 'still here' }),
      ]),
    );
    expect(r.drafts.map((d) => d.text)).toEqual(['still here']);
    expect(r.rejected).toBe(5);
    expectFullyAccounted(r, 6);
  });

  it('leaves the folder unset when GroupId is absent or unresolvable', () => {
    // Three real mappings in the reference file have no GroupId KEY at all — it is
    // omitted rather than null when unset. That is "unfiled", never a rejection.
    const r = convertInkSpokeExport(
      inkSpokeFile(
        [
          mapping({ Id: 'no-group' }),
          mapping({ Id: 'dangling', GroupId: 'nope' }),
          mapping({ Id: 'filed', GroupId: 'g1' }),
        ],
        [{ Id: 'g1', Name: 'Terminal' }],
      ),
    );
    expect(r.drafts.map((d) => d.folder)).toEqual([undefined, undefined, 'Terminal']);
    expect(r.rejected).toBe(0);
  });

  it('leaves the label unset when SpokenPhrase is blank, rather than rejecting', () => {
    const r = convertInkSpokeExport(inkSpokeFile([mapping({ SpokenPhrase: '   ' })]));
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0].label).toBeUndefined();
  });

  it('imports disabled and parameterized mappings — both carry real text', () => {
    const r = convertInkSpokeExport(
      inkSpokeFile([
        mapping({ Id: 'off', IsEnabled: false }, { Text: 'still mine' }),
        mapping({ Id: 'param', IsParameterized: true }, { Text: '{text}' }),
      ]),
    );
    expect(r.drafts.map((d) => d.text)).toEqual(['still mine', '{text}']);
  });

  it('ignores SendEnterAfter — a snippet inserts text and never submits it', () => {
    const r = convertInkSpokeExport(
      inkSpokeFile([mapping({}, { Text: 'ls -la', SendEnterAfter: true })]),
    );
    expect(r.drafts[0].text).toBe('ls -la'); // no trailing newline, no Enter, nothing added
  });

  it('preserves the body verbatim, including trailing whitespace', () => {
    const r = convertInkSpokeExport(inkSpokeFile([mapping({}, { Text: '  padded \n' })]));
    expect(r.drafts[0].text).toBe('  padded \n');
  });

  it('tags every imported record with InkSpoke', () => {
    const r = convertInkSpokeExport(
      inkSpokeFile([mapping({ Id: 'a' }), mapping({ Id: 'b', ActionType: 'OpenUrl' }, { Url: 'u' })]),
    );
    expect(r.drafts.every((d) => d.tags?.includes(INKSPOKE_TAG))).toBe(true);
    expect(r.drafts).toHaveLength(2);
  });
});

/* ── Rephlo ───────────────────────────────────────────────────────────────────────── */

describe('convertRephloExport', () => {
  it('imports a command with its name, group and source tag', () => {
    const r = convertRephloExport(
      rephloFile([command({ name: 'Rewrite prompt', groupName: 'Developing' })]),
    );
    expect(r.drafts).toEqual([
      {
        text: 'do a thing carefully',
        label: 'Rewrite prompt',
        folder: 'Developing',
        tags: [REPHLO_TAG],
      },
    ]);
    expectFullyAccounted(r, 1);
  });

  it('takes `instruction` ONLY — fixedContentAppend is not part of the snippet', () => {
    // plan/030 D6. Rephlo never sends fixedContentAppend to the model; it concatenates it
    // at output-delivery time, with no separator of its own.
    const r = convertRephloExport(
      rephloFile([
        command({ instruction: 'the body', fixedContentAppend: '---\r\nappended tail' }),
      ]),
    );
    expect(r.drafts[0].text).toBe('the body');
    expect(r.drafts[0].text).not.toContain('appended tail');
  });

  it('skips an archived command rather than rejecting it', () => {
    // plan/030 D7. Neither of Rephlo's export paths filters IsArchived, so a "selected"
    // export can carry something the user already threw away.
    const r = convertRephloExport(
      rephloFile([command({ name: 'live' }), command({ name: 'binned', isArchived: true })]),
    );
    expect(r.drafts.map((d) => d.label)).toEqual(['live']);
    expect(r.skippedUnsupported).toBe(1);
    expect(r.rejected).toBe(0);
    expectFullyAccounted(r, 2);
  });

  it('rejects a null element and a missing/blank instruction, one at a time', () => {
    // A literal `null` in the array is valid JSON and Rephlo's own importer handles it as
    // an "empty command entry" rather than crashing.
    const r = convertRephloExport(
      rephloFile([
        null,
        command({ instruction: undefined }),
        command({ instruction: '   ' }),
        command({ instruction: 42 }),
        command({ name: 'survivor', instruction: 'still here' }),
      ]),
    );
    expect(r.drafts.map((d) => d.label)).toEqual(['survivor']);
    expect(r.rejected).toBe(4);
    expectFullyAccounted(r, 5);
  });

  it('leaves label and folder unset when name/groupName are absent', () => {
    // Optional strings are OMITTED, never written as null, so absence is the normal case.
    const r = convertRephloExport(rephloFile([command({ name: undefined })]));
    expect(r.drafts[0].label).toBeUndefined();
    expect(r.drafts[0].folder).toBeUndefined();
    expect(r.drafts[0].text).toBe('do a thing carefully');
  });

  it('preserves the instruction verbatim, newlines and all', () => {
    const body = 'line one\r\n\r\n  line two with trailing  ';
    expect(convertRephloExport(rephloFile([command({ instruction: body })])).drafts[0].text).toBe(
      body,
    );
  });

  it('drops description — a Snippet has nowhere to put it', () => {
    const r = convertRephloExport(
      rephloFile([command({ description: 'a note about this command' })]),
    );
    expect(JSON.stringify(r.drafts[0])).not.toContain('a note about this command');
  });
});

/* ── TermFlow ─────────────────────────────────────────────────────────────────────── */

describe('convertTermFlowEntries', () => {
  it('passes a valid entry through WHOLE, keeping fields this build does not know', () => {
    // `{ ...entry }` rather than a field-by-field copy: re-importing an export written by
    // a newer build must not silently strip whatever it added.
    const entry = {
      id: 'sn-1',
      text: 'echo hi',
      label: 'greet',
      folder: 'Misc',
      tags: ['x'],
      createdAt: 7,
      somethingFuture: true,
    };
    const r = convertTermFlowEntries([entry]);
    expect(r.drafts[0]).toEqual(entry);
    expect(r).toMatchObject({ rejected: 0, skippedUnsupported: 0 });
  });

  it('rejects an invalid entry and never reports anything as unsupported', () => {
    // TermFlow has no "valid but not a snippet" case — its records ARE snippets — so this
    // bucket must stay empty, or the four-term invariant would be hiding a miscount.
    const r = convertTermFlowEntries([{ id: 'a' }, { nope: true }, null, { id: 'b', text: 'ok' }]);
    expect(r.drafts.map((d) => d.text)).toEqual(['ok']);
    expect(r.rejected).toBe(3);
    expect(r.skippedUnsupported).toBe(0);
    expectFullyAccounted(r, 4);
  });
});
