/**
 * Backlog 011 reload-reattach fix + design 006: a prompt-hooked shell must
 * reattach with its command-suggest prompt gate re-seeded — ARMED when the
 * backend's strict bare-prompt signal says the shell is idle with zero children
 * (first command keeps suggestions), DISARMED otherwise (an agent CLI running
 * across the reload can't leak keystrokes into the history popup). A hookless
 * shell must NOT be seeded (would gate it forever).
 */
import { reattachPromptGate, markArmProbePending, takeArmProbePending } from '../reattachGate';

describe('reattachPromptGate', () => {
  it('seeds ARMED for a hooked shell sitting at a bare prompt (design 006)', () => {
    expect(reattachPromptGate(true, true)).toEqual({ seen: true, armed: true });
  });

  it('seeds DISARMED for a hooked shell with a foreground child (agent CLI/REPL/nested shell)', () => {
    expect(reattachPromptGate(true, false)).toEqual({ seen: true, armed: false });
  });

  it('seeds DISARMED when atPrompt is absent (older backend) — never arm on uncertainty', () => {
    expect(reattachPromptGate(true, undefined)).toEqual({ seen: true, armed: false });
    expect(reattachPromptGate(true, 'true')).toEqual({ seen: true, armed: false });
    expect(reattachPromptGate(true, 1)).toEqual({ seen: true, armed: false });
  });

  it('does NOT seed a hookless shell (cmd/ssh keep the ungated heuristic), regardless of atPrompt', () => {
    expect(reattachPromptGate(false, true)).toBeNull();
    expect(reattachPromptGate(false, false)).toBeNull();
  });

  it('does NOT seed when the hook flag is absent or truthy-but-wrong', () => {
    expect(reattachPromptGate(undefined, true)).toBeNull();
    expect(reattachPromptGate('true', true)).toBeNull();
    expect(reattachPromptGate(1, true)).toBeNull();
  });
});

describe('arm-probe pending markers (review 008 M-1)', () => {
  it('is single-use: consumed exactly once after a mark', () => {
    markArmProbePending('t-probe');
    expect(takeArmProbePending('t-probe')).toBe(true);
    expect(takeArmProbePending('t-probe')).toBe(false);
  });

  it('is false for a terminal that was never marked (ordinary remounts skip the probe)', () => {
    expect(takeArmProbePending('t-never-marked')).toBe(false);
  });
});
