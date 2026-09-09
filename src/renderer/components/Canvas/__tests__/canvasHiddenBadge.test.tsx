/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

let hidden: Record<string, true> = {};
jest.mock('react-redux', () => ({ useSelector: (selector: any) => selector({ canvas: { hidden } }) }));

import { CanvasHiddenForTerminal, CanvasHiddenForTerminals } from '../CanvasHiddenBadge';

let container: HTMLDivElement;
let root: Root;
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => { hidden = {}; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('CanvasHiddenBadge', () => {
  it('renders nothing without hidden terminals, then renders the pane face', () => {
    act(() => root.render(<CanvasHiddenForTerminal key="empty" terminalId="tm-a" />));
    expect(container.querySelector('.canvas-hidden-badge')).toBeNull();
    hidden = { 'tm-a': true };
    act(() => root.render(<CanvasHiddenForTerminal key="hidden" terminalId="tm-a" />));
    expect(container.querySelector('.canvas-hidden-badge')!.title).toBe('Hidden from the canvas');
  });

  it('counts and pluralises the tab face', () => {
    hidden = { 'tm-a': true, 'tm-b': true };
    act(() => root.render(<CanvasHiddenForTerminals terminalIds={['tm-a', 'tm-b', 'tm-c']} />));
    expect(container.querySelector('.canvas-hidden-badge')!.title).toBe('2 terminals in this tab are hidden from the canvas');
    expect(container.textContent).toBe('+1');
  });
});
