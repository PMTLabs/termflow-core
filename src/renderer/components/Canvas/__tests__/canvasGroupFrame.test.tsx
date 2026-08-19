/**
 * @jest-environment jsdom
 *
 * Where a group's right-click menu may be reached from — and, just as much, where it may not.
 *
 * The frame is a real box, not a `pointer-events: none` outline: it covers the canvas background
 * everywhere a group sits. Hanging the menu on the frame itself would therefore shadow the
 * background's own "New terminal here" menu across the whole interior of every group, which is
 * the larger and more useful target. So the gesture belongs to the group's HANDLES — the label
 * when the group is drawn as a frame, the chip when the workspace has collapsed past that tier —
 * and the negative case below is the half that keeps it that way.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { CanvasGroupFrame } from '../CanvasGroupFrame';
import { CanvasMetricsContext } from '../canvasMetricsContext';
import { DEFAULT_METRICS } from '../canvasGeometry';
import type { CanvasGroupModel } from '../canvasSelectors';

const group: CanvasGroupModel = {
  tabId: 'tb-a',
  title: 'api',
  rect: { x: 100, y: 120, w: 900, h: 600 },
  nodeIds: ['tm-1', 'tm-2'],
  anyRunning: false,
};

let container: HTMLDivElement;
let root: Root;
let onContextMenu: jest.Mock;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  onContextMenu = jest.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (collapsed: boolean) => {
  act(() => {
    root.render(
      <CanvasMetricsContext.Provider value={DEFAULT_METRICS}>
        <CanvasGroupFrame
          group={group}
          zoom={collapsed ? 0.05 : 1}
          collapsed={collapsed}
          onContextMenu={onContextMenu}
        />
      </CanvasMetricsContext.Provider>,
    );
  });
};

const rightClick = (el: Element | null) => {
  act(() => { el!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
};

const label = () => container.querySelector('.canvas-glabel');
const frame = () => container.querySelector('.canvas-gframe');
const chip = () => container.querySelector('.canvas-gchip');

describe('CanvasGroupFrame — reaching the group menu', () => {
  it('opens it from the label', () => {
    render(false);
    rightClick(label());
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  /** Collapsed, the label is gone and the chip is the only thing still legible — and so the only
   *  handle the group has left. */
  it('opens it from the chip once the group has collapsed', () => {
    render(true);
    expect(label()).toBeNull();
    rightClick(chip());
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  /**
   * The negative half. A right-click inside a group — which is most of the canvas — must still
   * reach the background menu that spawns a terminal where you pointed.
   */
  it('leaves the frame\'s interior to the background menu', () => {
    render(false);
    rightClick(frame());
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it('does not fire on an ordinary click of the label', () => {
    render(false);
    act(() => { label()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onContextMenu).not.toHaveBeenCalled();
  });
});
