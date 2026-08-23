/**
 * @jest-environment jsdom
 *
 * The pane's exit → banner chain, end to end through the REAL store.
 *
 * `endedOverlay.test.tsx` renders `EndedOverlay` directly and `sessionExitSlice.test.ts`
 * drives the reducer directly, so both stayed green while every link BETWEEN them was
 * untested: nothing asserted that a real `pty:exit` reaching a real `TerminalPane`
 * produces a real `SessionClosedBanner` with its Restart and Dismiss controls. That gap
 * is what let `plan/024` Req 4 move the fact from `useState` into the store without a
 * single test having to change.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';

jest.mock('../TerminalPane.css', () => ({}));
jest.mock('../SessionClosedBanner.css', () => ({}));

// The pane pulls the whole terminal stack in at module load; stub the parts that need a
// real canvas/backend so this isolates the exit → banner wiring.
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
    // Already-bound: the mount effect reuses it and returns before any spawn.
    getProcessId: () => 'pc-1',
    getProcessIdForTerminal: () => 'pc-1',
    createTerminal: jest.fn(),
    writeToTerminal: jest.fn().mockResolvedValue(undefined),
    resizeTerminal: jest.fn().mockResolvedValue(undefined),
    closeTerminal: jest.fn().mockResolvedValue(undefined),
    stashPromptGate: jest.fn(),
  },
}));

import { TerminalPane } from '../TerminalPane';
import { store } from '../../../store';
import { clearAllSessionClosed } from '../../../store/slices/sessionExitSlice';

const TERM = 'tm-banner-1';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  store.dispatch(clearAllSessionClosed());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <Provider store={store}>
        <TerminalPane
          paneId="pane-1"
          terminalId={TERM}
          isActive
          onSplit={() => {}}
          onClose={() => {}}
          onFocus={() => {}}
        />
      </Provider>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  store.dispatch(clearAllSessionClosed());
});

const exit = (detail: Record<string, unknown>) =>
  act(() => {
    window.dispatchEvent(new CustomEvent('pty:exit', { detail }));
  });

const banner = () => container.querySelector('.session-closed-banner');
const buttonLabels = () =>
  Array.from(container.querySelectorAll('.session-closed-banner button')).map(
    (b) => b.textContent?.trim(),
  );

describe('pane exit → SessionClosedBanner (plan/024 Req 4)', () => {
  it('shows no banner while the session is live', () => {
    expect(banner()).toBeNull();
  });

  it('renders the banner when THIS pane\'s terminal exits', () => {
    exit({ terminalId: TERM, exitCode: 0, cwd: null });
    expect(banner()).not.toBeNull();
    expect(banner()!.textContent).toContain('Session closed');
  });

  it('offers Restart and Dismiss, plus the (x) close', () => {
    exit({ terminalId: TERM, exitCode: 1, cwd: null });
    expect(buttonLabels()).toEqual(expect.arrayContaining(['Restart', 'Dismiss']));
    expect(container.querySelector('.session-closed-banner__close')).not.toBeNull();
  });

  it('prints the exit code the backend reported', () => {
    exit({ terminalId: TERM, exitCode: 130, cwd: null });
    expect(banner()!.textContent).toContain('exit 130');
  });

  it('matches on processId when the backend could not resolve a terminalId', () => {
    exit({ processId: 'pc-1', exitCode: 0, cwd: null });
    expect(banner()).not.toBeNull();
  });

  it('ignores a SIBLING pane\'s exit', () => {
    exit({ terminalId: 'tm-someone-else', processId: 'pc-99', exitCode: 0, cwd: null });
    expect(banner()).toBeNull();
  });

  it('dismisses back to no banner', () => {
    exit({ terminalId: TERM, exitCode: 0, cwd: null });
    const dismiss = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.session-closed-banner button'),
    ).find((b) => b.textContent?.trim() === 'Dismiss')!;
    act(() => dismiss.click());
    expect(banner()).toBeNull();
  });

  it('marks the pane ended so the tint shows too', () => {
    exit({ terminalId: TERM, exitCode: 0, cwd: null });
    expect(container.querySelector('.terminal-pane')!.className).toContain('is-ended');
    expect(container.querySelector('.pane-ended-overlay')).not.toBeNull();
  });
});
