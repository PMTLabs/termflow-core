/**
 * Headless Auto-Terminal Client
 * Enhanced client specifically for headless terminal operations
 */

import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { TerminalInfo, TerminalEvent } from './types';
import { HeadlessConfig } from './headless-config';

export interface HeadlessTerminalInfo extends TerminalInfo {
  mode: 'headless';
  shellType: string;
  lastActivity?: string;
}

export interface HeadlessTerminalCreateOptions {
  profile?: string;
  name?: string;
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Client for interacting with Auto-Terminal in headless mode
 */
export class HeadlessAutoTerminalClient extends EventEmitter {
  private axios: AxiosInstance;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private config: HeadlessConfig;
  private isConnected: boolean = false;

  constructor(config: HeadlessConfig) {
    super();
    this.config = config;
    
    this.axios = axios.create({
      baseURL: config.apiUrl,
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    // Set up axios response interceptor for better error handling
    this.axios.interceptors.response.use(
      response => response,
      error => {
        console.error('API request failed:', error.message);
        return Promise.reject(error);
      }
    );
  }

  /**
   * Connect to headless Auto-Terminal WebSocket
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = new URL(this.config.wsUrl);
        wsUrl.searchParams.set('token', this.config.token);
        wsUrl.searchParams.set('mode', 'headless');
        
        this.ws = new WebSocket(wsUrl.toString(), {
          headers: {
            'Authorization': `Bearer ${this.config.token}`,
            'X-Client-Mode': 'headless'
          }
        });

        this.ws.on('open', () => {
          console.log('✅ Connected to Auto-Terminal headless WebSocket');
          this.isConnected = true;
          this.emit('connected');
          this.startHeartbeat();
          resolve();
        });

        this.ws.on('message', (data: string) => {
          try {
            const message = JSON.parse(data);
            
            if (message.type === 'event' && message.event) {
              const event = message.event as TerminalEvent;
              this.emit('event', event);
              this.emit(event.type, event);
              
              // Emit terminal-specific events for headless terminals
              if (event.terminalId && event.type) {
                this.emit(`terminal.${event.terminalId}.${event.type}`, event.data);
              }
            }
          } catch (error) {
            console.error('Failed to parse WebSocket message:', error);
          }
        });

        this.ws.on('close', () => {
          console.log('📡 WebSocket connection closed');
          this.isConnected = false;
          this.emit('disconnected');
          this.stopHeartbeat();
          
          if (this.config.autoReconnect && !this.reconnectTimer) {
            this.scheduleReconnect();
          }
        });

        this.ws.on('error', (error) => {
          console.error('WebSocket error:', error);
          this.isConnected = false;
          this.emit('error', error);
          
          if (!this.reconnectTimer) {
            reject(error);
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
    
    this.isConnected = false;
  }

  /**
   * Create a new headless terminal
   */
  async createHeadlessTerminal(options: HeadlessTerminalCreateOptions = {}): Promise<HeadlessTerminalInfo> {
    const createOptions = {
      profile: options.profile || this.config.terminalConfig.defaultShell,
      name: options.name || `Agent Terminal ${Date.now()}`,
      cwd: options.cwd || this.config.terminalConfig.workingDirectory,
      env: {
        ...this.config.terminalConfig.environment,
        ...options.env
      },
      mode: 'headless'
    };

    try {
      const response = await this.axios.post<HeadlessTerminalInfo>('/api/terminals', createOptions);
      const terminal = {
        ...response.data,
        mode: 'headless' as const
      };
      
      console.log(`🖥️ Created headless terminal: ${terminal.id} (${terminal.profile})`);
      this.emit('terminal:created', terminal);
      
      return terminal;
    } catch (error: any) {
      console.error('Failed to create headless terminal:', error.message);
      throw new Error(`Failed to create headless terminal: ${error.message}`);
    }
  }

  /**
   * Get list of headless terminals
   */
  async getHeadlessTerminals(): Promise<HeadlessTerminalInfo[]> {
    try {
      const response = await this.axios.get<HeadlessTerminalInfo[]>('/api/terminals?mode=headless');
      return response.data.map(terminal => ({
        ...terminal,
        mode: 'headless' as const
      }));
    } catch (error: any) {
      console.error('Failed to get headless terminals:', error.message);
      throw new Error(`Failed to get headless terminals: ${error.message}`);
    }
  }

  /**
   * Get headless terminal details
   */
  async getHeadlessTerminal(id: string): Promise<HeadlessTerminalInfo> {
    try {
      const response = await this.axios.get<HeadlessTerminalInfo>(`/api/terminals/${id}`);
      return {
        ...response.data,
        mode: 'headless' as const
      };
    } catch (error: any) {
      console.error(`Failed to get headless terminal ${id}:`, error.message);
      throw new Error(`Failed to get headless terminal: ${error.message}`);
    }
  }

  /**
   * Send input to headless terminal
   */
  async sendInput(terminalId: string, data: string): Promise<void> {
    try {
      await this.axios.post(`/api/terminals/${terminalId}/input`, { data });
    } catch (error: any) {
      console.error(`Failed to send input to terminal ${terminalId}:`, error.message);
      throw new Error(`Failed to send input: ${error.message}`);
    }
  }

  /**
   * Execute a prompt in headless terminal (for AI CLIs)
   */
  async executePrompt(terminalId: string, prompt: string, cliType: string = 'claude'): Promise<any> {
    try {
      const response = await this.axios.post(`/api/terminals/${terminalId}/prompt`, {
        prompt,
        cliType
      });
      
      console.log(`📤 Executed prompt in headless terminal ${terminalId} (${cliType})`);
      return response.data;
    } catch (error: any) {
      console.error(`Failed to execute prompt in terminal ${terminalId}:`, error.message);
      throw new Error(`Failed to execute prompt: ${error.message}`);
    }
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
    try {
      const response = await this.axios.get(`/api/terminals/${terminalId}/output`, {
        params: { lines, offset }
      });
      return response.data;
    } catch (error: any) {
      console.error(`Failed to get output from terminal ${terminalId}:`, error.message);
      throw new Error(`Failed to get output: ${error.message}`);
    }
  }

  /**
   * Terminate a headless terminal
   */
  async terminateTerminal(terminalId: string): Promise<void> {
    try {
      await this.axios.delete(`/api/terminals/${terminalId}`);
      console.log(`🗑️ Terminated headless terminal: ${terminalId}`);
      this.emit('terminal:terminated', terminalId);
    } catch (error: any) {
      console.error(`Failed to terminate terminal ${terminalId}:`, error.message);
      throw new Error(`Failed to terminate terminal: ${error.message}`);
    }
  }

  /**
   * Subscribe to terminal events
   */
  subscribeToTerminal(terminalId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    
    const patterns = [
      'output.data',
      'input.data',
      'process.exit',
      'terminal.created',
      'terminal.closed'
    ];
    
    this.ws.send(JSON.stringify({
      id: `subscribe-headless-${terminalId}-${Date.now()}`,
      type: 'subscribe',
      payload: {
        patterns,
        filters: {
          terminalId,
          mode: 'headless'
        }
      }
    }));
    
    console.log(`📡 Subscribed to headless terminal events: ${terminalId}`);
  }

  /**
   * Check if Auto-Terminal is running in headless mode
   */
  async checkHeadlessMode(): Promise<boolean> {
    try {
      const response = await this.axios.get('/api/health');
      return response.data.mode === 'headless';
    } catch (error) {
      console.warn('Could not verify headless mode - assuming headless');
      return true;
    }
  }

  /**
   * Get connection status
   */
  isWebSocketConnected(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(async () => {
      console.log('🔄 Attempting headless WebSocket reconnection...');
      this.reconnectTimer = null;
      
      try {
        await this.connect();
        console.log('✅ Headless WebSocket reconnected successfully');
      } catch (error: any) {
        if (error.message?.includes('401')) {
          console.error('❌ Reconnection failed: Authentication error');
        } else {
          console.error('❌ Reconnection failed:', error.message);
          if (this.config.autoReconnect) {
            this.scheduleReconnect();
          }
        }
      }
    }, this.config.reconnectInterval);
  }

  /**
   * Start heartbeat
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          id: `heartbeat-headless-${Date.now()}`,
          type: 'heartbeat',
          payload: {
            timestamp: new Date().toISOString(),
            mode: 'headless'
          }
        }));
      }
    }, 30000);
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}