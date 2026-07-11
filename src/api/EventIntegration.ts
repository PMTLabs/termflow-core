import { PTYManager, ProcessInfo } from '../shell/PTYManager';
import { eventBus } from './EventBus';
import ProcessMonitor from './ProcessMonitor';

/**
 * Integrates PTYManager with EventBus for automatic event publishing
 */
export class EventIntegration {
  private ptyManager: PTYManager;
  private processMonitor: ProcessMonitor;
  private terminalProcessMap: Map<string, string>; // terminalId -> processId

  constructor(ptyManager: PTYManager) {
    this.ptyManager = ptyManager;
    this.terminalProcessMap = new Map();
    
    // Initialize process monitor with configuration
    this.processMonitor = new ProcessMonitor(ptyManager, {
      metricsInterval: 5000,
      inactivityTimeout: 30000,
      enableCpuMonitoring: true,
      enableMemoryMonitoring: true,
      enableIOMonitoring: true
    });
    
    this.setupEventListeners();
  }

  /**
   * Map a terminal ID to a process ID
   */
  mapTerminalToProcess(terminalId: string, processId: string): void {
    this.terminalProcessMap.set(terminalId, processId);
    // Also map in process monitor
    this.processMonitor.mapTerminalToProcess(terminalId, processId);
  }

  /**
   * Get terminal ID from process ID
   */
  getTerminalId(processId: string): string | undefined {
    for (const [terminalId, pid] of this.terminalProcessMap) {
      if (pid === processId) return terminalId;
    }
    return undefined;
  }

  private setupEventListeners(): void {
    // Process lifecycle events
    this.ptyManager.on('process-spawned', (processId: string, info: ProcessInfo) => {
      const terminalId = this.getTerminalId(processId) || processId;
      eventBus.publish({
        type: 'process.start',
        timestamp: Date.now(),
        terminalId,
        processId,
        data: {
          command: info.shell,
          pid: info.pid,
        },
      });

      // Simulate ready event after a short delay
      setTimeout(() => {
        eventBus.publish({
          type: 'process.ready',
          timestamp: Date.now(),
          terminalId,
          processId,
          data: {},
        });
      }, 100);
    });

    this.ptyManager.on('process-exit', (processId: string, exitCode: number) => {
      const terminalId = this.getTerminalId(processId) || processId;
      eventBus.publish({
        type: 'process.exit',
        timestamp: Date.now(),
        terminalId,
        processId,
        data: {
          exitCode,
        },
      });
      
      // Clean up mapping
      this.terminalProcessMap.delete(terminalId);
    });

    this.ptyManager.on('process-error', (processId: string, error: Error) => {
      const terminalId = this.getTerminalId(processId) || processId;
      eventBus.publish({
        type: 'process.error',
        timestamp: Date.now(),
        terminalId,
        processId,
        data: {
          error: error.message,
          stack: error.stack,
        },
      });
    });

    // Data events
    this.ptyManager.on('process-data', (processId: string, data: string) => {
      const terminalId = this.getTerminalId(processId) || processId;
      eventBus.publish({
        type: 'output.data',
        timestamp: Date.now(),
        terminalId,
        processId,
        data: {
          content: data,
          bytesWritten: Buffer.byteLength(data, 'utf8'),
        },
      });
    });
  }

  /**
   * Publish input event when data is sent to terminal
   */
  publishInputEvent(terminalId: string, processId: string, data: string): void {
    eventBus.publish({
      type: 'input.data',
      timestamp: Date.now(),
      terminalId,
      processId,
      data: {
        content: data,
        length: data.length,
      },
    });
  }

  /**
   * Publish state change event
   */
  publishStateChange(terminalId: string, processId: string, state: 'idle' | 'busy'): void {
    eventBus.publish({
      type: 'state.change',
      timestamp: Date.now(),
      terminalId,
      processId,
      data: {
        state,
      },
    });
  }

  /**
   * Get event statistics for a terminal
   */
  getTerminalEventStats(terminalId: string): Record<string, number> {
    const events = eventBus.getEventHistory({ terminalId });
    const stats: Record<string, number> = {};
    
    for (const event of events) {
      stats[event.type] = (stats[event.type] || 0) + 1;
    }
    
    return stats;
  }

  /**
   * Get process monitor instance
   */
  getProcessMonitor(): ProcessMonitor {
    return this.processMonitor;
  }

  /**
   * Get process state by terminal ID
   */
  getProcessState(terminalId: string) {
    return this.processMonitor.getProcessByTerminal(terminalId);
  }

  /**
   * Get all active processes
   */
  getActiveProcesses() {
    return this.processMonitor.getActiveProcesses();
  }

  /**
   * Get process metrics for a specific process
   */
  async getProcessMetrics(processId: string) {
    return this.processMonitor.collectProcessMetrics(processId);
  }

  /**
   * Get system-wide metrics
   */
  getSystemMetrics() {
    return this.processMonitor.getSystemMetrics();
  }

  /**
   * Stop event integration and monitoring
   */
  stop(): void {
    this.processMonitor.stop();
    this.terminalProcessMap.clear();
  }
}

// Export singleton instance when PTYManager is available
let eventIntegration: EventIntegration | null = null;

export function initializeEventIntegration(ptyManager: PTYManager): EventIntegration {
  if (!eventIntegration) {
    eventIntegration = new EventIntegration(ptyManager);
  }
  return eventIntegration;
}

export function getEventIntegration(): EventIntegration | null {
  return eventIntegration;
}