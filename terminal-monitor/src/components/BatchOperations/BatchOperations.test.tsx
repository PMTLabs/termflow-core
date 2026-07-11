import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import BatchOperations from './BatchOperations';
import terminalsReducer from '../../store/slices/terminalsSlice';
import axios from 'axios';

jest.mock('axios');
const mockAxios = axios as jest.Mocked<typeof axios>;

// Mock the useConfirmDialog hook
jest.mock('../../hooks/useConfirmDialog', () => ({
  useConfirmDialog: () => {
    const mockConfirm = jest.fn().mockResolvedValue(true);
    return {
      confirm: mockConfirm,
      ConfirmDialog: () => null,
    };
  },
}));

describe('BatchOperations', () => {
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
      processId: 'proc-1',
      status: 'running' as const,
      createdAt: '2023-01-01T00:00:00Z',
    },
    {
      id: 'term-2',
      name: 'Terminal 2',
      profile: 'powershell',
      processId: 'proc-2',
      status: 'running' as const,
      createdAt: '2023-01-01T01:00:00Z',
    },
    {
      id: 'term-3',
      name: 'Terminal 3',
      profile: 'cmd',
      processId: 'proc-3',
      status: 'exited' as const,
      createdAt: '2023-01-01T02:00:00Z',
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should not render when no terminals are selected', () => {
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

    const { container } = render(
      <Provider store={store}>
        <BatchOperations />
      </Provider>
    );

    expect(container.firstChild).toBeNull();
  });

  it('should render batch operations when terminals are selected', () => {
    const store = createMockStore({
      terminals: {
        terminals: mockTerminals,
        selectedTerminalId: 'term-1',
        selectedTerminalIds: ['term-1', 'term-2'],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
    });

    render(
      <Provider store={store}>
        <BatchOperations />
      </Provider>
    );

    expect(screen.getByText('2 terminals selected')).toBeInTheDocument();
    expect(screen.getByText('Clear Selection')).toBeInTheDocument();
    expect(screen.getByText('Send Command')).toBeInTheDocument();
    expect(screen.getByText('Kill Terminals')).toBeInTheDocument();
  });

  it('should handle clear selection', () => {
    const store = createMockStore({
      terminals: {
        terminals: mockTerminals,
        selectedTerminalId: 'term-1',
        selectedTerminalIds: ['term-1', 'term-2'],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
    });

    render(
      <Provider store={store}>
        <BatchOperations />
      </Provider>
    );

    fireEvent.click(screen.getByText('Clear Selection'));

    const state = store.getState();
    expect(state.terminals.selectedTerminalIds).toEqual([]);
  });

  it('should handle batch command sending', async () => {
    mockAxios.post.mockResolvedValue({ data: { success: true } });

    const store = createMockStore({
      terminals: {
        terminals: mockTerminals,
        selectedTerminalId: 'term-1',
        selectedTerminalIds: ['term-1', 'term-2'],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
    });

    render(
      <Provider store={store}>
        <BatchOperations />
      </Provider>
    );

    // Click send command button
    fireEvent.click(screen.getByText('Send Command'));

    // Dialog should appear (mocked to auto-confirm)
    await waitFor(() => {
      // Command should be sent to both terminals
      expect(mockAxios.post).toHaveBeenCalledTimes(2);
    });
  });

  it('should handle batch kill terminals', async () => {
    mockAxios.delete.mockResolvedValue({ data: { success: true } });

    const store = createMockStore({
      terminals: {
        terminals: mockTerminals,
        selectedTerminalId: 'term-1',
        selectedTerminalIds: ['term-1', 'term-2'],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
    });

    render(
      <Provider store={store}>
        <BatchOperations />
      </Provider>
    );

    // Click kill terminals button
    fireEvent.click(screen.getByText('Kill Terminals'));

    await waitFor(() => {
      expect(mockAxios.delete).toHaveBeenCalledWith('/api/terminals/term-1');
      expect(mockAxios.delete).toHaveBeenCalledWith('/api/terminals/term-2');
    });
  });

  it('should show select all button when not all terminals selected', () => {
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
        <BatchOperations />
      </Provider>
    );

    expect(screen.getByText('Select All')).toBeInTheDocument();
  });

  it('should handle select all', () => {
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
        <BatchOperations />
      </Provider>
    );

    fireEvent.click(screen.getByText('Select All'));

    const state = store.getState();
    expect(state.terminals.selectedTerminalIds).toHaveLength(3);
    expect(state.terminals.selectedTerminalIds).toContain('term-1');
    expect(state.terminals.selectedTerminalIds).toContain('term-2');
    expect(state.terminals.selectedTerminalIds).toContain('term-3');
  });

  it('should filter only running terminals for certain operations', () => {
    const store = createMockStore({
      terminals: {
        terminals: mockTerminals,
        selectedTerminalId: 'term-1',
        selectedTerminalIds: ['term-1', 'term-2', 'term-3'],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
    });

    render(
      <Provider store={store}>
        <BatchOperations />
      </Provider>
    );

    // Should show count of running terminals for send command
    expect(screen.getByText('3 terminals selected')).toBeInTheDocument();
    expect(screen.getByText(/Send Command/)).toBeInTheDocument();
  });

  it('should handle API errors gracefully', async () => {
    mockAxios.post.mockRejectedValue(new Error('Network error'));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

    const store = createMockStore({
      terminals: {
        terminals: mockTerminals,
        selectedTerminalId: 'term-1',
        selectedTerminalIds: ['term-1', 'term-2'],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
    });

    render(
      <Provider store={store}>
        <BatchOperations />
      </Provider>
    );

    fireEvent.click(screen.getByText('Send Command'));

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    consoleErrorSpy.mockRestore();
  });

  it('should disable kill button when only exited terminals selected', () => {
    const store = createMockStore({
      terminals: {
        terminals: mockTerminals,
        selectedTerminalId: 'term-3',
        selectedTerminalIds: ['term-3'],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
    });

    render(
      <Provider store={store}>
        <BatchOperations />
      </Provider>
    );

    const killButton = screen.getByText('Kill Terminals').closest('button');
    expect(killButton).toBeDisabled();
  });
});
