/**
 * Auto-Terminal Agent Monitor
 * 
 * This sample application demonstrates how to:
 * 1. Monitor Auto-Terminal for AI agent activity (Claude CLI, Gemini CLI, etc.)
 * 2. Detect prompt lifecycle events (start, execute, finish)
 * 3. Track prompt execution duration
 * 4. Automatically chain prompts when one completes
 */

import 'dotenv/config';
import chalk from 'chalk';
import ora from 'ora';
import { AutoTerminalClient } from './api-client';
import { AgentDetector } from './agent-detector';
import { PromptManager } from './prompt-manager';
import { OutputEvent, InputEvent, TerminalInfo } from './types';

// Configuration
const CONFIG = {
  apiUrl: process.env.API_URL || 'http://localhost:3001',
  wsUrl: process.env.WS_URL || 'ws://localhost:9876',
  token: process.env.API_TOKEN || 'your-api-token-here',
  autoReconnect: true,
  reconnectInterval: 5000
};

class AgentMonitorApp {
  private client: AutoTerminalClient;
  private detector: AgentDetector;
  private promptManager: PromptManager;
  private monitoredTerminals: Set<string> = new Set();
  private promptQueue: Map<string, string[]> = new Map();

  constructor() {
    this.client = new AutoTerminalClient(CONFIG);
    this.detector = new AgentDetector();
    this.promptManager = new PromptManager();
    
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Client events
    this.client.on('connected', () => {
      console.log(chalk.green('✓ Connected to Auto-Terminal'));
    });

    this.client.on('disconnected', () => {
      console.log(chalk.yellow('⚠ Disconnected from Auto-Terminal'));
    });

    this.client.on('error', (error) => {
      console.error(chalk.red('✗ Connection error:'), error.message);
    });

    // Terminal events
    this.client.on('output.data', (event: OutputEvent) => {
      if (this.monitoredTerminals.has(event.terminalId)) {
        this.detector.processOutput(event);
      }
    });

    this.client.on('input.data', (event: InputEvent) => {
      if (this.monitoredTerminals.has(event.terminalId)) {
        // Don't log input events to reduce noise
      }
    });

    // Agent detection events
    this.detector.on('agentDetected', ({ terminalId, agentType, timestamp }) => {
      console.log(chalk.blue(`\n🤖 AI Agent Detected!`));
      console.log(chalk.blue(`   Terminal: ${terminalId}`));
      console.log(chalk.blue(`   Type: ${agentType}`));
      console.log(chalk.blue(`   Time: ${timestamp.toLocaleTimeString()}`));
    });

    this.detector.on('promptDetected', ({ terminalId, agentType, prompt }) => {
      console.log(chalk.cyan(`\n📝 Prompt Started:`));
      console.log(chalk.cyan(`   Agent: ${agentType}`));
      console.log(chalk.cyan(`   Prompt: ${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}`));
      
      // Start tracking this prompt session
      const session = this.promptManager.startSession(terminalId, agentType, prompt);
      console.log(chalk.cyan(`   Session ID: ${session.id}`));
    });

    this.detector.on('responseCompleted', ({ terminalId, response }) => {
      console.log(chalk.yellow(`\n[DEBUG] Response completed handler called`));
      console.log(chalk.yellow(`[DEBUG] Terminal: ${terminalId}`));
      console.log(chalk.yellow(`[DEBUG] Response length: ${response.length}`));
      
      const session = this.promptManager.getActiveSession(terminalId);
      
      if (session) {
        const completed = this.promptManager.completeSession(session.id, response);
        
        if (completed) {
          console.log(chalk.green(`\n✅ Prompt Completed:`));
          console.log(chalk.green(`   Session: ${completed.id}`));
          console.log(chalk.green(`   Duration: ${completed.duration}ms`));
          console.log(chalk.green(`   Response: ${response.substring(0, 100)}${response.length > 100 ? '...' : ''}`));
          
          // Check if there are queued prompts for this terminal
          this.processNextPrompt(terminalId);
        }
      } else {
        console.log(chalk.red(`[HANDLER] No active session found for terminal ${terminalId}`));
        // Maybe we have a queued prompt to process anyway?
        this.processNextPrompt(terminalId);
      }
    });

    // Prompt manager events - commented to reduce noise
    /*
    this.promptManager.on('sessionStarted', (session) => {
      console.log(chalk.magenta(`\n⏱️  Session ${session.id} started at ${session.startTime.toLocaleTimeString()}`));
    });
    */

    this.promptManager.on('sessionCompleted', (session) => {
      const stats = this.promptManager.getStatistics(session.terminalId);
      console.log(chalk.magenta(`\n📊 Statistics for terminal ${session.terminalId}:`));
      console.log(chalk.magenta(`   Total sessions: ${stats.totalSessions}`));
      console.log(chalk.magenta(`   Completed: ${stats.completedSessions}`));
      console.log(chalk.magenta(`   Average duration: ${stats.averageDuration}ms`));
    });
  }

  /**
   * Start monitoring all terminals
   */
  async startMonitoring(): Promise<void> {
    const spinner = ora('Connecting to Auto-Terminal...').start();
    
    try {
      // Connect to WebSocket
      await this.client.connect();
      spinner.succeed('Connected to Auto-Terminal');
      
      // Get active terminals
      const terminals = await this.client.getTerminals();
      console.log(chalk.yellow(`\nFound ${terminals.length} active terminal(s)`));
      
      // Start monitoring each terminal
      for (const terminal of terminals) {
        await this.monitorTerminal(terminal);
      }
      
      if (terminals.length === 0) {
        console.log(chalk.yellow('\nNo active terminals found. Start Auto-Terminal and create a terminal first.'));
      }
    } catch (error) {
      spinner.fail('Failed to connect');
      throw error;
    }
  }

  /**
   * Monitor a specific terminal
   */
  async monitorTerminal(terminal: TerminalInfo): Promise<void> {
    console.log(chalk.gray(`\nMonitoring terminal: ${terminal.name} (${terminal.id})`));
    console.log(chalk.gray(`Process ID: ${terminal.processId}`));
    
    // Monitor both terminal ID and process ID
    this.monitoredTerminals.add(terminal.id);
    if (terminal.processId) {
      this.monitoredTerminals.add(terminal.processId);
    }
    
    this.client.subscribeToTerminal(terminal.id);
    
    // Get recent output to detect if an agent is already running
    try {
      const output = await this.client.getOutput(terminal.id, 50);
      if (output.raw) {
        this.detector.processOutput({
          id: 'history',
          timestamp: new Date().toISOString(),
          terminalId: terminal.id,
          processId: terminal.processId,
          type: 'output.data',
          data: { content: output.raw }
        });
      }
    } catch (error) {
      console.error(chalk.red(`Failed to get output history for ${terminal.id}`));
    }
  }

  /**
   * Send a prompt to a terminal
   */
  async sendPrompt(terminalId: string, prompt: string): Promise<void> {
    const agentType = this.detector.getActiveAgent(terminalId) || 'claude';
    
    console.log(chalk.yellow(`\n📤 Sending prompt to ${agentType} in terminal ${terminalId}`));
    console.log(chalk.yellow(`   Prompt: ${prompt}`));
    
    // Manually start a session since API prompts might not show in terminal output
    const session = this.promptManager.startSession(terminalId, agentType, prompt);
    console.log(chalk.yellow(`   Started session: ${session.id}`));
    
    try {
      await this.client.executePrompt(terminalId, prompt, agentType);
    } catch (error: any) {
      console.error(chalk.red(`Failed to send prompt: ${error.message}`));
      // If failed, complete the session as failed
      this.promptManager.completeSession(session.id, '');
    }
  }

  /**
   * Queue prompts for automatic execution
   */
  queuePrompts(terminalId: string, prompts: string[]): void {
    this.promptQueue.set(terminalId, prompts);
    console.log(chalk.blue(`\n📋 Queued ${prompts.length} prompts for terminal ${terminalId}`));
    
    // Process first prompt if no active session
    if (!this.promptManager.getActiveSession(terminalId)) {
      this.processNextPrompt(terminalId);
    }
  }

  /**
   * Process next queued prompt
   */
  private async processNextPrompt(terminalId: string): Promise<void> {
    const queue = this.promptQueue.get(terminalId) || [];
    
    if (queue.length > 0) {
      const nextPrompt = queue.shift()!;
      this.promptQueue.set(terminalId, queue);
      
      console.log(chalk.blue(`\n🔄 Processing next queued prompt (${queue.length} remaining)`));
      
      // Wait a bit before sending next prompt
      setTimeout(() => {
        this.sendPrompt(terminalId, nextPrompt);
      }, 2000);
    }
  }

  /**
   * Demo: Create a terminal with Claude CLI and run prompts
   */
  async runDemo(): Promise<void> {
    console.log(chalk.bold.cyan('\n🎭 Running Agent Monitor Demo\n'));
    
    // Create a new terminal
    const spinner = ora('Creating demo terminal...').start();
    
    try {
      // const terminal = await this.client.createTerminal({
      //   "tabId": "tab-1753053993581-w0t2k4mdi",
      //   profile: 'bash',
      //   name: 'Agent Monitor Demo'
      // });

      //get first terminal
      const terminals = await this.client.getTerminals();
      const terminal = terminals[0];
      
      // spinner.succeed(`Created terminal: ${terminal.name} (${terminal.id})`);
      spinner.succeed(`First terminal: ${terminal.name} (${terminal.id})`);
      
      // Start monitoring it
      await this.monitorTerminal(terminal);
      
      // Wait for terminal to initialize
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check if Claude is already running
      console.log(chalk.yellow('\n🔍 Checking if Claude CLI is already running...'));
      
      // Get recent output to check current state
      const output = await this.client.getOutput(terminal.id, 50);
      
      // Process existing output through detector
      if (output.raw) {
        console.log(chalk.gray('[DEBUG] Processing existing terminal output...'));
        this.detector.processOutput({
          id: 'history',
          timestamp: new Date().toISOString(),
          terminalId: terminal.id,
          processId: terminal.processId,
          type: 'output.data',
          data: { content: output.raw }
        });
      }
      
      let claudeDetected = this.detector.getActiveAgent(terminal.id) === 'claude';
      
      if (claudeDetected) {
        console.log(chalk.green('✅ Claude CLI is already running!'));
      } else {
        // Try to start Claude CLI
        console.log(chalk.yellow('🚀 Starting Claude CLI...'));
        await this.client.sendInput(terminal.id, 'claude\n');
        
        // Wait for Claude to start
        let attempts = 0;
        const maxAttempts = 10; // Try for 10 seconds
        
        while (!claudeDetected && attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          claudeDetected = this.detector.getActiveAgent(terminal.id) === 'claude';
          
          if (!claudeDetected) {
            attempts++;
            console.log(chalk.gray(`⏳ Waiting for Claude CLI to start... (${attempts}/${maxAttempts})`));
          }
        }
        
        if (claudeDetected) {
          console.log(chalk.green('✅ Claude CLI started successfully!'));
        } else {
          console.log(chalk.red('❌ Claude CLI did not start. Make sure Claude is installed.'));
          console.log(chalk.yellow('💡 Try running "claude" manually in the terminal to check if it\'s installed.'));
          
          // Show what we found in the output
          console.log(chalk.gray('\nTerminal output:'));
          const recentLines = output.lines?.slice(-5) || [];
          recentLines.forEach(line => console.log(chalk.gray(`  ${line}`)));
          
          return;
        }
      }
      
      // Queue multiple prompts
      this.queuePrompts(terminal.id, [
        'Write a haiku about monitoring software - add "PROCESS PROMPT COMPLETED" at the end',
        'Explain what a TypeScript interface is in one sentence',
        'Generate a JSON object representing a user profile'
      ]);
      
    } catch (error: any) {
      spinner.fail('Demo failed');
      console.error(chalk.red(error.message));
    }
  }

  /**
   * Check if Claude CLI is running in a terminal
   */
  isClaudeRunning(terminalId: string): boolean {
    const activeAgent = this.detector.getActiveAgent(terminalId);
    return activeAgent === 'claude';
  }

  /**
   * Get all terminals with Claude running
   */
  getClaudeTerminals(): string[] {
    const claudeTerminals: string[] = [];
    for (const terminalId of this.monitoredTerminals) {
      if (this.isClaudeRunning(terminalId)) {
        claudeTerminals.push(terminalId);
      }
    }
    return claudeTerminals;
  }

  /**
   * Get session report
   */
  getSessionReport(): void {
    console.log(chalk.bold.yellow('\n📈 Session Report\n'));
    
    const recentSessions = this.promptManager.getRecentSessions(5);
    
    if (recentSessions.length === 0) {
      console.log(chalk.gray('No sessions recorded yet.'));
      return;
    }
    
    recentSessions.forEach((session, index) => {
      console.log(chalk.white(`${index + 1}. Session ${session.id}`));
      console.log(chalk.gray(`   Agent: ${session.agentType}`));
      console.log(chalk.gray(`   Status: ${session.status}`));
      console.log(chalk.gray(`   Start: ${session.startTime.toLocaleTimeString()}`));
      
      if (session.duration) {
        console.log(chalk.gray(`   Duration: ${session.duration}ms`));
      }
      
      console.log(chalk.gray(`   Prompt: ${session.prompt.substring(0, 50)}...`));
      
      if (session.response) {
        console.log(chalk.gray(`   Response: ${session.response.substring(0, 50)}...`));
      }
      
      console.log();
    });
  }
}

// Main execution
async function main() {
  console.log(chalk.bold.blue('Auto-Terminal Agent Monitor v1.0.0'));
  console.log(chalk.gray('Monitoring AI agents in Auto-Terminal\n'));
  
  const app = new AgentMonitorApp();
  
  try {
    // Start monitoring
    await app.startMonitoring();
    
    // Run demo if requested
    if (process.argv.includes('--demo')) {
      await app.runDemo();
    }
    
    // Set up periodic reports
    setInterval(() => {
      app.getSessionReport();
    }, 30000);
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\n\nShutting down...'));
      app.getSessionReport();
      process.exit(0);
    });
    
  } catch (error: any) {
    console.error(chalk.red('Fatal error:'), error.message);
    process.exit(1);
  }
}

// Run the application
main().catch(console.error);