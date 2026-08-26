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
});
