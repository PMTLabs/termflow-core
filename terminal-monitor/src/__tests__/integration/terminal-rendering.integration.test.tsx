import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import App from '../../App';
import authReducer, { login } from '../../store/slices/authSlice';
import terminalsReducer, {
  fetchTerminals,
} from '../../store/slices/terminalsSlice';
import outputReducer, { addOutput } from '../../store/slices/outputSlice';
import connectionReducer from '../../store/slices/connectionSlice';
import gridReducer from '../../store/slices/gridSlice';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

// Create a test store
const createTestStore = () => {
  return configureStore({
    reducer: {
      auth: authReducer,
      connection: connectionReducer,
      terminals: terminalsReducer,
      output: outputReducer,
      grid: gridReducer,
    },
  });
};

// Mock xterm.js
jest.mock('@xterm/xterm', () => ({
  Terminal: jest.fn().mockImplementation(() => ({
    loadAddon: jest.fn(),
    open: jest.fn(),
    write: jest.fn(),
    clear: jest.fn(),
    dispose: jest.fn(),
    onData: jest.fn(),
    onResize: jest.fn(),
    resize: jest.fn(),
    options: {},
    unicode: { activeVersion: '11' },
  })),
}));

// Mock xterm addons
jest.mock('@xterm/addon-fit', () => ({
  FitAddon: jest.fn().mockImplementation(() => ({
    fit: jest.fn(),
  })),
}));

jest.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@xterm/addon-webgl', () => ({
  WebglAddon: jest.fn().mockImplementation(() => ({
    onContextLoss: jest.fn(),
    dispose: jest.fn(),
  })),
}));

// Mock WebSocket
jest.mock('../../services/WebSocketService');

describe('Terminal Rendering Integration', () => {
  let mockAxios: MockAdapter;
  let store: ReturnType<typeof createTestStore>;

  beforeEach(async () => {
    // Create fresh store for each test
    store = createTestStore();

    mockAxios = new MockAdapter(axios);

    // Setup authentication
    mockAxios.onPost('/api/auth/login').reply(200, {
      token: 'test-token',
      permissions: ['read', 'write'],
    });

    await store.dispatch(login());
  });

  afterEach(() => {
    mockAxios.restore();
  });

  describe('Terminal Display', () => {
    it('should render terminal list and viewer', async () => {
      const mockTerminals = [
        {
          id: 'term-1',
          name: 'Terminal 1',
          profile: 'bash',
          processId: 'proc-21',
          status: 'running',
          createdAt: new Date().toISOString(),
        },
      ];

      mockAxios
        .onGet('/api/terminals')
        .reply(200, { terminals: mockTerminals });

      render(
        <Provider store={store}>
          <App />
        </Provider>
      );

      // Wait for terminals to load
      await waitFor(() => {
        expect(screen.getByText('Terminal 1')).toBeInTheDocument();
      });
    });

    it('should display terminal output', async () => {
      const mockTerminals = [
        {
          id: 'term-1',
          name: 'Terminal 1',
          profile: 'bash',
          processId: 'proc-22',
          status: 'running',
          createdAt: new Date().toISOString(),
        },
      ];

      mockAxios
        .onGet('/api/terminals')
        .reply(200, { terminals: mockTerminals });

      render(
        <Provider store={store}>
          <App />
        </Provider>
      );

      await waitFor(() => {
        expect(screen.getByText('Terminal 1')).toBeInTheDocument();
      });

      // Select terminal
      fireEvent.click(screen.getByText('Terminal 1'));

      // Add output to store
      store.dispatch(
        addOutput({
          terminalId: 'term-1',
          data: 'Hello from terminal\n',
        })
      );

      // Terminal content should be rendered (mocked in this case)
      await waitFor(() => {
        const terminalViewer = screen.getByTestId('terminal-viewer-term-1');
        expect(terminalViewer).toBeInTheDocument();
      });
    });

    it('should handle terminal selection', async () => {
      const mockTerminals = [
        {
          id: 'term-1',
          name: 'Terminal 1',
          profile: 'bash',
          processId: 'proc-23',
          status: 'running',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'term-2',
          name: 'Terminal 2',
          profile: 'powershell',
          processId: 'proc-24',
          status: 'running',
          createdAt: new Date().toISOString(),
        },
      ];

      mockAxios
        .onGet('/api/terminals')
        .reply(200, { terminals: mockTerminals });

      render(
        <Provider store={store}>
          <App />
        </Provider>
      );

      await waitFor(() => {
        expect(screen.getByText('Terminal 1')).toBeInTheDocument();
        expect(screen.getByText('Terminal 2')).toBeInTheDocument();
      });

      // Click on Terminal 2
      fireEvent.click(screen.getByText('Terminal 2'));

      // Terminal 2 should be selected
      const state = store.getState();
      expect(state.terminals.selectedTerminalId).toBe('term-2');
    });
  });

  describe('Input Handling', () => {
    it('should send input to selected terminal', async () => {
      const mockTerminals = [
        {
          id: 'term-1',
          name: 'Terminal 1',
          profile: 'bash',
          processId: 'proc-25',
          status: 'running',
          createdAt: new Date().toISOString(),
        },
      ];

      mockAxios
        .onGet('/api/terminals')
        .reply(200, { terminals: mockTerminals });
      mockAxios
        .onPost('/api/terminals/term-1/input')
        .reply(200, { success: true });

      render(
        <Provider store={store}>
          <App />
        </Provider>
      );

      await waitFor(() => {
        expect(screen.getByText('Terminal 1')).toBeInTheDocument();
      });

      // Select terminal
      fireEvent.click(screen.getByText('Terminal 1'));

      // Find input field
      const input = screen.getByPlaceholderText('Type a command...');
      expect(input).toBeInTheDocument();

      // Type and send command
      fireEvent.change(input, { target: { value: 'ls -la' } });
      fireEvent.keyPress(input, { key: 'Enter', code: 'Enter', charCode: 13 });

      await waitFor(() => {
        expect(mockAxios.history.post).toHaveLength(2); // login + input
        expect(mockAxios.history.post[1].url).toBe(
          '/api/terminals/term-1/input'
        );
      });
    });

    it('should handle batch input', async () => {
      const mockTerminals = [
        {
          id: 'term-1',
          name: 'Terminal 1',
          profile: 'bash',
          processId: 'proc-26',
          status: 'running',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'term-2',
          name: 'Terminal 2',
          profile: 'bash',
          processId: 'proc-27',
          status: 'running',
          createdAt: new Date().toISOString(),
        },
      ];

      mockAxios
        .onGet('/api/terminals')
        .reply(200, { terminals: mockTerminals });
      mockAxios
        .onPost(/\/api\/terminals\/.*\/input/)
        .reply(200, { success: true });

      render(
        <Provider store={store}>
          <App />
        </Provider>
      );

      await waitFor(() => {
        expect(screen.getByText('Terminal 1')).toBeInTheDocument();
        expect(screen.getByText('Terminal 2')).toBeInTheDocument();
      });

      // Multi-select terminals
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]); // Terminal 1
      fireEvent.click(checkboxes[1]); // Terminal 2

      // Batch operations should appear
      await waitFor(() => {
        expect(screen.getByText('2 terminals selected')).toBeInTheDocument();
      });

      // Send batch command
      const input = screen.getByPlaceholderText(/Send to 2 terminals/);
      fireEvent.change(input, { target: { value: 'echo "batch"' } });
      fireEvent.keyPress(input, { key: 'Enter', code: 'Enter', charCode: 13 });

      await waitFor(() => {
        const postRequests = mockAxios.history.post.filter((req) =>
          req.url?.includes('/input')
        );
        expect(postRequests).toHaveLength(2);
      });
    });
  });

  describe('Grid View', () => {
    it('should toggle grid view', async () => {
      const mockTerminals = [
        {
          id: 'term-1',
          name: 'Terminal 1',
          profile: 'bash',
          processId: 'proc-28',
          status: 'running',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'term-2',
          name: 'Terminal 2',
          profile: 'bash',
          processId: 'proc-29',
          status: 'running',
          createdAt: new Date().toISOString(),
        },
      ];

      mockAxios
        .onGet('/api/terminals')
        .reply(200, { terminals: mockTerminals });

      render(
        <Provider store={store}>
          <App />
        </Provider>
      );

      await waitFor(() => {
        expect(screen.getByText('Terminal 1')).toBeInTheDocument();
      });

      // Toggle grid view
      const gridToggle = screen.getByLabelText('Grid View');
      fireEvent.click(gridToggle);

      // Grid layout should appear
      await waitFor(() => {
        expect(screen.getByText('Grid View')).toBeInTheDocument();
      });

      const state = store.getState();
      expect(state.grid.isGridViewActive).toBe(true);
    });

    it('should display terminals in grid layout', async () => {
      const mockTerminals = Array.from({ length: 4 }, (_, i) => ({
        id: `term-${i + 1}`,
        name: `Terminal ${i + 1}`,
        profile: 'bash',
        processId: 'proc-30',
        status: 'running',
        createdAt: new Date().toISOString(),
      }));

      mockAxios
        .onGet('/api/terminals')
        .reply(200, { terminals: mockTerminals });

      // Pre-set grid view active
      store.dispatch({ type: 'grid/setGridViewActive', payload: true });
      store.dispatch({
        type: 'grid/addLayout',
        payload: {
          id: '2x2',
          name: '2x2 Grid',
          rows: 2,
          cols: 2,
          terminals: mockTerminals.map((t, i) => ({
            terminalId: t.id,
            position: { row: Math.floor(i / 2), col: i % 2 },
          })),
        },
      });
      store.dispatch({ type: 'grid/setActiveLayout', payload: '2x2' });

      render(
        <Provider store={store}>
          <App />
        </Provider>
      );

      await waitFor(() => {
        // All terminals should be visible in grid
        mockTerminals.forEach((terminal) => {
          expect(
            screen.getByTestId(`terminal-viewer-${terminal.id}`)
          ).toBeInTheDocument();
        });
      });
    });
  });

  describe('Real-time Updates', () => {
    it('should update terminal output in real-time', async () => {
      const mockTerminals = [
        {
          id: 'term-1',
          name: 'Terminal 1',
          profile: 'bash',
          processId: 'proc-31',
          status: 'running',
          createdAt: new Date().toISOString(),
        },
      ];

      mockAxios
        .onGet('/api/terminals')
        .reply(200, { terminals: mockTerminals });

      render(
        <Provider store={store}>
          <App />
        </Provider>
      );

      await waitFor(() => {
        expect(screen.getByText('Terminal 1')).toBeInTheDocument();
      });

      // Select terminal
      fireEvent.click(screen.getByText('Terminal 1'));

      // Simulate real-time output updates
      for (let i = 0; i < 5; i++) {
        store.dispatch(
          addOutput({
            terminalId: 'term-1',
            data: `Line ${i + 1}\n`,
          })
        );
      }

      // Verify output buffer is updated
      const state = store.getState();
      expect(state.output.buffers['term-1']).toContain('Line 1');
      expect(state.output.buffers['term-1']).toContain('Line 5');
    });

    it('should handle terminal status changes', async () => {
      const mockTerminals = [
        {
          id: 'term-1',
          name: 'Terminal 1',
          profile: 'bash',
          processId: 'proc-32',
          status: 'running',
          createdAt: new Date().toISOString(),
        },
      ];

      mockAxios
        .onGet('/api/terminals')
        .reply(200, { terminals: mockTerminals });

      render(
        <Provider store={store}>
          <App />
        </Provider>
      );

      await waitFor(() => {
        expect(screen.getByText('Terminal 1')).toBeInTheDocument();
        expect(screen.getByText('running')).toBeInTheDocument();
      });

      // Update terminal status
      store.dispatch({
        type: 'terminals/updateTerminalStatus',
        payload: { terminalId: 'term-1', status: 'exited' },
      });

      await waitFor(() => {
        expect(screen.getByText('exited')).toBeInTheDocument();
      });
    });
  });

  describe('Error Scenarios', () => {
    it('should handle terminal connection failures', async () => {
      mockAxios.onGet('/api/terminals').reply(500, { error: 'Server error' });

      render(
        <Provider store={store}>
          <App />
        </Provider>
      );

      await waitFor(() => {
        expect(
          screen.getByText(/Failed to fetch terminals/)
        ).toBeInTheDocument();
      });
    });

    it('should handle terminal input failures gracefully', async () => {
      const mockTerminals = [
        {
          id: 'term-1',
          name: 'Terminal 1',
          profile: 'bash',
          processId: 'proc-33',
          status: 'running',
          createdAt: new Date().toISOString(),
        },
      ];

      mockAxios
        .onGet('/api/terminals')
        .reply(200, { terminals: mockTerminals });
      mockAxios
        .onPost('/api/terminals/term-1/input')
        .reply(500, { error: 'Input failed' });

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      render(
        <Provider store={store}>
          <App />
        </Provider>
      );

      await waitFor(() => {
        expect(screen.getByText('Terminal 1')).toBeInTheDocument();
      });

      // Select terminal and send input
      fireEvent.click(screen.getByText('Terminal 1'));
      const input = screen.getByPlaceholderText('Type a command...');
      fireEvent.change(input, { target: { value: 'test' } });
      fireEvent.keyPress(input, { key: 'Enter', code: 'Enter', charCode: 13 });

      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Failed to send input'),
          expect.any(Error)
        );
      });

      consoleErrorSpy.mockRestore();
    });
  });
});
