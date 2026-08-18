/**
 * @jest-environment jsdom
 *
 * `NodeTerminal` is the one canvas component whose MARKUP is a contract rather than
 * styling (design/012 D17), so it is worth the cost of a real DOM render. The repo
 * deliberately has no `@testing-library/react`, so this drives `react-dom/client` +
 * `React.act`, mirroring ToastContainer.test.tsx.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { NodeTerminal } from '../NodeTerminal';
import {
  __getSurfaceHostForTest, __resetSurfaceHostsForTest,
} from '../../../services/surfaceHosts';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  __resetSurfaceHostsForTest();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (props: { terminalId: string; focused?: boolean }) =>
  act(() => {
    root.render(<NodeTerminal terminalId={props.terminalId} focused={props.focused ?? false} />);
  });

const hostEl = () => container.querySelector<HTMLElement>('.terminal-display')!;

describe('NodeTerminal', () => {
  it('registers its host under the terminal id', () => {
    render({ terminalId: 'tm-1' });
    expect(__getSurfaceHostForTest('tm-1')).toBe(hostEl());
  });

  it('satisfies the D17 host contract', () => {
    render({ terminalId: 'tm-1' });
    const host = hostEl();
    // FitAddon measures term.element.parentElement — the HOST, never the wrapper.
    expect(host.getAttribute('data-terminal-id')).toBe('tm-1');
    expect(host.parentElement!.classList.contains('terminal-display-wrapper')).toBe(true);
    // RC3 / H10: a host with no layout box makes proposeDimensions() return a bogus grid.
    expect(host.style.display).not.toBe('none');
  });

  // The class is not decoration: 15 CSS rules, the global Ctrl+C guard's
  // `closest('.terminal-display')` and the ended-region rail's
  // `closest('.terminal-display-wrapper')` all resolve through these two names.
  it('carries both contract class names', () => {
    render({ terminalId: 'tm-1' });
    expect(hostEl().classList.contains('terminal-display')).toBe(true);
    expect(hostEl().parentElement!.className).toContain('canvas-surface');
  });

  it('gives term.element no pointer events while the node is unfocused (D19)', () => {
    render({ terminalId: 'tm-1', focused: false });
    expect(hostEl().style.pointerEvents).toBe('none');
  });

  it('lifts the pointer gate when the node is focused', () => {
    render({ terminalId: 'tm-1', focused: false });
    render({ terminalId: 'tm-1', focused: true });
    expect(hostEl().style.pointerEvents).toBe('auto');
  });

  // A fresh arrow every render makes React detach and re-attach the ref on every
  // commit, and each detach relocates a LIVE terminal. Assert the element identity
  // rather than merely that something is registered — a re-register would leave a
  // different element in the slot and still look registered.
  it('keeps ONE registration, of the SAME element, across re-renders', () => {
    render({ terminalId: 'tm-1' });
    const first = __getSurfaceHostForTest('tm-1');
    expect(first).not.toBeNull();
    render({ terminalId: 'tm-1', focused: true });
    render({ terminalId: 'tm-1', focused: false });
    expect(__getSurfaceHostForTest('tm-1')).toBe(first);
  });

  it('clears its registration on unmount', () => {
    render({ terminalId: 'tm-1' });
    act(() => root.unmount());
    expect(__getSurfaceHostForTest('tm-1')).toBeNull();
    root = createRoot(container); // afterEach unmounts again; keep it valid
  });

  it('moves the registration when the terminal id changes', () => {
    render({ terminalId: 'tm-1' });
    render({ terminalId: 'tm-2' });
    expect(__getSurfaceHostForTest('tm-1')).toBeNull();
    expect(__getSurfaceHostForTest('tm-2')).toBe(hostEl());
  });

  // Two NodeTerminals for one id would alias the registry, which has no refcount:
  // whichever unmounts first clears the slot while the other is still displaying that
  // exact element (spike 004 Q5). Nothing prevents it structurally, so pin the
  // last-writer-wins behaviour that results, as the evidence for §4.1's single-owner rule.
  it('leaves the LAST registrant owning the slot when a second one appears', () => {
    act(() => {
      root.render(
        <>
          <NodeTerminal terminalId="tm-dup" focused={false} />
          <NodeTerminal terminalId="tm-dup" focused={false} />
        </>,
      );
    });
    const all = container.querySelectorAll<HTMLElement>('.terminal-display');
    expect(all).toHaveLength(2);
    expect(__getSurfaceHostForTest('tm-dup')).toBe(all[1]);
  });
});
