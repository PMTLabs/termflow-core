/**
 * @jest-environment jsdom
 *
 * A context menu belongs to the TAB it was opened in — the pane half, end to end through a real
 * `TerminalPane`.
 *
 * `PaneContextMenu` portals to `document.body` (see the comment above its `createPortal`), which
 * is the whole defect: `TerminalContainer.css` hides a background tab with
 * `visibility/opacity/content-visibility` on `.tab-content`, and a portalled node is not in that
 * subtree. Background tabs stay MOUNTED, so tab A's menu kept painting over tab B and read as
 * tab B's own menu. The menu's own dismissals — an outside `mousedown` and Escape — never fire
 * for a keyboard (`Ctrl+Tab`, `Ctrl+1…9`) or programmatic (API/MCP, session restore) switch.
 *
 * Queried against `document.body` rather than `container` for exactly that reason: asserting on
 * the pane's own subtree would pass against the broken component, because the menu was never in
 * it. That is the assertion this file exists to get right.
 *
 * Harness (mocks, real store, `react-dom/client` + `act`) mirrors
 * `sessionClosedBannerWiring.test.tsx`; there is no testing-library in this repo.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';

jest.mock('../TerminalPane.css', () => ({}));
jest.mock('../SessionClosedBanner.css', () => ({}));

// The pane pulls the whole terminal stack in at module load; stub the parts that need a real
// canvas/backend so this isolates the menu's tab scoping.
jest.mock('../../Terminal/TerminalDisplay', () => ({
  __esModule: true,
  default: () => <div data-testid="terminal-display" />,
  TerminalDisplay: () => <div data-testid="terminal-display" />,
  cleanupTerminalCache: () => {},
}));

// Header drag needs a PaneDragProvider ancestor; nothing here exercises dragging.
jest.mock('../dnd/usePaneDrag', () => ({ usePaneDrag: () => () => {} }));

jest.mock('../../../services/TerminalService', () => ({
  terminalService: {
    getProcessId: () => 'pc-1',
    getProcessIdForTerminal: () => 'pc-1',
    createTerminal: jest.fn(),
    writeToTerminal: jest.fn().mockResolvedValue(undefined),
    resizeTerminal: jest.fn().mockResolvedValue(undefined),
    closeTerminal: jest.fn().mockResolvedValue(undefined),
    stashPromptGate: jest.fn(),
  },
}));

// The tracker polls the backend for the pane's coding agent; irrelevant here, and its refresh
// would leave a floating promise rejecting after the test ends.
jest.mock('../../../services/AgentSchemeTracker', () => ({
  agentSchemeTracker: {
    getAgentForTerminal: () => null,
    getDetectedAgentForTerminal: () => null,
    getDetectedAgentExeForTerminal: () => null,
    refreshNow: () => Promise.resolve(),
    subscribe: () => () => {},
    start: () => {},
    stop: () => {},
  },
}));

import { TerminalPane } from '../TerminalPane';
import { store } from '../../../store';

const TERM = 'tm-menu-scope-1';

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

function render(isTabActive: boolean) {
  act(() => {
    root.render(
      <Provider store={store}>
        <TerminalPane
          paneId="pane-1"
          terminalId={TERM}
          isActive
          isTabActive={isTabActive}
          onSplit={() => {}}
          onClose={() => {}}
          onFocus={() => {}}
        />
      </Provider>,
    );
  });
}

/** The portalled menu, looked for where it actually lives. */
const menu = () => document.body.querySelector('.pane-context-menu');

/**
 * Right-click the pane HEADER, which is the only target `handleContextMenu` accepts.
 *
 * Dispatched on the header element itself and allowed to bubble to the pane's
 * `onContextMenu`, so the `target.closest('.terminal-pane-header')` check sees the real header.
 */
function rightClickHeader() {
  const header = container.querySelector('.terminal-pane-header');
  expect(header).not.toBeNull();
  act(() => {
    header!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }),
    );
  });
}

describe('pane context menu is scoped to its tab', () => {
  it('opens on a right-click in the active tab', () => {
    render(true);
    expect(menu()).toBeNull();
    rightClickHeader();
    expect(menu()).not.toBeNull();
  });

  // AC1: open in tab A, switch to tab B → the menu is no longer visible.
  it('is dismissed when its tab stops being the active one', () => {
    render(true);
    rightClickHeader();
    expect(menu()).not.toBeNull();

    render(false);

    expect(menu()).toBeNull();
  });

  // AC2: the menu must not come back with the tab. Switching away closed it; switching back is
  // not a right-click, so the tab must be menu-free until the user asks for one.
  it('stays dismissed when its tab becomes active again', () => {
    render(true);
    rightClickHeader();
    render(false);
    render(true);

    expect(menu()).toBeNull();
  });

  // AC3: a menu opened AFTER the switch is scoped the same way — one deactivation must not
  // have spent the dismissal.
  it('dismisses a menu opened after the tab came back', () => {
    render(true);
    rightClickHeader();
    render(false);
    render(true);

    rightClickHeader();
    expect(menu()).not.toBeNull();

    render(false);
    expect(menu()).toBeNull();
  });
});
