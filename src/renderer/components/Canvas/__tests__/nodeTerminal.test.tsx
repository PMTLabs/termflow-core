/**
 * @jest-environment jsdom
 *
 * `NodeTerminal` is the one canvas component whose MARKUP is a contract rather than
 * styling (design/012 D17), so it is worth the cost of a real DOM render. The repo
 * deliberately has no `@testing-library/react`, so this drives `react-dom/client` +
 * `React.act`, mirroring ToastContainer.test.tsx.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { NodeTerminal } from '../NodeTerminal';
import {
  __getSurfaceHostForTest, __resetSurfaceHostsForTest,
} from '../../../services/surfaceHosts';
import {
  setSurfaceChrome, __resetSurfaceChromeForTest,
} from '../../../services/surfaceChrome';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom implements no scrolling at all, and `CommandSuggestPopup` keeps its selected row in
  // view on every selection change. Stubbed rather than avoided: the popup is what this file
  // now renders, and the alternative is not rendering the real component.
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  __resetSurfaceHostsForTest();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (props: { terminalId: string; focused?: boolean }) =>
  act(() => {
    root.render(<NodeTerminal terminalId={props.terminalId} focused={props.focused ?? false} />);
  });

const hostEl = () => container.querySelector<HTMLElement>('.terminal-display')!;

describe('NodeTerminal', () => {
  it('registers its host under the terminal id', () => {
    render({ terminalId: 'tm-1' });
    expect(__getSurfaceHostForTest('tm-1')).toBe(hostEl());
  });

  it('satisfies the D17 host contract', () => {
    render({ terminalId: 'tm-1' });
    const host = hostEl();
    // FitAddon measures term.element.parentElement — the HOST, never the wrapper.
    expect(host.getAttribute('data-terminal-id')).toBe('tm-1');
    expect(host.parentElement!.classList.contains('terminal-display-wrapper')).toBe(true);
    // RC3 / H10: a host with no layout box makes proposeDimensions() return a bogus grid.
    expect(host.style.display).not.toBe('none');
  });

  // The class is not decoration: 15 CSS rules, the global Ctrl+C guard's
  // `closest('.terminal-display')` and the ended-region rail's
  // `closest('.terminal-display-wrapper')` all resolve through these two names.
  it('carries both contract class names', () => {
    render({ terminalId: 'tm-1' });
    expect(hostEl().classList.contains('terminal-display')).toBe(true);
    expect(hostEl().parentElement!.className).toContain('canvas-surface');
  });

  it('gives term.element no pointer events while the node is unfocused (D19)', () => {
    render({ terminalId: 'tm-1', focused: false });
    expect(hostEl().style.pointerEvents).toBe('none');
  });

  it('lifts the pointer gate when the node is focused', () => {
    render({ terminalId: 'tm-1', focused: false });
    render({ terminalId: 'tm-1', focused: true });
    expect(hostEl().style.pointerEvents).toBe('auto');
  });

  // A fresh arrow every render makes React detach and re-attach the ref on every
  // commit, and each detach relocates a LIVE terminal. Assert the element identity
  // rather than merely that something is registered — a re-register would leave a
  // different element in the slot and still look registered.
  it('keeps ONE registration, of the SAME element, across re-renders', () => {
    render({ terminalId: 'tm-1' });
    const first = __getSurfaceHostForTest('tm-1');
    expect(first).not.toBeNull();
    render({ terminalId: 'tm-1', focused: true });
    render({ terminalId: 'tm-1', focused: false });
    expect(__getSurfaceHostForTest('tm-1')).toBe(first);
  });

  it('clears its registration on unmount', () => {
    render({ terminalId: 'tm-1' });
    act(() => root.unmount());
    expect(__getSurfaceHostForTest('tm-1')).toBeNull();
    root = createRoot(container); // afterEach unmounts again; keep it valid
  });

  it('moves the registration when the terminal id changes', () => {
    render({ terminalId: 'tm-1' });
    render({ terminalId: 'tm-2' });
    expect(__getSurfaceHostForTest('tm-1')).toBeNull();
    expect(__getSurfaceHostForTest('tm-2')).toBe(hostEl());
  });

  // Two NodeTerminals for one id would alias the registry, which has no refcount:
  // whichever unmounts first clears the slot while the other is still displaying that
  // exact element (spike 004 Q5). Nothing prevents it structurally, so pin the
  // last-writer-wins behaviour that results, as the evidence for §4.1's single-owner rule.
  it('leaves the LAST registrant owning the slot when a second one appears', () => {
    act(() => {
      root.render(
        <>
          <NodeTerminal terminalId="tm-dup" focused={false} />
          <NodeTerminal terminalId="tm-dup" focused={false} />
        </>,
      );
    });
    const all = container.querySelectorAll<HTMLElement>('.terminal-display');
    expect(all).toHaveLength(2);
    expect(__getSurfaceHostForTest('tm-dup')).toBe(all[1]);
  });
});

/**
 * `plan/020` §5 — the overlay carries the pane's floating chrome.
 *
 * `TerminalDisplay` publishes the state; this renders it. The pairing that matters is
 * overlaid-vs-not: an ordinary node draws its surface below 1:1 inside a clipping box, so the
 * same popup there would be both shrunken and cut off. Every positive below has its negative.
 */
describe('NodeTerminal chrome (overlay only)', () => {
  const CHROME = {
    atBottom: true,
    suggest: { open: false, items: [], selectedIndex: 0, focused: false, anchor: null },
    scrollToBottom: jest.fn(),
    pickSuggestion: jest.fn(),
    openContextMenu: jest.fn(),
    restartSession: jest.fn(),
    dismissSessionClosed: jest.fn(),
  };
  const owner = {};

  const renderNode = (overlaid: boolean) =>
    act(() => {
      root.render(<NodeTerminal terminalId="tm-c" focused overlaid={overlaid} />);
    });

  const button = () => container.querySelector('.scroll-to-bottom-button');
  const popup = () => container.querySelector('.command-suggest-popup');

  afterEach(() => __resetSurfaceChromeForTest());

  it('draws nothing at all when no host is publishing chrome', () => {
    renderNode(true);
    expect(button()).toBeNull();
    expect(popup()).toBeNull();
  });

  it('shows the scroll-to-bottom button only once scrolled away', () => {
    setSurfaceChrome('tm-c', owner, { ...CHROME, atBottom: true });
    renderNode(true);
    // Pinned to the tail: the button exists as a component but renders nothing.
    expect(button()).toBeNull();

    act(() => { setSurfaceChrome('tm-c', owner, { ...CHROME, atBottom: false }); });
    expect(button()).not.toBeNull();
  });

  it('does NOT show it on an ordinary node', () => {
    setSurfaceChrome('tm-c', owner, { ...CHROME, atBottom: false });
    renderNode(false);
    expect(button()).toBeNull();
  });

  it('renders the suggest popup, inside the surface wrapper that anchors it', () => {
    setSurfaceChrome('tm-c', owner, {
      ...CHROME,
      suggest: { open: true, items: ['git status'], selectedIndex: 0, focused: true, anchor: null },
    });
    renderNode(true);
    const el = popup();
    expect(el).not.toBeNull();
    // `CommandSuggestPopup` places itself against `offsetParent`, so it has to be a child of the
    // wrapper that carries the terminal's box — the same relationship it has in the pane.
    expect(el!.parentElement).toBe(container.querySelector('.canvas-surface'));
    expect(el!.textContent).toContain('git status');
  });

  it('does NOT render the popup on an ordinary node', () => {
    setSurfaceChrome('tm-c', owner, {
      ...CHROME,
      suggest: { open: true, items: ['git status'], selectedIndex: 0, focused: true, anchor: null },
    });
    renderNode(false);
    expect(popup()).toBeNull();
  });

  it('leaves the host contract untouched', () => {
    setSurfaceChrome('tm-c', owner, { ...CHROME, atBottom: false });
    renderNode(true);
    // The chrome is a SIBLING of the host, never inside it: `FitAddon` measures the host, and
    // an extra child there is a box that moves with the terminal's own geometry.
    const host = container.querySelector<HTMLElement>('.terminal-display')!;
    expect(host.children).toHaveLength(0);
    expect(__getSurfaceHostForTest('tm-c')).toBe(host);
  });

  /**
   * `plan/021` R2 — the TEXT context menu.
   *
   * Unlike the popup and the button, this one is a TRIGGER rather than a rendered thing: the
   * menu is portaled to `document.body` by `TerminalDisplay`, so all that has to cross is the
   * right-click. What can go wrong is that it never crosses (the node's own menu opens
   * instead) or that BOTH open.
   */
  describe('context menu trigger', () => {
    const rightClick = (el: Element) => {
      const ev = new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 120, clientY: 340,
      });
      act(() => { el.dispatchEvent(ev); });
      return ev;
    };

    it('hands a right-click on the overlaid terminal to the pane\'s menu', () => {
      const openContextMenu = jest.fn();
      setSurfaceChrome('tm-c', owner, { ...CHROME, openContextMenu });
      renderNode(true);
      const ev = rightClick(container.querySelector('.terminal-display')!);
      // Viewport coordinates, straight through: `ContextMenu` is `position: fixed`.
      expect(openContextMenu).toHaveBeenCalledWith(120, 340);
      expect(ev.defaultPrevented).toBe(true);
    });

    it('stops the event so the NODE menu does not open behind it', () => {
      // The node binds its own `onContextMenu` on `.canvas-node`, an ancestor of this host.
      // Without `stopPropagation` a right-click on a glyph opens two menus at once.
      const onNodeMenu = jest.fn();
      const openContextMenu = jest.fn();
      setSurfaceChrome('tm-c', owner, { ...CHROME, openContextMenu });
      act(() => {
        root.render(
          <div onContextMenu={onNodeMenu}>
            <NodeTerminal terminalId="tm-c" focused overlaid />
          </div>,
        );
      });
      rightClick(container.querySelector('.terminal-display')!);
      expect(openContextMenu).toHaveBeenCalledTimes(1);
      expect(onNodeMenu).not.toHaveBeenCalled();
    });

    it('leaves an ordinary node\'s right-click alone', () => {
      // Paired negative. An ordinary node renders below 1:1 and never publishes chrome, so the
      // node's own menu — arrange, close, overlay — is the correct one there.
      const onNodeMenu = jest.fn();
      const openContextMenu = jest.fn();
      setSurfaceChrome('tm-c', owner, { ...CHROME, openContextMenu });
      act(() => {
        root.render(
          <div onContextMenu={onNodeMenu}>
            <NodeTerminal terminalId="tm-c" focused overlaid={false} />
          </div>,
        );
      });
      rightClick(container.querySelector('.terminal-display')!);
      expect(openContextMenu).not.toHaveBeenCalled();
      expect(onNodeMenu).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * The session-closed banner on the overlay — `plan/024` Req 4.
 *
 * The requirement was explicit that the pane's footer must be BROUGHT to the overlay rather than
 * reimplemented there, so the first thing worth asserting is that it is the same component: the
 * class names below are `SessionClosedBanner`'s own, and a canvas copy would have had to
 * reproduce them to pass.
 *
 * The split between the two sources is the design, and each half is tested against the other's
 * absence: the FACT comes from the store (via the `exitInfo` prop) because a node must know it
 * with no publisher, and the ACTIONS come from `surfaceChrome` because only the pane can perform
 * a restart.
 */
describe('NodeTerminal — session-closed banner', () => {
  const CHROME = {
    atBottom: true,
    suggest: { open: false, items: [], selectedIndex: 0, focused: false, anchor: null },
    scrollToBottom: jest.fn(),
    pickSuggestion: jest.fn(),
    openContextMenu: jest.fn(),
    restartSession: jest.fn(),
    dismissSessionClosed: jest.fn(),
  };
  const owner = {};
  const EXITED = { exitCode: 130 };

  const renderNode = (
    overlaid: boolean,
    exitInfo: { exitCode: number | null } | null,
  ) => act(() => {
    root.render(
      <NodeTerminal terminalId="tm-e" focused overlaid={overlaid} exitInfo={exitInfo} fontSize={14} />,
    );
  });

  const banner = () => container.querySelector('.session-closed-banner');
  const restartButton = () => [...container.querySelectorAll<HTMLButtonElement>(
    '.session-closed-banner__button',
  )].find((b) => b.textContent === 'Restart') ?? null;
  const dismissButton = () =>
    container.querySelector<HTMLButtonElement>('.session-closed-banner__close');

  beforeEach(() => {
    CHROME.restartSession.mockClear();
    CHROME.dismissSessionClosed.mockClear();
  });
  afterEach(() => __resetSurfaceChromeForTest());

  it('shows the pane\'s own banner, with the exit code', () => {
    setSurfaceChrome('tm-e', owner, CHROME);
    renderNode(true, EXITED);
    expect(banner()).not.toBeNull();
    expect(banner()!.textContent).toContain('Session closed');
    expect(banner()!.textContent).toContain('130');
    // The hint the shared Ctrl+R binding exists to honour.
    expect(banner()!.textContent).toContain('Ctrl');
  });

  it('shows nothing while the session is still running', () => {
    setSurfaceChrome('tm-e', owner, CHROME);
    renderNode(true, null);
    expect(banner()).toBeNull();
  });

  // An ordinary node renders well below 1:1 inside a clipping box; a banner there would be a few
  // illegible pixels over the terminal it is describing.
  it('shows nothing on an ordinary node, even when the session has ended', () => {
    setSurfaceChrome('tm-e', owner, CHROME);
    renderNode(false, EXITED);
    expect(banner()).toBeNull();
  });

  /**
   * A banner whose Restart did nothing would be worse than no banner. `chrome` is the publisher
   * of both actions, so without it there is nothing to call and the banner is withheld.
   */
  it('shows nothing when no pane is publishing the actions', () => {
    renderNode(true, EXITED);
    expect(banner()).toBeNull();
  });

  it('routes Restart to the pane that owns the shell', () => {
    setSurfaceChrome('tm-e', owner, CHROME);
    renderNode(true, EXITED);
    act(() => {
      restartButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(CHROME.restartSession).toHaveBeenCalledTimes(1);
    expect(CHROME.dismissSessionClosed).not.toHaveBeenCalled();
  });

  it('routes Dismiss to the pane too, and only Dismiss', () => {
    setSurfaceChrome('tm-e', owner, CHROME);
    renderNode(true, EXITED);
    act(() => {
      dismissButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(CHROME.dismissSessionClosed).toHaveBeenCalledTimes(1);
    expect(CHROME.restartSession).not.toHaveBeenCalled();
  });

  it('renders inside the surface wrapper, like the rest of the overlay chrome', () => {
    setSurfaceChrome('tm-e', owner, CHROME);
    renderNode(true, EXITED);
    expect(banner()!.parentElement).toBe(container.querySelector('.canvas-surface'));
  });

  // Exit code 0 is a real exit — a `!!exitCode` test anywhere on this path hides a clean finish.
  it('shows the banner for a clean exit', () => {
    setSurfaceChrome('tm-e', owner, CHROME);
    renderNode(true, { exitCode: 0 });
    expect(banner()).not.toBeNull();
    expect(banner()!.textContent).toContain('0');
  });

  it('omits the code when the backend could not report one', () => {
    setSurfaceChrome('tm-e', owner, CHROME);
    renderNode(true, { exitCode: null });
    expect(banner()).not.toBeNull();
    expect(banner()!.textContent).toContain('Session closed');
    expect(banner()!.textContent).not.toContain('exit ');
  });

  /**
   * Ctrl+R, via the hook shared with `TerminalPane`. Dispatched on the wrapper the hook binds to,
   * in capture phase, so this exercises the real listener rather than a simulated one.
   */
  it('restarts on Ctrl+R while the banner is up', () => {
    setSurfaceChrome('tm-e', owner, CHROME);
    renderNode(true, EXITED);
    act(() => {
      container.querySelector('.canvas-surface')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(CHROME.restartSession).toHaveBeenCalledTimes(1);
  });

  // The negative that keeps the case above from breaking reverse-search: with a live shell,
  // Ctrl+R belongs to the shell and must reach the PTY untouched.
  it('leaves Ctrl+R alone while the session is running', () => {
    setSurfaceChrome('tm-e', owner, CHROME);
    renderNode(true, null);
    act(() => {
      container.querySelector('.canvas-surface')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(CHROME.restartSession).not.toHaveBeenCalled();
  });
});
