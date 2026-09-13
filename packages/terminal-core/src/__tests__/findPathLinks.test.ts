import { findPathLinks } from '../TerminalEngine';

describe('findPathLinks', () => {
  it('matches a Windows absolute path with line:col', () => {
    const text = 'error at C:\\src\\main.rs:42:7 today';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('C:\\src\\main.rs');
    expect(m.line).toBe(42);
    expect(m.col).toBe(7);
    expect(text.slice(m.start, m.end)).toBe('C:\\src\\main.rs');
  });

  it('matches a Windows drive path that uses forward slashes (D:/...)', () => {
    // Many tools (and agent Edit()/Write() logs) print Windows paths with `/`.
    const text = 'Edit(D:/sources/work/rephlo/spikes/RagPoc/Program.cs)';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('D:/sources/work/rephlo/spikes/RagPoc/Program.cs');
  });

  it('keeps drive + line:col on a forward-slash Windows path', () => {
    const [m] = findPathLinks('at D:/a/b/main.rs:10:2 fails');
    expect(m.path).toBe('D:/a/b/main.rs');
    expect(m.line).toBe(10);
    expect(m.col).toBe(2);
  });

  it('does not mistake a URL scheme (http://) for a drive path', () => {
    for (const m of findPathLinks('see https://example.com/a/b.html')) {
      expect(m.path.startsWith('p:')).toBe(false);
      expect(m.path).not.toContain('://');
    }
  });

  it('matches a POSIX absolute path', () => {
    const [m] = findPathLinks('see /usr/lib/foo.so for details');
    expect(m.path).toBe('/usr/lib/foo.so');
  });

  it('matches a relative path with a line number', () => {
    const [m] = findPathLinks('  src/app/main.ts:10  ');
    expect(m.path).toBe('src/app/main.ts');
    expect(m.line).toBe(10);
    expect(m.col).toBeUndefined();
  });

  it('matches a ./ relative path', () => {
    const [m] = findPathLinks('open ./scripts/build.sh now');
    expect(m.path).toBe('./scripts/build.sh');
  });

  it('matches Windows backslash relative paths', () => {
    const [a] = findPathLinks('error in .\\src\\main.rs:42');
    expect(a.path).toBe('.\\src\\main.rs');
    expect(a.line).toBe(42);
    const [b] = findPathLinks('see src\\app\\index.ts here');
    expect(b.path).toBe('src\\app\\index.ts');
  });

  it('matches a multi-segment relative path with a dotted directory', () => {
    // Real-world failing case: a C# source path with a dotted folder name.
    const [m] = findPathLinks('  Rephlo.UI/ViewModels/SyncStatusBannerViewModel.cs  ');
    expect(m.path).toBe('Rephlo.UI/ViewModels/SyncStatusBannerViewModel.cs');
  });

  it('strips a trailing ) that wraps the path (markdown / tool-log style)', () => {
    const text = 'Write(D:\\sources\\work\\rephlo\\docs\\plan\\312-plan.md)';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('D:\\sources\\work\\rephlo\\docs\\plan\\312-plan.md');
    expect(text.slice(m.start, m.end)).toBe('D:\\sources\\work\\rephlo\\docs\\plan\\312-plan.md');
  });

  it('strips trailing sentence punctuation but keeps balanced parens in the name', () => {
    expect(findPathLinks('see (/usr/lib/foo.so)')[0].path).toBe('/usr/lib/foo.so');
    expect(findPathLinks('open /tmp/report.txt.')[0].path).toBe('/tmp/report.txt');
    expect(findPathLinks('cat /tmp/file(1).txt here')[0].path).toBe('/tmp/file(1).txt');
  });

  it('does not match a bare word or a flag', () => {
    expect(findPathLinks('just some words and --flag=value')).toHaveLength(0);
  });

  it('does not match git branch / ref shapes (no file extension)', () => {
    // These are git refs, not file paths — the bare-path branch must require a
    // file extension so word/word slugs drop out.
    expect(findPathLinks('on branch feature/audit-chat-render-perf today')).toHaveLength(0);
    expect(findPathLinks('PR 203 feature/audit-sse-async-read = D1-01')).toHaveLength(0);
    expect(findPathLinks('git log origin/develop and origin/main')).toHaveLength(0);
  });

  it('does not match a git range expression (origin/a...origin/b)', () => {
    const text = 'origin/develop...origin/feature/audit-vm-event-leak-cluster';
    expect(findPathLinks(text)).toHaveLength(0);
  });

  it('does not treat a slash inside word/word as a POSIX absolute path', () => {
    // The `/` in `origin/feature` must not start a bogus absolute-path match.
    expect(findPathLinks('compare origin/feature/x with main')).toHaveLength(0);
  });

  it('matches a ~/ home-relative path and keeps the tilde', () => {
    // Real-world failing case: an agent's config path printed with `~/`. Before the
    // ~ branch existed, the POSIX-abs alternative matched starting at the `/` right
    // after the tilde (its lookbehind doesn't exclude `~`), so the match silently
    // dropped the `~` and produced a bogus filesystem-root path.
    const text = '~/.gemini/antigravity-cli/brain/b0a98b22-2a03-4265-9adc-9b615e1b9b08/terminal_monitor_state.json';
    const [m] = findPathLinks(text);
    expect(m.path).toBe(text);
    expect(text.slice(m.start, m.end)).toBe(text);
  });

  it('matches a ~\\ home-relative path (Windows separator)', () => {
    const [m] = findPathLinks('open ~\\scoop\\apps\\config.json now');
    expect(m.path).toBe('~\\scoop\\apps\\config.json');
  });

  it('matches a ~/ path with a line:col suffix', () => {
    const [m] = findPathLinks('at ~/src/main.rs:42:7 today');
    expect(m.path).toBe('~/src/main.rs');
    expect(m.line).toBe(42);
    expect(m.col).toBe(7);
  });

  it('does not match a bare ~ or a tilde mid-word', () => {
    expect(findPathLinks('cd ~ now')).toHaveLength(0);
    expect(findPathLinks('roughly ~5 items changed')).toHaveLength(0);
  });

  it('matches the Claude Update parenthesized bare filename', () => {
    const text = 'Update(015-x.html)';
    const [m] = findPathLinks(text);
    expect(text.slice(m.start, m.end)).toBe('015-x.html');
    expect(m.path).toBe('015-x.html');
  });

  it('matches the Claude Read parenthesized bare filename', () => {
    const text = 'Read(README.md)';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('README.md');
    expect(text.slice(m.start, m.end)).toBe('README.md');
  });

  it('matches the Claude Write parenthesized bare filename', () => {
    const text = 'Write(a.md)';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('a.md');
    expect(text.slice(m.start, m.end)).toBe('a.md');
  });

  it('matches the Claude Edit parenthesized bare filename', () => {
    const text = 'Edit(b.ts)';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('b.ts');
    expect(text.slice(m.start, m.end)).toBe('b.ts');
  });

  it('matches the Claude MultiEdit parenthesized bare filename', () => {
    const text = 'MultiEdit(c.py)';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('c.py');
    expect(text.slice(m.start, m.end)).toBe('c.py');
  });

  it('matches the Claude NotebookEdit parenthesized bare filename', () => {
    const text = 'NotebookEdit(d.ipynb)';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('d.ipynb');
    expect(text.slice(m.start, m.end)).toBe('d.ipynb');
  });

  it('matches the Claude Create parenthesized bare filename', () => {
    const text = 'Create(e.rs)';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('e.rs');
    expect(text.slice(m.start, m.end)).toBe('e.rs');
  });

  it('matches the Claude Delete parenthesized bare filename', () => {
    const text = 'Delete(f.go)';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('f.go');
    expect(text.slice(m.start, m.end)).toBe('f.go');
  });

  it('matches the Claude Remove parenthesized bare filename', () => {
    const text = 'Remove(g.cs)';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('g.cs');
    expect(text.slice(m.start, m.end)).toBe('g.cs');
  });

  it('matches lower-case opencode read()', () => {
    const text = 'read(app.tsx)';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('app.tsx');
    expect(text.slice(m.start, m.end)).toBe('app.tsx');
  });

  it('matches lower-case opencode write()', () => {
    const text = 'write(x.md)';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('x.md');
    expect(text.slice(m.start, m.end)).toBe('x.md');
  });

  it('matches lower-case opencode edit()', () => {
    const text = 'edit(y.js)';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('y.js');
    expect(text.slice(m.start, m.end)).toBe('y.js');
  });

  it('matches a Codex Read space-prefixed bare filename', () => {
    const text = 'Read foo.ts';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('foo.ts');
    expect(text.slice(m.start, m.end)).toBe('foo.ts');
  });

  it('matches a Codex Edited space-prefixed bare filename', () => {
    const text = 'Edited main.rs (+3 -1)';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('main.rs');
    expect(text.slice(m.start, m.end)).toBe('main.rs');
  });

  it('matches a Gemini ReadFile space-prefixed bare filename', () => {
    const text = '✓ ReadFile config.yaml';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('config.yaml');
    expect(text.slice(m.start, m.end)).toBe('config.yaml');
  });

  it('matches a Gemini WriteFile space-prefixed bare filename', () => {
    const text = 'WriteFile out.json';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('out.json');
    expect(text.slice(m.start, m.end)).toBe('out.json');
  });

  it('matches a Gemini ReadFile colon-prefixed bare filename', () => {
    const text = 'ReadFile: a.md';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('a.md');
    expect(text.slice(m.start, m.end)).toBe('a.md');
  });

  it('keeps the :line:col suffix on a verb-prefixed bare filename', () => {
    const text = 'Write(notes.md:12:3)';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('notes.md');
    expect(m.line).toBe(12);
    expect(m.col).toBe(3);
    expect(text.slice(m.start, m.end)).toBe('notes.md');
  });

  it('keeps a full separator path in Update(docs/015-x.html)', () => {
    const text = 'Update(docs/015-x.html)';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('docs/015-x.html');
    expect(text.slice(m.start, m.end)).toBe('docs/015-x.html');
  });

  it('keeps a dotted-directory separator path in Update(src.v2/main.rs)', () => {
    const text = 'Update(src.v2/main.rs)';
    const [m] = findPathLinks(text);
    expect(m.path).toBe('src.v2/main.rs');
    expect(text.slice(m.start, m.end)).toBe('src.v2/main.rs');
  });

  it('does not match a version string after Update', () => {
    // The final extension must start with a letter, so v1.2.3 stays ordinary text.
    expect(findPathLinks('Update v1.2.3')).toHaveLength(0);
  });

  it('does not link a digit-first extension after a verb (the documented .7z tradeoff)', () => {
    // Same letter-first rule as above, seen from the other side: this is the cost
    // PATH_RE's branch-6 comment names. Pinned so a later widening is deliberate.
    expect(findPathLinks('Read(archive.7z)')).toHaveLength(0);
  });

  it('does not match a non-file Bash tool row', () => {
    expect(findPathLinks('Bash(git status)')).toHaveLength(0);
  });

  it('does not match a non-file Glob tool row', () => {
    expect(findPathLinks('Glob(**/*.ts)')).toHaveLength(0);
  });

  it('does not match a non-file Grep tool row', () => {
    expect(findPathLinks('Grep(foo.bar)')).toHaveLength(0);
  });

  it('does not match a non-file Search tool row', () => {
    expect(findPathLinks('Search(x.y)')).toHaveLength(0);
  });

  it('does not match Read followed by a line count', () => {
    expect(findPathLinks('⎿  Read 120 lines')).toHaveLength(0);
  });

  it('does not match Updated followed by a file count', () => {
    expect(findPathLinks('Updated 3 files')).toHaveLength(0);
  });

  it('does not match a bare filename in FAILED output without a file verb', () => {
    expect(findPathLinks('FAILED 17 tests in automationSteps.test.ts')).toHaveLength(0);
  });

  it('does not match Unread because the verb must start at a word boundary', () => {
    expect(findPathLinks('Unread foo.ts')).toHaveLength(0);
  });

  it('does not match package.json in plain prose', () => {
    expect(findPathLinks('package.json')).toHaveLength(0);
  });
});
