import { PTYManager } from '../shell/PTYManager';
import { ShellProfileManager } from '../shell/ShellProfileManager';
import { EventEmitter } from 'events';

export interface HeadlessTerminal {
  id: string;
  processId: string;
  name: string;
  shellType: string;
  createdAt: Date;
  status: 'active' | 'inactive' | 'terminated';
  lastActivity?: Date;
}

/**
 * Manages terminal processes in headless mode
 * Provides lifecycle management, metadata tracking, and process registry
 */
export class HeadlessManager extends EventEmitter {
  private terminals: Map<string, HeadlessTerminal> = new Map();
  private ptyManager: PTYManager;
  private profileManager: ShellProfileManager;
  private processCounter: number = 0;
  private resettingTerminals: Set<string> = new Set(); // Track terminals being reset

  constructor(ptyManager: PTYManager, profileManager: ShellProfileManager) {
    super();
    this.ptyManager = ptyManager;
    this.profileManager = profileManager;
    
    // Set up event listeners for terminal lifecycle
    this.setupEventListeners();
  }

  /**
   * Create a new headless terminal with metadata
   */
  async createTerminal(
    shellType: string = 'cmd',
    name?: string,
    cwd?: string,
    env?: Record<string, string>
  ): Promise<HeadlessTerminal> {
    try {
      // Generate unique ID and name
      const terminalId = `headless-${Date.now()}-${this.processCounter++}`;
      const terminalName = name || `Terminal ${this.processCounter}`;

      // Resolve shell profile
      const defaultProfile = this.profileManager.getDefaultProfile();
      const profile = this.profileManager.getProfile(shellType) || defaultProfile;
      
      if (!profile) {
        throw new Error(`Shell profile not found: ${shellType}`);
      }

      // Create the terminal process
      const processId = this.ptyManager.spawn({
        shell: profile.executable,
        args: profile.args || [],
        cwd: cwd || process.cwd(),
        env: env || {}
      });

      // Create metadata entry
      const terminal: HeadlessTerminal = {
        id: terminalId,
        processId,
        name: terminalName,
        shellType,
        createdAt: new Date(),
        status: 'active',
        lastActivity: new Date()
      };

      // Store in registry
      this.terminals.set(terminalId, terminal);

      // Emit creation event
      this.emit('terminal:created', terminal);

      console.log(`Created headless terminal: ${terminalId} (PID: ${processId})`);
      return terminal;
    } catch (error) {
      console.error('Failed to create headless terminal:', error);
      throw error;
    }
  }

  /**
   * List all active terminals
   */
  listTerminals(): HeadlessTerminal[] {
    return Array.from(this.terminals.values()).filter(t => t.status !== 'terminated');
  }

  /**
   * Get terminal by ID
   */
  getTerminal(terminalId: string): HeadlessTerminal | undefined {
    return this.terminals.get(terminalId);
  }

  /**
   * Get terminal by process ID
   */
  getTerminalByProcessId(processId: string): HeadlessTerminal | undefined {
    return Array.from(this.terminals.values()).find(t => t.processId === processId);
  }

  /**
   * Update terminal activity timestamp
   */
  updateActivity(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      terminal.lastActivity = new Date();
    }
  }

  /**
   * Terminate a specific terminal
   */
  async terminateTerminal(terminalId: string): Promise<void> {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }

    try {
      // Kill the process
      this.ptyManager.kill(terminal.processId);
      
      // Update status
      terminal.status = 'terminated';
      
      // Remove from registry after a delay to allow cleanup
      setTimeout(() => {
        this.terminals.delete(terminalId);
      }, 1000);

      // Emit termination event
      this.emit('terminal:terminated', terminal);
      
      console.log(`Terminated headless terminal: ${terminalId}`);
    } catch (error) {
      console.error(`Failed to terminate terminal ${terminalId}:`, error);
      throw error;
    }
  }

  /**
   * Reset a terminal by killing the old process and creating a new one with the same configuration
   */
  async resetTerminal(terminalId: string): Promise<HeadlessTerminal> {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }

    // Mark terminal as resetting to prevent event listener from deleting it
    this.resettingTerminals.add(terminalId);

    try {
      // Get the shell profile for the current terminal
      const profile = this.profileManager.getProfile(terminal.shellType) || this.profileManager.getDefaultProfile();
      if (!profile) {
        throw new Error(`Shell profile not found: ${terminal.shellType}`);
      }

      // Kill the existing process
      this.ptyManager.kill(terminal.processId);

      // Wait for the process to fully terminate
      await new Promise(resolve => setTimeout(resolve, 150));

      // Create a new process with the same configuration
      const newProcessId = this.ptyManager.spawn({
        shell: profile.executable,
        args: profile.args || [],
        cwd: process.cwd(),
        env: {}
      });

      // Update the terminal with new process information
      terminal.processId = newProcessId;
      terminal.status = 'active';
      terminal.lastActivity = new Date();

      // Emit reset event
      this.emit('terminal:reset', terminal);

      console.log(`Reset headless terminal: ${terminalId} (New PID: ${newProcessId})`);
      return terminal;
    } catch (error) {
      console.error(`Failed to reset terminal ${terminalId}:`, error);
      throw error;
    } finally {
      // Remove from resetting set
      this.resettingTerminals.delete(terminalId);
    }
  }

  /**
   * Terminate all terminals
   */
  async terminateAll(): Promise<void> {
    const terminalIds = Array.from(this.terminals.keys());
    
    for (const id of terminalIds) {
      try {
        await this.terminateTerminal(id);
      } catch (error) {
        console.error(`Error terminating terminal ${id}:`, error);
      }
    }
  }

  /**
   * Set up event listeners for terminal lifecycle
   */
  private setupEventListeners(): void {
    // Listen for terminal exit events from PTYManager
    this.ptyManager.on('process-exit', (processId: string, exitCode: number) => {
      const terminal = this.getTerminalByProcessId(processId);
      if (terminal && !this.resettingTerminals.has(terminal.id)) {
        terminal.status = 'inactive';
        this.emit('terminal:exited', terminal, exitCode);
        
        // Remove from registry after a delay
        setTimeout(() => {
          this.terminals.delete(terminal.id);
        }, 5000);
      }
    });

    // Listen for terminal data events to update activity
    this.ptyManager.on('process-data', (processId: string, _data: string) => {
      const terminal = this.getTerminalByProcessId(processId);
      if (terminal) {
        this.updateActivity(terminal.id);
      }
    });
  }

  /**
   * Get statistics about headless terminals
   */
  getStatistics(): {
    total: number;
    active: number;
    inactive: number;
    terminated: number;
  } {
    const terminals = Array.from(this.terminals.values());
    
    return {
      total: terminals.length,
      active: terminals.filter(t => t.status === 'active').length,
      inactive: terminals.filter(t => t.status === 'inactive').length,
      terminated: terminals.filter(t => t.status === 'terminated').length
    };
  }

  /**
   * Clean up inactive terminals older than specified minutes
   */
  cleanupInactiveTerminals(inactiveMinutes: number = 30): number {
    const now = new Date();
    const cutoffTime = new Date(now.getTime() - inactiveMinutes * 60 * 1000);
    let cleaned = 0;

    for (const [id, terminal] of this.terminals.entries()) {
      if (terminal.status === 'inactive' && 
          terminal.lastActivity && 
          terminal.lastActivity < cutoffTime) {
        this.terminals.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`Cleaned up ${cleaned} inactive terminals`);
    }

    return cleaned;
  }
}