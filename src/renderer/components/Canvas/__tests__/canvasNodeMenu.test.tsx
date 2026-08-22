/**
 * @jest-environment jsdom
 *
 * A terminal node's right-click menu (Tam, 2026-08-21).
 *
 * It shipped offering exactly one item — Close Terminal — so the gesture people try first led
 * only to the irreversible action, while the two ways out of the overview sat in header buttons
 * that appear on hover and vanish at the chip tier.
 *
 * What is actually worth pinning here is not "three items exist" but the two things that make
 * the menu honest:
 *
 *  - **The overlay item has two FACES**, and the label must match what the click will do. An
 *    item reading "Enlarge on the canvas" on a node already filling the screen still toggles
 *    the overlay — shut — so a wrong label is not a cosmetic defect, it is an item that does
 *    the opposite of what it says. Asserted as a table over `overlaid`.
 *  - **It shares its vocabulary with the header buttons.** The labels are those buttons'
 *    tooltips verbatim; derived from `CanvasNode`'s source below rather than restated, so a
 *    rename on one surface fails here instead of quietly splitting into two vocabularies.
 *
 * The menu portals to `document.body` (see `CanvasMenu`), so every query is rooted there.
 */
import React, { act } from 'react';
import path from 'path';
import { createRoot, Root } from 'react-dom/client';
import { CanvasNodeMenu } from '../CanvasNodeMenu';
import { readSource } from '../../../utils/readSource';

let container: HTMLDivElement;
let root: Root;
let handlers: {
  onToggleOverlay: jest.Mock;
  onOpenAsTab: jest.Mock;
  onCloseTerminal: jest.Mock;
  onDismiss: jest.Mock;
};

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  handlers = {
    onToggleOverlay: jest.fn(),
    onOpenAsTab: jest.fn(),
    onCloseTerminal: jest.fn(),
    onDismiss: jest.fn(),
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (overlaid: boolean) => {
  act(() => {
    root.render(
      <CanvasNodeMenu x={40} y={60} title="server" overlaid={overlaid} {...handlers} />,
    );
  });
};

/**
 * Every row, in order, as the WORDS a user reads — the icon deliberately excluded.
 *
 * `CanvasMenuItem` renders the glyph as a `.menu-icon` span inside the same button, so a bare
 * `textContent` returns `"⛶Enlarge on the canvas"`. The icon has its own assertions below; a
 * label check that carried it would fail on a glyph change and read as a wording regression.
 */
const labels = (): string[] =>
  [...document.querySelectorAll('.canvas-menu .context-menu-item')]
    .map((b) => (b.textContent ?? '').replace(b.querySelector('.menu-icon')?.textContent ?? '', ''));

const itemMatching = (fragment: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.canvas-menu .context-menu-item')]
    .find((b) => (b.textContent ?? '').includes(fragment));
  if (!found) throw new Error(`no menu item matching "${fragment}" — labels: ${labels().join(' | ')}`);
  return found;
};

const click = (el: Element) =>
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });

describe('the node menu offers more than the destructive action', () => {
  it('lists enlarge, open-in-tab and close, in that order', () => {
    render(false);
    expect(labels()).toEqual([
      'Enlarge on the canvas',
      'Open in its tab',
      'Close Terminal',
    ]);
  });

  it('names the terminal it acts on', () => {
    render(false);
    expect(document.querySelector('.canvas-menu .context-menu-header')!.textContent).toBe('server');
  });

  /**
   * The destructive item stays LAST and stays marked, for the reason the header's close button is
   * last: it must not sit where a click aimed at either item above it can land, and it must not
   * look like its two harmless neighbours.
   */
  it('keeps close last, marked dangerous, and behind a divider', () => {
    render(false);
    const items = [...document.querySelectorAll('.canvas-menu .context-menu-item')];
    const close = items[items.length - 1];
    expect(labels()[labels().length - 1]).toBe('Close Terminal');
    expect(close.classList.contains('danger')).toBe(true);
    // ...and the two above it are NOT, or `danger` would say nothing about which is which.
    expect(items.slice(0, -1).some((i) => i.classList.contains('danger'))).toBe(false);

    const dividers = [...document.querySelectorAll('.canvas-menu .context-menu-divider')];
    expect(dividers.length).toBe(2);
    expect(dividers[1].compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });
});

/**
 * The state table. Each row is (what the user sees × what the click does), asserted together —
 * a label and a handler checked in separate cases can both pass while pointing opposite ways.
 */
describe('the overlay item changes face with the node', () => {
  type Row = { overlaid: boolean; label: string; icon: string };
  const TABLE: Row[] = [
    { overlaid: false, label: 'Enlarge on the canvas', icon: '⛶' },
    { overlaid: true, label: 'Shrink back to the canvas', icon: '⤡' },
  ];

  it.each(TABLE)('overlaid=$overlaid reads "$label"', ({ overlaid, label, icon }) => {
    render(overlaid);
    const item = itemMatching(label);
    expect(item.querySelector('.menu-icon')!.textContent).toBe(icon);
    click(item);
    expect(handlers.onToggleOverlay).toHaveBeenCalledTimes(1);
    // ...and nothing else fired. One row, one action.
    expect(handlers.onOpenAsTab).not.toHaveBeenCalled();
    expect(handlers.onCloseTerminal).not.toHaveBeenCalled();
  });

  // The negative that makes the table mean something: the OTHER face must be absent, not merely
  // out-ranked. A menu rendering both would satisfy every row above.
  it.each(TABLE)('overlaid=$overlaid shows only that face', ({ overlaid }) => {
    render(overlaid);
    const shown = labels().filter((l) => /Enlarge|Shrink/.test(l));
    expect(shown).toHaveLength(1);
  });

  /**
   * Tam asked for a better word than "close" here, and this is the guard on the answer: `✕ Close
   * Terminal` sits in the same menu and kills a shell. Two items called "close", one destructive,
   * is the ambiguity `canvasCloseWiring` already policed the ✕ GLYPH for — the word needs the
   * same protection, or the fix holds on the icon and leaks through the label.
   */
  it('never calls the shrink item a close', () => {
    render(true);
    const shrink = labels().find((l) => /Shrink/.test(l))!;
    expect(shrink.toLowerCase()).not.toContain('close');
    expect(labels().filter((l) => /close/i.test(l))).toEqual(['Close Terminal']);
  });

  it('never wears the close glyph on a sizing item', () => {
    for (const overlaid of [false, true]) {
      render(overlaid);
      expect(itemMatching(overlaid ? 'Shrink' : 'Enlarge').querySelector('.menu-icon')!.textContent)
        .not.toBe('✕');
    }
  });
});

describe('each item runs its own action and dismisses the menu', () => {
  it.each([
    ['Open in its tab', 'onOpenAsTab'],
    ['Close Terminal', 'onCloseTerminal'],
  ] as const)('%s calls %s', (label, key) => {
    render(false);
    click(itemMatching(label));
    expect(handlers[key]).toHaveBeenCalledTimes(1);
    expect(handlers.onDismiss).toHaveBeenCalledTimes(1);
  });

  // A menu left open over the tab it just switched to (or over a node it just closed) is the
  // failure this covers — each item dismisses, not just the ones that stay on the canvas.
  it('dismisses on every item, including the overlay toggle', () => {
    render(false);
    click(itemMatching('Enlarge'));
    expect(handlers.onDismiss).toHaveBeenCalledTimes(1);
  });
});

/**
 * The vocabulary is SHARED with the header buttons, not merely similar.
 *
 * `CanvasNode`'s two controls carry these strings in their `title` attributes. Restating them
 * here as literals would let a rename on one surface pass silently, leaving the app with two
 * names for one action — which is the whole reason the menu reuses the button's words.
 */
describe('the menu and the header buttons say the same thing', () => {
  const NODE_TSX = readSource(path.resolve(__dirname, '../CanvasNode.tsx'));

  it.each([
    ['Enlarge on the canvas', false],
    ['Shrink back to the canvas', true],
    ['Open in its tab', false],
  ] as const)('"%s" is also a header button tooltip', (label, overlaid) => {
    expect(NODE_TSX).toContain(label);
    render(overlaid);
    expect(labels()).toContain(label);
  });
});

/**
 * The WIRING — `CanvasMode` hands this component its props, and every case above holds against a
 * caller that passes the wrong ones.
 *
 * Source-derived because mounting `CanvasMode` means mounting the terminals it hosts. Comments
 * are stripped first: this component's own docblock names both labels and both handlers, so an
 * un-stripped regex would happily match the prose explaining the rule instead of the rule.
 */
describe('CanvasMode wires the menu to the live overlay', () => {
  const MODE = readSource(path.resolve(__dirname, '../CanvasMode.tsx'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const props = (): string => {
    const m = /<CanvasNodeMenu[\s\S]*?\/>/.exec(MODE);
    expect(m).not.toBeNull();
    return m![0];
  };

  it('renders the menu component rather than inlining items again', () => {
    expect(MODE).toContain('<CanvasNodeMenu');
    // The old single-item menu is gone, not left beside the new one — two node menus would both
    // open on one right-click, stacked.
    expect(MODE).not.toMatch(/<CanvasMenu\b[\s\S]*?Close Terminal/);
  });

  /**
   * `overlaid` must be READ from the live `overlayId`, never remembered when the menu opened.
   * The overlay's backdrop stays clickable while the menu is up, so a snapshot taken at open
   * time can be stale by the time the item is clicked — and the item would then read "Shrink
   * back to the canvas" for a node already back on it.
   */
  it('derives the overlaid face from the live overlayId', () => {
    expect(props()).toMatch(/overlaid=\{overlayId === nodeMenu\.node\.terminalId\}/);
  });

  /** A toggle, not an open: the same handler must close the overlay when it is already this node. */
  it('toggles the overlay rather than always opening it', () => {
    const toggle = /onToggleOverlay=\{([\s\S]*?)\}\n/.exec(props())?.[1] ?? '';
    expect(toggle).toContain('closeOverlay()');
    expect(toggle).toContain('setOverlayNode(nodeMenu.node.terminalId)');
  });

  /**
   * `openAsTab` takes (tabId, paneId) and both come off the node the menu was opened on.
   * Passing the SELECTED node instead would work in every ordinary case — the right-click
   * selects — and silently open the wrong tab whenever the selection had moved on.
   */
  it('opens the tab of the node the menu belongs to', () => {
    expect(props()).toMatch(/onOpenAsTab=\{openAsTab\(nodeMenu\.node\.tabId, nodeMenu\.node\.paneId\)\}/);
  });

  it('still routes close through the shared close flow', () => {
    expect(props()).toMatch(/onCloseTerminal=\{\(\) => closeNode\(nodeMenu\.node\)\}/);
  });

  // Guard on the guard: `props()` returning an empty string would make every match above
  // vacuous, and an empty string is exactly what a renamed component yields.
  it('found a real element to read', () => {
    expect(props().length).toBeGreaterThan(80);
    expect(props()).toContain('nodeMenu.x');
  });
});

