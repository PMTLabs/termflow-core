/**
 * @jest-environment jsdom
 *
 * The tab colour on the tab strip's transient surfaces: the rename popup, and the tear-off drag
 * preview that lives in its own OS window.
 *
 * The preview is the one worth the most care. It is a SEPARATE renderer with its own store, so the
 * colour cannot be selected there — it has to arrive as data, and it arrives by two different
 * routes: a query parameter when the window is first created, and an event when an existing window
 * is reused for another tab. Those are independent code paths in two languages, and wiring only
 * one leaves either the session's FIRST drag or all the others showing the wrong colour. Which
 * half broke would depend on drag order, so it would present as flakiness rather than as a bug.
 * Both routes are asserted below.
 *
 * NOT covered here, stated rather than left to be discovered: `TabContextMenu`'s header, and the
 * imperative DOM ghost `makeTabGhost` builds on the non-native drag path. The first pulls the real
 * app store and its services into the suite and breaks this file's event mock through a circular
 * import; the second is module-private to `TabManager` and reachable only by driving a whole tab
 * drag. Both are wired the same way as the surfaces above and are covered by the typecheck, but
 * neither has a test — see the branch notes.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { TabRenamePopup } from '../TabRenamePopup';
import { renderDragPreview } from '../DragPreview';

/**
 * The Tauri event bridge, captured rather than stubbed away: the test needs to FIRE
 * `drag-preview:title` to exercise the reuse route, which is the half a query-param-only fix
 * would leave broken.
 */
let emit: ((payload: unknown) => void) | null = null;
let listenedEventName: string | null = null;
jest.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    listenedEventName = name;
    emit = (payload: unknown) => cb({ payload });
    return Promise.resolve(() => { emit = null; });
  },
}));

const RED = '#ff5f56';
const GREEN = '#27c93f';

const asCss = (hex: string) => {
  const probe = document.createElement('div');
  probe.style.color = hex;
  return probe.style.color;
};

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
  document.body.innerHTML = '';
  emit = null;
  listenedEventName = null;
});

const colourOf = (sel: string) =>
  (document.body.querySelector(sel) as HTMLElement | null)?.style.color ?? null;

describe('TabRenamePopup colour', () => {
  const render = (titleColor?: string) => {
    act(() => {
      root.render(
        <TabRenamePopup x={0} y={0} initialTitle="api" titleColor={titleColor} onSubmit={() => {}} onClose={() => {}} />,
      );
    });
  };

  it('shows the name being edited in the tab\'s colour, whatever the colour', () => {
    render(RED);
    expect(colourOf('.tab-rename-input')).toBe(asCss(RED));
    render(GREEN);
    expect(colourOf('.tab-rename-input')).toBe(asCss(GREEN));
  });

  it('leaves the box on its own styling for an uncoloured tab', () => {
    render(undefined);
    expect(colourOf('.tab-rename-input')).toBe('');
  });
});

describe('tear-off drag preview colour', () => {
  /** `renderDragPreview` mounts into `#root`, as the preview window's entry point does. */
  const mountPreview = (title: string, color?: string) => {
    const el = document.createElement('div');
    el.id = 'root';
    document.body.appendChild(el);
    act(() => { renderDragPreview(title, color); });
  };

  // ROUTE 1 — the query parameter, used when the preview window is created. This is the
  // session's FIRST tab drag.
  it('wears the colour handed to it at creation', () => {
    mountPreview('api', RED);
    expect(colourOf('.drag-preview-window__bar')).toBe(asCss(RED));
  });

  it('wears a GREEN colour handed to it at creation', () => {
    mountPreview('web', GREEN);
    expect(colourOf('.drag-preview-window__bar')).toBe(asCss(GREEN));
  });

  it('is bare at creation when the tab has no colour', () => {
    mountPreview('api', undefined);
    expect(colourOf('.drag-preview-window__bar')).toBe('');
  });

  // ROUTE 2 — the event, used when an EXISTING preview window is reused for a different tab.
  // Every drag after the first in a session takes this path.
  it('repaints when the window is reused for a differently-coloured tab', () => {
    mountPreview('api', RED);
    expect(listenedEventName).toBe('drag-preview:title');
    expect(colourOf('.drag-preview-window__bar')).toBe(asCss(RED));
    act(() => { emit!({ title: 'web', color: GREEN }); });
    expect(document.body.querySelector('.drag-preview-window__bar')!.textContent).toBe('web');
    expect(colourOf('.drag-preview-window__bar')).toBe(asCss(GREEN));
  });

  /**
   * Reuse for an UNCOLOURED tab has to clear the previous tab's colour.
   *
   * This is the case a naive `color && setColor(color)` would fail: the window is reused, so the
   * old colour is still in state, and dragging an uncoloured tab after a coloured one would show
   * it wearing the previous tab's group colour — a false statement about which group it is in.
   */
  it('clears the colour when reused for an uncoloured tab', () => {
    mountPreview('api', RED);
    act(() => { emit!({ title: 'plain', color: null }); });
    expect(colourOf('.drag-preview-window__bar')).toBe('');
  });
});
