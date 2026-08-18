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

/**
 * The agent chip's data source, stubbed at the hook.
 *
 * Not optional and not only for speed: the real `useDetectedAgent` reaches
 * `AgentSchemeTracker` → the store → `colorSchemas` → `TerminalEngine` → xterm, which calls
 * `HTMLCanvasElement.getContext` at module scope and throws in jsdom. Stubbing the hook keeps
 * this suite about the node's header, and gives the chip's own cases a value to drive.
 */
let mockAgent: { agent: string | null; icon: string | null } = { agent: null, icon: null };
jest.mock('../../Terminal/useDetectedAgent', () => ({
  useDetectedAgent: () => mockAgent,
}));

beforeEach(() => { mockAgent = { agent: null, icon: null }; });

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
  onClose?: () => void;
  onPointerDown?: () => void;
  onDoubleClick?: () => void;
  onChipClick?: () => void;
  onContextMenu?: () => void;
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
const closeButton = () =>
  container.querySelector<HTMLButtonElement>('.canvas-node-close');

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
 * The close button — Tam's item 1.
 *
 * It shares `.canvas-node-open`'s box with the two above it, which is exactly why the cases
 * here are about telling it apart from them. What it does is irreversible and what they do is
 * not, so "the third button in a row of identical 18px squares" has to be distinguishable by
 * more than position.
 */
describe('close-terminal button', () => {
  it('is a third control, not a replacement for either', () => {
    render('gpu', { onOpenAsTab: jest.fn(), onOpenOverlay: jest.fn(), onClose: jest.fn() });
    expect(container.querySelectorAll('.canvas-node-open')).toHaveLength(3);
    expect(closeButton()).not.toBeNull();
    expect(closeButton()).not.toBe(button());
    expect(closeButton()).not.toBe(overlayButton());
  });

  it('calls back when clicked, and only itself', () => {
    const onClose = jest.fn();
    const onOpenAsTab = jest.fn();
    const onOpenOverlay = jest.fn();
    render('gpu', { onClose, onOpenAsTab, onOpenOverlay });

    fire(closeButton()!, 'click');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenAsTab).not.toHaveBeenCalled();
    expect(onOpenOverlay).not.toHaveBeenCalled();
  });

  /**
   * The header is a drag handle. A close button that let pointerdown through would start a
   * drag on the node it is about to remove — and the pointer capture that drag takes outlives
   * the node, so the canvas keeps following the mouse with nothing under it.
   */
  it('stops the node gestures, like its neighbours', () => {
    const onPointerDown = jest.fn();
    const onDoubleClick = jest.fn();
    render('gpu', { onClose: jest.fn(), onPointerDown, onDoubleClick });

    act(() => {
      closeButton()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    });
    fire(closeButton()!, 'dblclick');
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('names the terminal it closes, and says so on hover', () => {
    render('gpu', { onClose: jest.fn() });
    expect(closeButton()!.getAttribute('aria-label')).toContain('server');
    expect(closeButton()!.getAttribute('title')).toBe('Close terminal');
    expect(closeButton()!.type).toBe('button');
  });

  it('is absent at the chip tier, and when no handler was supplied', () => {
    render('chip', { onClose: jest.fn() });
    expect(closeButton()).toBeNull();
    render('gpu', {});
    expect(closeButton()).toBeNull();
  });

  /**
   * The half of item 1 that is about the OTHER button: while a node is overlaid, the control
   * that shrinks it used to render `✕`. With a real close beside it, one header would have held
   * two ✕ with different meanings, one of which kills a shell.
   */
  it('does not share its glyph with the shrink control', () => {
    render('gpu', { onClose: jest.fn(), onOpenOverlay: jest.fn() }, true);
    expect(closeButton()!.textContent).toBe('✕');
    expect(overlayButton()!.textContent).not.toBe('✕');
  });
});

/**
 * The agent/CLI chip in the title bar — Tam's item 6.
 *
 * `AgentChip` exists but is positioned over the PANE's terminal content, and Canvas Mode moves
 * `term.element` out of the pane into a node host while `TerminalPane` (and its chip) stay in
 * the background tab — so the canvas showed no agent at all.
 */
describe('agent chip', () => {
  const chip = () => container.querySelector('.canvas-node-agent');

  it('shows the detected agent beside the shell badge', () => {
    mockAgent = { agent: 'claude', icon: null };
    render('gpu', {});
    expect(chip()).not.toBeNull();
    expect(chip()!.textContent).toContain('claude');
    // Both are present: they are different facts. The shell is what the pane was launched as
    // and never changes; the agent is what is running in it right now.
    expect(container.querySelector('.canvas-node-shell')!.textContent).toBe('zsh');
  });

  it('renders nothing for a plain shell', () => {
    mockAgent = { agent: null, icon: null };
    render('gpu', {});
    expect(chip()).toBeNull();
  });

  it('shows the binary icon when one resolved', () => {
    mockAgent = { agent: 'codex', icon: 'data:image/png;base64,AAA' };
    render('gpu', {});
    expect(chip()!.querySelector('img')).not.toBeNull();
  });

  /**
   * Split from the case above rather than re-rendering into the same tree, and the reason is
   * the memo on `CanvasNodeAgent`.
   *
   * Mutating `mockAgent` and calling `render` again is a PARENT re-render with identical
   * props, which a memoised child correctly skips — so the old chip stayed on screen and the
   * test read that as a bug in the component. It is not how the value changes in production:
   * `useDetectedAgent` subscribes to the tracker and updates the chip's OWN state, and memo
   * never blocks a re-render a component schedules for itself. Each case gets a fresh tree
   * (`beforeEach` makes one), which is also the more honest arrangement: "an agent whose
   * binary icon never resolved" is a starting state, not a transition.
   */
  it('copes with an agent whose icon never resolved', () => {
    mockAgent = { agent: 'codex', icon: null };
    render('gpu', {});
    expect(chip()!.querySelector('img')).toBeNull();
    expect(chip()!.textContent).toContain('codex');
  });

  // Same reason the buttons and the shell badge go: at the chip tier the header IS the node.
  it('is absent at the chip tier', () => {
    mockAgent = { agent: 'claude', icon: null };
    render('chip', {});
    expect(chip()).toBeNull();
  });
});

/**
 * What the NODE still publishes, now that the two counter-scales moved to the root.
 *
 * `--node-k` and `--node-chrome-k` are functions of the zoom alone, so `CanvasMode` sets them
 * once on `.canvas-mode` — which is also what lets a group FRAME read the chrome scale, since
 * frames are siblings of nodes rather than children. What stays here is the one thing that is
 * genuinely per-node: the surface scale, which depends on this node's own width and is the
 * entire implementation of the overlay.
 */
describe('per-node custom properties', () => {
  const node = () => container.querySelector<HTMLElement>('.canvas-node')!;

  const renderAt = (zoom: number) => act(() => {
    root.render(withMetrics(
      <CanvasNode node={node0} tier="gpu" zoom={zoom} selected={false} focused={false}
        dimmed={false} hidden={false} />,
    ));
  });

  it('publishes a surface scale derived from its own width', () => {
    renderAt(1);
    expect(Number(node().style.getPropertyValue('--node-surface-scale')))
      .toBeCloseTo(node0.rect.w / DEFAULT_METRICS.hostW, 9);
  });

  // The zoom-only scales must NOT be duplicated here. Two writers for one value is how they
  // drift, and the node-level copy is the one that cannot reach a group frame.
  it('does not also publish the zoom-only scales', () => {
    renderAt(4);
    expect(node().style.getPropertyValue('--node-k')).toBe('');
    expect(node().style.getPropertyValue('--node-chrome-k')).toBe('');
  });

  // The header gives up its slack so the BODY never changes world height — the invariant the
  // surface scale depends on. Asserted through the rendered box, not the formula.
  it('shrinks the node by exactly the header slack, never the body', () => {
    const heights: number[] = [];
    for (const zoom of [1, 4]) {
      renderAt(zoom);
      heights.push(parseFloat(node().style.height));
    }
    expect(heights[0]).toBeCloseTo(node0.rect.h, 6);
    expect(heights[1]).toBeCloseTo(node0.rect.h - HEAD_H + HEAD_H / 4, 6);
  });
});

/**
 * The node applies ITS OWN host box (`plan/017`).
 *
 * This is the consumer that makes the whole fix reachable, and it had no coverage: with
 * `canvasHostBoxes` measuring correctly and the stylesheet reading `--node-host-w` correctly, a
 * `CanvasNode` that quietly ignored its `hostBox` prop still passed all 261 tests. The variable
 * would simply never be set, `.canvas-surface` would take its `var(--canvas-host-w)` fallback
 * arm, and every terminal would be re-fitted to the session box exactly as before — the bug,
 * fully restored, behind a green suite.
 *
 * So these assert the DIFFERENCE from the session box rather than the value alone. A box equal
 * to `DEFAULT_METRICS` would be satisfied by either code path and would prove nothing — see
 * [[test-arrange-right-assert-blind]].
 */
describe('per-node host box', () => {
  const node = () => container.querySelector<HTMLElement>('.canvas-node')!;
  /** Deliberately unlike DEFAULT_METRICS on both axes — a quarter-split pane. */
  const BOX = { w: 1263.5, h: 622.25 };

  const renderWith = (hostBox?: { w: number; h: number }) => act(() => {
    root.render(withMetrics(
      <CanvasNode node={node0} tier="gpu" zoom={1} selected={false} focused={false}
        dimmed={false} hidden={false} hostBox={hostBox} />,
    ));
  });

  it('publishes its own box as pixel lengths, not the session box', () => {
    renderWith(BOX);
    expect(node().style.getPropertyValue('--node-host-w')).toBe(`${BOX.w}px`);
    expect(node().style.getPropertyValue('--node-host-h')).toBe(`${BOX.h}px`);
    // The guard on the guard: if these ever coincided, the assertions above would hold for a
    // node that ignored its prop entirely.
    expect(BOX.w).not.toBe(DEFAULT_METRICS.hostW);
    expect(BOX.h).not.toBe(DEFAULT_METRICS.hostH);
  });

  it('scales the surface against its own box, so the overlay lands at 1:1', () => {
    renderWith(BOX);
    expect(Number(node().style.getPropertyValue('--node-surface-scale')))
      .toBeCloseTo(node0.rect.w / BOX.w, 9);
  });

  // Decision C: the overlay is the terminal at ACTUAL size. A node given a world rect equal to
  // its own host box must render its surface at exactly scale 1 — that is the whole contract,
  // and it is per-terminal, so a node whose box came from a small pane reaches 1:1 at a smaller
  // rect than one from a full-width pane.
  it('reaches exactly 1:1 when the world rect equals its own box', () => {
    act(() => {
      root.render(withMetrics(
        <CanvasNode node={{ ...node0, rect: { ...node0.rect, w: BOX.w } }} tier="gpu" zoom={1}
          selected={false} focused={false} dimmed={false} hidden={false} hostBox={BOX} />,
      ));
    });
    expect(Number(node().style.getPropertyValue('--node-surface-scale'))).toBeCloseTo(1, 9);
  });

  // The documented fallback: a terminal with nothing to measure gets the session box, and is
  // the one case that still re-fits on entry (`plan/017` §6).
  it('falls back to the session box when it has none of its own', () => {
    renderWith(undefined);
    expect(node().style.getPropertyValue('--node-host-w')).toBe(`${DEFAULT_METRICS.hostW}px`);
    expect(Number(node().style.getPropertyValue('--node-surface-scale')))
      .toBeCloseTo(node0.rect.w / DEFAULT_METRICS.hostW, 9);
  });
});
