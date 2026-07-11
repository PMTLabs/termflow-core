import React from 'react';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import TerminalViewer from './TerminalViewer';
import terminalsReducer from '../../store/slices/terminalsSlice';

// Mock the engine-backed TerminalView since it uses xterm.js / terminal-core.
jest.mock('./TerminalView', () => {
  return {
    __esModule: true,
    default: ({ terminalId }: { terminalId: string }) => (
      <div data-testid={`terminal-view-${terminalId}`}>Terminal {terminalId}</div>
    ),
  };
});

describe('TerminalViewer', () => {
  const createMockStore = (preloadedState?: any) => {
    return configureStore({
      reducer: {
        terminals: terminalsReducer,
      },
      preloadedState,
    });
  };

  const mockTerminal = {
    id: 'term-1',
    name: 'Terminal 1',
    profile: 'bash',
    processId: 'proc-11',
    status: 'running' as const,
    createdAt: '2023-01-01T00:00:00Z',
  };

  const terminalsState = (overrides?: any) => ({
    terminals: {
      terminals: [mockTerminal],
      selectedTerminalId: 'term-1',
      selectedTerminalIds: [],
      loading: false,
      error: null,
      lastFetchTime: 0,
      lastFetchId: null,
      hasInitiallyFetched: true,
      ...overrides,
    },
  });

  it('should render terminal viewer with terminal info', () => {
    const store = createMockStore(terminalsState());

    render(
      <Provider store={store}>
        <TerminalViewer terminalId="term-1" />
      </Provider>
    );

    expect(
      screen.getByRole('heading', { name: 'Terminal 1 (bash)' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('terminal-view-term-1')).toBeInTheDocument();
  });

  it('should show not found message for non-existent terminal', () => {
    const store = createMockStore(
      terminalsState({ selectedTerminalId: null })
    );

    render(
      <Provider store={store}>
        <TerminalViewer terminalId="non-existent" />
      </Provider>
    );

    expect(
      screen.getByText('Select a terminal to view output')
    ).toBeInTheDocument();
  });

  it('should update the header when terminal changes', () => {
    const store = createMockStore(
      terminalsState({
        terminals: [
          { ...mockTerminal, status: 'running' },
          {
            ...mockTerminal,
            id: 'term-2',
            name: 'Terminal 2',
            status: 'exited',
          },
        ],
      })
    );

    const { rerender } = render(
      <Provider store={store}>
        <TerminalViewer terminalId="term-1" />
      </Provider>
    );

    expect(
      screen.getByRole('heading', { name: 'Terminal 1 (bash)' })
    ).toBeInTheDocument();

    rerender(
      <Provider store={store}>
        <TerminalViewer terminalId="term-2" />
      </Provider>
    );

    expect(
      screen.getByRole('heading', { name: 'Terminal 2 (bash)' })
    ).toBeInTheDocument();
  });
});
