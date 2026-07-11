/**
 * Auto-Terminal API Client
 */

import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { TerminalInfo, TerminalEvent, MonitorConfig } from './types';

export class AutoTerminalClient extends EventEmitter {
  private axios: AxiosInstance;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatInterval: number = 30000; // 30 seconds

  constructor(private config: MonitorConfig) {
    super();
    
    this.axios = axios.create({
      baseURL: config.apiUrl,
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Connect to WebSocket for real-time events
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Try passing token in URL as well as headers (some WebSocket implementations don't pass headers properly)
        const wsUrl = new URL(this.config.wsUrl);
        wsUrl.searchParams.set('token', this.config.token);
        
        this.ws = new WebSocket(wsUrl.toString(), {
          headers: {
            'Authorization': `Bearer ${this.config.token}`
          }
        });

        this.ws.on('open', () => {
          console.log('Connected to Auto-Terminal WebSocket');
          this.emit('connected');
          this.startHeartbeat();
          resolve();
        });

        this.ws.on('message', (data: string) => {
          try {
            const message = JSON.parse(data);
            
            // Handle different message types from server
            if (message.type === 'event' && message.event) {
              // This is an event broadcast from the server
              const event = message.event as TerminalEvent;
              this.emit('event', event);
              this.emit(event.type, event);
              
              // Also emit terminal-specific events
              if (event.terminalId && event.type) {
                this.emit(`terminal.${event.terminalId}.${event.type}`, event.data);
              }
            } else if (message.id && message.success !== undefined) {
              // This is a response to a request we made
              // Could be subscribe confirmation, heartbeat response, etc.
              if (message.data?.clientId) {
                console.log('WebSocket welcome message received');
              }
            }
          } catch (error) {
            console.error('Failed to parse WebSocket message:', error);
          }
        });

        this.ws.on('close', () => {
          console.log('WebSocket connection closed');
          this.emit('disconnected');
          this.stopHeartbeat();
          
          if (this.config.autoReconnect && !this.reconnectTimer) {
            this.scheduleReconnect();
          }
        });

        this.ws.on('error', (error) => {
          console.error('WebSocket error:', error);
          this.emit('error', error);
          
          // Only reject on initial connection, not on reconnection attempts
          if (!this.reconnectTimer) {
            reject(error);
          }
        });
        
        // Set a flag to prevent immediate reconnection on auth errors
        this.ws.on('unexpected-response', (_request, response) => {
          if (response.statusCode === 401) {
            console.error('Authentication failed. Please check your API token.');
            this.config.autoReconnect = false; // Disable auto-reconnect on auth failure
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    this.stopHeartbeat();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(async () => {
      console.log('Attempting to reconnect...');
      this.reconnectTimer = null;
      
      try {
        await this.connect();
        console.log('Reconnected successfully');
      } catch (error: any) {
        // Don't log full error stack for expected errors
        if (error.message?.includes('401')) {
          console.error('Reconnection failed: Authentication error. Auto-reconnect disabled.');
        } else {
          console.error('Reconnection failed:', error.message || error);
          // Schedule another reconnection attempt if not an auth error
          if (this.config.autoReconnect) {
            this.scheduleReconnect();
          }
        }
      }
    }, this.config.reconnectInterval);
  }

  /**
   * Get list of active terminals
   */
  async getTerminals(): Promise<TerminalInfo[]> {
    const response = await this.axios.get<TerminalInfo[]>('/api/terminals');
    return response.data;
  }

  /**
   * Get terminal details
   */
  async getTerminal(id: string): Promise<TerminalInfo> {
    const response = await this.axios.get<TerminalInfo>(`/api/terminals/${id}`);
    return response.data;
  }

  /**
   * Create a new terminal
   */
  async createTerminal(options: {
    profile?: string;
    name?: string;
    tabId?: string;
    paneId?: string;
    direction?: 'horizontal' | 'vertical';
  }): Promise<TerminalInfo> {
    const response = await this.axios.post<TerminalInfo>('/api/terminals', options);
    return response.data;
  }

  /**
   * Send input to terminal
   */
  async sendInput(terminalId: string, data: string): Promise<void> {
    await this.axios.post(`/api/terminals/${terminalId}/input`, { data });
  }

  /**
   * Execute a prompt (for AI CLIs)
   */
  async executePrompt(terminalId: string, prompt: string, cliType: string = 'claude'): Promise<any> {
    const response = await this.axios.post(`/api/terminals/${terminalId}/prompt`, {
      prompt,
      cliType
    });
    return response.data;
  }

  /**
   * Get terminal output
   */
  async getOutput(terminalId: string, lines: number = 100, offset: number = 0): Promise<{
    lines: string[];
    totalLines: number;
    offset: number;
    raw: string;
  }> {
    const response = await this.axios.get(`/api/terminals/${terminalId}/output`, {
      params: { lines, offset }
    });
    return response.data;
  }

  /**
   * Get event history
   */
  async getEventHistory(terminalId?: string, types?: string[], limit: number = 100): Promise<TerminalEvent[]> {
    const response = await this.axios.get<TerminalEvent[]>('/api/events/history', {
      params: {
        terminalId,
        types: types?.join(','),
        limit
      }
    });
    return response.data;
  }

  /**
   * Subscribe to terminal events
   */
  subscribeToTerminal(terminalId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    
    // Subscribe to all events for this terminal
    // Note: The event patterns should match what the EventBus publishes
    const patterns = [
      'output.data',  // Match all output events, filter by terminalId
      'input.data',   // Match all input events
      'process.exit', // Match process exits
      'terminal.created',
      'terminal.closed'
    ];
    
    this.ws.send(JSON.stringify({
      id: `subscribe-${terminalId}-${Date.now()}`,
      type: 'subscribe',
      payload: {
        patterns,
        filters: {
          terminalId
        }
      }
    }));
  }

  /**
   * Unsubscribe from terminal events
   */
  unsubscribeFromTerminal(_terminalId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    
    // Note: This would need the subscription ID from the subscribe response
    // For now, we'll just close the connection when done
    console.warn('Unsubscribe not fully implemented - would need subscription ID');
  }

  /**
   * Start sending heartbeat messages
   */
  private startHeartbeat(): void {
    this.stopHeartbeat(); // Clear any existing timer
    
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const heartbeatMessage = {
          id: `heartbeat-${Date.now()}`,
          type: 'heartbeat',
          payload: {
            timestamp: new Date().toISOString()
          }
        };
        
        this.ws.send(JSON.stringify(heartbeatMessage));
      }
    }, this.heartbeatInterval);
  }

  /**
   * Stop sending heartbeat messages
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}