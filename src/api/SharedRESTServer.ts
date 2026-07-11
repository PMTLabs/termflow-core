import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PTYManager } from '../shell/PTYManager';

interface RegistryTerminal {
  id: string;
  processId: string;
  pid?: number;
  shell?: string;
  createdAt: string;
  cols: number;
  rows: number;
}

interface TerminalRegistry {
  version: number;
  lastUpdated: string;
  terminals: RegistryTerminal[];
}

/**
 * SharedPTYManager that reads from the Electron app's terminal registry
 */
class SharedPTYManager extends PTYManager {
  private registryPath: string;
  private commandDir: string;
  private registryCache: TerminalRegistry | null = null;
  private lastRegistryCheck: number = 0;

  constructor() {
    super();
    
    // Find the terminal registry file
    const userData = this.findUserDataPath();
    this.registryPath = path.join(userData, 'terminal-registry.json');
    this.commandDir = path.join(userData, 'terminal-commands');
    
    // Create command directory if it doesn't exist
    if (!fs.existsSync(this.commandDir)) {
      fs.mkdirSync(this.commandDir, { recursive: true });
    }
    
    console.log('SharedPTYManager initialized');
    console.log('Registry path:', this.registryPath);
    console.log('Command directory:', this.commandDir);
  }

  private findUserDataPath(): string {
    // Try common locations for Auto Terminal user data
    const appName = 'auto-terminal';
    const possiblePaths = [
      path.join(os.homedir(), 'AppData', 'Roaming', appName),
      path.join(os.homedir(), '.config', appName),
      path.join(os.homedir(), 'Library', 'Application Support', appName)
    ];
    
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
    
    // Default to Windows path
    return possiblePaths[0];
  }

  private loadRegistry(): TerminalRegistry | null {
    // Cache registry for 1 second to avoid excessive file reads
    const now = Date.now();
    if (this.registryCache && now - this.lastRegistryCheck < 1000) {
      return this.registryCache;
    }
    
    try {
      if (fs.existsSync(this.registryPath)) {
        const data = fs.readFileSync(this.registryPath, 'utf8');
        this.registryCache = JSON.parse(data);
        this.lastRegistryCheck = now;
        return this.registryCache;
      }
    } catch (error) {
      console.error('Error loading terminal registry:', error);
    }
    
    return null;
  }

  getActiveProcesses(): any[] {
    const registry = this.loadRegistry();
    if (!registry) {
      return [];
    }
    
    return registry.terminals.map(t => ({
      id: t.processId,
      pid: t.pid,
      shell: t.shell,
      startTime: new Date(t.createdAt),
      isAlive: true
    }));
  }

  getProcess(processId: string): any {
    const registry = this.loadRegistry();
    if (!registry) {
      return null;
    }
    
    const terminal = registry.terminals.find(t => t.processId === processId);
    if (!terminal) {
      return null;
    }
    
    return {
      id: terminal.processId,
      pid: terminal.pid,
      shell: terminal.shell,
      startTime: new Date(terminal.createdAt),
      isAlive: true
    };
  }

  write(processId: string, data: string): void {
    // Write command to a file that the Electron app monitors
    const commandFile = path.join(this.commandDir, `${processId}-${Date.now()}.cmd`);
    
    try {
      fs.writeFileSync(commandFile, JSON.stringify({
        type: 'write',
        processId,
        data,
        timestamp: new Date().toISOString()
      }));
      
      console.log(`Wrote command for terminal ${processId}`);
    } catch (error) {
      console.error(`Error writing command for terminal ${processId}:`, error);
      throw error;
    }
  }

  resize(processId: string, cols: number, rows: number): void {
    const commandFile = path.join(this.commandDir, `${processId}-${Date.now()}.cmd`);
    
    try {
      fs.writeFileSync(commandFile, JSON.stringify({
        type: 'resize',
        processId,
        cols,
        rows,
        timestamp: new Date().toISOString()
      }));
      
      console.log(`Resized terminal ${processId} to ${cols}x${rows}`);
    } catch (error) {
      console.error(`Error resizing terminal ${processId}:`, error);
      throw error;
    }
  }

  kill(processId: string, signal?: string): void {
    const commandFile = path.join(this.commandDir, `${processId}-${Date.now()}.cmd`);
    
    try {
      fs.writeFileSync(commandFile, JSON.stringify({
        type: 'kill',
        processId,
        signal,
        timestamp: new Date().toISOString()
      }));
      
      console.log(`Requested kill for terminal ${processId}`);
    } catch (error) {
      console.error(`Error killing terminal ${processId}:`, error);
      throw error;
    }
  }

  spawn(_options: any): string {
    // Cannot create terminals from the shared API
    throw new Error('Terminal creation is not supported via the shared API. Please create terminals using the Auto Terminal application.');
  }
}

export { SharedPTYManager };