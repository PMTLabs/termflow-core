import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import GridLayout from './GridLayout';
import terminalsReducer from '../../store/slices/terminalsSlice';
import gridReducer from '../../store/slices/gridSlice';
import outputReducer from '../../store/slices/outputSlice';

// Mock TerminalViewer component
jest.mock('../TerminalViewer/TerminalViewer', () => {
  return {
    __esModule: true,
    default: ({ terminalId }: { terminalId: string }) => (
      <div data-testid={`terminal-viewer-${terminalId}`}>
        Terminal Viewer: {terminalId}
      </div>
    ),
  };
});

// Mock react-dnd hooks
jest.mock('react-dnd', () => ({
  ...jest.requireActual('react-dnd'),
  useDrag: () => [{ isDragging: false }, jest.fn(), jest.fn()],
  useDrop: () => [{ isOver: false }, jest.fn()],
}));

describe('GridLayout', () => {
  const createMockStore = (preloadedState?: any) => {
    return configureStore({
      reducer: {
        terminals: terminalsReducer,
        grid: gridReducer,
        output: outputReducer,
      },
      preloadedState,
    });
  };

  const mockTerminals = [
    {
      id: 'term-1',
      name: 'Terminal 1',
      profile: 'bash',
      processId: 'proc-4',
      status: 'running' as const,
      createdAt: '2023-01-01T00:00:00Z',
    },
    {
      id: 'term-2',
      name: 'Terminal 2',
      profile: 'powershell',
      processId: 'proc-5',
      status: 'running' as const,
      createdAt: '2023-01-01T01:00:00Z',
    },
    {
      id: 'term-3',
      name: 'Terminal 3',
      profile: 'cmd',
      processId: 'proc-6',
      status: 'running' as const,
      createdAt: '2023-01-01T02:00:00Z',
    },
    {
      id: 'term-4',
      name: 'Terminal 4',
      profile: 'bash',
      processId: 'proc-7',
      status: 'exited' as const,
      createdAt: '2023-01-01T03:00:00Z',
    },
  ];

  const mockLayout = {
    id: '2x2',
    name: '2x2 Grid',
    terminals: [
      { terminalId: 'term-1', position: { row: 0, col: 0 } },
      { terminalId: 'term-2', position: { row: 0, col: 1 } },
      { terminalId: 'term-3', position: { row: 1, col: 0 } },
      { terminalId: 'term-4', position: { row: 1, col: 1 } },
    ],
    rows: 2,
    cols: 2,
  };

  const renderWithProviders = (component: React.ReactElement, store: any) => {
    return render(
      <Provider store={store}>
        <DndProvider backend={HTML5Backend}>{component}</DndProvider>
      </Provider>
    );
  };

  it('should render grid layout with terminals', () => {
    const store = createMockStore({
      terminals: {
        terminals: mockTerminals,
        selectedTerminalId: 'term-1',
        selectedTerminalIds: [],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
      grid: {
        layouts: [mockLayout],
        activeLayoutId: '2x2',
        isGridViewActive: true,
        savedLayouts: [],
      },
      output: {
        buffers: {},
        maxBufferSize: 1000000,
      },
    });

    renderWithProviders(<GridLayout />, store);

    expect(screen.getByTestId('terminal-viewer-term-1')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-viewer-term-2')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-viewer-term-3')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-viewer-term-4')).toBeInTheDocument();
  });

  it('should show no layout selected message', () => {
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
      grid: {
        layouts: [mockLayout],
        activeLayoutId: null,
        isGridViewActive: true,
        savedLayouts: [],
      },
      output: {
        buffers: {},
        maxBufferSize: 1000000,
      },
    });

    renderWithProviders(<GridLayout />, store);

    expect(screen.getByText('No layout selected')).toBeInTheDocument();
  });

  it('should show layout not found message', () => {
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
      grid: {
        layouts: [],
        activeLayoutId: 'non-existent',
        isGridViewActive: true,
        savedLayouts: [],
      },
      output: {
        buffers: {},
        maxBufferSize: 1000000,
      },
    });

    renderWithProviders(<GridLayout />, store);

    expect(screen.getByText('Layout not found')).toBeInTheDocument();
  });

  it('should render grid controls', () => {
    const store = createMockStore({
      terminals: {
        terminals: mockTerminals,
        selectedTerminalId: 'term-1',
        selectedTerminalIds: [],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
      grid: {
        layouts: [mockLayout],
        activeLayoutId: '2x2',
        isGridViewActive: true,
        savedLayouts: [],
      },
      output: {
        buffers: {},
        maxBufferSize: 1000000,
      },
    });

    renderWithProviders(<GridLayout />, store);

    expect(screen.getByText('Grid View')).toBeInTheDocument();
    expect(screen.getByText('2x2 Grid')).toBeInTheDocument();
  });

  it('should handle fullscreen toggle', () => {
    const store = createMockStore({
      terminals: {
        terminals: mockTerminals,
        selectedTerminalId: 'term-1',
        selectedTerminalIds: [],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
      grid: {
        layouts: [mockLayout],
        activeLayoutId: '2x2',
        isGridViewActive: true,
        savedLayouts: [],
      },
      output: {
        buffers: {},
        maxBufferSize: 1000000,
      },
    });

    renderWithProviders(<GridLayout />, store);

    const fullscreenButton = screen.getAllByLabelText('fullscreen')[0];
    fireEvent.click(fullscreenButton);

    // Should update selectedTerminalId
    const state = store.getState();
    expect(state.terminals.selectedTerminalId).toBeDefined();
  });

  it('should handle multi-selection toggle', () => {
    const store = createMockStore({
      terminals: {
        terminals: mockTerminals,
        selectedTerminalId: 'term-1',
        selectedTerminalIds: [],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
      grid: {
        layouts: [mockLayout],
        activeLayoutId: '2x2',
        isGridViewActive: true,
        savedLayouts: [],
      },
      output: {
        buffers: {},
        maxBufferSize: 1000000,
      },
    });

    renderWithProviders(<GridLayout />, store);

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);

    const state = store.getState();
    expect(state.terminals.selectedTerminalIds).toContain('term-1');
  });

  it('should show empty cells for missing terminals', () => {
    const layoutWithMissing = {
      id: '2x2',
      name: '2x2 Grid',
      terminals: [
        { terminalId: 'term-1', position: { row: 0, col: 0 } },
        { terminalId: 'non-existent', position: { row: 0, col: 1 } },
      ],
      rows: 2,
      cols: 2,
    };

    const store = createMockStore({
      terminals: {
        terminals: [mockTerminals[0]],
        selectedTerminalId: null,
        selectedTerminalIds: [],
        loading: false,
        error: null,
        lastFetchTime: 0,
        lastFetchId: null,
        hasInitiallyFetched: true,
      },
      grid: {
        layouts: [layoutWithMissing],
        activeLayoutId: '2x2',
        isGridViewActive: true,
        savedLayouts: [],
      },
      output: {
        buffers: {},
        maxBufferSize: 1000000,
      },
    });

    renderWithProviders(<GridLayout />, store);

    expect(screen.getByTestId('terminal-viewer-term-1')).toBeInTheDocument();
    expect(screen.getByText('Empty')).toBeInTheDocument();
  });

  it('should highlight multi-selected terminals', () => {
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
      grid: {
        layouts: [mockLayout],
        activeLayoutId: '2x2',
        isGridViewActive: true,
        savedLayouts: [],
      },
      output: {
        buffers: {},
        maxBufferSize: 1000000,
      },
    });

    renderWithProviders(<GridLayout />, store);

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).toBeChecked();
    expect(checkboxes[2]).not.toBeChecked();
    expect(checkboxes[3]).not.toBeChecked();
  });

  it('should render different grid sizes correctly', () => {
    const layout3x3 = {
      id: '3x3',
      name: '3x3 Grid',
      terminals: [],
      rows: 3,
      cols: 3,
    };

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
      grid: {
        layouts: [layout3x3],
        activeLayoutId: '3x3',
        isGridViewActive: true,
        savedLayouts: [],
      },
      output: {
        buffers: {},
        maxBufferSize: 1000000,
      },
    });

    renderWithProviders(<GridLayout />, store);

    // Should have 9 cells for 3x3 grid
    const emptyCells = screen.getAllByText('Empty');
    expect(emptyCells).toHaveLength(9);
  });

  it('should support 2x3 grid layout', () => {
    const layout2x3 = {
      id: '2x3',
      name: '2x3 Grid',
      terminals: [
        { terminalId: 'term-1', position: { row: 0, col: 0 } },
        { terminalId: 'term-2', position: { row: 0, col: 1 } },
        { terminalId: 'term-3', position: { row: 0, col: 2 } },
        { terminalId: 'term-4', position: { row: 1, col: 0 } },
      ],
      rows: 2,
      cols: 3,
    };

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
      grid: {
        layouts: [layout2x3],
        activeLayoutId: '2x3',
        isGridViewActive: true,
        savedLayouts: [],
      },
      output: {
        buffers: {},
        maxBufferSize: 1000000,
      },
    });

    renderWithProviders(<GridLayout />, store);

    // Should render the configured terminals
    expect(screen.getByTestId('terminal-viewer-term-1')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-viewer-term-2')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-viewer-term-3')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-viewer-term-4')).toBeInTheDocument();
    
    // Should show layout name
    expect(screen.getByText('2x3 Grid')).toBeInTheDocument();
    
    // Should have 2 empty cells (6 total - 4 occupied = 2 empty)
    const emptyCells = screen.getAllByText('Empty');
    expect(emptyCells).toHaveLength(2);
  });
});
