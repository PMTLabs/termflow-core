/**
 * The helper every source-derived test reads through.
 *
 * Worth its own tests because the failure it prevents is invisible in the usual place: the suite
 * is green on a Linux runner and red on a Windows one, for the same commit, and the assertions
 * that break are the ones anchored on a literal `\n`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readSource } from '../readSource';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'read-source-'));
const write = (name: string, bytes: string): string => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, bytes, 'utf8');
  return p;
};

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('readSource', () => {
  it('reads an LF file unchanged', () => {
    expect(readSource(write('lf.txt', 'a\nb\nc'))).toBe('a\nb\nc');
  });

  it('reads a CRLF file as if it were LF', () => {
    expect(readSource(write('crlf.txt', 'a\r\nb\r\nc'))).toBe('a\nb\nc');
  });

  it('gives the two the same content, which is the whole point', () => {
    // Same commit, two runners, one answer.
    expect(readSource(write('a.txt', 'x\r\ny'))).toBe(readSource(write('b.txt', 'x\ny')));
  });

  /**
   * The exact shape that failed on CI: an `indexOf` for a pattern with a newline on BOTH sides.
   * Under CRLF the leading `\n` still matches (it is the second half of `\r\n`) but the trailing
   * one never does, so the search returns -1 and the test reports the code as missing.
   */
  it('makes a newline-delimited search find the same offset in both', () => {
    const body = 'const x = (\n      >\n);';
    const lf = readSource(write('p-lf.txt', body));
    const crlf = readSource(write('p-crlf.txt', body.replace(/\n/g, '\r\n')));
    expect(lf.indexOf('\n      >\n')).toBeGreaterThan(-1);
    expect(crlf.indexOf('\n      >\n')).toBe(lf.indexOf('\n      >\n'));
  });

  it('leaves a lone carriage return alone', () => {
    // Only the pair is a line ending. A stray `\r` inside a string literal in the source under
    // test is content, and rewriting it would change what the test is reading.
    expect(readSource(write('lone.txt', "a\\r b"))).toBe("a\\r b");
  });

  it('does not mind a file with no line endings at all', () => {
    expect(readSource(write('flat.txt', 'single'))).toBe('single');
  });
});
