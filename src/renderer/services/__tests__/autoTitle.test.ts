/**
 * Which OSC titles a tab adopts.
 *
 * `cmd.exe` announces its own full path as its terminal title, so a "Command Prompt" tab
 * renamed itself to `C:\WINDOWS\system32\cmd.exe` a frame after opening. Reported 2026-08-17
 * against Canvas Mode — a group frame is labelled with its tab's title — but the tab strip had
 * been showing it all along.
 *
 * The risk in fixing it is the opposite mistake: a rule broad enough to also swallow the
 * titles that carry real information. Most of what follows is that half.
 */
import { isExecutablePathTitle, shouldAdoptAutoTitle } from '../autoTitle';

describe('titles that are just the shell naming its own binary', () => {
  it.each([
    ['C:\\WINDOWS\\system32\\cmd.exe'],          // the report
    ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
    ['C:/Program Files/PowerShell/7/pwsh.exe'],  // forward slashes on Windows: Git Bash, WSL
    ['cmd.exe'],                                 // the same uselessness without a path
    ['/usr/bin/env.com'],
    ['C:\\tools\\run.BAT'],                      // extension match is case-insensitive
    ['  C:\\WINDOWS\\system32\\cmd.exe  '],      // padded
  ])('refuses %s', (title) => {
    expect(isExecutablePathTitle(title)).toBe(true);
    expect(shouldAdoptAutoTitle(title)).toBe(false);
  });

  /**
   * Nothing filtered an empty title, so a shell clearing its own left a nameless tab and an
   * unlabelled group. A much smaller bug, living in exactly the line being changed.
   */
  it.each([[''], ['   '], ['\t\n']])('refuses the empty title %j', (title) => {
    expect(shouldAdoptAutoTitle(title)).toBe(false);
  });

  it('refuses a path with a trailing separator', () => {
    expect(shouldAdoptAutoTitle('C:\\WINDOWS\\')).toBe(false);
  });
});

describe('titles that carry information, which must survive', () => {
  /**
   * The half that matters. A rule like "contains a path separator" or "contains .exe" would
   * pass every test above and quietly destroy all of these — and the loss is invisible,
   * because a tab that keeps its profile name looks perfectly fine.
   */
  it.each([
    ['C:\\Users\\user\\projects\\app'],    // a directory IS the useful case
    ['~/src/app'],
    ['/home/user'],
    ['dev@box: ~/src/app'],                 // the classic bash PROMPT_COMMAND title
    ['npm run build'],
    ['vim'],
    ['build.cmd (~/scripts) - VIM'],             // ends in the program, not the extension
    ['Deploying to C:\\srv\\app.exe now'],       // mentions an exe, is not one
    ['claude'],
    ['● app — 3 changes'],
  ])('adopts %s', (title) => {
    expect(isExecutablePathTitle(title)).toBe(false);
    expect(shouldAdoptAutoTitle(title)).toBe(true);
  });

  /**
   * A directory whose own name ends in something exe-like is the nastiest near-miss, and it is
   * real: plenty of repos have a `bin` or a `scripts.cmd` folder. This one is genuinely
   * ambiguous and the test records which way it was decided — refused, because the segment is
   * indistinguishable from a binary and a lost directory title costs less than a path in the
   * tab strip.
   */
  it('treats a directory that looks like a binary as a binary, knowingly', () => {
    expect(shouldAdoptAutoTitle('C:\\work\\scripts.cmd')).toBe(false);
  });
});
