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
