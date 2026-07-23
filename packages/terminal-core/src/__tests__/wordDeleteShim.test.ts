import { isPosixShell, decideWordDeleteShim } from '../TerminalEngine';

describe('isPosixShell', () => {
  test('cmd -> false', () => {
    expect(isPosixShell('cmd')).toBe(false);
  });
  test('powershell -> false', () => {
    expect(isPosixShell('powershell')).toBe(false);
  });
  test('pwsh -> false', () => {
    expect(isPosixShell('pwsh')).toBe(false);
  });
  test('case-insensitive match', () => {
    expect(isPosixShell('PowerShell')).toBe(false);
  });
  test('bash -> true', () => {
    expect(isPosixShell('bash')).toBe(true);
  });
  test('zsh -> true', () => {
    expect(isPosixShell('zsh')).toBe(true);
  });
  test('git-bash (real profile id from pty_manager.rs) -> true', () => {
    expect(isPosixShell('git-bash')).toBe(true);
  });
  test('fish -> true', () => {
    expect(isPosixShell('fish')).toBe(true);
  });
  test('cygwin -> true', () => {
    expect(isPosixShell('cygwin')).toBe(true);
  });
  test('wsl -> true', () => {
    expect(isPosixShell('wsl')).toBe(true);
  });
  test('wsl-ubuntu (real WSL profile id format: wsl-<distro>) -> true', () => {
    expect(isPosixShell('wsl-ubuntu')).toBe(true);
  });
  test('default -> false (ambiguous placeholder, e.g. StateManager.resetToDefaultLayout, often resolves to PowerShell — must NOT default to POSIX)', () => {
    expect(isPosixShell('default')).toBe(false);
  });
  test('settings (the Settings pseudo-tab) -> false', () => {
    expect(isPosixShell('settings')).toBe(false);
  });
  test('unrecognized custom profile id -> false (safer default)', () => {
    expect(isPosixShell('custom-my-shell')).toBe(false);
  });
  test('undefined -> false (safer default)', () => {
    expect(isPosixShell(undefined)).toBe(false);
  });
});

describe('decideWordDeleteShim', () => {
  const bashCtx = (overrides: Partial<{
    isNormalBuffer: boolean; protocolActive: boolean; shellType: string | undefined;
  }> = {}) => ({
    isNormalBuffer: true,
    protocolActive: false,
    shellType: 'bash',
    ...overrides,
  });
  const ctrlOnly = { ctrlKey: true, altKey: false, shiftKey: false, metaKey: false };
  const noMods = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };

  test('Ctrl+Backspace on bash at a plain prompt -> ESC DEL (backward-kill-word)', () => {
    const ctx = bashCtx();
    expect(decideWordDeleteShim('Backspace', ctrlOnly, ctx.isNormalBuffer, ctx.protocolActive, ctx.shellType))
      .toBe('\x1b\x7f');
  });

  test('Ctrl+Delete on bash at a plain prompt -> ESC d (kill-word)', () => {
    const ctx = bashCtx();
    expect(decideWordDeleteShim('Delete', ctrlOnly, ctx.isNormalBuffer, ctx.protocolActive, ctx.shellType))
      .toBe('\x1bd');
  });

  test('cmd shellType -> null (defers to Win32-Input-Mode)', () => {
    const ctx = bashCtx({ shellType: 'cmd' });
    expect(decideWordDeleteShim('Backspace', ctrlOnly, ctx.isNormalBuffer, ctx.protocolActive, ctx.shellType))
      .toBeNull();
  });

  test('powershell shellType -> null (defers to Win32-Input-Mode)', () => {
    const ctx = bashCtx({ shellType: 'powershell' });
    expect(decideWordDeleteShim('Delete', ctrlOnly, ctx.isNormalBuffer, ctx.protocolActive, ctx.shellType))
      .toBeNull();
  });

  test("'default' shellType -> null (ambiguous placeholder must not be shimmed, even though it often IS a real PowerShell session)", () => {
    const ctx = bashCtx({ shellType: 'default' });
    expect(decideWordDeleteShim('Backspace', ctrlOnly, ctx.isNormalBuffer, ctx.protocolActive, ctx.shellType))
      .toBeNull();
  });

  test('Kitty protocol active -> null (defers to the Kitty encoder)', () => {
    const ctx = bashCtx({ protocolActive: true });
    expect(decideWordDeleteShim('Backspace', ctrlOnly, ctx.isNormalBuffer, ctx.protocolActive, ctx.shellType))
      .toBeNull();
  });

  test('alt-screen (e.g. vim) -> null', () => {
    const ctx = bashCtx({ isNormalBuffer: false });
    expect(decideWordDeleteShim('Backspace', ctrlOnly, ctx.isNormalBuffer, ctx.protocolActive, ctx.shellType))
      .toBeNull();
  });

  test('Backspace without Ctrl -> null', () => {
    const ctx = bashCtx();
    expect(decideWordDeleteShim('Backspace', noMods, ctx.isNormalBuffer, ctx.protocolActive, ctx.shellType))
      .toBeNull();
  });

  test('Ctrl+Alt+Backspace -> null (exact ctrl-only chord required)', () => {
    const ctx = bashCtx();
    expect(decideWordDeleteShim('Backspace', { ...ctrlOnly, altKey: true }, ctx.isNormalBuffer, ctx.protocolActive, ctx.shellType))
      .toBeNull();
  });

  test('unrelated key -> null', () => {
    const ctx = bashCtx();
    expect(decideWordDeleteShim('a', ctrlOnly, ctx.isNormalBuffer, ctx.protocolActive, ctx.shellType))
      .toBeNull();
  });
});
