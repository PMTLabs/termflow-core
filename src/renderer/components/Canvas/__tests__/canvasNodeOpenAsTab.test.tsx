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
import { LodTier, HEAD_H, DEFAULT_METRICS } from '../canvasGeometry';
import { CanvasMetricsContext } from '../canvasMetricsContext';
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

const node0: CanvasNodeModel = {
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
  onOpenOverlay?: () => void;
  onPointerDown?: () => void;
  onDoubleClick?: () => void;
  onChipClick?: () => void;
}

/** CanvasNode reads the session's host box from context (see `canvasMetrics`), so every
 *  render here goes through a provider — there is deliberately no fallback for a node
 *  rendered outside one. */
const withMetrics = (node: React.ReactNode) => (
  <CanvasMetricsContext.Provider value={DEFAULT_METRICS}>{node}</CanvasMetricsContext.Provider>
);

function render(tier: LodTier, handlers: Handlers = {}, overlaid = false) {
  act(() => {
    root.render(withMetrics(
      <CanvasNode
        node={node0}
        tier={tier}
        zoom={1}
        selected={false}
        focused={false}
        dimmed={false}
        hidden={false}
        overlaid={overlaid}
        {...handlers}
      />,
    ));
  });
}

/** The two header buttons, told apart by what they do rather than by their order. */
const byLabel = (fragment: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.canvas-node-open')]
    .find((b) => (b.getAttribute('aria-label') ?? '').includes(fragment)) ?? null;
const button = () => byLabel('in its tab');
const overlayButton = () => byLabel('anvas') ?? byLabel('Shrink');

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

/**
 * The second header control: enlarge this node to a near-full-screen overlay without leaving
 * the canvas. It shares `.canvas-node-open` with the open-in-its-tab button, so the cases that
 * matter are the ones that could confuse the two — and the state flip, which is the only part
 * of this component that changes shape rather than just its callback.
 */
describe('enlarge-on-the-canvas button', () => {
  it('sits beside the open-in-its-tab button without replacing it', () => {
    render('gpu', { onOpenAsTab: jest.fn(), onOpenOverlay: jest.fn() });
    expect(container.querySelectorAll('.canvas-node-open')).toHaveLength(2);
    expect(button()).not.toBeNull();
    expect(overlayButton()).not.toBeNull();
    expect(overlayButton()).not.toBe(button());
  });

  it('calls back when clicked, and only itself', () => {
    const onOpenOverlay = jest.fn();
    const onOpenAsTab = jest.fn();
    render('gpu', { onOpenAsTab, onOpenOverlay });

    fire(overlayButton()!, 'click');
    expect(onOpenOverlay).toHaveBeenCalledTimes(1);
    expect(onOpenAsTab).not.toHaveBeenCalled();
  });

  it('stops the node gestures, like its neighbour', () => {
    const onPointerDown = jest.fn();
    const onDoubleClick = jest.fn();
    render('gpu', { onOpenOverlay: jest.fn(), onPointerDown, onDoubleClick });

    act(() => {
      overlayButton()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    });
    fire(overlayButton()!, 'dblclick');
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('becomes a close control once the node IS the overlay', () => {
    const onOpenOverlay = jest.fn();
    render('gpu', { onOpenOverlay }, true);

    const b = overlayButton()!;
    expect(b.getAttribute('aria-label')).toMatch(/^Shrink/);
    expect(b.getAttribute('title')).toMatch(/Shrink/);
    fire(b, 'click');
    expect(onOpenOverlay).toHaveBeenCalledTimes(1);   // same handler, it toggles
  });

  it('is absent at the chip tier', () => {
    render('chip', { onOpenOverlay: jest.fn() });
    expect(overlayButton()).toBeNull();
  });

  // An overlaid node fills the screen. `chip` is a tier assignment made from the node's
  // ORIGINAL rect, which can still say "chip" while the overlay is open — rendering the
  // overlay as a 58px chip would be a spectacular way to lose a terminal.
  it('renders as a full node even if its tier still says chip', () => {
    render('chip', { onOpenOverlay: jest.fn() }, true);
    expect(overlayButton()).not.toBeNull();
    expect(container.querySelector('.canvas-node')!.className).toContain('overlaid');
  });

  it('suppresses the fly-to gesture while overlaid — it is already full size', () => {
    const onDoubleClick = jest.fn();
    render('gpu', { onOpenOverlay: jest.fn(), onDoubleClick }, true);
    fire(container.querySelector('.canvas-node-body')!, 'dblclick');
    expect(onDoubleClick).not.toHaveBeenCalled();
  });
});

/**
 * The counter-scaled chrome, from the component's side: `Canvas.css` expresses border, rings
 * and ports through `--node-k`, and that only works if the node actually sets it.
 * `canvasNodeChrome.test.ts` owns the stylesheet half; this owns the handoff.
 */
describe('counter-scale custom properties', () => {
  const node = () => container.querySelector<HTMLElement>('.canvas-node')!;

  it('publishes --node-k as 1 at and below zoom 1', () => {
    act(() => {
      root.render(withMetrics(
        <CanvasNode node={node0} tier="gpu" zoom={0.4} selected={false} focused={false}
          dimmed={false} hidden={false} />,
      ));
    });
    expect(node().style.getPropertyValue('--node-k')).toBe('1');
  });

  it('publishes the reciprocal above zoom 1, and a surface scale from the node width', () => {
    act(() => {
      root.render(withMetrics(
        <CanvasNode node={node0} tier="gpu" zoom={4} selected={false} focused={false}
          dimmed={false} hidden={false} />,
      ));
    });
    expect(Number(node().style.getPropertyValue('--node-k'))).toBeCloseTo(0.25, 9);
    expect(Number(node().style.getPropertyValue('--node-surface-scale')))
      .toBeCloseTo(node0.rect.w / DEFAULT_METRICS.hostW, 9);
  });

  // The header gives up its slack so the BODY never changes world height — the invariant the
  // surface scale depends on. Asserted through the rendered box, not the formula.
  it('shrinks the node by exactly the header slack, never the body', () => {
    const heights: number[] = [];
    for (const zoom of [1, 4]) {
      act(() => {
        root.render(withMetrics(
        <CanvasNode node={node0} tier="gpu" zoom={zoom} selected={false} focused={false}
            dimmed={false} hidden={false} />,
      ));
      });
      heights.push(parseFloat(node().style.height));
    }
    expect(heights[0]).toBeCloseTo(node0.rect.h, 6);
    expect(heights[1]).toBeCloseTo(node0.rect.h - HEAD_H + HEAD_H / 4, 6);
  });
});
