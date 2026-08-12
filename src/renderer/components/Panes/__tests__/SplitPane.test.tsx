/**
 * @jest-environment jsdom
 *
 * Plan 012: double-clicking a pane splitter should balance the two panes on
 * that split to 50/50, reusing the existing onDragFinished(size) commit path.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

jest.mock('../SplitPane.css', () => ({}));

import { SplitPane } from '../SplitPane';

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

describe('SplitPane divider double-click (plan 012)', () => {
  it('calls onDragFinished(50) when the divider is double-clicked', () => {
    const onDragFinished = jest.fn();
    act(() => {
      root.render(
        <SplitPane split="vertical" size={70} onDragFinished={onDragFinished}>
          {[<div key="a">A</div>, <div key="b">B</div>]}
        </SplitPane>
      );
    });

    const divider = container.querySelector('.split-pane-divider') as HTMLElement;
    expect(divider).not.toBeNull();

    act(() => {
      divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    expect(onDragFinished).toHaveBeenCalledWith(50);
  });

  it('does not render a divider (and so cannot be balanced) while a child is maximized', () => {
    const onDragFinished = jest.fn();
    act(() => {
      root.render(
        <SplitPane split="vertical" size={70} onDragFinished={onDragFinished} maximizedChild={0}>
          {[<div key="a">A</div>, <div key="b">B</div>]}
        </SplitPane>
      );
    });

    expect(container.querySelector('.split-pane-divider')).toBeNull();
  });
});
