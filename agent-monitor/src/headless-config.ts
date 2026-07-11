/**
 * Headless Mode Configuration for Agent Monitor
 * Configures agent-monitor to use Auto-Terminal in headless mode
 */

export interface HeadlessConfig {
  apiUrl: string;
  wsUrl: string;
  token: string;
  mode: 'headless' | 'ui';
  autoReconnect: boolean;
  reconnectInterval: number;
  terminalConfig: {
    defaultShell: string;
    workingDirectory?: string;
    environment?: Record<string, string>;
  };
}

/**
 * Default headless configuration
 */
export const DEFAULT_HEADLESS_CONFIG: HeadlessConfig = {
  apiUrl: 'http://localhost:3001',
  wsUrl: 'ws://localhost:9876',
  token: process.env.AUTO_TERMINAL_TOKEN || 'dev-token',
  mode: 'headless',
  autoReconnect: true,
  reconnectInterval: 5000,
  terminalConfig: {
    defaultShell: 'powershell',
    workingDirectory: process.cwd(),
    environment: {
      FORCE_COLOR: '1',
      TERM: 'xterm-256color'
    }
  }
};

/**
 * Get headless configuration from environment variables
 */
export function getHeadlessConfig(): HeadlessConfig {
  return {
    ...DEFAULT_HEADLESS_CONFIG,
    apiUrl: process.env.AUTO_TERMINAL_API_URL || DEFAULT_HEADLESS_CONFIG.apiUrl,
    wsUrl: process.env.AUTO_TERMINAL_WS_URL || DEFAULT_HEADLESS_CONFIG.wsUrl,
    token: process.env.AUTO_TERMINAL_TOKEN || DEFAULT_HEADLESS_CONFIG.token,
    mode: (process.env.AUTO_TERMINAL_MODE as 'headless' | 'ui') || 'headless',
    terminalConfig: {
      ...DEFAULT_HEADLESS_CONFIG.terminalConfig,
      defaultShell: process.env.DEFAULT_SHELL || DEFAULT_HEADLESS_CONFIG.terminalConfig.defaultShell,
      workingDirectory: process.env.PROJECT_FOLDER || DEFAULT_HEADLESS_CONFIG.terminalConfig.workingDirectory
    }
  };
}

/**
 * Validate headless configuration
 */
export function validateHeadlessConfig(config: HeadlessConfig): void {
  if (!config.apiUrl) {
    throw new Error('API URL is required for headless mode');
  }
  
  if (!config.wsUrl) {
    throw new Error('WebSocket URL is required for headless mode');
  }
  
  if (!config.token) {
    console.warn('No authentication token provided - using development mode');
  }
  
  try {
    new URL(config.apiUrl);
  } catch {
    throw new Error(`Invalid API URL: ${config.apiUrl}`);
  }
  
  try {
    new URL(config.wsUrl);
  } catch {
    throw new Error(`Invalid WebSocket URL: ${config.wsUrl}`);
  }
}