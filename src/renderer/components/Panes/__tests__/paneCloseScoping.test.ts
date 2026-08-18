/**
 * Closing a pane removes it from the tab that OWNS it, not from whichever tab is active.
 *
 * `PaneManager` is mounted once per tab (`TerminalContainer` renders them all so background
 * tabs keep their PTYs), and the close request is routed by TREE MEMBERSHIP: every mounted
 * listener sees the `ui:requestPaneClose` / `ui:forcePaneClose` event and only the manager
 * whose `paneTree` prop contains that pane acts on it. That routing is per-tab.
 *
 * The mutation was not. `closePane` reads and writes `state.paneTree` — the ACTIVE tab's tree —
 * so for any tab that is not the active one the two disagreed. Canvas Mode makes that the
 * normal case rather than an edge case: the active tab is the canvas itself, a virtual tab with
 * no tree at all, so `closePane` hit its `if (!state.paneTree) return;` and did nothing. The PTY
 * was killed by the other half of `closePaneNonBlocking` and the pane stayed in the tree — a
 * dead node left on the canvas, saved and restored with the session.
 *
 * `removePaneFromTab` is the same operation with a `tabId`, and it already clears the tab's
 * maximize flag and repairs `activePaneId` when the tab it touches happens to be the active one.
 *
 * Source-derived because the failure lives in which ACTION is dispatched from inside a
 * `useCallback`, and mounting `PaneManager` for real means mounting live terminals.
 */
import path from 'path';
import { readSource } from '../../../utils/readSource';

const SRC = readSource(path.resolve(__dirname, '..', 'PaneManager.tsx'))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** `performClose`'s body alone — the file also dispatches `closePane` nowhere else, but
 *  scoping keeps this test honest if a second caller is ever added. */
const start = SRC.indexOf('const performClose = useCallback(');
const BODY = SRC.slice(start, SRC.indexOf('\n  }, [', start));
const DEPS = SRC.slice(SRC.indexOf('\n  }, [', start), SRC.indexOf(')', SRC.indexOf('\n  }, [', start)));

describe('performClose removes the pane from its owning tab', () => {
  it('exists as a scoped block to assert against', () => {
    expect(start).toBeGreaterThan(-1);
    expect(BODY).toContain('closePaneNonBlocking');
  });

  it('dispatches the TAB-SCOPED removal when it knows the tab', () => {
    expect(BODY).toContain('removePaneFromTab({ tabId, paneId })');
  });

  // The fallback is deliberate, not an oversight: `tabId` is an optional prop and the legacy
  // single-tab mount still relies on the active-tab action. Pinning the guard stops the
  // fallback quietly becoming the only path again.
  it('keeps the legacy active-tab action only as the no-tabId fallback', () => {
    expect(BODY).toMatch(/tabId\s*\?\s*removePaneFromTab\(\{ tabId, paneId \}\)\s*:\s*closePane\(paneId\)/);
  });

  it('never dispatches the unscoped close unconditionally', () => {
    expect(BODY).not.toContain('removeFromUi: () => dispatch(closePane(paneId))');
  });

  // A stale closure here would reintroduce the bug in its most confusing form: the right
  // action dispatched against the tab the component was mounted for LAST.
  it('lists tabId as a dependency of the callback', () => {
    expect(DEPS).toContain('tabId');
  });

  /**
   * Both entry points converge here, which is why this test does not have to be written
   * twice. `ui:requestPaneClose` goes through the confirm dialog to `performClose`, and
   * `ui:forcePaneClose` — the path Canvas Mode uses for a terminal whose process has already
   * exited — goes straight to it. If they ever stop sharing it, the forced path is the one
   * that would silently keep the old scoping.
   */
  it('is the single funnel both close events reach', () => {
    expect(SRC).toContain('const onRequest = route(handleClose);');
    expect(SRC).toContain('const onForce = route(performClose);');
    expect(SRC).toContain('setPendingClosePaneId(paneId);');
  });
});
