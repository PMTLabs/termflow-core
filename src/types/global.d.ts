interface TerminalAPI {
  // Shell management
  createTerminal: (profile?: string) => Promise<string>;
  closeTerminal: (id: string) => Promise<void>;
  writeToTerminal: (id: string, data: string) => Promise<void>;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>;
  
  // Event listeners
  onTerminalData: (callback: (id: string, data: string) => void) => void;
  onTerminalExit: (callback: (id: string, code: number) => void) => void;
  
  // System info
  getShellProfiles: () => Promise<any[]>;
  getSystemInfo: () => Promise<any>;
}

declare global {
  interface Window {
    terminalAPI: TerminalAPI;
  }
}

export {};