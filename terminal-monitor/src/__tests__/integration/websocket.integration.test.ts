import { configureStore } from '@reduxjs/toolkit';
import { WebSocketService } from '../../services/WebSocketService';
import connectionReducer, {
  wsConnected,
  wsDisconnected,
} from '../../store/slices/connectionSlice';
import outputReducer, { addOutput } from '../../store/slices/outputSlice';
import terminalsReducer, {
  updateTerminalStatus,
} from '../../store/slices/terminalsSlice';
import authReducer from '../../store/slices/authSlice';
import gridReducer from '../../store/slices/gridSlice';
import WS from 'jest-websocket-mock';

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

describe('WebSocket Integration', () => {
  let server: WS;
  let wsService: WebSocketService;
  let store: ReturnType<typeof createTestStore>;
  const wsUrl = 'ws://localhost:5122';

  beforeEach(async () => {
    // Create fresh store for each test
    store = createTestStore();

    // Create mock WebSocket server
    server = new WS(wsUrl);

    // Reset store state
    store.dispatch(wsDisconnected());

    // Create WebSocket service instance
    wsService = new WebSocketService(wsUrl, store);
  });

  afterEach(() => {
    wsService.disconnect();
    WS.clean();
  });

  describe('Connection Management', () => {
    it('should connect to WebSocket server and update store', async () => {
      wsService.connect();

      await server.connected;

      // Should dispatch connected action
      const state = store.getState();
      expect(state.connection.wsConnected).toBe(true);
    });

    it('should handle disconnection and update store', async () => {
      wsService.connect();
      await server.connected;

      // Simulate server disconnect
      server.close();

      // Wait for disconnect to process
      await new Promise((resolve) => setTimeout(resolve, 100));

      const state = store.getState();
      expect(state.connection.wsConnected).toBe(false);
    });

    it('should attempt reconnection on disconnect', async () => {
      wsService.connect();
      await server.connected;

      // Close the server
      server.close();

      // Wait for reconnection attempt
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Create new server for reconnection
      const newServer = new WS(wsUrl);
      await newServer.connected;

      const state = store.getState();
      expect(state.connection.reconnectAttempts).toBeGreaterThan(0);

      newServer.close();
    });
  });

  describe('Message Handling', () => {
    it('should handle terminal:output messages', async () => {
      wsService.connect();
      await server.connected;

      const outputMessage = {
        type: 'terminal:output',
        terminalId: 'term-1',
        data: 'Hello from terminal\n',
      };

      server.send(JSON.stringify(outputMessage));

      // Wait for message processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      const state = store.getState();
      expect(state.output.buffers['term-1']).toContain('Hello from terminal');
    });

    it('should handle terminal:status messages', async () => {
      wsService.connect();
      await server.connected;

      const statusMessage = {
        type: 'terminal:status',
        terminalId: 'term-1',
        status: 'exited',
      };

      server.send(JSON.stringify(statusMessage));

      // Wait for message processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      const state = store.getState();
      const terminal = state.terminals.terminals.find((t) => t.id === 'term-1');
      expect(terminal?.status).toBe('exited');
    });

    it('should buffer messages when disconnected', async () => {
      // Don't connect yet
      const testMessage = {
        type: 'terminal:output',
        terminalId: 'term-1',
        data: 'Buffered message',
      };

      // Send message while disconnected
      wsService.send('terminal:input', { terminalId: 'term-1', input: 'test' });

      // Now connect
      wsService.connect();
      await server.connected;

      // Should receive buffered message after connection
      await expect(server).toReceiveMessage(
        JSON.stringify({
          type: 'terminal:input',
          terminalId: 'term-1',
          input: 'test',
        })
      );
    });

    it('should handle authentication on connection', async () => {
      // Set auth token in store
      store.dispatch({
        type: 'auth/initializeAuth',
        payload: { token: 'test-token', permissions: ['read'] },
      });

      wsService.connect();
      await server.connected;

      // Should send auth message
      await expect(server).toReceiveMessage(
        JSON.stringify({
          type: 'auth',
          token: 'test-token',
        })
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed messages gracefully', async () => {
      wsService.connect();
      await server.connected;

      // Send invalid JSON
      server.send('invalid json');

      // Should not crash
      await new Promise((resolve) => setTimeout(resolve, 100));

      const state = store.getState();
      expect(state.connection.wsConnected).toBe(true);
    });

    it('should handle connection errors', async () => {
      // Close server before connecting
      server.close();

      wsService.connect();

      // Wait for connection attempt
      await new Promise((resolve) => setTimeout(resolve, 100));

      const state = store.getState();
      expect(state.connection.wsConnected).toBe(false);
      expect(state.connection.lastError).toBeTruthy();
    });

    it('should respect max reconnection attempts', async () => {
      wsService.connect();
      await server.connected;

      // Simulate multiple disconnections
      for (let i = 0; i < 6; i++) {
        server.close();
        await new Promise((resolve) => setTimeout(resolve, 1500));

        // Create new server for next attempt
        if (i < 5) {
          server = new WS(wsUrl);
        }
      }

      const state = store.getState();
      expect(state.connection.reconnectAttempts).toBeLessThanOrEqual(5);
    });
  });

  describe('Real-time Features', () => {
    it('should handle rapid message bursts', async () => {
      wsService.connect();
      await server.connected;

      // Send multiple messages rapidly
      for (let i = 0; i < 100; i++) {
        server.send(
          JSON.stringify({
            type: 'terminal:output',
            terminalId: 'term-1',
            data: `Line ${i}\n`,
          })
        );
      }

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 500));

      const state = store.getState();
      const output = state.output.buffers['term-1'] || '';

      // Should have all lines
      expect(output.split('\n').length).toBeGreaterThanOrEqual(100);
    });

    it('should handle concurrent terminal outputs', async () => {
      wsService.connect();
      await server.connected;

      // Send outputs from multiple terminals
      const terminals = ['term-1', 'term-2', 'term-3'];

      for (const terminalId of terminals) {
        for (let i = 0; i < 10; i++) {
          server.send(
            JSON.stringify({
              type: 'terminal:output',
              terminalId,
              data: `${terminalId}: Line ${i}\n`,
            })
          );
        }
      }

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 300));

      const state = store.getState();

      // Each terminal should have its output
      for (const terminalId of terminals) {
        expect(state.output.buffers[terminalId]).toBeTruthy();
        expect(state.output.buffers[terminalId]).toContain(terminalId);
      }
    });

    it('should handle terminal lifecycle events', async () => {
      wsService.connect();
      await server.connected;

      // Terminal created
      server.send(
        JSON.stringify({
          type: 'terminal:created',
          terminal: {
            id: 'new-term',
            name: 'New Terminal',
            profile: 'bash',
            processId: 'proc-34',
            status: 'running',
            createdAt: new Date().toISOString(),
          },
        })
      );

      // Terminal output
      server.send(
        JSON.stringify({
          type: 'terminal:output',
          terminalId: 'new-term',
          data: 'Starting bash...\n',
        })
      );

      // Terminal exit
      server.send(
        JSON.stringify({
          type: 'terminal:status',
          terminalId: 'new-term',
          status: 'exited',
        })
      );

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 200));

      const state = store.getState();
      const terminal = state.terminals.terminals.find(
        (t) => t.id === 'new-term'
      );

      expect(terminal).toBeTruthy();
      expect(terminal?.status).toBe('exited');
      expect(state.output.buffers['new-term']).toContain('Starting bash');
    });
  });
});
