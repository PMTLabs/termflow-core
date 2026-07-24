/**
 * Backlog 011 reload-reattach fix: a prompt-hooked shell must reattach with its
 * command-suggest prompt gate re-seeded DISARMED, so an agent CLI running across
 * a renderer reload (PTY-host hot-swap / app update) can't leak keystrokes into
 * the history popup. A hookless shell must NOT be seeded (would gate it forever).
 */
import { reattachPromptGate } from '../reattachGate';

describe('reattachPromptGate', () => {
  it('re-seeds a DISARMED gate for a prompt-hooked shell (suppress until a real prompt renders)', () => {
    expect(reattachPromptGate(true)).toEqual({ seen: true, armed: false });
  });

  it('does NOT seed a hookless shell (cmd/ssh keep the ungated heuristic)', () => {
    expect(reattachPromptGate(false)).toBeNull();
  });

  it('does NOT seed when the flag is absent (older backend / missing field)', () => {
    expect(reattachPromptGate(undefined)).toBeNull();
    // Guards against a truthy-but-wrong value (e.g. a stringified body field).
    expect(reattachPromptGate('true')).toBeNull();
    expect(reattachPromptGate(1)).toBeNull();
  });
});
