import { Server, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { EventBus, TerminalEvent, EventFilter } from './EventBus';
import { AuthManager } from './auth';
import { v4 as uuidv4 } from 'uuid';

export interface APIMessage {
  id: string;
  type: 'subscribe' | 'unsubscribe' | 'command' | 'query' | 'heartbeat';
  payload: any;
}

export interface APIResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: APIError;
}

export interface APIError {
  code: string;
  message: string;
  details?: any;
}

export interface ClientInfo {
  id: string;
  token: string;
  permissions: string[];
  connectedAt: Date;
}

export interface APIClient {
  id: string;
  ws: WebSocket;
  info: ClientInfo;
  subscriptions: Map<string, { id: string; patterns: string[] }>;
  lastHeartbeat: Date;
}

export interface WebSocketServerConfig {
  port: number;
  authManager: AuthManager;
  ptyManager?: any; // PTY manager for terminal operations
  terminalMap?: Map<string, string>; // Shared terminal ID -> process ID mapping
  heartbeatInterval?: number;
  clientTimeout?: number;
  maxClientsPerIP?: number;
  rateLimitPerMinute?: number;
}

export class APIWebSocketServer {
  private wss: Server;
  private clients: Map<string, APIClient>;
  private eventBus: EventBus;
  private config: WebSocketServerConfig;
  private authManager: AuthManager;
  private ptyManager?: any;
  private terminalMap?: Map<string, string>;
  private heartbeatTimer?: NodeJS.Timeout;
  private ipConnectionCount: Map<string, number>;
  private rateLimitTracker: Map<string, number[]>;

  constructor(config: WebSocketServerConfig, eventBus: EventBus) {
    this.config = {
      heartbeatInterval: 30000,
      clientTimeout: 60000,
      maxClientsPerIP: 10,
      rateLimitPerMinute: 1000,
      ...config,
    };

    this.authManager = config.authManager;
    this.ptyManager = config.ptyManager;
    this.terminalMap = config.terminalMap;
    this.eventBus = eventBus;
    this.clients = new Map();
    this.ipConnectionCount = new Map();
    this.rateLimitTracker = new Map();

    this.wss = new Server({
      port: config.port,
      verifyClient: this.verifyClient.bind(this),
    });

    this.setupHandlers();
    this.startHeartbeat();
  }

  private setupHandlers(): void {
    this.wss.on('connection', this.handleConnection.bind(this));
    this.wss.on('error', (error) => {
      console.error('WebSocket server error:', error);
    });
  }

  private verifyClient(info: { origin: string; req: IncomingMessage }, callback: (result: boolean) => void): void {
    const ip = info.req.socket.remoteAddress || '';
    
    // Check max connections per IP
    const currentConnections = this.ipConnectionCount.get(ip) || 0;
    if (currentConnections >= this.config.maxClientsPerIP!) {
      console.log(`❌ Max connections per IP exceeded: ${currentConnections}/${this.config.maxClientsPerIP}`);
      callback(false);
      return;
    }

    // Extract token from query string or authorization header
    const url = new URL(info.req.url || '', `http://${info.req.headers.host}`);
    const token = url.searchParams.get('token') ||
      info.req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      console.log(`❌ No token found in request`);
      callback(false);
      return;
    }

    // Verify token using AuthManager
    const payload = this.authManager.verifyToken(token);

    if (!payload) {
      console.log(`❌ Token verification failed`);
    }

    callback(payload !== null);
  }

  private authenticateClient(token: string): ClientInfo | null {
    const payload = this.authManager.verifyToken(token);
    if (!payload) return null;

    return {
      id: payload.sub || uuidv4(),
      token,
      permissions: payload.permissions || [],
      connectedAt: new Date(),
    };
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = req.socket.remoteAddress || '';
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token') ||
      req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      ws.close(1008, 'Missing authentication token');
      return;
    }

    const clientInfo = this.authenticateClient(token);
    if (!clientInfo) {
      ws.close(1008, 'Invalid authentication token');
      return;
    }

    // Create client
    const client: APIClient = {
      id: clientInfo.id,
      ws,
      info: clientInfo,
      subscriptions: new Map(),
      lastHeartbeat: new Date(),
    };

    this.clients.set(client.id, client);

    // Update IP connection count
    this.ipConnectionCount.set(ip, (this.ipConnectionCount.get(ip) || 0) + 1);

    // Set up client handlers
    ws.on('message', (data) => this.handleMessage(client.id, data));
    ws.on('close', () => this.handleDisconnection(client.id, ip));
    ws.on('error', (error) => {
      console.error(`Client ${client.id} error:`, error);
      this.handleDisconnection(client.id, ip);
    });

    // Send welcome message
    this.sendResponse(client, {
      id: 'welcome',
      success: true,
      data: {
        clientId: client.id,
        serverTime: new Date().toISOString(),
        heartbeatInterval: this.config.heartbeatInterval,
      },
    });
  }

  private handleDisconnection(clientId: string, ip: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Clean up subscriptions
    for (const [subId] of client.subscriptions) {
      this.eventBus.unsubscribe(subId);
    }

    // Remove client
    this.clients.delete(clientId);

    // Update IP connection count
    const count = this.ipConnectionCount.get(ip) || 0;
    if (count > 1) {
      this.ipConnectionCount.set(ip, count - 1);
    } else {
      this.ipConnectionCount.delete(ip);
    }
  }

  private handleMessage(clientId: string, data: any): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    try {
      // Rate limiting
      if (!this.checkRateLimit(clientId)) {
        this.sendError(client, 'rate-limit', 'RATE_LIMIT_EXCEEDED', 'Too many requests');
        return;
      }

      let message: APIMessage;
      try {
        message = JSON.parse(data.toString());
      } catch {
        this.sendError(client, 'invalid-message', 'INVALID_MESSAGE', 'Invalid JSON');
        return;
      }

      // Ensure message has an ID
      if (!message.id) {
        message.id = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      }

      // Update heartbeat
      client.lastHeartbeat = new Date();

      // Handle message types
      switch (message.type) {
        case 'subscribe':
          this.handleSubscribe(client, message);
          break;
        case 'unsubscribe':
          this.handleUnsubscribe(client, message);
          break;
        case 'command':
          this.handleCommand(client, message);
          break;
        case 'query':
          this.handleQuery(client, message);
          break;
        case 'heartbeat':
          this.handleHeartbeat(client, message);
          break;
        default:
          this.sendError(client, message.id, 'UNKNOWN_MESSAGE_TYPE',
            `Unknown message type: ${(message as any).type}`);
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
      this.sendError(client, 'internal-error', 'INTERNAL_ERROR',
        'An error occurred while processing your message');
    }
  }

  private handleSubscribe(client: APIClient, message: APIMessage): void {
    // Ensure payload exists
    if (!message.payload) {
      this.sendError(client, message.id, 'INVALID_PAYLOAD', 'Payload is required for subscribe message');
      return;
    }

    const { patterns, filters } = message.payload as {
      patterns: string[];
      filters?: EventFilter;
    };

    if (!patterns || !Array.isArray(patterns)) {
      this.sendError(client, message.id, 'INVALID_PAYLOAD', 'Patterns must be an array');
      return;
    }

    // Subscribe to event bus
    const subscription = this.eventBus.subscribe(
      patterns,
      (event) => this.broadcastEventToClient(client, event),
      filters
    );

    client.subscriptions.set(subscription.id, { id: subscription.id, patterns });

    this.sendResponse(client, {
      id: message.id,
      success: true,
      data: {
        subscriptionId: subscription.id,
        patterns,
      },
    });
  }

  private handleUnsubscribe(client: APIClient, message: APIMessage): void {
    // Ensure payload exists
    if (!message.payload) {
      this.sendError(client, message.id, 'INVALID_PAYLOAD', 'Payload is required for unsubscribe message');
      return;
    }

    const { subscriptionId } = message.payload;

    if (!subscriptionId || !client.subscriptions.has(subscriptionId)) {
      this.sendError(client, message.id, 'INVALID_SUBSCRIPTION', 'Subscription not found');
      return;
    }

    this.eventBus.unsubscribe(subscriptionId);
    client.subscriptions.delete(subscriptionId);

    this.sendResponse(client, {
      id: message.id,
      success: true,
    });
  }

  private handleCommand(client: APIClient, message: APIMessage): void {
    // Ensure payload exists
    if (!message.payload) {
      this.sendError(client, message.id, 'INVALID_PAYLOAD', 'Payload is required for command message');
      return;
    }

    const { action } = message.payload;

    // Check permissions based on action type
    let requiredPermission = 'execute'; // default fallback

    if (action === 'terminal:input') {
      requiredPermission = 'terminal.write';
    } else if (action === 'terminal:create') {
      requiredPermission = 'terminal.create';
    } else if (action === 'terminal:delete') {
      requiredPermission = 'terminal.delete';
    } else if (action === 'terminal:read') {
      requiredPermission = 'terminal.read';
    }

    if (!this.hasPermission(client, requiredPermission)) {
      this.sendError(client, message.id, 'PERMISSION_DENIED', `Insufficient permissions for action: ${action}. Required: ${requiredPermission}`);
      return;
    }

    // Handle specific command actions
    try {
      console.log(`WebSocket: Processing command with action: ${action}`);
      if (action === 'terminal:input') {
        const { terminalId, data } = message.payload;
        console.log(`WebSocket: Received terminal:input for terminalId: ${terminalId}, data length: ${data?.length || 0}`);

        if (!terminalId || typeof data !== 'string') {
          this.sendError(client, message.id, 'INVALID_PAYLOAD', 'terminalId and data (string) are required for terminal:input');
          return;
        }

        if (!this.ptyManager) {
          this.sendError(client, message.id, 'SERVICE_UNAVAILABLE', 'PTY manager not available');
          return;
        }

        // Use the same terminal mapping logic as the REST API
        console.log(`WebSocket: terminalMap available: ${this.terminalMap !== undefined}, size: ${this.terminalMap?.size || 0}`);
        if (this.terminalMap) {
          console.log(`WebSocket: terminalMap contents:`, Array.from(this.terminalMap.entries()));
        }
        
        const processId = this.terminalMap?.get(terminalId) || terminalId;
        console.log(`WebSocket: terminalId=${terminalId} -> processId=${processId} (mapped=${this.terminalMap?.has(terminalId)})`);
        
        // Check if process exists using the mapped process ID
        const process = this.ptyManager.getProcess(processId);
        if (!process && !this.ptyManager.getActiveProcesses().find((p: any) => p.id === processId)) {
          console.log(`WebSocket: Process ${processId} not found`);
        }

        if (!process) {
          const activeProcesses = this.ptyManager.getActiveProcesses();
          console.log(`WebSocket: Terminal ${terminalId} not found in ${activeProcesses.length} active processes`);
          console.log('WebSocket: Available processes:', activeProcesses.map((p: any) => ({
            id: p.id,
            terminalId: p.terminalId,
            pid: p.pid,
            status: p.status
          })));
          this.sendError(client, message.id, 'TERMINAL_NOT_FOUND', `Terminal ${terminalId} not found`);
          return;
        }

        // Send input to terminal using the correct process ID
        console.log(`WebSocket: Sending input to process ${processId} (terminal ${terminalId}): ${data.substring(0, 50)}...`);
        this.ptyManager.write(processId, data);

        this.sendResponse(client, {
          id: message.id,
          success: true,
          data: { message: 'Input sent to terminal' },
        });
      } else {
        // Generic command handling for other actions
        this.sendResponse(client, {
          id: message.id,
          success: true,
          data: { message: 'Command received' },
        });
      }
    } catch (error: any) {
      console.error('Error handling command:', error);
      this.sendError(client, message.id, 'COMMAND_FAILED', `Command execution failed: ${error.message}`);
    }
  }

  private handleQuery(client: APIClient, message: APIMessage): void {
    // Ensure payload exists
    if (!message.payload) {
      this.sendError(client, message.id, 'INVALID_PAYLOAD', 'Payload is required for query message');
      return;
    }

    const { type, params } = message.payload;

    switch (type) {
      case 'eventHistory':
        const history = this.eventBus.getEventHistory(params);
        this.sendResponse(client, {
          id: message.id,
          success: true,
          data: history,
        });
        break;

      case 'eventStats':
        const stats = this.eventBus.getEventStats();
        this.sendResponse(client, {
          id: message.id,
          success: true,
          data: stats,
        });
        break;

      default:
        this.sendError(client, message.id, 'UNKNOWN_QUERY', `Unknown query type: ${type}`);
    }
  }

  private handleHeartbeat(client: APIClient, message: APIMessage): void {
    this.sendResponse(client, {
      id: message.id,
      success: true,
      data: { serverTime: new Date().toISOString() },
    });
  }

  private broadcastEventToClient(client: APIClient, event: TerminalEvent): void {
    if (client.ws.readyState !== 1) return; // 1 = OPEN state

    const message = {
      type: 'event',
      event,
      timestamp: new Date().toISOString(),
    };

    client.ws.send(JSON.stringify(message));
  }

  private sendResponse(client: APIClient, response: APIResponse): void {
    if (client.ws.readyState !== 1) return; // 1 = OPEN state
    client.ws.send(JSON.stringify(response));
  }

  private sendError(client: APIClient, messageId: string, code: string, message: string): void {
    this.sendResponse(client, {
      id: messageId,
      success: false,
      error: { code, message },
    });
  }

  private hasPermission(client: APIClient, permission: string): boolean {
    // Use AuthManager for consistent permission checking
    return this.authManager.hasPermission(client.info.token, permission);
  }

  private checkRateLimit(clientId: string): boolean {
    const now = Date.now();
    const windowStart = now - 60000; // 1 minute window

    let requests = this.rateLimitTracker.get(clientId) || [];
    requests = requests.filter(time => time > windowStart);
    requests.push(now);

    this.rateLimitTracker.set(clientId, requests);

    return requests.length <= this.config.rateLimitPerMinute!;
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const timeout = this.config.clientTimeout!;

      for (const [clientId, client] of this.clients) {
        const lastSeen = client.lastHeartbeat.getTime();
        if (now - lastSeen > timeout) {
          console.log(`Client ${clientId} timed out`);
          client.ws.terminate();
          this.handleDisconnection(clientId, '');
        }
      }
    }, this.config.heartbeatInterval);
  }

  public broadcast(event: TerminalEvent): void {
    // This is called by external code to broadcast events to all clients
    this.eventBus.publish(event);
  }

  public stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    for (const client of this.clients.values()) {
      client.ws.close(1001, 'Server shutting down');
    }

    this.wss.close();
  }

  public getConnectedClients(): number {
    return this.clients.size;
  }

  public getClientInfo(clientId: string): ClientInfo | undefined {
    return this.clients.get(clientId)?.info;
  }
}