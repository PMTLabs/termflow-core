import { EventEmitter } from 'events';
import { eventBus, TerminalEvent, CommandEventData, PromptDetectionData } from './EventBus';
import { v4 as uuidv4 } from 'uuid';

export interface CommandTracker {
  id: string;
  terminalId: string;
  command: string;
  startTime: number;
  isWaiting: boolean;
  buffer: string;
  workingDirectory?: string;
  environment?: string;
}

export interface ShellPromptPattern {
  name: string;
  pattern: RegExp;
  environment: string;
  confidence: number;
}

export interface CommandMonitorConfig {
  promptDetectionTimeout?: number;  // Max time to wait for prompt after command (ms)
  bufferSizeLimit?: number;         // Max size of output buffer to analyze
  enableOutputCapture?: boolean;    // Whether to capture command output
  customPromptPatterns?: ShellPromptPattern[];
}

export class CommandCompletionMonitor extends EventEmitter {
  private config: CommandMonitorConfig;
  private activeCommands: Map<string, CommandTracker>;
  private promptPatterns: ShellPromptPattern[];
  private outputBuffers: Map<string, string>;

  constructor(config: CommandMonitorConfig = {}) {
    super();
    this.config = {
      promptDetectionTimeout: 30000,  // 30 seconds
      bufferSizeLimit: 10000,         // 10KB buffer
      enableOutputCapture: true,
      ...config
    };

    this.activeCommands = new Map();
    this.outputBuffers = new Map();
    this.promptPatterns = this.initializePromptPatterns();

    this.setupEventListeners();
  }

  private initializePromptPatterns(): ShellPromptPattern[] {
    const defaultPatterns: ShellPromptPattern[] = [
      // Windows Command Prompt
      {
        name: 'windows_cmd',
        pattern: /^[A-Z]:\\[^>]*>\s*$/m,
        environment: 'cmd',
        confidence: 0.9
      },
      // PowerShell
      {
        name: 'powershell',
        pattern: /^PS\s[^>]*>\s*$/m,
        environment: 'powershell',
        confidence: 0.9
      },
      // Git Bash / MinGW
      {
        name: 'git_bash',
        pattern: /^[^@]*@[^$]*\$\s*$/m,
        environment: 'bash',
        confidence: 0.8
      },
      // Linux/Unix Bash
      {
        name: 'unix_bash',
        pattern: /^[^$]*\$\s*$/m,
        environment: 'bash',
        confidence: 0.7
      },
      // Zsh
      {
        name: 'zsh',
        pattern: /^[^%]*%\s*$/m,
        environment: 'zsh',
        confidence: 0.8
      },
      // Fish shell
      {
        name: 'fish',
        pattern: /^[^>]*>\s*$/m,
        environment: 'fish',
        confidence: 0.6
      },
      // Claude Code specific completion pattern
      {
        name: 'claude_code_completion',
        pattern: /(?:Task\s+completed|✅|Done|Finished|Complete)/i,
        environment: 'any',
        confidence: 0.95
      }
    ];

    return [...defaultPatterns, ...(this.config.customPromptPatterns || [])];
  }

  private setupEventListeners(): void {
    // Listen for input data to track command starts
    eventBus.on('input.data', (event: TerminalEvent) => {
      this.handleInputData(event);
    });

    // Listen for output data to detect command completion
    eventBus.on('output.data', (event: TerminalEvent) => {
      this.handleOutputData(event);
    });

    // Listen for process exit events
    eventBus.on('process.exit', (event: TerminalEvent) => {
      this.handleProcessExit(event);
    });
  }

  private handleInputData(event: TerminalEvent): void {
    const input = event.data?.content || '';

    console.log(`CommandCompletionMonitor: Received input from process ${event.processId}:`, input.substring(0, 50) + '...');
    
    // Check if this looks like a command (ends with newline)
    if (input.includes('\r') || input.includes('\n')) {
      const command = input.replace(/\r?\n/g, '').trim();
      
      // Skip empty commands or simple navigation
      if (!command || command.length < 2) {
        return;
      }

      // Create command tracker
      const tracker: CommandTracker = {
        id: uuidv4(),
        terminalId: event.terminalId,
        command: command,
        startTime: Date.now(),
        isWaiting: true,
        buffer: '',
        environment: this.detectEnvironment(event.terminalId)
      };

      this.activeCommands.set(tracker.id, tracker);

      // Emit command start event
      eventBus.publish({
        type: 'process.command.start',
        timestamp: Date.now(),
        terminalId: event.terminalId,
        processId: event.processId,
        data: {
          command: command,
          startTime: tracker.startTime,
          workingDirectory: tracker.workingDirectory,
          environment: tracker.environment
        } as CommandEventData
      });

      // Set timeout for command completion detection
      setTimeout(() => {
        this.checkCommandTimeout(tracker.id);
      }, this.config.promptDetectionTimeout!);
    }
  }

  private handleOutputData(event: TerminalEvent): void {
    const output = event.data?.content || '';
    
    // Update output buffer for this terminal
    const currentBuffer = this.outputBuffers.get(event.terminalId) || '';
    const newBuffer = (currentBuffer + output).slice(-this.config.bufferSizeLimit!);
    this.outputBuffers.set(event.terminalId, newBuffer);

    // Check for command completion for all active commands in this terminal
    for (const [, tracker] of this.activeCommands) {
      if (tracker.terminalId === event.terminalId && tracker.isWaiting) {
        // Add to command's buffer
        tracker.buffer += output;
        
        // Check for prompt patterns
        const promptMatch = this.detectPrompt(tracker.buffer, tracker.environment);
        if (promptMatch) {
          this.completeCommand(tracker, promptMatch);
        }
      }
    }
  }

  private handleProcessExit(event: TerminalEvent): void {
    // Complete any waiting commands for this terminal
    for (const [, tracker] of this.activeCommands) {
      if (tracker.terminalId === event.terminalId && tracker.isWaiting) {
        this.completeCommand(tracker, {
          prompt: '',
          pattern: 'process.exit',
          confidence: 1.0,
          previousCommand: tracker.command
        });
      }
    }
  }

  private detectPrompt(buffer: string, environment?: string): PromptDetectionData | null {
    // Get the last few lines to check for prompts
    const lines = buffer.split('\n').slice(-5);
    const recentOutput = lines.join('\n');

    for (const pattern of this.promptPatterns) {
      // Skip environment-specific patterns if they don't match
      if (pattern.environment !== 'any' && environment && 
          pattern.environment !== environment) {
        continue;
      }

      const match = pattern.pattern.exec(recentOutput);
      if (match) {
        return {
          prompt: match[0].trim(),
          pattern: pattern.name,
          confidence: pattern.confidence,
          timeSinceLastCommand: Date.now()
        };
      }
    }

    return null;
  }

  private completeCommand(tracker: CommandTracker, promptData: PromptDetectionData): void {
    if (!tracker.isWaiting) return;

    tracker.isWaiting = false;
    const endTime = Date.now();
    const duration = endTime - tracker.startTime;

    // Emit command completion event
    eventBus.publish({
      type: 'process.command.complete',
      timestamp: endTime,
      terminalId: tracker.terminalId,
      data: {
        command: tracker.command,
        startTime: tracker.startTime,
        endTime: endTime,
        duration: duration,
        output: this.config.enableOutputCapture ? tracker.buffer : undefined,
        prompt: promptData.prompt,
        workingDirectory: tracker.workingDirectory,
        environment: tracker.environment
      } as CommandEventData
    });

    // Emit prompt detection event
    eventBus.publish({
      type: 'output.prompt.detected',
      timestamp: endTime,
      terminalId: tracker.terminalId,
      data: {
        ...promptData,
        previousCommand: tracker.command,
        timeSinceLastCommand: duration
      } as PromptDetectionData
    });

    // Clean up
    this.activeCommands.delete(tracker.id);
    
    // Emit completion event for external listeners
    this.emit('command-complete', {
      terminalId: tracker.terminalId,
      command: tracker.command,
      duration: duration,
      output: tracker.buffer,
      prompt: promptData
    });
  }

  private checkCommandTimeout(commandId: string): void {
    const tracker = this.activeCommands.get(commandId);
    if (tracker && tracker.isWaiting) {
      // Emit timeout event
      eventBus.publish({
        type: 'process.command.timeout',
        timestamp: Date.now(),
        terminalId: tracker.terminalId,
        data: {
          command: tracker.command,
          startTime: tracker.startTime,
          duration: Date.now() - tracker.startTime,
          environment: tracker.environment
        } as CommandEventData
      });

      // Mark as no longer waiting
      tracker.isWaiting = false;
      this.activeCommands.delete(commandId);
    }
  }

  private detectEnvironment(terminalId: string): string {
    // Try to detect shell environment from recent output
    const buffer = this.outputBuffers.get(terminalId) || '';
    
    for (const pattern of this.promptPatterns) {
      if (pattern.environment !== 'any' && pattern.pattern.test(buffer)) {
        return pattern.environment;
      }
    }
    
    return 'unknown';
  }

  /**
   * Get all currently active (waiting) commands
   */
  public getActiveCommands(): CommandTracker[] {
    return Array.from(this.activeCommands.values()).filter(cmd => cmd.isWaiting);
  }

  /**
   * Get active commands for a specific terminal
   */
  public getActiveCommandsForTerminal(terminalId: string): CommandTracker[] {
    return this.getActiveCommands().filter(cmd => cmd.terminalId === terminalId);
  }

  /**
   * Add a custom prompt pattern for command completion detection
   */
  public addPromptPattern(pattern: ShellPromptPattern): void {
    this.promptPatterns.push(pattern);
  }

  /**
   * Force complete a command (useful for manual intervention)
   */
  public forceCompleteCommand(commandId: string, reason: string = 'manual'): boolean {
    const tracker = this.activeCommands.get(commandId);
    if (tracker && tracker.isWaiting) {
      this.completeCommand(tracker, {
        prompt: reason,
        pattern: 'forced',
        confidence: 1.0,
        previousCommand: tracker.command
      });
      return true;
    }
    return false;
  }

  /**
   * Clean up resources
   */
  public dispose(): void {
    this.activeCommands.clear();
    this.outputBuffers.clear();
    this.removeAllListeners();
  }
}

// Export singleton instance
export const commandCompletionMonitor = new CommandCompletionMonitor();