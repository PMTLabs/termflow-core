export interface Terminal {
  id: string;
  processId: string;
  name: string;
  profile: string;
  status: 'running' | 'exited' | 'inactive' | 'resetting' | 'error';
  pid?: number;
  createdAt: string;
  mode?: 'headless' | 'ui';
}

export interface TerminalOutput {
  terminalId: string;
  data: string;
  timestamp: Date;
}

export interface TerminalInput {
  terminalId: string;
  data: string;
}

export interface WebSocketMessage {
  type: 'output' | 'connected' | 'disconnected' | 'error';
  terminalId?: string;
  data?: string;
  error?: string;
}

// Re-export recording and search types
export * from './recording';
export * from './search';
