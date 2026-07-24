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
