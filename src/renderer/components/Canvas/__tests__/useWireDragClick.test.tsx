/**
 * @jest-environment jsdom
 *
 * A press on a connection port is now two gestures — Tam's item 4.
 *
 * Drag it onto another node and you get a wire (Task 18). Press and release without moving and
 * you get a shell-profile menu, and the terminal it creates arrives already connected. One
 * pointerdown, two meanings, and the only thing separating them is movement — so the cases
 * worth testing are all at the seam, and every one of them fails silently:
 *
 *  - a click read as a drag → the menu never opens and the press does nothing at all;
 *  - a drag read as a click → a menu appears in the middle of a gesture that was going
 *    somewhere else, and the wire is never drawn;
 *  - both → a click that opens the menu AND connects something.
 *
 * Drives `react-dom/client` + `React.act` directly; the repo has no `@testing-library/react`.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore, EnhancedStore } from '@reduxjs/toolkit';
import canvasReducer from '../../../store/slices/canvasSlice';
import { useWireDrag, PortClick } from '../useWireDrag';
import { DRAG_SLOP } from '../canvasGestures';
import { NODE_W, NODE_H } from '../canvasGeometry';
import type { CanvasModel } from '../canvasSelectors';

const created: Array<[string, string]> = [];
jest.mock('../../../services/canvasGraph', () => ({
  createEdge: (from: string, to: string) => {
    created.push([from, to]);
    return Promise.resolve({ id: 'ed-1', from, to, label: null, origin: 'user' });
  },
}));

const node = (terminalId: string, x: number) => ({
  terminalId, tabId: 'tb-1', paneId: `pn-${terminalId}`, title: terminalId, shellType: 'zsh',
  rect: { x, y: 0, w: NODE_W, h: NODE_H }, isRunning: false, hasUnseenOutput: false,
});

const MODEL: CanvasModel = {
  nodes: [node('tm-a', 0), node('tm-b', 1000)],
  groups: [],
};

let container: HTMLDivElement;
let root: Root;
let store: EnhancedStore;
let clicks: PortClick[];

/** The DOM `useWireDrag` resolves against: it finds the port by `closest`, so the harness has
 *  to have the real ancestry — port inside node inside viewport. */
const Harness: React.FC = () => {
  const wire = useWireDrag(MODEL, (c) => { clicks.push(c); });
  return (
    <div className="canvas-viewport" onPointerDownCapture={wire.onPointerDownCapture}>
      <div className="canvas-node" data-terminal-id="tm-a">
        <span className="canvas-port e" data-port="e" />
      </div>
      <div className="canvas-node" data-terminal-id="tm-b">
        <span className="canvas-port w" data-port="w" />
      </div>
      <span data-testid="linking">{String(wire.linking)}</span>
      <span data-testid="ghost">{wire.ghost ?? ''}</span>
    </div>
  );
};

const port = (terminalId: string) =>
  container.querySelector<HTMLElement>(`[data-terminal-id="${terminalId}"] .canvas-port`)!;
const flag = (id: string) => container.querySelector(`[data-testid="${id}"]`)!.textContent;

const down = (el: HTMLElement, x: number, y: number) => act(() => {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
});
const move = (x: number, y: number) => act(() => {
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
});
const up = (x: number, y: number) => act(() => {
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y }));
});

/** What `terminalIdAt` reads. jsdom has no layout, so the drop target is stated outright. */
const hoverNode = (terminalId: string | null) => {
  document.elementFromPoint = (() =>
    terminalId ? container.querySelector(`[data-terminal-id="${terminalId}"]`) : null) as never;
};

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // jsdom ships neither, and a real gesture uses both. The shim carries only what the hook
  // reads — `clientX/clientY` (from MouseEvent) and `pointerId` — so it cannot accidentally
  // make a test pass on a field the browser would not have supplied.
  if (!('PointerEvent' in window)) {
    class PointerEventShim extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    (window as unknown as Record<string, unknown>).PointerEvent = PointerEventShim;
    (globalThis as unknown as Record<string, unknown>).PointerEvent = PointerEventShim;
  }
  Element.prototype.setPointerCapture = function setPointerCapture() { /* no-op */ };
});

beforeEach(() => {
  created.length = 0;
  clicks = [];
  hoverNode(null);
  store = configureStore({ reducer: { canvas: canvasReducer } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(<Provider store={store}><Harness /></Provider>); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('a press that never moves is a click', () => {
  it('reports the port and where to put the menu', () => {
    down(port('tm-a'), 200, 150);
    up(200, 150);

    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ fromId: 'tm-a', side: 'e', x: 200, y: 150 });
  });

  it('still counts as a click after a wobble under the threshold', () => {
    down(port('tm-a'), 200, 150);
    move(201, 149);
    move(202, 151);
    up(202, 151);
    expect(clicks).toHaveLength(1);
  });

  it('creates no edge', () => {
    down(port('tm-a'), 200, 150);
    up(200, 150);
    expect(created).toEqual([]);
    expect(store.getState().canvas.edges).toEqual([]);
  });

  /**
   * `linking` reveals every node's ports as candidate targets. That is feedback for a drag; on
   * a click it is a flash of the whole canvas lighting up for a gesture that was not a drag,
   * which is why it now arms on the first move past the slop rather than on pointerdown.
   */
  it('never lights the canvas up as a link target', () => {
    down(port('tm-a'), 200, 150);
    expect(flag('linking')).toBe('false');
    move(201, 150);
    expect(flag('linking')).toBe('false');
    expect(flag('ghost')).toBe('');
    up(201, 150);
    expect(flag('linking')).toBe('false');
  });
});

describe('a press that moves is a drag', () => {
  it('arms the link feedback once past the threshold, and not before', () => {
    down(port('tm-a'), 200, 150);
    move(200 + DRAG_SLOP, 150);
    expect(flag('linking')).toBe('false');
    move(200 + DRAG_SLOP + 2, 150);
    expect(flag('linking')).toBe('true');
    expect(flag('ghost')).not.toBe('');
  });

  it('connects the node it is released over, and reports no click', () => {
    down(port('tm-a'), 200, 150);
    move(400, 150);
    hoverNode('tm-b');
    up(600, 150);

    expect(clicks).toEqual([]);
    expect(created).toEqual([['tm-a', 'tm-b']]);
  });

  /**
   * The asymmetry that stops a drag becoming a click on release: `moved` latches. A drag that
   * wanders out and comes back — very easy with a node near where the gesture started —
   * would otherwise end inside the slop and open a menu instead of finishing the drag.
   */
  it('stays a drag even if it returns to where it started', () => {
    down(port('tm-a'), 200, 150);
    move(500, 400);
    move(200, 150);
    up(200, 150);

    expect(clicks).toEqual([]);
    expect(created).toEqual([]);      // released over nothing — a cancelled drag, not a click
  });

  it('does not connect a node to itself', () => {
    down(port('tm-a'), 200, 150);
    move(400, 150);
    hoverNode('tm-a');
    up(400, 150);

    expect(created).toEqual([]);
    expect(clicks).toEqual([]);
  });
});

describe('the gesture ends cleanly either way', () => {
  it('clears its state after a click, so the next press starts fresh', () => {
    down(port('tm-a'), 200, 150);
    up(200, 150);
    // A stray move after release must not resurrect the gesture.
    move(900, 900);
    expect(flag('linking')).toBe('false');
    expect(flag('ghost')).toBe('');

    down(port('tm-b'), 300, 250);
    up(300, 250);
    expect(clicks).toHaveLength(2);
    expect(clicks[1]).toMatchObject({ fromId: 'tm-b', side: 'w' });
  });
});
