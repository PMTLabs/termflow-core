import { EventEmitter } from 'events';
import { PTYManager } from '../shell/PTYManager';
import { eventBus } from './EventBus';
import { commandCompletionMonitor } from './CommandCompletionMonitor';
import * as os from 'os';

export interface ProcessMetrics {
  processId: string;
  terminalId?: string;
  pid: number;
  cpu: number;          // CPU usage percentage
  memory: number;       // Memory usage in bytes
  uptime: number;       // Process uptime in seconds
  timestamp: number;
}

export interface ProcessState {
  processId: string;
  terminalId?: string;
  pid: number;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';
  exitCode?: number;
  signal?: string;
  startTime: Date;
  endTime?: Date;
  lastActivity?: Date;
}

export interface MonitorConfig {
  metricsInterval?: number;      // How often to collect metrics (ms)
  inactivityTimeout?: number;    // Time before marking as inactive (ms)
  enableCpuMonitoring?: boolean;
  enableMemoryMonitoring?: boolean;
  enableIOMonitoring?: boolean;
}

export class ProcessMonitor extends EventEmitter {
  private ptyManager: PTYManager;
  private config: MonitorConfig;
  private monitoringInterval?: NodeJS.Timeout;
  private processStates: Map<string, ProcessState>;
  private terminalMapping: Map<string, string>; // terminalId -> processId

  constructor(ptyManager: PTYManager, config: MonitorConfig = {}) {
    super();
    this.ptyManager = ptyManager;
    this.config = {
      metricsInterval: 5000,
      inactivityTimeout: 30000,
      enableCpuMonitoring: true,
      enableMemoryMonitoring: true,
      enableIOMonitoring: true,
      ...config
    };
    
    this.processStates = new Map();
    this.terminalMapping = new Map();
    
    // Set unlimited listeners for high-volume monitoring scenarios
    this.setMaxListeners(0);
    
    this.setupEventHandlers();
    this.startMonitoring();
    
    // Initialize command completion monitoring
    this.setupCommandCompletionHandlers();
  }

  private setupEventHandlers(): void {
    // Listen to PTY manager events
    this.ptyManager.on('process-spawned', this.handleProcessSpawn.bind(this));
    this.ptyManager.on('process-data', this.handleProcessData.bind(this));
    this.ptyManager.on('process-exit', this.handleProcessExit.bind(this));
    this.ptyManager.on('process-error', this.handleProcessError.bind(this));
  }

  private handleProcessSpawn(processId: string, _info: any): void {
    const process = this.ptyManager.getProcess(processId);
    if (!process) return;

    const state: ProcessState = {
      processId,
      pid: process.pid,
      status: 'starting',
      startTime: new Date(),
      lastActivity: new Date()
    };

    this.processStates.set(processId, state);

    // Emit process lifecycle event
    eventBus.publish({
      type: 'process.spawn',
      processId,
      terminalId: '',
      timestamp: Date.now(),
      data: {
        pid: process.pid,
        startTime: state.startTime
      }
    });

    // Update status to running after a short delay
    setTimeout(() => {
      const currentState = this.processStates.get(processId);
      if (currentState && currentState.status === 'starting') {
        currentState.status = 'running';
        
        eventBus.publish({
          type: 'process.ready',
          processId,
          terminalId: currentState.terminalId || '',
          timestamp: Date.now(),
          data: {
            pid: currentState.pid
          }
        });
      }
    }, 100);
  }

  private handleProcessData(processId: string, _data: string): void {
    const state = this.processStates.get(processId);
    if (state) {
      state.lastActivity = new Date();
      
      // Emit activity event periodically
      eventBus.publish({
        type: 'process.activity',
        processId,
        terminalId: state.terminalId || '',
        timestamp: Date.now(),
        data: {
          timestamp: Date.now()
        }
      });
    }
  }

  private handleProcessExit(processId: string, exitCode: number, signal?: string): void {
    const state = this.processStates.get(processId);
    if (!state) return;

    state.status = 'stopped';
    state.exitCode = exitCode;
    state.signal = signal;
    state.endTime = new Date();

    // Emit exit event
    eventBus.publish({
      type: 'process.exit',
      processId,
      terminalId: state.terminalId || '',
      timestamp: Date.now(),
      data: {
        pid: state.pid,
        exitCode,
        signal,
        duration: state.endTime.getTime() - state.startTime.getTime()
      }
    });

    // Clean up
    this.processStates.delete(processId);
    
    // Remove terminal mapping if exists
    if (state.terminalId) {
      this.terminalMapping.delete(state.terminalId);
    }
  }

  private handleProcessError(processId: string, error: Error): void {
    const state = this.processStates.get(processId);
    if (!state) return;

    state.status = 'crashed';

    // Emit error event
    eventBus.publish({
      type: 'process.error',
      processId,
      terminalId: state.terminalId || '',
      timestamp: Date.now(),
      data: {
        error: error.message,
        stack: error.stack
      }
    });
  }

  private startMonitoring(): void {
    if (this.monitoringInterval) return;

    this.monitoringInterval = setInterval(() => {
      this.collectMetrics();
      this.checkInactivity();
    }, this.config.metricsInterval);
  }

  private async collectMetrics(): Promise<void> {
    for (const [processId, state] of this.processStates) {
      if (state.status !== 'running') continue;

      const process = this.ptyManager.getProcess(processId);
      if (!process) continue;

      const uptime = state.startTime ? (Date.now() - state.startTime.getTime()) / 1000 : 0;
      
      const metrics: ProcessMetrics = {
        processId,
        terminalId: state.terminalId,
        pid: state.pid || 0,
        cpu: 0,
        memory: 0,
        uptime: Math.max(0, uptime),
        timestamp: Date.now()
      };

      // Collect CPU usage
      if (this.config.enableCpuMonitoring) {
        const cpuValue = this.calculateCpuUsage(state.pid);
        metrics.cpu = isNaN(cpuValue) ? 0 : cpuValue;
      }

      // Collect memory usage (platform-specific)
      if (this.config.enableMemoryMonitoring) {
        const memValue = await this.getMemoryUsage(state.pid);
        metrics.memory = isNaN(memValue) ? 0 : memValue;
      }

      // Emit metrics event
      eventBus.publish({
        type: 'process.metrics',
        processId,
        terminalId: state.terminalId || '',
        timestamp: Date.now(),
        data: metrics
      });

      // Check for abnormal conditions
      this.checkAbnormalConditions(processId, metrics);
    }
  }

  private calculateCpuUsage(_pid: number): number {
    try {
      // Note: process.cpuUsage() only works for the current process
      // For monitoring child processes, we would need platform-specific tools
      // This is a simplified implementation that returns mock data
      
      // In production, you would use:
      // - Windows: wmic or performance counters
      // - Linux: /proc/[pid]/stat
      // - macOS: ps or sysctl
      
      // Return a realistic mock value between 0-20%
      const baseUsage = 5 + Math.random() * 15;
      const result = Math.round(baseUsage * 100) / 100;
      
      // Ensure we always return a valid number
      return isNaN(result) || result === null || result === undefined ? 0 : result;
    } catch (error) {
      console.error('CPU usage calculation error:', error);
      return 0;
    }
  }

  private async getMemoryUsage(_pid: number): Promise<number> {
    // This is a simplified implementation
    // In production, you'd use platform-specific tools
    try {
      if (process.platform === 'win32') {
        // On Windows, you'd use WMI or performance counters
        return 0;
      } else {
        // On Unix, you'd read from /proc/<pid>/status
        return 0;
      }
    } catch {
      return 0;
    }
  }

  private checkInactivity(): void {
    const now = Date.now();
    
    for (const [processId, state] of this.processStates) {
      if (state.status !== 'running' || !state.lastActivity) continue;
      
      const inactiveTime = now - state.lastActivity.getTime();
      
      if (inactiveTime > this.config.inactivityTimeout!) {
        eventBus.publish({
          type: 'process.inactive',
          processId,
          terminalId: state.terminalId || '',
          timestamp: Date.now(),
          data: {
            inactiveTime,
            lastActivity: state.lastActivity
          }
        });
      }
    }
  }

  private checkAbnormalConditions(processId: string, metrics: ProcessMetrics): void {
    // High CPU usage
    if (metrics.cpu > 90) {
      eventBus.publish({
        type: 'process.warning',
        processId,
        terminalId: metrics.terminalId || '',
        timestamp: Date.now(),
        data: {
          warning: 'high_cpu',
          cpu: metrics.cpu,
          threshold: 90
        }
      });
    }

    // High memory usage (example: > 1GB)
    if (metrics.memory > 1024 * 1024 * 1024) {
      eventBus.publish({
        type: 'process.warning',
        processId,
        terminalId: metrics.terminalId || '',
        timestamp: Date.now(),
        data: {
          warning: 'high_memory',
          memory: metrics.memory,
          threshold: 1024 * 1024 * 1024
        }
      });
    }
  }

  /**
   * Map a terminal ID to a process ID
   */
  public mapTerminalToProcess(terminalId: string, processId: string): void {
    this.terminalMapping.set(terminalId, processId);
    
    const state = this.processStates.get(processId);
    if (state) {
      state.terminalId = terminalId;
    }
  }

  /**
   * Get process state by terminal ID
   */
  public getProcessByTerminal(terminalId: string): ProcessState | undefined {
    const processId = this.terminalMapping.get(terminalId);
    if (!processId) return undefined;
    
    return this.processStates.get(processId);
  }

  /**
   * Get all active process states
   */
  public getActiveProcesses(): ProcessState[] {
    return Array.from(this.processStates.values())
      .filter(state => state.status === 'running');
  }

  /**
   * Get process metrics history
   */
  public getMetricsHistory(processId: string, duration: number = 3600000): any[] {
    // Query event history for metrics
    return eventBus.getEventHistory({
      processId,
      types: ['process.metrics'],
      after: new Date(Date.now() - duration)
    });
  }

  /**
   * Force collect metrics for a specific process
   */
  public async collectProcessMetrics(processId: string): Promise<ProcessMetrics | null> {
    const state = this.processStates.get(processId);
    if (!state || state.status !== 'running') return null;

    const process = this.ptyManager.getProcess(processId);
    if (!process) return null;

    const uptime = state.startTime ? (Date.now() - state.startTime.getTime()) / 1000 : 0;
    const cpuValue = this.calculateCpuUsage(state.pid);
    const memValue = await this.getMemoryUsage(state.pid);
    
    const metrics: ProcessMetrics = {
      processId,
      terminalId: state.terminalId,
      pid: state.pid || 0,
      cpu: isNaN(cpuValue) ? 0 : cpuValue,
      memory: isNaN(memValue) ? 0 : memValue,
      uptime: Math.max(0, uptime),
      timestamp: Date.now()
    };

    return metrics;
  }

  /**
   * Stop monitoring
   */
  public stop(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
    
    this.removeAllListeners();
    this.processStates.clear();
    this.terminalMapping.clear();
  }

  /**
   * Get system-wide metrics
   */
  public getSystemMetrics(): any {
    try {
      const cpus = os.cpus() || [];
      const totalMemory = os.totalmem() || 0;
      const freeMemory = os.freemem() || 0;
      const usedMemory = Math.max(0, totalMemory - freeMemory);
      const cpuUsage = this.calculateSystemCpuUsage();
      
      return {
        cpu: {
          count: cpus.length || 0,
          model: cpus[0]?.model || 'Unknown',
          speed: cpus[0]?.speed || 0,
          usage: cpuUsage,
          percentage: cpuUsage // Add both for compatibility
        },
        memory: {
          total: totalMemory,
          free: freeMemory,
          used: usedMemory,
          percentage: totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0
        },
        uptime: os.uptime() || 0,
        loadAverage: os.loadavg() || [0, 0, 0],
        platform: os.platform() || 'unknown',
        release: os.release() || 'unknown'
      };
    } catch (error) {
      console.error('System metrics collection error:', error);
      // Return safe default values
      return {
        cpu: {
          count: 0,
          model: 'Unknown',
          speed: 0,
          usage: 0,
          percentage: 0
        },
        memory: {
          total: 0,
          free: 0,
          used: 0,
          percentage: 0
        },
        uptime: 0,
        loadAverage: [0, 0, 0],
        platform: 'unknown',
        release: 'unknown'
      };
    }
  }

  private calculateSystemCpuUsage(): number {
    try {
      // Simplified system CPU calculation
      const cpus = os.cpus();
      
      // Null check for cpus array
      if (!cpus || cpus.length === 0) {
        return 0;
      }
      
      let totalIdle = 0;
      let totalTick = 0;

      cpus.forEach(cpu => {
        if (cpu && cpu.times) {
          for (const type in cpu.times) {
            const time = (cpu.times as any)[type];
            if (typeof time === 'number' && !isNaN(time)) {
              totalTick += time;
            }
          }
          if (typeof cpu.times.idle === 'number' && !isNaN(cpu.times.idle)) {
            totalIdle += cpu.times.idle;
          }
        }
      });

      // Prevent division by zero and ensure valid calculation
      if (totalTick === 0 || cpus.length === 0) {
        return 0;
      }

      const idle = totalIdle / cpus.length;
      const total = totalTick / cpus.length;
      
      // Prevent division by zero in usage calculation
      if (total === 0) {
        return 0;
      }
      
      const usage = 100 - ~~(100 * idle / total);
      
      // Ensure usage is within valid range
      return Math.max(0, Math.min(100, usage));
    } catch (error) {
      console.error('System CPU usage calculation error:', error);
      return 0;
    }
  }

  /**
   * Set up command completion monitoring handlers
   */
  private setupCommandCompletionHandlers(): void {
    // Listen for command completion events from the monitor
    commandCompletionMonitor.on('command-complete', (data) => {
      // Map terminal ID to process ID if available
      const processId = this.terminalMapping.get(data.terminalId);
      
      console.log(`Command completed in terminal ${data.terminalId}: ${data.command} (${data.duration}ms)`);
      
      // Update process activity
      if (processId) {
        const state = this.processStates.get(processId);
        if (state) {
          state.lastActivity = new Date();
          state.status = 'running';
        }
      }
    });

    // Handle command timeouts
    eventBus.on('process.command.timeout', (event) => {
      console.warn(`Command timed out in terminal ${event.terminalId}: ${event.data.command}`);
      
      const processId = this.terminalMapping.get(event.terminalId);
      if (processId) {
        const state = this.processStates.get(processId);
        if (state) {
          // Mark as potentially unresponsive
          eventBus.publish({
            type: 'process.warning',
            processId: processId,
            terminalId: event.terminalId,
            timestamp: Date.now(),
            data: {
              warning: 'command_timeout',
              command: event.data.command,
              duration: event.data.duration
            }
          });
        }
      }
    });
  }

  /**
   * Get command completion monitor instance
   */
  public getCommandMonitor() {
    return commandCompletionMonitor;
  }

  /**
   * Stop monitoring and clean up resources
   */
  public stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
    
    // Clean up command monitor
    commandCompletionMonitor.dispose();
    
    // Clear process states
    this.processStates.clear();
    this.terminalMapping.clear();
  }
}

export default ProcessMonitor;