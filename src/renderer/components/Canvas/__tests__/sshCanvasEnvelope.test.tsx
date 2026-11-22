/**
 * @jest-environment jsdom
 *
 * Plan 070 T2 — the two boxes of an SSH canvas node, captured from the source pane BEFORE host
 * registration, and the registered host staying the inner `.terminal-display`.
 *
 * JSDOM is not a layout engine: every rectangle and computed width here is an explicit fixture
 * (see `__testFixtures__/sshCanvasFixture.ts`). What is proven is which element is measured,
 * cached, registered and sized, and that the arithmetic hands FitAddon the same content box.
 * Real-engine geometry is T8.
 */
// `terminalCache` is a bare Map (cache.ts), so a Map is the faithful double.
const fakeCache = new Map<string, any>();
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: fakeCache, isFindShortcut: () => false }));
jest.mock('../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
jest.mock('../../../services/TerminalService', () => ({ terminalService: { writeToTerminal: jest.fn() } }));

/* eslint-disable import/first */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from '../../../store';
import { NodeTerminal } from '../NodeTerminal';
import { measureHostBox, measureSshSurfaceBox, clearHostBoxes, _sshBoxCount, _hostBoxCount } from '../canvasHostBoxes';
import { SSH_CSS_LAUNCH_STRIP_H, sshBrowserAllocation, sshTerminalBox, sshFallbackSurfaceBox } from '../canvasSshGeometry';
import { SshCanvasPresentation } from '../../Ssh/SshTerminalComposition';
import { __getSurfaceHostForTest, __resetSurfaceHostsForTest } from '../../../services/surfaceHosts';
import { __resetSshPresentationsForTest } from '../../Ssh/sshPresentations';
import {
  fitTerminal, relocateAndFit, seedSshPane, sizeHostContent, sshTag, stubRect,
} from '../../../__testFixtures__/sshCanvasFixture';

const FALLBACK = { w: 1600, h: 680 };
// Unequal on purpose: a terminal box, a browser column and a status row that cannot be confused.
const TERMINAL = { w: 1001.53125, h: 603.40625 };
const BROWSER_W = 260;   // 068's expanded column, border included
const STATUS_H = 25;     // the fixed status row, border included

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  fakeCache.clear();
  clearHostBoxes();
  __resetSurfaceHostsForTest();
  __resetSshPresentationsForTest();
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SSH envelope capture and entry', () => {
  it('sshCanvasEnvelope_preservesInnerHostOnEntry', () => {
    const id = 'tm-ssh-entry';
    const pane = seedSshPane(fakeCache, id, { terminal: TERMINAL, browserW: BROWSER_W, statusH: STATUS_H });
    const t = fitTerminal(pane.element);
    // Positive control: the source pane really produces a grid from its fixture box.
    expect(t.term.cols).toBeGreaterThan(2);
    expect(t.term.rows).toBeGreaterThan(2);

    // Capture, in CanvasMode's order: terminal box, then the SSH descriptor, both pre-registration.
    const hostBox = measureHostBox(id, FALLBACK);
    const box = measureSshSurfaceBox(id, hostBox, false);
    expect(hostBox).toEqual(TERMINAL);
    expect(box.source).toBe('measured');
    expect(box.initialTerminal).toEqual(TERMINAL);
    expect(box.envelope).toEqual({ w: TERMINAL.w + BROWSER_W, h: TERMINAL.h + SSH_CSS_LAUNCH_STRIP_H + STATUS_H });
    expect(box.envelope).not.toEqual(hostBox);          // the two boxes are distinct
    expect(sshTerminalBox(box, false)).toEqual(TERMINAL); // the slot is exactly the source box

    const tag = sshTag();
    act(() => root.render(<Provider store={store}>
      <NodeTerminal terminalId={id} focused={false} sshTag={tag} SshShell={SshCanvasPresentation}
        sshBrowserWidth={sshBrowserAllocation(box, tag.browserCollapsed)} />
    </Provider>));

    const surface = container.querySelector<HTMLElement>('.canvas-surface.canvas-ssh-surface')!;
    const registered = __getSurfaceHostForTest(id)!;
    expect(surface).not.toBeNull();
    expect(registered).not.toBeNull();
    // The registry points at the INNER `.terminal-display`, never the envelope or its wrapper.
    expect(registered.classList.contains('terminal-display')).toBe(true);
    expect(registered.getAttribute('data-terminal-id')).toBe(id);
    expect(registered).not.toBe(surface);
    expect(registered.parentElement!.classList.contains('terminal-display-wrapper')).toBe(true);
    expect(registered.parentElement!.classList.contains('canvas-surface')).toBe(false);
    expect(registered.closest('.ssh-terminal-host')).not.toBeNull();
    expect(registered.closest('.canvas-surface')).toBe(surface);
    expect(container.querySelectorAll('.terminal-display')).toHaveLength(1);
    // Browser column and status row are content of the envelope, outside the host.
    const aside = surface.querySelector<HTMLElement>('.ssh-browser')!;
    expect(aside.style.width).toBe(`${BROWSER_W}px`);
    expect(registered.contains(aside)).toBe(false);
    expect(surface.querySelector('.ssh-status')).not.toBeNull();
    expect(registered.contains(surface.querySelector('.ssh-status'))).toBe(false);

    // Fixture for the CSS chain: the slot is the envelope's remainder and the host fills it.
    const slot = sshTerminalBox(box, tag.browserCollapsed);
    sizeHostContent(registered, slot.w, slot.h);
    const entry = relocateAndFit(t, registered);
    expect(entry.after).toEqual(entry.before);
    expect(entry.resized).toBe(0);

    // Negative control: had the ENVELOPE been registered, FitAddon would see a different box.
    const wrong = document.createElement('div');
    sizeHostContent(wrong, box.envelope.w, box.envelope.h);
    document.body.appendChild(wrong);
    expect(relocateAndFit(t, wrong).resized).toBe(1);
  });

  it('sshCanvasEnvelope_refusesReplicaAndZeroMeasurement', () => {
    const id = 'tm-ssh-refuse';
    const pane = seedSshPane(fakeCache, id, { terminal: TERMINAL, browserW: BROWSER_W, statusH: STATUS_H });

    // Positive first: a valid fractional source is captured and cached.
    const first = measureSshSurfaceBox(id, TERMINAL, false);
    expect(first.source).toBe('measured');
    expect(first.envelope).toEqual({ w: 1261.53125, h: 628.40625 + SSH_CSS_LAUNCH_STRIP_H });
    expect(_sshBoxCount()).toBe(1);

    // After relocation the parent is our own replica; a zero source is no better. Neither
    // replaces the cached valid source.
    const replica = document.createElement('div');
    replica.className = 'canvas-surface';
    const replicaHost = document.createElement('div');
    replicaHost.className = 'terminal-display';
    replica.appendChild(replicaHost);
    document.body.appendChild(replica);
    stubRect(replicaHost, 333, 222);
    replicaHost.appendChild(pane.element);
    expect(measureSshSurfaceBox(id, TERMINAL, false)).toBe(first);
    stubRect(pane.host, 0, 0);
    expect(measureSshSurfaceBox(id, TERMINAL, false)).toBe(first);
    expect(_sshBoxCount()).toBe(1);

    // A fresh Canvas session: the replica is refused outright and the fallback is NOT cached.
    clearHostBoxes();
    expect(_sshBoxCount()).toBe(0);
    expect(_hostBoxCount()).toBe(0);
    const refused = measureSshSurfaceBox(id, FALLBACK, false);
    expect(refused).toEqual(sshFallbackSurfaceBox(FALLBACK, false));
    expect(refused.source).toBe('fallback');
    expect(_sshBoxCount()).toBe(0);

    // Zero source in its pane: fallback, not frozen; once it has layout, a real capture wins.
    pane.host.appendChild(pane.element);
    expect(measureSshSurfaceBox(id, FALLBACK, false).source).toBe('fallback');
    expect(_sshBoxCount()).toBe(0);
    stubRect(pane.status, 1, 0);
    stubRect(pane.host, TERMINAL.w, TERMINAL.h);
    expect(measureSshSurfaceBox(id, FALLBACK, false).source).toBe('fallback'); // zero status row
    stubRect(pane.status, 1, STATUS_H);
    const recaptured = measureSshSurfaceBox(id, FALLBACK, false);
    expect(recaptured.source).toBe('measured');
    expect(recaptured.envelope).toEqual(first.envelope);
    expect(_sshBoxCount()).toBe(1);

    // A never-rendered leaf and a local pane with no SSH shell both get the honest fallback.
    expect(measureSshSurfaceBox('tm-never', FALLBACK, true)).toEqual(sshFallbackSurfaceBox(FALLBACK, true));
    const local = document.createElement('div');
    local.className = 'terminal-display';
    const localElement = document.createElement('div');
    local.appendChild(localElement);
    document.body.appendChild(local);
    stubRect(local, 900, 500);
    fakeCache.set('tm-local', { terminal: { element: localElement } });
    expect(measureSshSurfaceBox('tm-local', FALLBACK, false).source).toBe('fallback');
    expect(_sshBoxCount()).toBe(1);
  });
});
