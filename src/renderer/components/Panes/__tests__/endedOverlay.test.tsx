/**
 * @jest-environment jsdom
 *
 * Spec 045 §3.1: content from an exited process must be visibly distinguished,
 * and ONLY from an exited process. The tint is an overlay ABOVE xterm's canvas —
 * a --terminal-display-background override would only paint the 4px padding
 * slack (TerminalDisplay.css:15), leaving the grid untouched.
 *
 * Drives the real pty:exit CustomEvent through the real component, per the
 * repo's react-dom/client + React.act harness (see PeersPanel.test.tsx).
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

jest.mock('../TerminalPane.css', () => ({}));
jest.mock('../SessionClosedBanner.css', () => ({}));

// The pane pulls in the whole terminal stack at module load; stub the parts that
// need a real canvas / backend so the test isolates the ended-state rendering.
jest.mock('../../Terminal/TerminalDisplay', () => ({
  __esModule: true,
  default: () => <div data-testid="terminal-display" />,
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

import { EndedOverlay } from '../EndedOverlay';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('EndedOverlay (spec 045 §3.1)', () => {
  it('renders the tint when the session has ended', () => {
    act(() => root.render(<EndedOverlay closedInfo={{ exitCode: 0 }} />));
    expect(container.querySelector('.pane-ended-overlay')).not.toBeNull();
  });

  it('renders the tint regardless of exit code', () => {
    act(() => root.render(<EndedOverlay closedInfo={{ exitCode: 1 }} />));
    expect(container.querySelector('.pane-ended-overlay')).not.toBeNull();
    act(() => root.render(<EndedOverlay closedInfo={{ exitCode: null }} />));
    expect(container.querySelector('.pane-ended-overlay')).not.toBeNull();
  });

  it('renders NOTHING for a live session (the "ended-only" requirement)', () => {
    act(() => root.render(<EndedOverlay closedInfo={null} />));
    expect(container.querySelector('.pane-ended-overlay')).toBeNull();
  });

  it('unmounts the tint when the session restarts (closedInfo cleared)', () => {
    act(() => root.render(<EndedOverlay closedInfo={{ exitCode: 0 }} />));
    expect(container.querySelector('.pane-ended-overlay')).not.toBeNull();
    act(() => root.render(<EndedOverlay closedInfo={null} />));
    expect(container.querySelector('.pane-ended-overlay')).toBeNull();
  });

  it('is inert to pointer events so selection still works underneath', () => {
    act(() => root.render(<EndedOverlay closedInfo={{ exitCode: 0 }} />));
    const el = container.querySelector('.pane-ended-overlay') as HTMLElement;
    // Asserted on the inline style: jsdom does not apply stylesheets.
    expect(el.style.pointerEvents).toBe('none');
  });

  it('is hidden from assistive tech (decorative)', () => {
    act(() => root.render(<EndedOverlay closedInfo={{ exitCode: 0 }} />));
    expect(container.querySelector('.pane-ended-overlay')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('paneClassName (spec 045 §3.1)', () => {
  it('marks an ended pane', async () => {
    const { paneClassName } = await import('../EndedOverlay');
    expect(paneClassName({ isActive: true, solo: false, closedInfo: { exitCode: 0 } }))
      .toContain('is-ended');
  });

  it('does not mark a live pane', async () => {
    const { paneClassName } = await import('../EndedOverlay');
    expect(paneClassName({ isActive: true, solo: false, closedInfo: null }))
      .not.toContain('is-ended');
  });

  it('preserves the existing active/solo classes', async () => {
    const { paneClassName } = await import('../EndedOverlay');
    const cls = paneClassName({ isActive: true, solo: true, closedInfo: null });
    expect(cls).toContain('terminal-pane');
    expect(cls).toContain('active');
    expect(cls).toContain('solo');
  });
});
