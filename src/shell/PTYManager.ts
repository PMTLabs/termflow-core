import { PtyProcess, IPtyProcessOptions } from './pty-wrapper';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

export interface SpawnOptions extends IPtyProcessOptions {
  shell?: string;
  args?: string[];
  profileId?: string;
}

export interface ProcessInfo {
  id: string;
  pid: number;
  shell: string;
  startTime: Date;
  isAlive: boolean;
  cols?: number;
  rows?: number;
  cwd?: string;
  profileId?: string;
}

export interface PTYManagerEvents {
  'process-spawned': (processId: string, info: ProcessInfo) => void;
  'process-data': (processId: string, data: string) => void;
  'process-exit': (processId: string, exitCode: number) => void;
  'process-error': (processId: string, error: Error) => void;
}

export declare interface PTYManager {
  on<K extends keyof PTYManagerEvents>(
    event: K,
    listener: PTYManagerEvents[K]
  ): this;
  emit<K extends keyof PTYManagerEvents>(
    event: K,
    ...args: Parameters<PTYManagerEvents[K]>
  ): boolean;
}

export class PTYManager extends EventEmitter {
  private processes: Map<string, PtyProcess>;
  private processInfo: Map<string, ProcessInfo>;

  constructor() {
    super();
    this.processes = new Map();
    this.processInfo = new Map();
  }

  /**
   * Spawn a new shell process
   * @returns processId
   */
  spawn(options: SpawnOptions): string {
    const processId = uuidv4();
    
    try {
      // Use provided shell or default
      const shell = options.shell || this.getDefaultShell();
      const args = options.args || [];
      
      console.log(`Spawning terminal with shell: ${shell}, args:`, args);

      // Create PTY process
      const ptyOptions: IPtyProcessOptions = {
        name: options.name || 'xterm-256color',
        cols: options.cols || 80,
        rows: options.rows || 24,
        cwd: options.cwd || process.cwd(),
        env: options.env || {},
      };
      
      // Don't set encoding on Windows - it's handled differently
      if (process.platform !== 'win32') {
        ptyOptions.encoding = options.encoding || 'utf8';
      }
      
      console.log(`PTYManager: Spawning PTY with options:`, {
        shell,
        args,
        name: ptyOptions.name,
        cols: ptyOptions.cols,
        rows: ptyOptions.rows,
        cwd: ptyOptions.cwd
      });
      
      const ptyProcess = new PtyProcess(shell, args, ptyOptions);

      // Store process
      this.processes.set(processId, ptyProcess);
      
      const info: ProcessInfo = {
        id: processId,
        pid: ptyProcess.pid,
        shell,
        startTime: new Date(),
        isAlive: true,
        cols: ptyOptions.cols,
        rows: ptyOptions.rows,
        cwd: ptyOptions.cwd as string,
        profileId: options.profileId
      };
      this.processInfo.set(processId, info);

      // Set up event handlers
      ptyProcess.onData((data) => {
        console.log(`PTYManager: Received data from process ${processId}:`, Date.now());
        this.emit('process-data', processId, data);
      });

      ptyProcess.onExit(({ exitCode }) => {
        this.handleProcessExit(processId, exitCode);
      });

      // Emit spawn event with process info
      this.emit('process-spawned', processId, info);

      return processId;
    } catch (error) {
      this.emit('process-error', processId, error as Error);
      throw error;
    }
  }

  /**
   * Write data to a process
   */
  write(processId: string, data: string): void {
    const process = this.processes.get(processId);
    if (!process) {
      throw new Error(`Process ${processId} not found`);
    }
    process.write(data);
  }

  /**
   * Resize a terminal
   */
  resize(processId: string, cols: number, rows: number): void {
    const process = this.processes.get(processId);
    if (!process) {
      throw new Error(`Process ${processId} not found`);
    }
    process.resize(cols, rows);
  }

  /**
   * Kill a process
   */
  kill(processId: string, signal?: string): void {
    const ptyProcess = this.processes.get(processId);
    if (!ptyProcess) {
      throw new Error(`Process ${processId} not found`);
    }
    ptyProcess.kill(signal);
  }

  /**
   * Get process by ID
   */
  getProcess(processId: string): PtyProcess | undefined {
    return this.processes.get(processId);
  }

  /**
   * Check if a process exists and is accessible
   */
  hasProcess(processId: string): boolean {
    return this.processes.has(processId) || this.processInfo.has(processId);
  }

  /**
   * List all processes
   */
  listProcesses(): ProcessInfo[] {
    return Array.from(this.processInfo.values());
  }

  /**
   * Get active process count
   */
  getActiveProcessCount(): number {
    return Array.from(this.processInfo.values())
      .filter(info => info.isAlive).length;
  }

  /**
   * Get all active processes
   */
  getActiveProcesses(): ProcessInfo[] {
    return Array.from(this.processInfo.values())
      .filter(info => info.isAlive);
  }

  /**
   * Clean up a specific process
   */
  private cleanupProcess(processId: string): void {
    console.log(`PTYManager: cleanupProcess called for ${processId}`);
    this.processes.delete(processId);
    const info = this.processInfo.get(processId);
    if (info) {
      console.log(`PTYManager: Setting isAlive=false for process ${processId}`);
      info.isAlive = false;
    } else {
      console.log(`PTYManager: WARNING - No process info found for ${processId}`);
    }
    console.log(`PTYManager: Current active processes: ${this.getActiveProcesses().map(p => p.id).join(', ')}`);
  }

  /**
   * Handle process exit
   */
  private handleProcessExit(processId: string, exitCode: number): void {
    this.cleanupProcess(processId);
    this.emit('process-exit', processId, exitCode);
  }

  /**
   * Get default shell for current platform
   */
  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      // Use full path to cmd.exe on Windows
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      return process.env.COMSPEC || `${systemRoot}\\System32\\cmd.exe`;
    }
    return process.env.SHELL || '/bin/bash';
  }

  /**
   * Gracefully close a process
   */
  async close(processId: string): Promise<void> {
    console.log(`PTYManager: close called for process ${processId}`);
    const ptyProcess = this.processes.get(processId);
    if (!ptyProcess) {
      console.log(`PTYManager: Process ${processId} not found - already closed`);
      return; // Already closed
    }

    console.log(`PTYManager: Found process ${processId}, attempting to close`);
    try {
      // On Windows, be more aggressive to prevent ConPTY console list issues
      if (process.platform === 'win32') {
        // Skip graceful shutdown on Windows and kill immediately
        console.log(`PTYManager: Killing process ${processId} (Windows)`);
        ptyProcess.kill();
        // Minimal wait to allow process termination
        await new Promise(resolve => setTimeout(resolve, 50));
      } else {
        // Unix systems: try graceful shutdown first
        if (ptyProcess.pid) {
          ptyProcess.write('\x03'); // Send Ctrl+C
          
          // Wait a bit for graceful exit
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // If still alive, kill it
          const info = this.processInfo.get(processId);
          if (info && info.isAlive) {
            ptyProcess.kill('SIGTERM');
            
            // Final fallback
            await new Promise(resolve => setTimeout(resolve, 200));
            if (info.isAlive) {
              ptyProcess.kill('SIGKILL');
            }
          }
        }
      }
    } catch (error) {
      // Ignore errors during cleanup - process might already be dead
      console.warn(`Warning during process cleanup ${processId}:`, (error as Error).message);
    } finally {
      console.log(`PTYManager: Finally block - calling cleanupProcess for ${processId}`);
      this.cleanupProcess(processId);
      console.log(`PTYManager: Close completed for process ${processId}`);
    }
  }

  /**
   * Dispose all processes gracefully
   */
  async dispose(): Promise<void> {
    console.log(`PTYManager: Disposing ${this.processes.size} processes...`);
    
    // On Windows, disable console list before cleanup
    if (process.platform === 'win32') {
      process.env.CONPTY_DISABLE_CONSOLE_LIST = 'true';
      process.env.NODE_PTY_DISABLE_CONSOLE_LIST = 'true';
    }
    
    // On Windows, kill all processes immediately without grace period
    if (process.platform === 'win32') {
      for (const [processId, ptyProcess] of this.processes) {
        try {
          ptyProcess.kill();
          this.cleanupProcess(processId);
        } catch (error) {
          // Ignore errors - process might already be dead
        }
      }
    } else {
      // Unix: graceful shutdown
      const closePromises: Promise<void>[] = [];
      
      for (const [processId] of this.processes) {
        closePromises.push(this.close(processId));
      }
      
      // Wait for all processes to close gracefully
      try {
        await Promise.allSettled(closePromises);
      } catch (error) {
        console.warn('Some processes did not close gracefully:', error);
      }
    }
    
    this.processes.clear();
    this.processInfo.clear();
    this.removeAllListeners();
    
    console.log('PTYManager: All processes disposed');
  }
}