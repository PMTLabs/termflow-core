/**
 * Types for Auto-Terminal Agent Monitor
 */

export interface TerminalInfo {
  id: string;
  processId: string;
  name: string;
  profile: string;
  status: 'running' | 'exited';
  pid?: number;
  createdAt: string;
  tabId?: string;
  paneId?: string;
}

export interface TerminalEvent {
  id: string;
  timestamp: string;
  terminalId: string;
  processId: string;
  type: string;
  data: any;
}

export interface OutputEvent extends TerminalEvent {
  type: 'output.data';
  data: {
    content: string;
  };
}

export interface InputEvent extends TerminalEvent {
  type: 'input.data';
  data: {
    content: string;
  };
}

export interface ProcessExitEvent extends TerminalEvent {
  type: 'process.exit';
  data: {
    exitCode: number;
    signal?: string;
  };
}

export type AgentType = 'claude' | 'gemini' | 'chatgpt' | 'unknown';

export interface PromptSession {
  id: string;
  terminalId: string;
  agentType: AgentType;
  prompt: string;
  startTime: Date;
  endTime?: Date;
  duration?: number;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  response?: string;
}

export interface AgentDetectionPattern {
  name: AgentType;
  startPattern: RegExp;
  promptIndicator: RegExp;
  responseStartPattern: RegExp;
  responseEndPattern: RegExp;
}

export interface MonitorConfig {
  apiUrl: string;
  wsUrl: string;
  token: string;
  autoReconnect: boolean;
  reconnectInterval: number;
}