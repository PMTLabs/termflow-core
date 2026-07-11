import { computeEffectiveAgents, ProcSnapshot } from '../agentSchemeLogic';

const mapped = new Set(['codex']);
const T = 1000;

function snap(p: Partial<ProcSnapshot> & { terminalId: string }): ProcSnapshot {
  return { agent: null, lastInputSource: null, lastInputAt: null, ...p };
}

describe('computeEffectiveAgents', () => {
  it('applies a mapped agent that is currently running', () => {
    const next = computeEffectiveAgents(
      [snap({ terminalId: 'a', agent: 'codex', lastInputSource: 'user', lastInputAt: T })],
      new Map(), mapped, T,
    );
    expect(next.get('a')).toBe('codex');
  });

  it('ignores an unmapped running agent (no override)', () => {
    const next = computeEffectiveAgents(
      [snap({ terminalId: 'a', agent: 'node', lastInputSource: 'user', lastInputAt: T })],
      new Map(), mapped, T,
    );
    expect(next.has('a')).toBe(false);
  });

  it('reverts when the agent is gone and the last write was user', () => {
    const prev = new Map([['a', 'codex']]);
    const next = computeEffectiveAgents(
      [snap({ terminalId: 'a', agent: null, lastInputSource: 'user', lastInputAt: T })],
      prev, mapped, T + 5000,
    );
    expect(next.has('a')).toBe(false);
  });

  it('stays sticky when the agent is gone and a recent write was api', () => {
    const prev = new Map([['a', 'codex']]);
    const next = computeEffectiveAgents(
      [snap({ terminalId: 'a', agent: null, lastInputSource: 'api', lastInputAt: T + 4000 })],
      prev, mapped, T + 5000,
    );
    expect(next.get('a')).toBe('codex');
  });

  it('stays sticky when api was the last writer even long after that write (long API task)', () => {
    // codex was prompted via API at T, ran for minutes, then exited. The poll that
    // detects the exit happens well after the API write — it must stay sticky, not
    // revert (the old time-window anchor got this wrong).
    const prev = new Map([['a', 'codex']]);
    const next = computeEffectiveAgents(
      [snap({ terminalId: 'a', agent: null, lastInputSource: 'api', lastInputAt: T })],
      prev, mapped, T + 5 * 60 * 1000,
    );
    expect(next.get('a')).toBe('codex');
  });

  it('reverts (not sticky) when the source is unknown', () => {
    const prev = new Map([['a', 'codex']]);
    const next = computeEffectiveAgents(
      [snap({ terminalId: 'a', agent: null, lastInputSource: null, lastInputAt: null })],
      prev, mapped, T + 5000,
    );
    expect(next.has('a')).toBe(false);
  });

  it('drops a sticky override once its agent mapping is removed', () => {
    const prev = new Map([['a', 'codex']]);
    // codex no longer mapped (empty set), even though a recent api write occurred.
    const next = computeEffectiveAgents(
      [snap({ terminalId: 'a', agent: null, lastInputSource: 'api', lastInputAt: T + 4000 })],
      prev, new Set(), T + 5000,
    );
    expect(next.has('a')).toBe(false);
  });

  it('drops terminals no longer present in the snapshot', () => {
    const prev = new Map([['a', 'codex']]);
    const next = computeEffectiveAgents([], prev, mapped, T);
    expect(next.has('a')).toBe(false);
  });

  it('does not mutate the previous map', () => {
    const prev = new Map([['a', 'codex']]);
    computeEffectiveAgents(
      [snap({ terminalId: 'a', agent: 'codex', lastInputSource: 'user', lastInputAt: T })],
      prev, mapped, T,
    );
    expect(prev.size).toBe(1);
    expect(prev.get('a')).toBe('codex');
  });
});
