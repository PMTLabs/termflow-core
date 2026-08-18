import fs from 'fs';

/**
 * Read a source file for a test that asserts against its TEXT, with line endings normalised.
 *
 * **This exists because of a CI failure that only happens on some runs.** A large number of tests
 * in this repo are source-derived — `CanvasMode` cannot be mounted under the root Jest config, so
 * anything expressed only in its JSX is untestable any other way — and many of them match
 * patterns containing a literal `\n`: an indexOf for `'\n      >\n'` to find where a JSX opening
 * tag closes, a slice to the `'\n    };'` that ends a handler, a regex anchored on a line start.
 *
 * Every one of those silently becomes `-1` under CRLF, because `>` is then followed by `\r`. And
 * whether the checkout is CRLF is **not a property of the commit**: the e2e job is
 * `runs-on: [self-hosted]` with no OS label, so it lands on a Linux box (LF, green) or the
 * Windows box (autocrlf → CRLF, red) depending on which is free. The same commit passes and fails
 * on re-run, which reads exactly like a flaky test and is not one — the assertion is simply
 * unsatisfiable on half the fleet.
 *
 * Normalising here rather than adding `.gitattributes` is deliberate: `text eol=lf` would fix the
 * checkout and leave every one of these tests still unable to run against a CRLF file, which is
 * what a contributor cloning with default Windows settings has. The test should not care.
 */
export function readSource(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

export default readSource;
