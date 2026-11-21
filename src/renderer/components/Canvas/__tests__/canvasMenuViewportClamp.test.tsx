/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanvasMenu } from '../CanvasMenu';

// jsdom has no layout: give every element the menu's measured size.
const size = (width: number, height: number) => {
  jest.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(width);
  jest.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(height);
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  jest.restoreAllMocks();
});

const open = (x: number, y: number) => {
  act(() => root.render(<CanvasMenu x={x} y={y} onClose={() => {}}><div>items</div></CanvasMenu>));
  return document.querySelector<HTMLElement>('.canvas-menu')!;
};

test('menu_opened_near_the_bottom_right_corner_stays_fully_on_screen', () => {
  size(300, 500);
  const menu = open(900, 700);
  expect(menu.style.left).toBe(`${1000 - 300 - 4}px`);
  expect(menu.style.top).toBe(`${800 - 500 - 4}px`);
});

test('menu_with_room_opens_exactly_at_the_click_point', () => {
  size(300, 200);
  const menu = open(120, 90);
  expect(menu.style.left).toBe('120px');
  expect(menu.style.top).toBe('90px');
});

test('menu_taller_than_the_window_is_capped_and_scrolls_from_the_top_margin', () => {
  size(300, 2000);
  const menu = open(10, 600);
  expect(menu.style.maxHeight).toBe(`${800 - 8}px`);
  expect(menu.style.overflowY).toBe('auto');
  expect(menu.style.top).toBe('4px');
});
