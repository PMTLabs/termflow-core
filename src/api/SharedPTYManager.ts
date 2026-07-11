import { EventEmitter } from 'events';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';

interface SharedTerminal {
  id: string;
  pid?: number;
  shell?: string;
  createdAt?: string;
}

/**
 * SharedPTYManager communicates with the Electron app's PTY manager
 * via IPC or shared memory/files
 */
export class SharedPTYManager extends EventEmitter {
  private terminals: Map<string, SharedTerminal> = new Map();
  private ipcClient: net.Socket | null = null;
  private stateFile: string;

  constructor() {
    super();
    
    // Use a shared state file to communicate between processes
    const appData = process.env.APPDATA || process.env.HOME;
    this.stateFile = path.join(appData!, 'auto-terminal', 'shared-terminals.json');
    
    // Start monitoring the shared state
    this.startStateMonitoring();
  }

  private startStateMonitoring(): void {
    // Initial load
    this.loadSharedState();
    
    // Watch for changes
    const dir = path.dirname(this.stateFile);
    if (fs.existsSync(dir)) {
      fs.watchFile(this.stateFile, { interval: 1000 }, () => {
        this.loadSharedState();
      });
    }
  }

  private loadSharedState(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = fs.readFileSync(this.stateFile, 'utf8');
        const state = JSON.parse(data);
        
        // Update our terminals map
        this.terminals.clear();
        for (const terminal of state.terminals || []) {
          this.terminals.set(terminal.id, terminal);
        }
        
        console.log(`Loaded ${this.terminals.size} terminals from shared state`);
      }
    } catch (error) {
      console.error('Error loading shared state:', error);
    }
  }

  private saveSharedState(): void {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      const state = {
        terminals: Array.from(this.terminals.values()),
        lastUpdated: new Date().toISOString()
      };
      
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error('Error saving shared state:', error);
    }
  }

  // Implement PTYManager interface methods
  spawn(_options: any): string {
    // In shared mode, we can't create terminals directly
    // Return a placeholder or throw an error
    throw new Error('Cannot create terminals via shared API. Please create terminals in the Auto Terminal app UI.');
  }

  write(processId: string, data: string): void {
    // Write to a command file that the Electron app monitors
    const commandFile = path.join(
      path.dirname(this.stateFile),
      `command-${processId}.txt`
    );
    
    try {
      fs.appendFileSync(commandFile, data);
      console.log(`Wrote ${data.length} bytes to terminal ${processId}`);
    } catch (error) {
      console.error(`Error writing to terminal ${processId}:`, error);
    }
  }

  resize(processId: string, cols: number, rows: number): void {
    // Write resize command to shared state
    const resizeFile = path.join(
      path.dirname(this.stateFile),
      `resize-${processId}.json`
    );
    
    try {
      fs.writeFileSync(resizeFile, JSON.stringify({ cols, rows }));
      console.log(`Resized terminal ${processId} to ${cols}x${rows}`);
    } catch (error) {
      console.error(`Error resizing terminal ${processId}:`, error);
    }
  }

  kill(processId: string): void {
    // Write kill command to shared state
    const killFile = path.join(
      path.dirname(this.stateFile),
      `kill-${processId}.txt`
    );
    
    try {
      fs.writeFileSync(killFile, 'kill');
      this.terminals.delete(processId);
      this.saveSharedState();
      console.log(`Requested kill for terminal ${processId}`);
    } catch (error) {
      console.error(`Error killing terminal ${processId}:`, error);
    }
  }

  getProcess(processId: string): any {
    const terminal = this.terminals.get(processId);
    if (!terminal) return null;
    
    return {
      id: terminal.id,
      pid: terminal.pid,
      shell: terminal.shell,
      createdAt: terminal.createdAt
    };
  }

  getActiveProcesses(): any[] {
    return Array.from(this.terminals.values()).map(terminal => ({
      id: terminal.id,
      pid: terminal.pid,
      shell: terminal.shell,
      createdAt: terminal.createdAt
    }));
  }

  dispose(): void {
    if (this.ipcClient) {
      this.ipcClient.destroy();
      this.ipcClient = null;
    }
    
    fs.unwatchFile(this.stateFile);
  }
}