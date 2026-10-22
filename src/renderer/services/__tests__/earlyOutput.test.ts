/**
 * @jest-environment jsdom
 *
 * Output a shell prints before its pane subscribes must reach that pane.
 *
 * The defect: a restored tab's fresh shell printed its first prompt while the pane was still
 * waiting for `createTerminal` to resolve and React to re-render. `TerminalService` dispatched
 * the chunk as a `pty:data` event nobody was listening to, the restore hydrated from a
 * prefix-only snapshot (old scrollback, not the screen), and the prompt never appeared: the
 * cursor sat on the prompt row with nothing on it, and typed text showed up mid-screen.
 */
import { EarlyOutput, EARLY_OUTPUT_CAP_BYTES, EARLY_OUTPUT_WINDOW_MS } from '../earlyOutput';
import { TerminalServiceClass } from '../TerminalService';
import { createMainBridge } from '../../components/Terminal/MainBridge';

describe('EarlyOutput', () => {
  let now = 0;
  const make = () => new EarlyOutput(() => now);
  beforeEach(() => { now = 1_000; });

  it('hands what it holds to the first claim, oldest first, and nothing to a second', () => {
    const early = make();
    early.record('pc-a', '\x1b[?9001h');
    early.record('pc-b', 'other');
    early.record('pc-a', 'PS D:\\src> ');
    expect(early.claim('pc-a')).toEqual(['\x1b[?9001h', 'PS D:\\src> ']);
    expect(early.claim('pc-a')).toEqual([]);
    expect(early.claim('pc-b')).toEqual(['other']);
  });

  it('never holds a claimed process again, so a remount is not fed stale chunks', () => {
    const early = make();
    expect(early.claim('pc-a')).toEqual([]);
    early.record('pc-a', 'live, already delivered to the listener');
    expect(early.claim('pc-a')).toEqual([]);
  });

  it('stops holding a process nobody claims once its window has passed', () => {
    const early = make();
    early.record('pc-a', 'first');
    now += EARLY_OUTPUT_WINDOW_MS;
    early.record('pc-a', 'still inside');
    now += 1;
    early.record('pc-a', 'past the window');
    expect(early.claim('pc-a')).toEqual([]);
  });

  it('drops an unclaimed process that went quiet when another one starts', () => {
    const early = make();
    early.record('pc-quiet', 'once');
    now += EARLY_OUTPUT_WINDOW_MS + 1;
    early.record('pc-new', 'hello');
    expect(early.claim('pc-quiet')).toEqual([]);
    expect(early.claim('pc-new')).toEqual(['hello']);
  });

  it('keeps only the newest bytes past the cap', () => {
    const early = make();
    const big = 'x'.repeat(EARLY_OUTPUT_CAP_BYTES / 2);
    early.record('pc-a', 'oldest');
    early.record('pc-a', big);
    early.record('pc-a', big);
    early.record('pc-a', 'newest');
    const held = early.claim('pc-a');
    expect(held[0]).not.toBe('oldest');
    expect(held[held.length - 1]).toBe('newest');
    expect(held.join('').length).toBeLessThanOrEqual(EARLY_OUTPUT_CAP_BYTES);
  });

  it('forgets an exited process entirely', () => {
    const early = make();
    early.record('pc-a', 'bye');
    early.forget('pc-a');
    expect(early.claim('pc-a')).toEqual([]);
  });
});

describe('TerminalService -> MainBridge: output before the pane subscribes', () => {
  let emitData!: (processId: string, data: string) => void;
  let emitExit!: (processId: string, exitCode: number) => void;

  beforeEach(() => {
    (window as any).electronAPI = {
      onTerminalData: jest.fn((cb) => { emitData = cb; }),
      onTerminalExit: jest.fn((cb) => { emitExit = cb; }),
    };
    new TerminalServiceClass(() => ({}));
  });
  afterEach(() => { delete (window as any).electronAPI; });

  it('delivers the shell`s first prompt to the pane that subscribes after it was printed', () => {
    emitData('pc-restored', '\x1b[16;1H');
    emitData('pc-restored', 'PS D:\\sources\\demo> ');
    emitData('pc-someone-else', 'not mine');

    const got: string[] = [];
    createMainBridge().onData('pc-restored', (d) => got.push(d));
    expect(got).toEqual(['\x1b[16;1H', 'PS D:\\sources\\demo> ']);

    // Live output after the subscription arrives once, after the early chunks.
    emitData('pc-restored', 'abd');
    expect(got).toEqual(['\x1b[16;1H', 'PS D:\\sources\\demo> ', 'abd']);
  });

  it('a second subscriber (a remount) gets live output only, as before', () => {
    emitData('pc-remount', 'early');
    const first = createMainBridge().onData('pc-remount', () => {});
    first.dispose();
    emitData('pc-remount', 'while unmounted');

    const got: string[] = [];
    createMainBridge().onData('pc-remount', (d) => got.push(d));
    emitData('pc-remount', 'live');
    expect(got).toEqual(['live']);
  });

  it('drops what was held for a process that exits before any pane subscribes', () => {
    emitData('pc-gone', 'output');
    emitExit('pc-gone', 0);
    const got: string[] = [];
    createMainBridge().onData('pc-gone', (d) => got.push(d));
    expect(got).toEqual([]);
  });
});
