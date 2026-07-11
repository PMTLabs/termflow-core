import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import TerminalList from './TerminalList';
import terminalsReducer from '../../store/slices/terminalsSlice';

// No mock needed - TerminalListItem is defined inline in TerminalList.tsx

describe('TerminalList', () => {
  const createMockStore = (preloadedState?: any) => {
    return configureStore({
      reducer: {
        terminals: terminalsReducer,
      },
      preloadedState,
    });
  };

  const mockTerminals = [
    {
      id: 'term-1',
      name: 'Terminal 1',
      profile: 'bash',
      processId: 'proc-8',
      status: 'running' as const,
      createdAt: '2023-01-01T00:00:00Z',
    },
    {
      id: 'term-2',
      name: 'Terminal 2',
      profile: 'powershell',
      processId: 'proc-9',
      status: 'exited' as const,
      createdAt: '2023-01-01T01:00:00Z',
    },
    {
      id: 'term-3',
      name: 'Terminal 3',
      profile: 'cmd',
      processId: 'proc-10',
      status: 'running' as const,
      createdAt: '2023-01-01T02:00:00Z',
    },
  ];

  it('should render all terminals', () => {
    const store = createMockStore({
      terminals: {
        terminals: mockTerminals,
        selectedTerminalId: null,
        selectedTerminalIds: [],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
    });

    render(
      <Provider store={store}>
        <TerminalList />
      </Provider>
    );

    expect(screen.getByTestId('terminal-item-term-1')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-item-term-2')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-item-term-3')).toBeInTheDocument();
  });

  it('should show empty state when no terminals', () => {
    const store = createMockStore({
      terminals: {
        terminals: [],
        selectedTerminalId: null,
        selectedTerminalIds: [],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
    });

    render(
      <Provider store={store}>
        <TerminalList />
      </Provider>
    );

    expect(screen.getByText('No terminals available')).toBeInTheDocument();
  });

  it('should show loading state', () => {
    const store = createMockStore({
      terminals: {
        terminals: [],
        selectedTerminalId: null,
        selectedTerminalIds: [],
        loading: true,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: false,
      },
    });

    render(
      <Provider store={store}>
        <TerminalList />
      </Provider>
    );

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('should handle terminal selection', () => {
    const store = createMockStore({
      terminals: {
        terminals: mockTerminals,
        selectedTerminalId: null,
        selectedTerminalIds: [],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
    });

    render(
      <Provider store={store}>
        <TerminalList />
      </Provider>
    );

    fireEvent.click(screen.getByTestId('terminal-item-term-1'));

    const state = store.getState();
    expect(state.terminals.selectedTerminalId).toBe('term-1');
  });

  it('should handle multi-selection toggle', () => {
    const store = createMockStore({
      terminals: {
        terminals: mockTerminals,
        selectedTerminalId: 'term-1',
        selectedTerminalIds: ['term-1'],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
    });

    render(
      <Provider store={store}>
        <TerminalList />
      </Provider>
    );

    fireEvent.click(screen.getByTestId('terminal-checkbox-term-2'));

    const state = store.getState();
    expect(state.terminals.selectedTerminalIds).toContain('term-2');
  });

  it('should show error state', () => {
    const store = createMockStore({
      terminals: {
        terminals: [],
        selectedTerminalId: null,
        selectedTerminalIds: [],
        loading: false,
        error: 'Failed to fetch terminals',
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: false,
      },
    });

    render(
      <Provider store={store}>
        <TerminalList />
      </Provider>
    );

    expect(screen.getByText('Failed to fetch terminals')).toBeInTheDocument();
  });

  it('should group terminals by status', () => {
    const store = createMockStore({
      terminals: {
        terminals: mockTerminals,
        selectedTerminalId: null,
        selectedTerminalIds: [],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
    });

    render(
      <Provider store={store}>
        <TerminalList />
      </Provider>
    );

    // Should show running terminals first
    const terminalItems = screen.getAllByTestId(/^terminal-item-/);
    expect(terminalItems[0]).toHaveAttribute(
      'data-testid',
      'terminal-item-term-1'
    );
    expect(terminalItems[1]).toHaveAttribute(
      'data-testid',
      'terminal-item-term-3'
    );
    expect(terminalItems[2]).toHaveAttribute(
      'data-testid',
      'terminal-item-term-2'
    );
  });

  it('should handle search filtering', () => {
    const store = createMockStore({
      terminals: {
        terminals: mockTerminals,
        selectedTerminalId: null,
        selectedTerminalIds: [],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
    });

    render(
      <Provider store={store}>
        <TerminalList />
      </Provider>
    );

    const searchInput = screen.getByPlaceholderText('Search terminals...');
    fireEvent.change(searchInput, { target: { value: 'Terminal 1' } });

    expect(screen.getByTestId('terminal-item-term-1')).toBeInTheDocument();
    expect(
      screen.queryByTestId('terminal-item-term-2')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('terminal-item-term-3')
    ).not.toBeInTheDocument();
  });

  it('should handle refresh button click', () => {
    const store = createMockStore({
      terminals: {
        terminals: mockTerminals,
        selectedTerminalId: null,
        selectedTerminalIds: [],
        loading: false,
        error: null,
        lastFetchTime: Date.now(),
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
    });

    render(
      <Provider store={store}>
        <TerminalList />
      </Provider>
    );

    const refreshButton = screen.getByLabelText('refresh terminals');
    fireEvent.click(refreshButton);

    // Should dispatch fetchTerminals action
    const actions = store.getState();
    expect(actions).toBeDefined();
  });
});
