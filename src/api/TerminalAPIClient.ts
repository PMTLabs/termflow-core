import { EventEmitter } from 'events';
import { TerminalEvent, TerminalEventType, EventFilter } from './EventBus';

export interface TerminalAPIClientConfig {
  host: string;
  port: number;
  token: string;
  secure?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export interface TerminalInstance {
  id: string;
  sendInput: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
  on: (event: string, callback: (data: any) => void) => void;
}

/**
 * Client SDK for Terminal WebSocket API
 */
export class TerminalAPIClient extends EventEmitter {
  private config: TerminalAPIClientConfig;
  private ws?: WebSocket;
  private connected: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private messageHandlers: Map<string, (response: any) => void>;
  private subscriptions: Map<string, string>; // pattern -> subscriptionId
  private intentionalDisconnect: boolean = false;

  constructor(config: TerminalAPIClientConfig) {
    super();
    this.config = {
      secure: false,
      reconnectInterval: 5000,
      maxReconnectAttempts: 10,
      ...config,
    };
    
    this.messageHandlers = new Map();
    this.subscriptions = new Map();
    
    // Set unlimited listeners for WebSocket event handling
    this.setMaxListeners(0);
  }

  /**
   * Connect to the WebSocket server
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = this.config.secure ? 'wss' : 'ws';
      const url = `${protocol}://${this.config.host}:${this.config.port}?token=${this.config.token}`;
      
      try {
        this.ws = new WebSocket(url);
        
        this.ws.onopen = () => {
          this.connected = true;
          this.reconnectAttempts = 0;
          this.intentionalDisconnect = false;
          this.emit('connected');
          resolve();
        };
        
        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };
        
        this.ws.onclose = (event) => {
          this.connected = false;
          this.emit('disconnected', event.code, event.reason);
          
          // Only attempt reconnection if not intentionally disconnected
          if (!this.intentionalDisconnect) {
            this.handleReconnect();
          }
        };
        
        this.ws.onerror = (error) => {
          this.emit('error', error);
          if (!this.connected) {
            reject(error);
          }
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the server
   */
  disconnect(): void {
    // Mark as intentional disconnect to prevent auto-reconnection
    this.intentionalDisconnect = true;
    
    // Clear any pending reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = undefined;
    }
    
    // Reset reconnect attempts
    this.reconnectAttempts = 0;
  }
  
  /**
   * Manually trigger reconnection
   */
  reconnect(): void {
    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;
    
    if (!this.connected && !this.reconnectTimer) {
      this.handleReconnect();
    }
  }

  /**
   * Subscribe to event patterns
   */
  async subscribe(patterns: string | string[], filter?: EventFilter): Promise<string> {
    const patternArray = Array.isArray(patterns) ? patterns : [patterns];
    const patternKey = patternArray.join(',');
    
    // Check if already subscribed
    if (this.subscriptions.has(patternKey)) {
      return this.subscriptions.get(patternKey)!;
    }
    
    const response = await this.sendMessage('subscribe', {
      patterns: patternArray,
      filters: filter,
    });
    
    const subscriptionId = response.data.subscriptionId;
    this.subscriptions.set(patternKey, subscriptionId);
    
    return subscriptionId;
  }

  /**
   * Unsubscribe from events
   */
  async unsubscribe(patterns: string | string[]): Promise<void> {
    const patternArray = Array.isArray(patterns) ? patterns : [patterns];
    const patternKey = patternArray.join(',');
    const subscriptionId = this.subscriptions.get(patternKey);
    
    if (!subscriptionId) return;
    
    await this.sendMessage('unsubscribe', { subscriptionId });
    this.subscriptions.delete(patternKey);
  }

  /**
   * Create a new terminal
   */
  async createTerminal(_options: {
    profile?: string;
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<TerminalInstance> {
    // This would typically make an HTTP request to the REST API
    // For now, return a mock implementation
    const terminalId = `term-${Date.now()}`;
    
    // Subscribe to terminal events
    await this.subscribe([
      `output.data`,
      `process.*`,
    ], {
      terminalIds: [terminalId],
    });
    
    const terminal: TerminalInstance = {
      id: terminalId,
      sendInput: async (data: string) => {
        await this.sendMessage('command', {
          action: 'sendInput',
          terminalId,
          data,
        });
      },
      resize: async (cols: number, rows: number) => {
        await this.sendMessage('command', {
          action: 'resize',
          terminalId,
          cols,
          rows,
        });
      },
      close: async () => {
        await this.sendMessage('command', {
          action: 'close',
          terminalId,
        });
      },
      on: (event: string, callback: (data: any) => void) => {
        this.on(`terminal.${terminalId}.${event}`, callback);
      },
    };
    
    return terminal;
  }

  /**
   * Get event history
   */
  async getEventHistory(criteria?: any): Promise<TerminalEvent[]> {
    const response = await this.sendMessage('query', {
      type: 'eventHistory',
      params: criteria,
    });
    return response.data;
  }

  /**
   * Get event statistics
   */
  async getEventStats(): Promise<Record<TerminalEventType, number>> {
    const response = await this.sendMessage('query', {
      type: 'eventStats',
    });
    return response.data;
  }

  private async sendMessage(type: string, payload: any): Promise<any> {
    if (!this.ws || this.ws.readyState !== 1) { // 1 = OPEN state
      throw new Error('Not connected');
    }
    
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const message = {
      id: messageId,
      type,
      payload,
    };
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.messageHandlers.delete(messageId);
        reject(new Error('Request timeout'));
      }, 10000);
      
      this.messageHandlers.set(messageId, (response) => {
        clearTimeout(timeout);
        this.messageHandlers.delete(messageId);
        
        if (response.success) {
          resolve(response);
        } else {
          reject(new Error(response.error?.message || 'Request failed'));
        }
      });
      
      this.ws!.send(JSON.stringify(message));
    });
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);
      
      // Handle response to a request
      if (message.id && this.messageHandlers.has(message.id)) {
        this.messageHandlers.get(message.id)!(message);
        return;
      }
      
      // Handle event broadcast
      if (message.type === 'event') {
        const event = message.event as TerminalEvent;
        this.emit('event', event);
        this.emit(event.type, event);
        
        // Emit terminal-specific events
        if (event.terminalId) {
          this.emit(`terminal.${event.terminalId}.${event.type}`, event.data);
        }
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  private handleReconnect(): void {
    // Avoid multiple reconnection attempts
    if (this.reconnectTimer) {
      return;
    }
    
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts!) {
      this.emit('reconnectFailed');
      return;
    }
    
    this.reconnectAttempts++;
    this.emit('reconnecting', this.reconnectAttempts);
    
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await this.connect();
        
        // Restore subscriptions after successful reconnection
        if (this.subscriptions.size > 0) {
          const subscriptionsToRestore = new Map(this.subscriptions);
          this.subscriptions.clear();
          
          for (const [patternKey, _oldSubscriptionId] of subscriptionsToRestore) {
            const patterns = patternKey.split(',');
            try {
              await this.subscribe(patterns);
              this.emit('subscriptionRestored', patterns);
            } catch (error) {
              this.emit('subscriptionRestoreFailed', patterns, error);
            }
          }
        }
        
        this.emit('reconnected');
      } catch (error) {
        // Connection failed, will trigger another reconnect attempt via onclose
        this.emit('reconnectAttemptFailed', this.reconnectAttempts, error);
      }
    }, this.config.reconnectInterval);
  }
}

// Usage example:
/*
const client = new TerminalAPIClient({
  host: 'localhost',
  port: 9876,
  token: 'your-api-token'
});

// Connect to server
await client.connect();

// Subscribe to all process events
client.on('process.exit', (event) => {
  console.log(`Process exited: ${event.processId}`);
});

// Create a terminal
const terminal = await client.createTerminal({
  profile: 'powershell'
});

// Listen for output
terminal.on('output.data', (data) => {
  console.log(data.content);
});

// Send input
await terminal.sendInput('dir\r\n');
*/