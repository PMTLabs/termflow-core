/**
 * @jest-environment jsdom
 *
 * design/012 §4.1 + D5 — §13 T14.
 *
 * Why the clear is IDENTITY-CHECKED and why the signature has no `| null`
 * (review 094 B3, accepted in full). Rev 4 declared
 * `setSurfaceHost(terminalId, el: HTMLElement | null)` and leaned the whole of
 * §4.1 on "setSurfaceHost(id, null) clears ONLY if the registered element is the
 * one being cleared". That is not implementable: React invokes a bare callback ref
 * with `null` on detach, and `null` carries no identity to compare against. React
 * 19 (package.json:104, "react": "^19.1.0") supports a ref callback RETURNING a
 * cleanup function; when it does, React calls the cleanup instead of re-invoking
 * the ref with null — so at runtime `el` is always a real element and the identity
 * check has something to check.
 *
 * What the identity check does and does not buy (spike 004 Q5, measured over four
 * teardown exercises): it DOES stop a stale cleanup wiping a slot something else
 * has since overwritten with a DIFFERENT element; it does NOT detect "am I the last
 * owner", and it says NOTHING about where the element physically lives. Residence
 * is a separate problem, handled by the relocation effect (Task 12).
 *
 * The repo deliberately avoids React Testing Library (its installed v13 predates
 * React 19), so this drives react-dom/client + React.act, mirroring
 * ToastContainer.test.tsx.
 */
import React, { act, useCallback } from 'react';
import { createRoot, Root } from 'react-dom/client';
import {
  setSurfaceHost,
  clearSurfaceHost,
  useSurfaceHost,
  subscribeSurfaceHosts,
  __resetSurfaceHostsForTest,
} from '../surfaceHosts';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  __resetSurfaceHostsForTest();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  __resetSurfaceHostsForTest();
});

/** A reader that renders whatever host is registered for `id`. */
function Reader({ id }: { id: string }) {
  const host = useSurfaceHost(id);
  return <span data-testid="reader">{host ? host.id || 'anon' : 'none'}</span>;
}

function mount(node: React.ReactElement) {
  root = createRoot(container);
  act(() => { root.render(node); });
}

describe('design/012 §4.1 — the surface-host registry', () => {
  it('reports null when nothing is registered, and the element once one is', () => {
    mount(<Reader id="tb-1" />);
    expect(container.textContent).toBe('none');

    const host = document.createElement('div');
    host.id = 'host-a';
    act(() => { setSurfaceHost('tb-1', host); });
    expect(container.textContent).toBe('host-a');

    act(() => { clearSurfaceHost('tb-1', host); });
    expect(container.textContent).toBe('none');
  });

  // The identity check. A stale cleanup must not wipe a slot something else has
  // since overwritten with a DIFFERENT element (spike 004 Q5).
  it('a stale cleanup with a mismatched element does not clear', () => {
    const first = document.createElement('div');
    first.id = 'first';
    const second = document.createElement('div');
    second.id = 'second';

    mount(<Reader id="tb-2" />);
    act(() => { setSurfaceHost('tb-2', first); });
    act(() => { setSurfaceHost('tb-2', second); });
    expect(container.textContent).toBe('second');

    // `first`'s cleanup runs late — it must be a no-op.
    act(() => { clearSurfaceHost('tb-2', first); });
    expect(container.textContent).toBe('second');

    act(() => { clearSurfaceHost('tb-2', second); });
    expect(container.textContent).toBe('none');
  });

  // The 086 Q2 failure, as a regression test: a host element REPLACED under a
  // stable component must re-register the new node.
  it('re-registers when the host element is replaced under a stable component', () => {
    const first = document.createElement('div');
    first.id = 'first';
    const second = document.createElement('div');
    second.id = 'second';

    mount(<Reader id="tb-3" />);
    act(() => { setSurfaceHost('tb-3', first); });
    expect(container.textContent).toBe('first');
    act(() => { setSurfaceHost('tb-3', second); });
    expect(container.textContent).toBe('second');
  });

  // Both writers are NO-OPS when they would not change the map, and only a real
  // change notifies subscribers — otherwise every render of a canvas node would
  // schedule a useSyncExternalStore re-render for nothing.
  it('notifies only on a real change', () => {
    let notifications = 0;
    const unsubscribe = subscribeSurfaceHosts(() => { notifications += 1; });
    try {
      const host = document.createElement('div');
      setSurfaceHost('tb-4', host);
      expect(notifications).toBe(1);
      setSurfaceHost('tb-4', host);        // same element — no-op
      expect(notifications).toBe(1);

      const other = document.createElement('div');
      clearSurfaceHost('tb-4', other);     // identity mismatch — no-op
      expect(notifications).toBe(1);

      clearSurfaceHost('tb-4', host);
      expect(notifications).toBe(2);
      clearSurfaceHost('tb-4', host);      // already gone — no-op
      expect(notifications).toBe(2);
    } finally {
      unsubscribe();
    }
  });

  // Keys are independent: one terminal's host must never surface for another.
  it('keys hosts independently per terminal id', () => {
    const a = document.createElement('div');
    a.id = 'a';
    mount(<Reader id="tb-5" />);
    act(() => { setSurfaceHost('tb-OTHER', a); });
    expect(container.textContent).toBe('none');
  });

  // §13 T14, last clause: the useCallback([id]) STABILITY requirement. A fresh
  // arrow every render makes React detach and re-attach the ref on every commit —
  // clear + re-register — which is pure notification churn at best. This is the
  // shape design 012 §4.1 prescribes for the canvas node, exercised end to end.
  it('the prescribed callback-ref shape registers once per host, not once per render', () => {
    let notifications = 0;
    const unsubscribe = subscribeSurfaceHosts(() => { notifications += 1; });

    function CanvasNode({ id, tick }: { id: string; tick: number }) {
      // EXACTLY the shape design 012 §4.1 prescribes.
      const hostRef = useCallback<React.RefCallback<HTMLDivElement>>(
        (el) => {
          if (el === null) return;
          setSurfaceHost(id, el);
          return () => clearSurfaceHost(id, el);
        },
        [id],
      );
      return (
        <div className="terminal-display-wrapper canvas-surface" data-tick={tick}>
          <div className="terminal-display" data-terminal-id={id} ref={hostRef} />
        </div>
      );
    }

    try {
      root = createRoot(container);
      act(() => { root.render(<CanvasNode id="tb-6" tick={0} />); });
      expect(notifications).toBe(1);

      // A re-render with no id change must produce ZERO further notifications.
      act(() => { root.render(<CanvasNode id="tb-6" tick={1} />); });
      act(() => { root.render(<CanvasNode id="tb-6" tick={2} />); });
      expect(notifications).toBe(1);

      // Unmounting runs the returned cleanup — React 19 calls it instead of
      // re-invoking the ref with null.
      act(() => { root.render(<div />); });
      expect(notifications).toBe(2);
    } finally {
      unsubscribe();
    }
  });
});
