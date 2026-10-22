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

  it('hands output over up to the window`s last millisecond, and not one after', () => {
    const early = make();
    early.record('pc-edge', 'first');
    now += EARLY_OUTPUT_WINDOW_MS;
    early.record('pc-edge', 'still inside');
    expect(early.claim('pc-edge')).toEqual(['first', 'still inside']);

    // A process that went quiet inside its window and is claimed after it: nothing, even though
    // no later chunk or new process ever triggered a sweep.
    early.record('pc-quiet', 'startup');
    now += EARLY_OUTPUT_WINDOW_MS + 1;
    expect(early.claim('pc-quiet')).toEqual([]);
  });

  it('a chunk arriving after the window closes the process for good', () => {
    const early = make();
    early.record('pc-a', 'first');
    now += EARLY_OUTPUT_WINDOW_MS + 1;
    early.record('pc-a', 'past the window');
    now = 1_000; // were it still held, a claim inside its window would now return it
    expect(early.claim('pc-a')).toEqual([]);
  });

  it('a sweep closes an expired process: later chunks for it are not held as a new one', () => {
    const early = make();
    early.record('pc-quiet', 'once');
    now += EARLY_OUTPUT_WINDOW_MS + 1;
    early.record('pc-new', 'hello'); // sweeps pc-quiet
    early.record('pc-quiet', 'after the sweep');
    expect(early.claim('pc-quiet')).toEqual([]);
    expect(early.claim('pc-new')).toEqual(['hello']);
  });

  it('keeps exactly the newest chunks that fit the cap', () => {
    const early = make();
    const quarter = (c: string) => c.repeat(EARLY_OUTPUT_CAP_BYTES / 4);
    const half = 'd'.repeat(EARLY_OUTPUT_CAP_BYTES / 2);
    for (const c of ['a', 'b', 'c']) early.record('pc-a', quarter(c));
    // 1.25x the cap: exactly the oldest quarter goes, and the two after it still fit.
    early.record('pc-a', half);
    expect(early.claim('pc-a')).toEqual([quarter('b'), quarter('c'), half]);
  });

  it('close drops what is held and stops holding', () => {
    const early = make();
    early.record('pc-a', 'held');
    early.close('pc-a');
    early.record('pc-a', 'after close');
    expect(early.claim('pc-a')).toEqual([]);
  });
});

describe('TerminalService -> MainBridge: output before the pane subscribes', () => {
  let emitData!: (processId: string, data: string) => void;
  let emitExit!: (processId: string, exitCode: number) => void;
  let service!: TerminalServiceClass;

  beforeEach(() => {
    (window as any).electronAPI = {
      onTerminalData: jest.fn((cb) => { emitData = cb; }),
      onTerminalExit: jest.fn((cb) => { emitExit = cb; }),
    };
    service = new TerminalServiceClass(() => ({}));
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

  it('a chunk coalesced past the exit event is not held again for a remount', () => {
    // The backend emits `terminal:exit` at once but defers data by a few ms, so the last
    // chunk can arrive after the exit; the pane's live listener already wrote it.
    createMainBridge().onData('pc-exiting', () => {}).dispose();
    emitExit('pc-exiting', 0);
    emitData('pc-exiting', 'logout\r\n');

    const got: string[] = [];
    createMainBridge().onData('pc-exiting', (d) => got.push(d));
    expect(got).toEqual([]);
  });

  it('a shell that exits before its pane subscribes still shows what it printed', () => {
    emitData('pc-failed', 'profile error');
    emitExit('pc-failed', 1);
    const got: string[] = [];
    createMainBridge().onData('pc-failed', (d) => got.push(d));
    expect(got).toEqual(['profile error']);
  });

  it('a process already running when this window registers it hydrates as before, with nothing held', () => {
    // A pane moved in from another window: `terminal:data` is broadcast to every window, so this
    // window saw the process's startup output too.
    emitData('pc-moved', 'startup seen by every window');
    service.attachExistingTerminal('tm-moved', 'pc-moved');
    const got: string[] = [];
    createMainBridge().onData('pc-moved', (d) => got.push(d));
    expect(got).toEqual([]);
  });
});
