import { findUrlLinks, findPathLinks, URL_RE } from '../TerminalEngine';

/**
 * The URL matcher behind both the terminal's underline and the menu's "Copy Link"
 * (Tam, 2026-08-21).
 *
 * The claim that matters most here is not any single URL shape — it is that there is ONE
 * pattern. `URL_RE` is handed to `WebLinksAddon` via `ILinkProviderOptions.urlRegex`, so what
 * xterm underlines and what `getLinkAt` finds are the same question asked once. A second regex
 * written for the menu would produce a class of defect nobody can find on purpose: a link drawn
 * underlined with no Copy Link on it, or a Copy Link offered over text that is not a link.
 */
describe('URL_RE is the single source of truth', () => {
  /**
   * NOT global. The object is SHARED with the addon, and a `/g` regex carries `lastIndex`
   * between calls — the addon would resume scanning from wherever our last scan stopped, so a
   * URL would underline on one hover and not the next. `findUrlLinks` clones it per scan.
   */
  it('is not a global regex', () => {
    expect(URL_RE.global).toBe(false);
  });

  it('is handed to WebLinksAddon rather than left to its private default', () => {
    // Source-derived: the wiring is a constructor argument and has no runtime handle here —
    // the addon is mocked in this package's jest config.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const src: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../TerminalEngine.ts'), 'utf-8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(src).toMatch(/new WebLinksAddon\([\s\S]*?\{\s*urlRegex:\s*URL_RE\s*\}\s*\)/);
  });

  /**
   * The pattern is the addon's own default, copied deliberately so that adopting it changes
   * WHERE the answer lives and not WHICH urls are detected. If a future xterm changes its
   * default, this test does not fail — nor should it: ours is now the one in use. It is here to
   * record that the two started identical.
   */
  it('still requires a scheme, like the addon it came from', () => {
    expect(URL_RE.source).toContain('https?');
    expect('example.com/foo').not.toMatch(URL_RE);
    expect('www.example.com').not.toMatch(URL_RE);
  });
});

describe('findUrlLinks', () => {
  const urls = (text: string) => findUrlLinks(text).map((u) => u.url);

  it('finds a plain http and https url', () => {
    expect(urls('see http://example.com now')).toEqual(['http://example.com']);
    expect(urls('see https://example.com now')).toEqual(['https://example.com']);
  });

  it('finds several on one line, in order', () => {
    expect(urls('a https://one.test b https://two.test c'))
      .toEqual(['https://one.test', 'https://two.test']);
  });

  it('keeps a path, query and fragment', () => {
    expect(urls('https://ex.test/a/b?c=1&d=2#frag'))
      .toEqual(['https://ex.test/a/b?c=1&d=2#frag']);
  });

  /** Terminal output ends sentences. The trailing stop is not part of the address. */
  it('leaves sentence punctuation out of the match', () => {
    expect(urls('go to https://example.com.')).toEqual(['https://example.com']);
    expect(urls('go to https://example.com, then')).toEqual(['https://example.com']);
    expect(urls('(https://example.com)')).toEqual(['https://example.com']);
  });

  it('reports offsets that actually index the text', () => {
    const text = 'see https://example.com/x here';
    const [hit] = findUrlLinks(text);
    expect(text.slice(hit.start, hit.end)).toBe(hit.url);
  });

  it('finds nothing in ordinary output', () => {
    expect(urls('$ git status')).toEqual([]);
    expect(urls('')).toEqual([]);
  });

  /**
   * Guard on the loop, not on the pattern: a zero-length match would spin `re.exec` forever and
   * hang the renderer on a right-click. The pattern cannot produce one, but the loop's advance
   * is the invariant, so it gets a case rather than an assumption.
   */
  it('terminates on input designed to stress the scan', () => {
    expect(() => findUrlLinks(`${'https://a.test '.repeat(200)}tail`)).not.toThrow();
    expect(findUrlLinks(`${'https://a.test '.repeat(200)}tail`)).toHaveLength(200);
  });
});

/**
 * URLs and paths overlap, and `getLinkAt` resolves the overlap by testing URLs FIRST. These pin
 * that the ambiguity is real — without them, the ordering in `getLinkAt` looks arbitrary and
 * would survive being "tidied" the other way round, which offers "Copy Path" over the tail of
 * every link in the terminal.
 */
describe('a url is also shaped like a path', () => {
  it('both matchers claim the same text', () => {
    const text = 'fetch https://example.com/a/b.txt done';
    expect(findUrlLinks(text)).toHaveLength(1);
    expect(findPathLinks(text).length).toBeGreaterThan(0);
  });

  it('and the path matcher grabs only part of it, which is why url wins', () => {
    const text = 'fetch https://example.com/a/b.txt done';
    const url = findUrlLinks(text)[0];
    const path = findPathLinks(text)[0];
    expect(url.url).toBe('https://example.com/a/b.txt');
    // The path match is a fragment of the URL, not the whole address — copying it would put a
    // meaningless string on the clipboard.
    expect(path.path).not.toBe(url.url);
  });
});
