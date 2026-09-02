/**
 * The tab-drag preview nudge must not be re-armed before it completes (Tam, 2026-09-02).
 *
 * A TRIPWIRE over source, in the style of `copyLinkWiring`: `beginTabDrag` is a module-private
 * function driven by real pointer events against a Tauri bridge, so the behaviour under test —
 * "how many of these are in flight at once" — cannot be observed from a mounted component.
 *
 * What it guards: `moveDragPreview` crosses into the backend and waits on the OS main thread.
 * Clearing `movePending` at DISPATCH time rather than on COMPLETION puts one more call on the
 * wire every animation frame regardless of how far behind the main thread has fallen. During
 * the macOS freeze this was diagnosed from, three were in flight at once and the slowest took
 * 2.4 seconds. The queue must be able to apply backpressure.
 *
 * Matched against source with comments STRIPPED: the fix is explained in a comment that names
 * `movePending`, and to a regex an explanation is indistinguishable from the thing it explains.
 */
import * as path from 'path';
import { readSource } from '../../../utils/readSource';

const code = readSource(path.join(__dirname, '..', 'TabManager.tsx'))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the drag-preview nudge is throttled by completion, not by frame', () => {
  const scheduler = (() => {
    const start = code.indexOf('const scheduleNativeMove');
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf('const onMove', start);
    expect(end).toBeGreaterThan(start);
    return code.slice(start, end);
  })();

  it('reopens the gate only after the call settles', () => {
    expect(scheduler).toMatch(/\.finally\(\(\)\s*=>\s*\{\s*movePending\s*=\s*false;?\s*\}\)/);
  });

  /**
   * The ordering IS the defect. `movePending = false` sitting above the invoke reads as a
   * perfectly ordinary rAF throttle and compiles identically — only its position says whether
   * a stalled backend can be flooded.
   */
  it('does not clear the flag before dispatching the call', () => {
    const dispatch = scheduler.indexOf('moveDragPreview');
    const reopen = scheduler.indexOf('movePending = false');
    expect(dispatch).toBeGreaterThan(-1);
    expect(reopen).toBeGreaterThan(-1);
    expect(reopen).toBeGreaterThan(dispatch);
  });
});
