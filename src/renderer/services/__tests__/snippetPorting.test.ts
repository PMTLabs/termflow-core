/**
 * @jest-environment jsdom
 */
// Import/export service layer for Snippets (plan/029 §8). The service owns the two
// dialogs, the §8.1 envelope, and the §8.4 merge semantics; it does NOT dispatch —
// the caller applies `added` with one `setSnippets`.
//
// Cancelling a dialog is a normal outcome, not an error: it is asserted here as its
// own `{ ok: 'cancelled' }` branch so a caller can never surface it as a failure.

import type { Snippet } from '../../store/slices/settingsSlice';
import { describeImport, exportSnippets, importSnippets } from '../snippetPorting';

const pickSnippetsExportPath = jest.fn();
const pickSnippetsImportPath = jest.fn();
const exportSnippetsFile = jest.fn();
const importSnippetsFile = jest.fn();

beforeEach(() => {
  pickSnippetsExportPath.mockReset();
  pickSnippetsImportPath.mockReset();
  exportSnippetsFile.mockReset();
  importSnippetsFile.mockReset();
  exportSnippetsFile.mockResolvedValue(undefined);
  (window as any).electronAPI = {
    pickSnippetsExportPath,
    pickSnippetsImportPath,
    exportSnippetsFile,
    importSnippetsFile,
  };
});

const snip = (over: Partial<Snippet> = {}): Snippet => ({
  id: 'sn-file-1',
  text: 'echo hello',
  createdAt: 111,
  ...over,
});

/** A well-formed §8.1 export file as the renderer would receive it from Rust. */
const file = (snippets: unknown[], version: unknown = 1): string =>
  JSON.stringify({ version, exportedAt: 1757000000000, snippets });

describe('exportSnippets', () => {
  it('writes the §8.1 envelope to the picked path and reports it', async () => {
    pickSnippetsExportPath.mockResolvedValue('C:/tmp/termflow-snippets.json');
    const result = await exportSnippets([snip({ id: 'sn-a', text: 'ls -la' })]);

    expect(result).toEqual({ ok: true, path: 'C:/tmp/termflow-snippets.json' });
    expect(exportSnippetsFile).toHaveBeenCalledTimes(1);
    const [path, json] = exportSnippetsFile.mock.calls[0];
    expect(path).toBe('C:/tmp/termflow-snippets.json');
    const envelope = JSON.parse(json);
    expect(envelope.version).toBe(1);
    expect(typeof envelope.exportedAt).toBe('number');
    expect(envelope.snippets).toEqual([{ id: 'sn-a', text: 'ls -la', createdAt: 111 }]);
  });

  it('returns the cancelled outcome and writes nothing when the save dialog is dismissed', async () => {
    pickSnippetsExportPath.mockResolvedValue(null);
    const result = await exportSnippets([snip()]);

    expect(result).toEqual({ ok: 'cancelled' });
    expect(exportSnippetsFile).not.toHaveBeenCalled();
  });

  it('reports a picker failure as a reason, NOT as a cancellation', async () => {
    // The browser dev host throws from the picker. A rejected picker must not be
    // folded into the cancelled branch — that would report "cancelled" for an
    // export the user actually asked for.
    pickSnippetsExportPath.mockRejectedValue(new Error('Exporting snippets requires the desktop app.'));

    const result = await exportSnippets([snip()]);
    expect(result).toEqual({
      ok: false,
      reason: 'Exporting snippets requires the desktop app.',
    });
    expect(exportSnippetsFile).not.toHaveBeenCalled();
  });

  it('reports a write failure as a reason rather than throwing', async () => {
    pickSnippetsExportPath.mockResolvedValue('C:/tmp/x.json');
    // Tauri's invoke rejects with the raw Err(String) from the command.
    exportSnippetsFile.mockRejectedValue('Snippet files must end in .json (got "x.txt")');

    const result = await exportSnippets([snip()]);
    expect(result).toEqual({ ok: false, reason: 'Snippet files must end in .json (got "x.txt")' });
  });
});

describe('importSnippets', () => {
  it('mints a fresh id for every incoming record (D9)', async () => {
    pickSnippetsImportPath.mockResolvedValue('C:/tmp/in.json');
    importSnippetsFile.mockResolvedValue(
      file([snip({ id: 'sn-collides', text: 'a' }), snip({ id: 'sn-collides-2', text: 'b' })])
    );

    const result = await importSnippets([]);
    if (result.ok !== true) throw new Error(`expected ok, got ${JSON.stringify(result)}`);

    expect(result.added).toHaveLength(2);
    const ids = result.added.map((s) => s.id);
    expect(ids).not.toContain('sn-collides');
    expect(ids).not.toContain('sn-collides-2');
    expect(new Set(ids).size).toBe(2);
    // Everything except the id survives verbatim.
    expect(result.added.map((s) => s.text)).toEqual(['a', 'b']);
  });

  it('re-mints even when the incoming id does not collide with anything local', async () => {
    // The rule is unconditional (a file from another machine can collide), not
    // "re-mint only on collision" — a conditional version would pass a test that
    // seeded the collision, and silently import foreign ids in every other case.
    pickSnippetsImportPath.mockResolvedValue('C:/tmp/in.json');
    importSnippetsFile.mockResolvedValue(file([snip({ id: 'sn-unique-in-file', text: 'a' })]));

    const result = await importSnippets([snip({ id: 'sn-local', text: 'local' })]);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.added[0].id).not.toBe('sn-unique-in-file');
  });

  it('skips and counts a record whose text exactly matches an existing snippet', async () => {
    pickSnippetsImportPath.mockResolvedValue('C:/tmp/in.json');
    importSnippetsFile.mockResolvedValue(
      file([snip({ id: 'f1', text: 'echo hello' }), snip({ id: 'f2', text: 'echo fresh' })])
    );

    const result = await importSnippets([snip({ id: 'sn-local', text: 'echo hello' })]);
    if (result.ok !== true) throw new Error('expected ok');

    expect(result.imported).toBe(1);
    expect(result.skippedDuplicates).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.added.map((s) => s.text)).toEqual(['echo fresh']);
  });

  it('treats a near-match as a distinct snippet — the duplicate rule is exact text', async () => {
    pickSnippetsImportPath.mockResolvedValue('C:/tmp/in.json');
    importSnippetsFile.mockResolvedValue(file([snip({ text: 'echo hello ' })]));

    const result = await importSnippets([snip({ text: 'echo hello' })]);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.imported).toBe(1);
    expect(result.skippedDuplicates).toBe(0);
  });

  it('counts a within-file duplicate as skipped rather than importing the same text twice', async () => {
    pickSnippetsImportPath.mockResolvedValue('C:/tmp/in.json');
    importSnippetsFile.mockResolvedValue(
      file([snip({ id: 'f1', text: 'dupe' }), snip({ id: 'f2', text: 'dupe' })])
    );

    const result = await importSnippets([]);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.imported).toBe(1);
    expect(result.skippedDuplicates).toBe(1);
  });

  it('drops and counts a malformed entry while its valid siblings survive', async () => {
    pickSnippetsImportPath.mockResolvedValue('C:/tmp/in.json');
    importSnippetsFile.mockResolvedValue(
      file([
        snip({ id: 'f1', text: 'good one' }),
        { id: 'f2' }, // no `text`
        { text: 'no id' },
        null,
        'not an object',
        { id: 'f3', text: 'bad tags', tags: [1, 2] },
        snip({ id: 'f4', text: 'good two' }),
      ])
    );

    const result = await importSnippets([]);
    if (result.ok !== true) throw new Error('expected ok');

    expect(result.rejected).toBe(5);
    expect(result.imported).toBe(2);
    expect(result.added.map((s) => s.text)).toEqual(['good one', 'good two']);
  });

  it('refuses an unknown version, naming the version in the message', async () => {
    pickSnippetsImportPath.mockResolvedValue('C:/tmp/in.json');
    importSnippetsFile.mockResolvedValue(file([snip()], 2));

    const result = await importSnippets([]);
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected failure');
    expect(result.reason).toContain('2');
    // …and it must not have parsed hopefully.
    expect(result).not.toHaveProperty('added');
  });

  it('refuses a file with no version at all', async () => {
    pickSnippetsImportPath.mockResolvedValue('C:/tmp/in.json');
    importSnippetsFile.mockResolvedValue(JSON.stringify({ snippets: [snip()] }));

    const result = await importSnippets([]);
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected failure');
    // B-04: an implementation returning the same generic reason for every negative
    // case (e.g. always 'Import failed.') passes `ok === false` here identically to
    // the wrong-version and not-an-array cases below. This pins the version check
    // specifically — it must name the file as missing a version, not just fail.
    expect(result.reason).toContain('missing');
    expect(result.reason).toContain(String(1));
  });

  it('refuses non-JSON content without throwing', async () => {
    pickSnippetsImportPath.mockResolvedValue('C:/tmp/in.json');
    importSnippetsFile.mockResolvedValue('<html>not json at all</html>');

    const result = await importSnippets([]);
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected failure');
    expect(result.reason).toBeTruthy();
  });

  it('refuses a JSON file whose snippets key is not an array', async () => {
    pickSnippetsImportPath.mockResolvedValue('C:/tmp/in.json');
    importSnippetsFile.mockResolvedValue(JSON.stringify({ version: 1, snippets: 'nope' }));

    const result = await importSnippets([]);
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected failure');
    // B-04: distinguishes this from the version-refusal case above — a version 1
    // envelope reached the array check, so the reason must be about the missing
    // "snippets" list, not a repeat of the version message.
    expect(result.reason).toBe('That file has no "snippets" list.');
  });

  it('returns the cancelled outcome and reads nothing when the open dialog is dismissed', async () => {
    pickSnippetsImportPath.mockResolvedValue(null);

    const result = await importSnippets([snip()]);
    expect(result).toEqual({ ok: 'cancelled' });
    expect(importSnippetsFile).not.toHaveBeenCalled();
  });

  it('reports a picker failure as a reason, NOT as a cancellation', async () => {
    pickSnippetsImportPath.mockRejectedValue(new Error('Importing snippets requires the desktop app.'));

    const result = await importSnippets([]);
    expect(result).toEqual({
      ok: false,
      reason: 'Importing snippets requires the desktop app.',
    });
    expect(importSnippetsFile).not.toHaveBeenCalled();
  });

  it('reports a read failure as a reason rather than throwing', async () => {
    pickSnippetsImportPath.mockResolvedValue('C:/tmp/huge.json');
    importSnippetsFile.mockRejectedValue('C:/tmp/huge.json is larger than the 5 MB import limit');

    const result = await importSnippets([]);
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected failure');
    expect(result.reason).toContain('5 MB');
  });

  it('accounts for every entry in the file: imported + skippedDuplicates + rejected === entries', async () => {
    // The cheapest guard against a counting bug — a record that is silently
    // neither imported, skipped nor rejected would break this identity and
    // nothing else in the suite.
    const entries: unknown[] = [
      snip({ id: 'f1', text: 'fresh a' }),
      snip({ id: 'f2', text: 'fresh b' }),
      snip({ id: 'f3', text: 'already here' }), // duplicate of existing
      snip({ id: 'f4', text: 'fresh a' }), // within-file duplicate
      { id: 'f5' }, // malformed
      { nope: true }, // malformed
      snip({ id: 'f7', text: 'fresh c', folder: 'Git', tags: ['x'] }),
    ];
    pickSnippetsImportPath.mockResolvedValue('C:/tmp/in.json');
    importSnippetsFile.mockResolvedValue(file(entries));

    const result = await importSnippets([snip({ id: 'sn-local', text: 'already here' })]);
    if (result.ok !== true) throw new Error('expected ok');

    expect(result.imported + result.skippedDuplicates + result.rejected).toBe(entries.length);
    expect(result.imported).toBe(3);
    expect(result.skippedDuplicates).toBe(2);
    expect(result.rejected).toBe(2);
    expect(result.added).toHaveLength(result.imported);
  });

  it('defaults a missing createdAt instead of rejecting an otherwise-good record', async () => {
    pickSnippetsImportPath.mockResolvedValue('C:/tmp/in.json');
    importSnippetsFile.mockResolvedValue(file([{ id: 'f1', text: 'no timestamp' }]));

    const result = await importSnippets([]);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.imported).toBe(1);
    expect(typeof result.added[0].createdAt).toBe('number');
    expect(result.added[0].createdAt).toBeGreaterThan(0);
  });

  // D-05: `typeof Infinity === 'number'`, so a `typeof === 'number'` guard (the
  // pre-fix code) treats it as a valid timestamp. It then serializes to `null` in
  // JSON and breaks `snippetSearch.ts`'s `b.createdAt - a.createdAt` sort comparator.
  // `Number.isFinite` must reject it and fall back to `Date.now()` the same way a
  // missing `createdAt` does.
  //
  // Built as a raw JSON string rather than through `file()`/`JSON.stringify`: there
  // is no valid JSON spelling of `NaN`, and `JSON.stringify(Infinity)` itself
  // produces `null` — the overflowing numeric literal `1e400` is how a real file
  // can carry `Infinity` through `JSON.parse` while still being syntactically valid.
  it.each([
    ['Infinity', '1e400', Infinity],
    ['-Infinity', '-1e400', -Infinity],
  ])('defaults a non-finite createdAt (%s) instead of importing it verbatim', async (_label, literal, badValue) => {
    pickSnippetsImportPath.mockResolvedValue('C:/tmp/in.json');
    importSnippetsFile.mockResolvedValue(
      `{"version":1,"exportedAt":1,"snippets":[{"id":"f1","text":"bad timestamp","createdAt":${literal}}]}`,
    );

    const result = await importSnippets([]);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.imported).toBe(1);
    expect(Number.isFinite(result.added[0].createdAt)).toBe(true);
    expect(result.added[0].createdAt).not.toBe(badValue);
  });

  it('preserves folder and tags on an imported record', async () => {
    pickSnippetsImportPath.mockResolvedValue('C:/tmp/in.json');
    importSnippetsFile.mockResolvedValue(
      file([snip({ id: 'f1', text: 'k get pods', label: 'Pods', folder: 'K8s', tags: ['ops'] })])
    );

    const result = await importSnippets([]);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.added[0]).toMatchObject({
      text: 'k get pods',
      label: 'Pods',
      folder: 'K8s',
      tags: ['ops'],
    });
  });

  it('reports a clear reason when the host has no import bridge at all', async () => {
    (window as any).electronAPI = {};
    const result = await importSnippets([]);
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected failure');
    // B-04: named "reports a clear reason" but never checked one — an implementation
    // that threw the picker-failure or read-failure generic fallback instead of the
    // host-unavailable message would still pass `ok === false`.
    expect(result.reason).toBe('Importing snippets is not available in this host.');
  });
});

/* ── plan/030 — cross-product import ──────────────────────────────────────────────── */

describe('importSnippets — InkSpoke and Rephlo (plan/030)', () => {
  /** Feed `importSnippets` a whole envelope, however shaped, through the mocked host. */
  const givenFile = (envelope: unknown): void => {
    pickSnippetsImportPath.mockResolvedValue('C:/tmp/in.json');
    importSnippetsFile.mockResolvedValue(JSON.stringify(envelope));
  };

  const inkSpokeMapping = (
    over: Record<string, unknown>,
    params: Record<string, unknown> | string = { Text: 'body' },
  ): Record<string, unknown> => ({
    Id: 'm-1',
    SpokenPhrase: 'phrase',
    ActionType: 'SendKeys',
    ActionParamsJson: typeof params === 'string' ? params : JSON.stringify(params),
    IsEnabled: true,
    IsParameterized: false,
    ...over,
  });

  it('AC: a valid InkSpoke export becomes snippets tagged InkSpoke', async () => {
    givenFile({
      SchemaVersion: 2,
      ExportedAt: '2026-09-04T21:40:20Z',
      Groups: [{ Id: 'g1', Name: 'Terminal' }],
      Mappings: [
        inkSpokeMapping({ Id: 'a', SpokenPhrase: 'list files', GroupId: 'g1' }, { Text: 'ls -la' }),
        inkSpokeMapping({ Id: 'b', ActionType: 'OpenUrl' }, { Url: 'https://example.test' }),
      ],
    });

    const result = await importSnippets([]);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.format).toBe('inkspoke');
    expect(result.imported).toBe(2);
    expect(result.added.every((s) => s.tags?.includes('InkSpoke'))).toBe(true);
    expect(result.added[0]).toMatchObject({ text: 'ls -la', label: 'list files', folder: 'Terminal' });
    // The SECOND record's body too. Asserting only the first lets an implementation that
    // reads the URL from the wrong key — or drops it — still satisfy `imported === 2`.
    expect(result.added[1]).toMatchObject({ text: 'https://example.test', folder: undefined });
    // A fresh id and a real timestamp, exactly as the TermFlow path mints them (D9).
    expect(result.added.map((s) => s.id)).toEqual(result.added.map((s) => expect.stringMatching(/^sn-/)));
    expect(result.added.every((s) => Number.isFinite(s.createdAt))).toBe(true);
  });

  it('AC: a valid Rephlo export becomes snippets tagged Rephlo', async () => {
    givenFile({
      version: '1.3',
      exportedAt: '2026-09-04T21:42:39Z',
      commands: [
        { name: 'Rewrite', instruction: 'rewrite this text', groupName: 'Developing', isArchived: false },
      ],
    });

    const result = await importSnippets([]);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.format).toBe('rephlo');
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({
      text: 'rewrite this text',
      label: 'Rewrite',
      folder: 'Developing',
      tags: ['Rephlo'],
    });
  });

  it('AC: a native TermFlow export still reports format termflow and nothing unsupported', async () => {
    givenFile({ version: 1, exportedAt: 1, snippets: [snip({ text: 'unchanged' })] });

    const result = await importSnippets([]);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result).toMatchObject({ format: 'termflow', imported: 1, skippedUnsupported: 0 });
    expect(result.added[0].text).toBe('unchanged');
  });

  it('AC: valid records import while malformed ones in the SAME file are rejected', async () => {
    givenFile({
      SchemaVersion: 2,
      Mappings: [
        inkSpokeMapping({ Id: 'ok-1' }, { Text: 'first' }),
        inkSpokeMapping({ Id: 'broken' }, ''), // the real file's empty ActionParamsJson
        inkSpokeMapping({ Id: 'ok-2' }, { Text: 'second' }),
      ],
    });

    const result = await importSnippets([]);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.added.map((s) => s.text)).toEqual(['first', 'second']);
    expect(result.rejected).toBe(1);
  });

  it('AC: an imported command with text identical to an existing snippet is skipped', async () => {
    givenFile({
      SchemaVersion: 2,
      Mappings: [
        // Distinct SpokenPhrases on purpose. With the fixture's shared default phrase,
        // an implementation that de-duplicated on the LABEL rather than the text would
        // collapse these three identically and the test could not tell the two rules
        // apart. Here the labels are all different and only the texts collide.
        inkSpokeMapping({ Id: 'dupe-of-local', SpokenPhrase: 'say hello' }, { Text: 'already here' }),
        inkSpokeMapping({ Id: 'fresh', SpokenPhrase: 'do the new thing' }, { Text: 'brand new' }),
        inkSpokeMapping({ Id: 'dupe-in-file', SpokenPhrase: 'a different phrase' }, { Text: 'brand new' }),
      ],
    });

    // Dedup must compare the text a mapping PRODUCES, not its raw record — which is only
    // true because the merge stage runs after conversion, once, for every format.
    const result = await importSnippets([snip({ id: 'sn-local', text: 'already here' })]);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.added.map((s) => s.text)).toEqual(['brand new']);
    // The survivor is the FIRST of the colliding pair, carrying its own label — not the
    // last one seen, and not a merge of the two.
    expect(result.added.map((s) => s.label)).toEqual(['do the new thing']);
    expect(result.skippedDuplicates).toBe(2);
  });

  it('AC: an unsupported JSON file adds nothing and says so clearly', async () => {
    givenFile({ tool: 'something-else', items: [{ cmd: 'ls' }] });

    const result = await importSnippets([]);
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected failure');
    expect(result).not.toHaveProperty('added');
    // Names all three, because "not a TermFlow export" would now be a lie: an InkSpoke
    // file genuinely IS readable, and the user needs to tell refusal from bug.
    expect(result.reason).toContain('TermFlow');
    expect(result.reason).toContain('InkSpoke');
    expect(result.reason).toContain('Rephlo');
  });

  it('a file that merely has a `commands` key is unsupported, not parsed as Rephlo', async () => {
    // Without the corroborating version check this would import as Rephlo and report
    // "rejected 2 malformed", which reads as "your file is broken" rather than
    // "this is not one of ours".
    givenFile({ commands: ['ls', 'cd'] });

    const result = await importSnippets([]);
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected failure');
    expect(result.reason).toContain('InkSpoke');
  });

  it('accounts for every record in FOUR buckets, not three', async () => {
    givenFile({
      SchemaVersion: 2,
      Mappings: [
        inkSpokeMapping({ Id: 'i1' }, { Text: 'fresh a' }),
        inkSpokeMapping({ Id: 'i2' }, { Text: 'fresh b' }),
        inkSpokeMapping({ Id: 'i3' }, { Text: 'already here' }), // duplicate of existing
        inkSpokeMapping({ Id: 'i4' }, { Text: 'fresh a' }), // within-file duplicate
        inkSpokeMapping({ Id: 'i5' }, ''), // malformed params
        inkSpokeMapping({ Id: 'i6', ActionType: 'CloseApp' }, { AppIdentifier: 'auto' }),
        inkSpokeMapping({ Id: 'i7' }, { Text: 'Y2lwaGVy', IsSecret: true, Nonce: 'bm9uY2U=' }),
      ],
    });

    const result = await importSnippets([snip({ id: 'sn-local', text: 'already here' })]);
    if (result.ok !== true) throw new Error('expected ok');
    expect(
      result.imported + result.skippedDuplicates + result.rejected + result.skippedUnsupported,
    ).toBe(7);
    expect(result.imported).toBe(2);
    expect(result.skippedDuplicates).toBe(2);
    expect(result.rejected).toBe(1);
    expect(result.skippedUnsupported).toBe(2); // the app action AND the encrypted one
    expect(result.added).toHaveLength(result.imported);
  });

  it('never lets an encrypted InkSpoke payload reach the store', async () => {
    // The strongest statement of plan/030 D5, made at the boundary the user actually
    // touches rather than only inside the converter.
    givenFile({
      SchemaVersion: 2,
      Mappings: [inkSpokeMapping({ Id: 'secret' }, { Text: 'Y2lwaGVydGV4dA==', IsSecret: true })],
    });

    const result = await importSnippets([]);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.added).toEqual([]);
    expect(result.skippedUnsupported).toBe(1);
  });

  it('still refuses a wrong-version TermFlow file rather than guessing a foreign format', async () => {
    // Detection must not steal this case: the honest answer names the version.
    givenFile({ version: 2, exportedAt: 1, snippets: [snip()] });

    const result = await importSnippets([]);
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected failure');
    expect(result.reason).toContain('version');
    expect(result.reason).not.toContain('InkSpoke');
  });

  it('a MIXED envelope still reaches the TermFlow version refusal, not a foreign parser', async () => {
    // The disjoint fixture above cannot see this: with the foreign checks first, an
    // envelope carrying both `snippets` and `commands` was consumed as an empty Rephlo
    // import — reported as a cheerful "Imported 0", the snippets silently ignored and the
    // version gate never reached. That is the failure mode the gate exists to prevent.
    givenFile({ version: '2', exportedAt: 1, snippets: [snip()], commands: [] });

    const result = await importSnippets([]);
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected failure');
    expect(result.reason).toContain('version');
    expect(result.reason).toContain('"2"');
  });

  it('a mixed InkSpoke-shaped envelope carrying `snippets` is ours, not InkSpoke’s', async () => {
    givenFile({ version: 1, exportedAt: 1, snippets: [snip({ text: 'mine' })], SchemaVersion: 2, Mappings: [] });

    const result = await importSnippets([]);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.format).toBe('termflow');
    expect(result.added.map((s) => s.text)).toEqual(['mine']);
  });
});

describe('describeImport (plan/030 §4.3)', () => {
  it('is byte-for-byte unchanged for a TermFlow import', () => {
    // The common path must not grow "skipped 0 unsupported" noise.
    expect(
      describeImport({ imported: 3, skippedDuplicates: 1, rejected: 0, skippedUnsupported: 0, format: 'termflow' }),
    ).toBe('Imported 3, skipped 1 duplicate, rejected 0 malformed.');
    // ...and it still works for a caller that knows nothing about the new fields.
    expect(describeImport({ imported: 2, skippedDuplicates: 2, rejected: 5 })).toBe(
      'Imported 2, skipped 2 duplicates, rejected 5 malformed.',
    );
  });

  it('appends the unsupported count and the source, both correctly pluralised', () => {
    expect(
      describeImport({ imported: 37, skippedDuplicates: 0, rejected: 1, skippedUnsupported: 5, format: 'inkspoke' }),
    ).toBe(
      'Imported 37, skipped 0 duplicates, rejected 1 malformed. Skipped 5 unsupported records. Source: InkSpoke export.',
    );
    expect(
      describeImport({ imported: 1, skippedDuplicates: 1, rejected: 0, skippedUnsupported: 1, format: 'rephlo' }),
    ).toBe(
      'Imported 1, skipped 1 duplicate, rejected 0 malformed. Skipped 1 unsupported record. Source: Rephlo export.',
    );
  });

  it('omits the unsupported clause at zero, even for a foreign source', () => {
    expect(
      describeImport({ imported: 5, skippedDuplicates: 0, rejected: 0, skippedUnsupported: 0, format: 'rephlo' }),
    ).toBe('Imported 5, skipped 0 duplicates, rejected 0 malformed. Source: Rephlo export.');
  });
});
