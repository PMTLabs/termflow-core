import { isAbsolutePath, joinCwd } from '../pathResolve';

describe('isAbsolutePath', () => {
  it('detects Windows + POSIX + UNC absolute paths', () => {
    expect(isAbsolutePath('C:\\a\\b')).toBe(true);
    expect(isAbsolutePath('/usr/bin')).toBe(true);
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
    expect(isAbsolutePath('src/main.rs')).toBe(false);
    expect(isAbsolutePath('./x')).toBe(false);
    expect(isAbsolutePath('../y')).toBe(false);
  });

  it('treats ~-relative home paths as needing no cwd join', () => {
    // These resolve against the user's home directory, not the terminal's cwd, so
    // the openPath handler must route them like an absolute path (see
    // TerminalDisplay's `isAbsolutePath(rawPath) || !pid` check).
    expect(isAbsolutePath('~/.gemini/brain/state.json')).toBe(true);
    expect(isAbsolutePath('~\\scoop\\apps')).toBe(true);
    expect(isAbsolutePath('~')).toBe(true);
    // A filename that merely starts with `~` (no separator, not bare) is not
    // home-shorthand — e.g. an Office lock file `~$doc.docx`.
    expect(isAbsolutePath('~backup.txt')).toBe(false);
  });
});

describe('joinCwd', () => {
  it('joins under a Windows cwd and normalizes the relative part to backslashes', () => {
    // A forward-slash relative path (common in build/test output) must become a
    // native backslash path so Windows opens it instead of "File not found".
    expect(joinCwd('D:\\work\\proj', 'src/main.rs')).toBe('D:\\work\\proj\\src\\main.rs');
    expect(joinCwd('D:\\work\\proj', 'Rephlo.UI/ViewModels/X.cs')).toBe(
      'D:\\work\\proj\\Rephlo.UI\\ViewModels\\X.cs',
    );
  });
  it('joins under a POSIX cwd with a slash and strips leading ./', () => {
    expect(joinCwd('/home/u/proj', './src/main.rs')).toBe('/home/u/proj/src/main.rs');
  });
});
