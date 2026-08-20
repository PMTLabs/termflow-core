/**
 * @jest-environment jsdom
 *
 * `useOverlayChromeGate` (`plan/020` §5) — and specifically the round trip that the first
 * version got wrong.
 *
 * The bug this file exists for: an effect keyed only on `overlaid` never re-runs across a
 * Canvas tab switch, because §4 deliberately keeps `overlayId` set the whole time. The
 * relocation on the way back re-gates the engine to `paneChrome: false`, and nothing puts it
 * back — so the overlay returns to the screen still drawing a popup whose keys the engine no
 * longer claims and whose input updates it silently drops.
 *
 * The invariant, stated so it can be asserted directly:
 *
 *   **after any relocation, a terminal that IS the overlay ends with its chrome gate open.**
 *
 * Not "the effect ran", not "the source mentions `host`" — the engine's final state.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { useOverlayChromeGate, ChromeGateEngine } from '../useOverlayChromeGate';

/** Records the flag the way the real engine holds it, so a test can ask for the END STATE
 *  rather than for a call sequence — a sequence assertion passes on a flag that was set and
 *  then unset ([[assert-the-maximum-not-the-final-value]], applied to the final value). */
class FakeEngine implements ChromeGateEngine {
  active = false;
  calls: boolean[] = [];
  setChromeHostActive(active: boolean): void {
    this.active = active;
    this.calls.push(active);
  }
  /** What `relocateTo({ paneChrome })` does to the same field, R7. */
  relocate(toCanvas: boolean): void {
    this.active = !toCanvas;
  }
}

let container: HTMLDivElement;
let root: Root;
let closes = 0;

const Harness: React.FC<{
  engine: FakeEngine;
  overlaid: boolean;
  host: HTMLElement | null;
  engineGeneration?: number;
}> = ({ engine, overlaid, host, engineGeneration = 1 }) => {
  const engineRef = React.useRef<FakeEngine | null>(engine);
  engineRef.current = engine;
  useOverlayChromeGate({
    engineRef,
    overlaid,
    host,
    engineGeneration,
    // A fresh closure every render on purpose: it must not be able to re-run the effect.
    closePopup: () => { closes += 1; },
  });
  return null;
};

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  closes = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const hostA = () => document.createElement('div');

describe('useOverlayChromeGate', () => {
  it('opens the gate when this terminal becomes the overlay', () => {
    const engine = new FakeEngine();
    const host = hostA();
    act(() => { root.render(<Harness engine={engine} overlaid={false} host={host} />); });
    expect(engine.active).toBe(false);
    expect(engine.calls).toEqual([]);          // not overlaid: the flag is the relocation's

    act(() => { root.render(<Harness engine={engine} overlaid host={host} />); });
    expect(engine.active).toBe(true);
  });

  /**
   * THE REGRESSION TEST. `overlaid` is held constant at `true` for the whole sequence — exactly
   * what `plan/020` §4 makes true — and only the host moves, as `CanvasMode` unmounting and
   * remounting makes it move.
   */
  it('re-opens the gate after a canvas tab-switch round trip', () => {
    const engine = new FakeEngine();
    const canvasHost = hostA();
    act(() => { root.render(<Harness engine={engine} overlaid host={canvasHost} />); });
    expect(engine.active).toBe(true);

    // Switch away: CanvasMode unmounts, the host registration is cleared, and the terminal is
    // relocated back to its pane. `overlaid` does NOT change.
    act(() => {
      engine.relocate(false);
      root.render(<Harness engine={engine} overlaid host={null} />);
    });
    // In a pane, chrome is active either way — this is not the interesting half.
    expect(engine.active).toBe(true);

    // Switch back: the terminal is relocated onto the canvas node, which sets the flag FALSE
    // and closes the popup state. This is where the gate has to be re-asserted.
    const newHost = hostA();
    act(() => {
      engine.relocate(true);
      root.render(<Harness engine={engine} overlaid host={newHost} />);
    });
    expect(engine.active).toBe(true);
  });

  // The same edge, stated as the property rather than the story — so a future refactor that
  // changes HOW the host is observed still has to keep the outcome.
  it('ends with the gate open after any relocation, while overlaid', () => {
    const engine = new FakeEngine();
    let host: HTMLElement | null = hostA();
    act(() => { root.render(<Harness engine={engine} overlaid host={host} />); });

    for (let i = 0; i < 4; i += 1) {
      const toCanvas = i % 2 === 0;
      host = toCanvas ? null : hostA();
      act(() => {
        engine.relocate(!toCanvas);
        root.render(<Harness engine={engine} overlaid host={host} />);
      });
      expect(engine.active).toBe(true);
    }
  });

  it('closes the gate and the popup when the overlay closes', () => {
    const engine = new FakeEngine();
    const host = hostA();
    act(() => { root.render(<Harness engine={engine} overlaid host={host} />); });
    expect(closes).toBe(0);

    act(() => { root.render(<Harness engine={engine} overlaid={false} host={host} />); });
    expect(engine.active).toBe(false);
    expect(closes).toBe(1);
  });

  /**
   * The one-liner this hook must never become. A terminal in an ordinary pane is not the
   * overlay, and an unconditional `setChromeHostActive(overlaid)` would gate its suggestions
   * off — in every normal tab in the app, not just on the canvas.
   */
  it('never touches the flag for a terminal that is not the overlay', () => {
    const engine = new FakeEngine();
    engine.relocate(false);                     // living in its pane, chrome active
    act(() => { root.render(<Harness engine={engine} overlaid={false} host={null} />); });
    act(() => { root.render(<Harness engine={engine} overlaid={false} host={hostA()} />); });
    expect(engine.calls).toEqual([]);
    expect(engine.active).toBe(true);
  });

  // A re-render that changes nothing must not tear the gate down and put it back: the teardown
  // closes the popup, so a stray one would shut the popup under the user's hands.
  it('survives a re-render with a fresh closePopup closure', () => {
    const engine = new FakeEngine();
    const host = hostA();
    act(() => { root.render(<Harness engine={engine} overlaid host={host} />); });
    act(() => { root.render(<Harness engine={engine} overlaid host={host} />); });
    expect(engine.calls).toEqual([true]);
    expect(closes).toBe(0);
  });

  // H12 / review 098 A1: the ref is only trustworthy once the engine has mounted, and a
  // terminalId change swaps it. A generation bump has to re-assert against the NEW engine.
  it('re-asserts against a replacement engine', () => {
    const first = new FakeEngine();
    const host = hostA();
    act(() => { root.render(<Harness engine={first} overlaid host={host} engineGeneration={1} />); });
    expect(first.active).toBe(true);

    const second = new FakeEngine();
    act(() => {
      root.render(<Harness engine={second} overlaid host={host} engineGeneration={2} />);
    });
    expect(second.active).toBe(true);
    // And the outgoing engine is the one the cleanup wound down — captured, not re-read.
    expect(first.active).toBe(false);
  });
});
