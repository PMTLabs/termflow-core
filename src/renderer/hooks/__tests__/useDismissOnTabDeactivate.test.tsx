/**
 * @jest-environment jsdom
 *
 * `useDismissOnTabDeactivate` — the tab-switch dismissal shared by every floating surface a
 * terminal owns (`TerminalDisplay`'s context menu, snippets flyout, path picker and schema
 * picker) and by `TerminalPane`'s pane-title menu.
 *
 * The defect it exists to close: those menus render through `createPortal(…, document.body)` at
 * `position: fixed`, so they sit OUTSIDE the `.tab-content` subtree that
 * `TerminalContainer.css` hides with `visibility/opacity/content-visibility`. A background tab
 * stays mounted, so a menu opened in tab A keeps painting over tab B and reads as tab B's own
 * menu. The menu's only self-dismissals are an outside `mousedown` and Escape — neither of which
 * a keyboard (`Ctrl+Tab`, `Ctrl+1…9`) or programmatic (API/MCP, canvas "open as tab", session
 * restore) switch produces.
 *
 * Tested here rather than through `TerminalDisplay`, which cannot be mounted under the root Jest
 * config (two untransformed CSS imports, `@tauri-apps/api/event`, and a real `Terminal.open()`
 * that needs a canvas 2D context jsdom lacks) — the same reason
 * `terminalDisplayRelocationWiring.test.ts` is a source tripwire. The pane's half of the same
 * wiring IS mounted for real, in `Panes/__tests__/paneMenuTabScope.test.tsx`.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { useDismissOnTabDeactivate } from '../useDismissOnTabDeactivate';

let container: HTMLDivElement;
let root: Root;

const Host: React.FC<{ isTabActive: boolean; dismiss: () => void }> = ({ isTabActive, dismiss }) => {
  useDismissOnTabDeactivate(isTabActive, dismiss);
  return null;
};

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

/** Mount the host with an initial activity, returning a `rerender` bound to the same root. */
function mount(isTabActive: boolean, dismiss: () => void) {
  act(() => root.render(<Host isTabActive={isTabActive} dismiss={dismiss} />));
  return (next: boolean, nextDismiss: () => void = dismiss) =>
    act(() => root.render(<Host isTabActive={next} dismiss={nextDismiss} />));
}

describe('useDismissOnTabDeactivate', () => {
  it('dismisses when the hosting tab goes from active to inactive', () => {
    const dismiss = jest.fn();
    const rerender = mount(true, dismiss);
    expect(dismiss).not.toHaveBeenCalled();

    rerender(false);

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  /**
   * The canvas case, and the reason this is a TRANSITION and not a `!isTabActive` guard.
   *
   * A terminal relocated onto a Canvas node keeps its `TerminalDisplay` mounted in its own
   * (now background) pane tab, so `isTabActive` is false for its whole life on the canvas —
   * and `NodeTerminal` opens THIS component's menu through the published `openContextMenu`.
   * A hook that fired whenever it saw `false` would close that menu on the render that opened
   * it, on every right-click, and the overlay would have no context menu at all.
   */
  it('does not dismiss on a mount that is already inactive', () => {
    const dismiss = jest.fn();
    mount(false, dismiss);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('does not dismiss on re-renders while the tab stays inactive', () => {
    const dismiss = jest.fn();
    const rerender = mount(false, dismiss);
    rerender(false);
    rerender(false);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('does not dismiss on a mount that is active', () => {
    const dismiss = jest.fn();
    mount(true, dismiss);
    expect(dismiss).not.toHaveBeenCalled();
  });

  /** Coming BACK to a tab must not tear down a menu the user has just re-opened there. */
  it('does not dismiss when the tab becomes active again', () => {
    const dismiss = jest.fn();
    const rerender = mount(false, dismiss);
    rerender(true);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('does not dismiss on re-renders while the tab stays active', () => {
    const dismiss = jest.fn();
    const rerender = mount(true, dismiss);
    rerender(true);
    rerender(true);
    expect(dismiss).not.toHaveBeenCalled();
  });

  /**
   * Acceptance criterion 3: a menu opened in tab B after the switch is scoped to B and goes
   * away when B does. One deactivation must not consume the hook.
   */
  it('dismisses again on every later deactivation', () => {
    const dismiss = jest.fn();
    const rerender = mount(true, dismiss);
    rerender(false);
    rerender(true);
    rerender(false);
    expect(dismiss).toHaveBeenCalledTimes(2);
  });

  /**
   * The callback closes over the owner's `setState`s and is written inline at both call sites,
   * so it has a fresh identity on every render. Two things must hold: the LATEST one runs, and a
   * new identity on its own must not count as a deactivation — otherwise the hook fires on every
   * render of an inactive tab and takes the canvas overlay's menu with it.
   *
   * The first half is what pins the `dismissRef.current = dismiss` assignment specifically:
   * dropping it (seed the ref, never refresh it) leaves `first` holding the dismissal forever,
   * and this is the only case in the file that notices. Reaching for the ref at all is NOT what
   * that assignment is for — see the hook, where the mutation that proved it is recorded.
   */
  it('calls the latest dismiss, and a new dismiss identity alone does not fire it', () => {
    const first = jest.fn();
    const second = jest.fn();
    const third = jest.fn();
    const rerender = mount(true, first);

    rerender(true, second);
    expect(second).not.toHaveBeenCalled();

    rerender(false, third);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(third).toHaveBeenCalledTimes(1);
  });
});
