/**
 * @jest-environment jsdom
 */
import { emitPtyInput } from '../ptyInputSignal';

describe('emitPtyInput', () => {
  it('dispatches a pty:input CustomEvent carrying processId, data, and a timestamp', () => {
    const seen: Array<{ processId: string; data: string; t: number }> = [];
    const handler = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('pty:input', handler);
    try {
      emitPtyInput('proc-1', 'ls -la');
    } finally {
      window.removeEventListener('pty:input', handler);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].processId).toBe('proc-1');
    expect(seen[0].data).toBe('ls -la');
    expect(typeof seen[0].t).toBe('number');
  });

  it('never throws (input must not break if signalling fails)', () => {
    expect(() => emitPtyInput('p', 'x')).not.toThrow();
  });
});
