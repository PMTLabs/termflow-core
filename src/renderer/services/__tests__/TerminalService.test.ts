/**
 * @jest-environment jsdom
 */
import { terminalService } from '../TerminalService';

describe('TerminalService.getTerminalIdForProcess', () => {
  it('returns the terminalId mapped to a given processId', () => {
    terminalService.registerExistingTerminal('tm-getpid-1', 'pc-getpid-1');
    expect(terminalService.getTerminalIdForProcess('pc-getpid-1')).toBe('tm-getpid-1');
  });

  it('returns undefined for an unknown processId', () => {
    expect(terminalService.getTerminalIdForProcess('pc-unknown-xyz')).toBeUndefined();
  });
});

describe('TerminalService console-window adoption', () => {
  let adoptConsoleWindow: jest.Mock;

  beforeEach(() => {
    adoptConsoleWindow = jest.fn().mockResolvedValue(undefined);
    (window as any).electronAPI = {
      adoptConsoleWindow,
      createTerminal: jest.fn().mockResolvedValue('pc-adopt-1'),
    };
  });

  it('adopts on a fresh spawn', async () => {
    await terminalService.createTerminal('tm-adopt-1');
    expect(adoptConsoleWindow).toHaveBeenCalledWith('pc-adopt-1');
  });

  // The owner must track the pane's CURRENT window, so attaching an existing
  // PTY into another window has to re-adopt — adopting only at spawn would
  // leave a detached pane's dialogs owned by the window it came from.
  it('re-adopts when an existing process is bound into this window', () => {
    terminalService.registerExistingTerminal('tm-adopt-2', 'pc-adopt-2');
    expect(adoptConsoleWindow).toHaveBeenCalledWith('pc-adopt-2');
  });

  it('survives a bridge without the command (browser/non-Windows)', () => {
    (window as any).electronAPI = {};
    expect(() => terminalService.registerExistingTerminal('tm-adopt-3', 'pc-adopt-3')).not.toThrow();
  });

  it('swallows a rejected adopt — it must never break process binding', () => {
    adoptConsoleWindow.mockRejectedValue(new Error('no hwnd'));
    expect(() => terminalService.registerExistingTerminal('tm-adopt-4', 'pc-adopt-4')).not.toThrow();
    expect(terminalService.getTerminalIdForProcess('pc-adopt-4')).toBe('tm-adopt-4');
  });
});

describe('TerminalService.stashPromptGate (backlog 011 hot-swap reattach seed)', () => {
  it('stashes a gate that takePromptGateHandoff drains exactly once', () => {
    terminalService.stashPromptGate('tb-seed-1', { seen: true, armed: false });
    expect(terminalService.takePromptGateHandoff('tb-seed-1')).toEqual({ seen: true, armed: false });
    // Single-use — the engine only reads it on its first mount.
    expect(terminalService.takePromptGateHandoff('tb-seed-1')).toBeUndefined();
  });

  it('clears a pending stash when passed null (hookless shell → no gate)', () => {
    terminalService.stashPromptGate('tb-seed-2', { seen: true, armed: false });
    terminalService.stashPromptGate('tb-seed-2', null);
    expect(terminalService.takePromptGateHandoff('tb-seed-2')).toBeUndefined();
  });
});
