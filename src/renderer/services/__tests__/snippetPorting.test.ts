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
import { exportSnippets, importSnippets } from '../snippetPorting';

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
  });
});
