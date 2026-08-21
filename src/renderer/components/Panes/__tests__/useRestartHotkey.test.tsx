/**
 * @jest-environment jsdom
 *
 * `useRestartHotkey` — the Ctrl+R binding shared by `TerminalPane` and the Canvas overlay
 * (`plan/024` Req 4).
 *
 * Its behaviour is exercised end-to-end through `NodeTerminal`, but it has TWO consumers and
 * only one of them is covered there: `TerminalPane` has no render test (xterm needs a real
 * canvas), so the pane's half of the contract would otherwise rest on nothing. These cases pin
 * the contract itself, which is what both call sites actually depend on.
 */
import React, { act, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { useRestartHotkey } from '../useRestartHotkey';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const Host: React.FC<{ active: boolean; onRestart: () => void }> = ({ active, onRestart }) => {
  const ref = useRef<HTMLDivElement>(null);
  useRestartHotkey(ref, active, onRestart);
  return <div ref={ref} data-testid="host"><span>inner</span></div>;
};

const render = (active: boolean, onRestart: () => void) =>
  act(() => { root.render(<Host active={active} onRestart={onRestart} />); });

const host = () => container.querySelector<HTMLElement>('[data-testid="host"]')!;
const press = (el: Element, init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => { el.dispatchEvent(e); });
  return e;
};

describe('useRestartHotkey', () => {
  it('fires on Ctrl+R while active', () => {
    const onRestart = jest.fn();
    render(true, onRestart);
    press(host(), { key: 'r', ctrlKey: true });
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('accepts a capital R, so Caps Lock is not a dead key', () => {
    const onRestart = jest.fn();
    render(true, onRestart);
    press(host(), { key: 'R', ctrlKey: true });
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  /**
   * The negative that matters most: with a live shell, Ctrl+R is the shell's reverse-search and
   * must reach the PTY untouched. Binding unconditionally would silently break a key people use
   * constantly, in every terminal in the app.
   */
  it('is not bound at all while inactive', () => {
    const onRestart = jest.fn();
    render(false, onRestart);
    const e = press(host(), { key: 'r', ctrlKey: true });
    expect(onRestart).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('ignores the same key without Ctrl, and Ctrl with other modifiers', () => {
    const onRestart = jest.fn();
    render(true, onRestart);
    press(host(), { key: 'r' });
    press(host(), { key: 'r', ctrlKey: true, altKey: true });
    press(host(), { key: 'r', ctrlKey: true, metaKey: true });
    expect(onRestart).not.toHaveBeenCalled();
  });

  // preventDefault is load-bearing, not tidiness: Ctrl+R reloads the WebView.
  it('swallows the key so the WebView cannot reload', () => {
    render(true, jest.fn());
    const e = press(host(), { key: 'r', ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
  });

  /**
   * CAPTURE phase, which is what puts it ahead of xterm's own handler on the element inside.
   *
   * Dispatching from a DESCENDANT is what tells capture from bubble. The hook stops propagation,
   * and stopping it during the CAPTURE phase means the event never descends — so the inner
   * listener sees nothing at all. A bubble-phase binding would have let the inner element handle
   * the key first and only then reached the hook, which is precisely the ordering that would put
   * a Ctrl+R into the PTY on its way to restarting the shell.
   */
  it('intercepts before the event can reach a descendant', () => {
    const onRestart = jest.fn();
    const seenByInner: KeyboardEvent[] = [];
    render(true, onRestart);
    const inner = host().querySelector('span')!;
    inner.addEventListener('keydown', (e) => seenByInner.push(e as KeyboardEvent));
    press(inner, { key: 'r', ctrlKey: true });
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(seenByInner).toHaveLength(0);
  });

  // The paired positive: the descendant must still receive every OTHER key, or the case above
  // would be satisfied by a hook that swallowed the keyboard wholesale.
  it('lets every other key through to the descendant', () => {
    const seenByInner: string[] = [];
    render(true, jest.fn());
    const inner = host().querySelector('span')!;
    inner.addEventListener('keydown', (e) => seenByInner.push((e as KeyboardEvent).key));
    press(inner, { key: 'r' });
    press(inner, { key: 'c', ctrlKey: true });
    expect(seenByInner).toEqual(['r', 'c']);
  });

  it('unbinds when it goes inactive', () => {
    const onRestart = jest.fn();
    render(true, onRestart);
    press(host(), { key: 'r', ctrlKey: true });
    expect(onRestart).toHaveBeenCalledTimes(1);

    render(false, onRestart);
    press(host(), { key: 'r', ctrlKey: true });
    expect(onRestart).toHaveBeenCalledTimes(1); // unchanged
  });
});
