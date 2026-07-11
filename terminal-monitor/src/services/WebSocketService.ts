import { store } from '../store/store';
import {
  setWsConnected,
  incrementReconnectAttempts,
  setConnectionError,
} from '../store/slices/connectionSlice';
import { updateTerminalStatus } from '../store/slices/terminalsSlice';
import authService from './authService';
import { logTerminalData } from '../utils/terminalDebug';
import { MessageQueue } from './MessageQueue';

interface APIMessage {
  id: string;
  type: 'subscribe' | 'unsubscribe' | 'command' | 'query' | 'heartbeat';
  payload: any;
}

interface APIResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: { code: string; message: string };
}

interface EventMessage {
  type: 'event';
  event: {
    type: string;
    terminalId?: string;
    data?: any;
    exitCode?: number;
  };
  timestamp: string;
}

enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
  ERROR = 'ERROR',
}

// WebSocket close codes
const WS_CLOSE_CODES: { [key: number]: string } = {
  1000: 'Normal closure',
  1001: 'Going away',
  1002: 'Protocol error',
  1003: 'Unsupported data',
  1004: 'Reserved',
  1005: 'No status received',
  1006: 'Abnormal closure',
  1007: 'Invalid frame payload data',
  1008: 'Policy violation',
  1009: 'Message too big',
  1010: 'Mandatory extension',
  1011: 'Internal server error',
  1015: 'TLS handshake',
};

class WebSocketService {
  private ws: WebSocket | null = null;
  private reconnectInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private connectionTimeout: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseReconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private connectionState: ConnectionState = ConnectionState.DISCONNECTED;
  private lastHeartbeatResponse: number = Date.now();
  private missedHeartbeats = 0;
  private messageQueue: MessageQueue;
  private subscriptionId: string | null = null;

  // Engine seam (terminal-core): per-terminal output/exit subscribers.
  // Since Phase 4 these are the SOLE live-output/exit delivery path to the engine —
  // the legacy Redux batching path was removed; output now flows only through these.
  private outputSubs = new Map<string, Set<(data: string) => void>>();
  private exitSubs = new Map<string, Set<(code: number) => void>>();
  private isInitialConnection = true; // Track if this is the first connection attempt
  private initialConnectionTimer: NodeJS.Timeout | null = null;

  private performanceMetrics = {
    messagesPerSecond: 0,
    avgBatchSize: 0,
    lastSecondMessageCount: 0,
    lastSecondTimestamp: Date.now()
  };
  private readonly WS_URL =
    process.env.REACT_APP_WS_URL || 'ws://localhost:42031/ws';
  private readonly CONNECTION_TIMEOUT = 10000; // 10 seconds
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private readonly MAX_MISSED_HEARTBEATS = 2;
  private readonly INITIAL_CONNECTION_DELAY = 1000; // Wait 1 second for server to be ready

  constructor() {
    this.messageQueue = new MessageQueue();
  }

  connect() {
    // Prevent multiple simultaneous connection attempts
    if (
      this.connectionState === ConnectionState.CONNECTING ||
      this.connectionState === ConnectionState.CONNECTED
    ) {
      console.log(
        `WebSocket ${this.connectionState.toLowerCase()}, skipping connection attempt`
      );
      return;
    }

    const token = authService.getToken();
    if (!token) {
      console.error('No auth token available for WebSocket connection');
      store.dispatch(setConnectionError('Authentication required'));
      this.connectionState = ConnectionState.ERROR;
      return;
    }

    // For initial connections, add a delay to let the server start up
    if (this.isInitialConnection) {
      console.log('Initial WebSocket connection - waiting for server to be ready...');
      this.initialConnectionTimer = setTimeout(() => {
        this.isInitialConnection = false;
        this.attemptConnection(token);
      }, this.INITIAL_CONNECTION_DELAY);
      return;
    }

    this.attemptConnection(token);
  }

  private async attemptConnection(token: string) {
    this.connectionState = ConnectionState.CONNECTING;
    console.log(`Connecting to WebSocket server at ${this.WS_URL}...`);

    // Only show detailed token info in development
    if (process.env.NODE_ENV === 'development') {
      console.log(`Using token: ${token.substring(0, 20)}...${token.substring(token.length - 20)}`);
    }

    // For initial connections, check if the server is ready
    if (this.reconnectAttempts === 0) {
      try {
        const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:42031';
        const response = await fetch(`${apiUrl}/api/health`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        if (!response.ok) {
          console.log('REST API not ready yet, will retry WebSocket connection...');
          this.handleConnectionFailure('Server not ready');
          return;
        }
        console.log('REST API is ready, proceeding with WebSocket connection');
      } catch (error) {
        console.log('REST API health check failed, server may still be starting up...');
        this.handleConnectionFailure('Server health check failed');
        return;
      }
    }

    // Debug token details only in development
    if (process.env.NODE_ENV === 'development') {
      authService.debugToken();
    }

    try {
      // Browser WebSocket API doesn't support headers, use query parameter
      console.log('Attempting WebSocket connection with token query parameter...');
      this.ws = new WebSocket(`${this.WS_URL}?token=${encodeURIComponent(token)}`);

      // Set connection timeout
      this.connectionTimeout = setTimeout(() => {
        if (this.connectionState === ConnectionState.CONNECTING) {
          console.error('WebSocket connection timeout');
          this.ws?.close();
          this.handleConnectionFailure('Connection timeout');
        }
      }, this.CONNECTION_TIMEOUT);

      this.setupEventHandlers();
    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      this.handleConnectionFailure('Failed to create WebSocket connection');
    }
  }

  private setupEventHandlers() {
    if (!this.ws) return;

    this.ws.onopen = () => {
      console.log('WebSocket connected successfully');

      // Clear connection timeout
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }

      this.connectionState = ConnectionState.CONNECTED;
      store.dispatch(setWsConnected(true));
      store.dispatch(setConnectionError(null));
      this.reconnectAttempts = 0;
      this.missedHeartbeats = 0;

      // Subscribe to all terminal events using correct pattern
      const subscriptionMessage = {
        id: `sub-${Date.now()}`,
        type: 'subscribe' as const,
        payload: {
          patterns: ['output.data', 'process.*', 'input.data', 'state.change'],
        },
      };
      this.send(subscriptionMessage);

      // Process any queued messages
      const queuedMessages = this.messageQueue.dequeueAll();
      queuedMessages.forEach((msg) => {
        console.log('Processing queued message:', msg.type, msg.data);
        // Reconstruct the message from queued data
        if (msg.data && typeof msg.data === 'object' && 'message' in msg.data) {
          const message = msg.data.message as APIMessage;
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
          }
        }
      });

      // Start heartbeat
      this.startHeartbeat();
    };

    this.ws.onclose = (event) => {
      const reason = WS_CLOSE_CODES[event.code] || 'Unknown reason';
      console.log(
        `WebSocket disconnected: ${event.code} - ${reason}`,
        event.reason || ''
      );

      // Enhanced debugging for authentication failures
      if (event.code === 1008 || event.code === 1006) {
        // Show detailed error only after multiple failed attempts or if it's not the initial connection
        if (this.reconnectAttempts > 2 || !this.isInitialConnection) {
          console.error('=== WebSocket Authentication Failed ===');
          console.error(`- Close code: ${event.code} (${event.code === 1008 ? 'Policy violation' : 'Abnormal closure'})`);
          console.error('- Reason:', event.reason || 'No specific reason provided');
          console.error('- This typically means the JWT token was invalid or expired');
          console.error('');
          console.error('🔧 TROUBLESHOOTING STEPS:');
          console.error('1. Verify auto-terminal server is running:');
          console.error('   - Check if port 42031 (REST API / WebSocket) is working');
          console.error('2. Check auto-terminal server logs for authentication errors');
          console.error('3. Verify JWT secret configuration in auto-terminal server');
          console.error('4. Try restarting the auto-terminal application');
          console.error('');
          console.error('💡 WORKAROUND: The terminal monitor will continue to work with API-only mode');
          console.error('   Real-time updates will be disabled until WebSocket is fixed');
        } else {
          // For initial connection failures, just log a simple message
          console.log(`WebSocket connection failed (${event.code}), server may still be starting up. Will retry...`);
        }
      }

      // Clear connection timeout if still active
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }

      store.dispatch(setWsConnected(false));
      this.stopHeartbeat();

      // Determine if we should reconnect
      const shouldReconnect =
        event.code !== 1000 && // Normal closure
        event.code !== 1001 && // Going away
        event.code !== 1008 && // Policy violation (auth failure)
        this.connectionState !== ConnectionState.DISCONNECTED;

      if (shouldReconnect) {
        this.connectionState = ConnectionState.RECONNECTING;
        this.scheduleReconnect();
      } else {
        this.connectionState = ConnectionState.DISCONNECTED;
        if (event.code === 1008) {
          store.dispatch(
            setConnectionError('Authentication failed - please login again')
          );
        }
      }
    };

    this.ws.onerror = (error) => {
      // The error event doesn't provide much useful information
      // Real error details come through the close event
      console.error('WebSocket error occurred');

      // Only set error if we're not already handling a close event
      if (this.connectionState === ConnectionState.CONNECTING) {
        this.handleConnectionFailure(
          'Connection failed - server may be unavailable'
        );
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Handle different message types
        if (data.type === 'event') {
          this.handleEventMessage(data as EventMessage);
        } else if (data.id) {
          this.handleResponse(data as APIResponse);
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };
  }

  private handleEventMessage(message: EventMessage) {
    const { event } = message;

    switch (event.type) {
      case 'output.data':
        if (event.terminalId && event.data?.content) {
          // Debug: Log when output arrives from WebSocket
          console.debug(`[WebSocket] output.data received at ${Date.now()} for terminal ${event.terminalId}, length: ${event.data.content.length}`);

          // Track performance metrics
          this.updatePerformanceMetrics();

          // Engine seam: feed direct output subscribers (terminal-core engine).
          // Live bytes are rendered by xterm via this seam; the old Redux
          // `appendOutput` batch path was removed (terminal-core phase-4 cleanup) —
          // no component reads `selectTerminalOutput` anymore.
          this.outputSubs
            .get(event.terminalId)
            ?.forEach((cb) => cb(event.data.content));
        }
        break;

      case 'process.exit':
        if (event.terminalId) {
          store.dispatch(
            updateTerminalStatus({
              id: event.terminalId,
              status: 'exited',
            })
          );

          // Engine seam (additive): feed direct exit subscribers.
          this.exitSubs
            .get(event.terminalId)
            ?.forEach((cb) => cb(event.exitCode ?? 0));
        }
        break;

      case 'input.data':
        // Log input for debugging
        if (event.terminalId && event.data?.content) {
          console.log(
            `Input to terminal ${event.terminalId}: ${event.data.content}`
          );
        }
        break;

      case 'process.start':
      case 'process.ready':
        if (event.terminalId) {
          store.dispatch(
            updateTerminalStatus({
              id: event.terminalId,
              status: 'running',
            })
          );
        }
        break;

      case 'terminal:output':
        // Alternative event type name
        if (event.terminalId && event.data?.content) {
          // Track performance metrics
          this.updatePerformanceMetrics();

          // Engine seam: feed direct output subscribers (terminal-core engine).
          this.outputSubs
            .get(event.terminalId)
            ?.forEach((cb) => cb(event.data.content));
        }
        break;

      case 'process.metrics':
        // Process performance metrics - log for debugging but don't update UI
        if (event.terminalId && event.data) {
          //console.debug(`Process metrics for ${event.terminalId}:`, event.data );
        }
        break;

      case 'process.inactive':
        // Process became inactive - update terminal status
        if (event.terminalId) {
          console.log(`Process inactive for terminal ${event.terminalId}`);
          store.dispatch(
            updateTerminalStatus({
              id: event.terminalId,
              status: 'inactive',
            })
          );
        }
        break;

      case 'process.active':
        // Process became active - update terminal status
        if (event.terminalId) {
          console.log(`Process active for terminal ${event.terminalId}`);
          store.dispatch(
            updateTerminalStatus({
              id: event.terminalId,
              status: 'running',
            })
          );
        }
        break;
      case 'process.activity':
        // Process became active - update terminal status
        if (event.terminalId) {
          console.log(`Process activity for terminal ${event.terminalId}`);
          store.dispatch(
            updateTerminalStatus({
              id: event.terminalId,
              status: 'running',
            })
          );
        }
        break;

      // Add more event handlers as needed
      default:
        console.log('Unhandled event type:', event.type, event);
    }
  }

  private handleResponse(response: APIResponse) {
    if (response.id === 'welcome') {
      console.log('Welcome message received:', response.data);
    } else if (response.id.startsWith('hb-')) {
      // Heartbeat response
      this.lastHeartbeatResponse = Date.now();
      this.missedHeartbeats = 0;
    } else if (response.id.startsWith('sub-') && response.success) {
      // Store subscription ID for later unsubscribe
      this.subscriptionId = response.data?.subscriptionId || null;
      console.log('Subscription successful:', this.subscriptionId);
    } else if (!response.success && response.error) {
      console.error('API Error:', response.error);
      store.dispatch(setConnectionError(response.error.message));
    }
  }

  private send(message: APIMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        console.error('Failed to send WebSocket message:', error);
      }
    } else {
      console.warn('Cannot send message - WebSocket not connected, queuing...');
      // Queue message for later delivery (except heartbeats)
      if (message.type !== 'heartbeat') {
        this.messageQueue.enqueue({
          type: message.type,
          data: {
            message,
            priority: message.type === 'command' ? 'high' : 'normal',
          },
        });
      }
    }
  }

  private startHeartbeat() {
    this.lastHeartbeatResponse = Date.now();

    this.heartbeatInterval = setInterval(() => {
      if (this.connectionState !== ConnectionState.CONNECTED) {
        return;
      }

      // Check if we've missed too many heartbeats
      const timeSinceLastResponse = Date.now() - this.lastHeartbeatResponse;
      if (
        timeSinceLastResponse >
        this.HEARTBEAT_INTERVAL * this.MAX_MISSED_HEARTBEATS
      ) {
        console.error('Heartbeat timeout - connection may be dead');
        this.missedHeartbeats++;

        if (this.missedHeartbeats >= this.MAX_MISSED_HEARTBEATS) {
          console.error('Too many missed heartbeats, forcing reconnection');
          this.ws?.close();
          return;
        }
      }

      this.send({
        id: `hb-${Date.now()}`,
        type: 'heartbeat',
        payload: {},
      });
    }, this.HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private handleConnectionFailure(error: string) {
    this.connectionState = ConnectionState.ERROR;
    store.dispatch(setConnectionError(error));
    store.dispatch(setWsConnected(false));

    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      store.dispatch(
        setConnectionError(
          'Unable to establish connection - please refresh the page'
        )
      );
      this.connectionState = ConnectionState.ERROR;
      return;
    }

    // Calculate delay with exponential backoff and jitter
    const exponentialDelay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    // Add jitter (±25% randomization) to prevent thundering herd
    const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);
    const delay = Math.round(exponentialDelay + jitter);

    this.reconnectAttempts++;
    store.dispatch(incrementReconnectAttempts());

    console.log(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );

    this.reconnectInterval = setTimeout(() => {
      if (this.connectionState !== ConnectionState.DISCONNECTED) {
        this.connect();
      }
    }, delay);
  }

  sendInput(terminalId: string, data: string) {
    if (!this.isConnected()) {
      console.error('Cannot send input - WebSocket not connected');
      store.dispatch(setConnectionError('Not connected to server'));
      // Queue the input command for later
      this.messageQueue.enqueue({
        type: 'command',
        data: {
          message: {
            id: `cmd-${Date.now()}`,
            type: 'command',
            payload: {
              action: 'terminal:input',
              terminalId,
              data,
            },
          },
          priority: 'high',
        },
        terminalId,
      });
      return;
    }

    // Send input command through WebSocket
    this.send({
      id: `cmd-${Date.now()}`,
      type: 'command',
      payload: {
        action: 'terminal:input',
        terminalId,
        data,
      },
    });
  }

  /**
   * Subscribe to raw output for a single terminal (engine seam).
   * Returns a disposable. Since Phase 4 this is the sole live-output delivery
   * path to the engine — there is no longer a Redux batching path.
   */
  onOutput(terminalId: string, cb: (data: string) => void) {
    let set = this.outputSubs.get(terminalId);
    if (!set) {
      set = new Set();
      this.outputSubs.set(terminalId, set);
    }
    set.add(cb);
    return {
      dispose: () => {
        set!.delete(cb);
        if (set!.size === 0) this.outputSubs.delete(terminalId);
      },
    };
  }

  /**
   * Subscribe to process exit for a single terminal (engine seam).
   * Returns a disposable. Since Phase 4 this is the sole exit-delivery path
   * to the engine — there is no longer a Redux batching path.
   */
  onExit(terminalId: string, cb: (code: number) => void) {
    let set = this.exitSubs.get(terminalId);
    if (!set) {
      set = new Set();
      this.exitSubs.set(terminalId, set);
    }
    set.add(cb);
    return {
      dispose: () => {
        set!.delete(cb);
        if (set!.size === 0) this.exitSubs.delete(terminalId);
      },
    };
  }

  disconnect() {
    console.log('Disconnecting WebSocket...');
    this.connectionState = ConnectionState.DISCONNECTED;

    this.stopHeartbeat();

    if (this.reconnectInterval) {
      clearTimeout(this.reconnectInterval);
      this.reconnectInterval = null;
    }

    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }

    if (this.initialConnectionTimer) {
      clearTimeout(this.initialConnectionTimer);
      this.initialConnectionTimer = null;
    }

    // Unsubscribe before closing
    if (this.subscriptionId && this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        id: `unsub-${Date.now()}`,
        type: 'unsubscribe',
        payload: {
          subscriptionId: this.subscriptionId,
        },
      });
    }

    if (this.ws) {
      this.ws.close(1000, 'Client disconnecting');
      this.ws = null;
    }

    // Clear queued messages on disconnect
    this.messageQueue.clear();
    this.subscriptionId = null;
  }

  isConnected(): boolean {
    return (
      this.ws?.readyState === WebSocket.OPEN &&
      this.connectionState === ConnectionState.CONNECTED
    );
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  // Force a reconnection (useful for manual retry)
  forceReconnect() {
    console.log('Forcing WebSocket reconnection...');
    this.reconnectAttempts = 0;
    if (this.ws) {
      this.ws.close();
    }
    this.connect();
  }

  /**
   * Update performance metrics for adaptive optimization
   */
  private updatePerformanceMetrics() {
    const now = Date.now();
    this.performanceMetrics.lastSecondMessageCount++;

    // Update messages per second every second
    if (now - this.performanceMetrics.lastSecondTimestamp >= 1000) {
      this.performanceMetrics.messagesPerSecond = this.performanceMetrics.lastSecondMessageCount;
      this.performanceMetrics.lastSecondMessageCount = 0;
      this.performanceMetrics.lastSecondTimestamp = now;

      // Log performance warnings for very high message rates
      if (this.performanceMetrics.messagesPerSecond > 100) {
        console.warn(
          `High message rate detected: ${this.performanceMetrics.messagesPerSecond} messages/sec.`
        );
      }
    }
  }

  /**
   * Get current performance metrics (for debugging)
   */
  getPerformanceMetrics() {
    return { ...this.performanceMetrics };
  }
}

const webSocketService = new WebSocketService();
export default webSocketService;
