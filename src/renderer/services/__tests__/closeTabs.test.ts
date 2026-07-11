import {
  isShellName,
  filterMeaningfulProcesses,
  computeAffectedTabs,
} from '../closeTabs';

describe('isShellName', () => {
  it.each(['pwsh', 'powershell', 'bash', 'sh', 'zsh', 'cmd', 'fish'])(
    'treats %s as a bare shell',
    (name) => expect(isShellName(name)).toBe(true),
  );

  it('is case-insensitive', () => {
    expect(isShellName('PWSH')).toBe(true);
    expect(isShellName('Bash')).toBe(true);
  });

  it('ignores a trailing .exe', () => {
    expect(isShellName('cmd.exe')).toBe(true);
    expect(isShellName('pwsh.exe')).toBe(true);
    expect(isShellName('PowerShell.EXE')).toBe(true);
  });

  it('tolerates a full path', () => {
    expect(isShellName('C:\\Windows\\System32\\cmd.exe')).toBe(true);
    expect(isShellName('/bin/bash')).toBe(true);
  });

  it('does not match real foreground processes', () => {
    for (const name of ['node', 'vim', 'npm', 'python', 'git', 'docker']) {
      expect(isShellName(name)).toBe(false);
    }
  });

  it('returns false for empty / whitespace', () => {
    expect(isShellName('')).toBe(false);
    expect(isShellName('   ')).toBe(false);
  });
});

describe('filterMeaningfulProcesses', () => {
  it('drops bare shells', () => {
    expect(filterMeaningfulProcesses(['pwsh', 'node', 'bash'])).toEqual(['node']);
  });

  it('drops empties and whitespace-only entries', () => {
    expect(filterMeaningfulProcesses(['', '  ', 'node'])).toEqual(['node']);
  });

  it('de-duplicates case-insensitively, preserving first-seen casing and order', () => {
    expect(filterMeaningfulProcesses(['Node', 'node', 'vim', 'NODE'])).toEqual(['Node', 'vim']);
  });

  it('returns [] when only shells are present (idle terminal)', () => {
    expect(filterMeaningfulProcesses(['pwsh', 'pwsh.exe', 'cmd'])).toEqual([]);
  });

  it('keeps order of distinct meaningful processes', () => {
    expect(filterMeaningfulProcesses(['npm', 'node', 'esbuild'])).toEqual([
      'npm',
      'node',
      'esbuild',
    ]);
  });
});

describe('computeAffectedTabs', () => {
  const tabs = ['a', 'b', 'c', 'd']; // display order

  it('single → just the clicked tab', () => {
    expect(computeAffectedTabs(tabs, 'b', 'single')).toEqual(['b']);
  });

  it('right → tabs after the clicked one, in order', () => {
    expect(computeAffectedTabs(tabs, 'b', 'right')).toEqual(['c', 'd']);
  });

  it('right on the last tab → empty', () => {
    expect(computeAffectedTabs(tabs, 'd', 'right')).toEqual([]);
  });

  it('left → tabs before the clicked one, in order', () => {
    expect(computeAffectedTabs(tabs, 'c', 'left')).toEqual(['a', 'b']);
  });

  it('left on the first tab → empty', () => {
    expect(computeAffectedTabs(tabs, 'a', 'left')).toEqual([]);
  });

  it('others → every tab except the clicked one', () => {
    expect(computeAffectedTabs(tabs, 'b', 'others')).toEqual(['a', 'c', 'd']);
  });

  it('others with a single tab → empty', () => {
    expect(computeAffectedTabs(['only'], 'only', 'others')).toEqual([]);
  });

  it('returns [] when the clicked tab is not present', () => {
    expect(computeAffectedTabs(tabs, 'z', 'right')).toEqual([]);
    expect(computeAffectedTabs(tabs, 'z', 'single')).toEqual([]);
  });
});
