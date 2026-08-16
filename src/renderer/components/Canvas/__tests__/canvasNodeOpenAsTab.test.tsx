/**
 * @jest-environment jsdom
 *
 * The "open in its tab" affordance on a canvas node — the escape hatch from the overview
 * back to a normal terminal (`backlog/007` §4).
 *
 * It is a button inside a header that is itself a drag handle, sitting on a node that owns
 * three other gestures: pointerdown selects, click reaches the chip handler, dblclick
 * flies the viewport to focus. A button that fires its own action AND one of those does
 * two things per press, and which one you notice depends on the tier — so each is asserted
 * separately rather than trusting one "it doesn't bubble" case.
 *
 * Drives `react-dom/client` + `React.act` directly; the repo has no `@testing-library/react`.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { CanvasNode } from '../CanvasNode';
import { LodTier } from '../canvasGeometry';
import { CanvasNodeModel } from '../canvasSelectors';

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

const node: CanvasNodeModel = {
  terminalId: 'tm-1',
  tabId: 'tb-1',
  paneId: 'pn-1',
  title: 'server',
  shellType: 'zsh',
  rect: { x: 0, y: 0, w: 340, h: 210 },
  isRunning: false,
  hasUnseenOutput: false,
};

interface Handlers {
  onOpenAsTab?: () => void;
  onPointerDown?: () => void;
  onDoubleClick?: () => void;
  onChipClick?: () => void;
}

function render(tier: LodTier, handlers: Handlers = {}) {
  act(() => {
    root.render(
      <CanvasNode
        node={node}
        tier={tier}
        zoom={1}
        selected={false}
        focused={false}
        dimmed={false}
        hidden={false}
        {...handlers}
      />,
    );
  });
}

const button = () => container.querySelector<HTMLButtonElement>('.canvas-node-open');

/** A real bubbling event, so `stopPropagation` is exercised rather than simulated. */
const fire = (el: Element, type: string) =>
  act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })); });

describe('open-in-its-tab button', () => {
  it('appears on an interactive node and calls back when clicked', () => {
    const onOpenAsTab = jest.fn();
    render('gpu', { onOpenAsTab });

    expect(button()).not.toBeNull();
    fire(button()!, 'click');
    expect(onOpenAsTab).toHaveBeenCalledTimes(1);
  });

  // A chip is a few pixels of world space with the header taking the whole node; a button
  // there would be unhittable and would crowd out the one thing a chip has to show.
  it('is absent at the chip tier', () => {
    render('chip', { onOpenAsTab: jest.fn() });
    expect(button()).toBeNull();
  });

  it('is absent when no handler was supplied', () => {
    render('gpu', {});
    expect(button()).toBeNull();
  });

  it('does not also select the node', () => {
    const onPointerDown = jest.fn();
    render('gpu', { onOpenAsTab: jest.fn(), onPointerDown });

    act(() => {
      button()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    });
    expect(onPointerDown).not.toHaveBeenCalled();
  });

  it('does not also fly the viewport to focus', () => {
    const onDoubleClick = jest.fn();
    render('gpu', { onOpenAsTab: jest.fn(), onDoubleClick });

    fire(button()!, 'dblclick');
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  // Pairs with the negatives above: the node's own handlers must still work when the
  // click lands anywhere else, or "nothing bubbles" would be satisfiable by breaking them.
  it('leaves the node\'s own gestures working elsewhere in the header', () => {
    const onPointerDown = jest.fn();
    const onDoubleClick = jest.fn();
    render('gpu', { onOpenAsTab: jest.fn(), onPointerDown, onDoubleClick });

    const title = container.querySelector('.canvas-node-title')!;
    act(() => {
      title.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    });
    fire(title, 'dblclick');

    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it('names the terminal it opens, for screen readers', () => {
    render('gpu', { onOpenAsTab: jest.fn() });
    expect(button()!.getAttribute('aria-label')).toContain('server');
    // A bare <button> inside a form-less header still defaults to type="submit" in HTML;
    // being explicit costs nothing and removes a class of surprise.
    expect(button()!.type).toBe('button');
  });
});
