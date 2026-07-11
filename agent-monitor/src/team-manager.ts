#!/usr/bin/env node

/**
 * Team Manager - Multi-Agent Software Development Team Orchestration
 * 
 * Updated architecture:
 * - Agent-monitor: WebSocket connection to ChatHub (monitoring only)
 * - Agents: MCP tools for ChatHub collaboration
 * - System Architect: Assigns tasks via ChatHub MCP
 * - Agent-monitor: Monitors Project Coordinator messages and prompts idle agents
 */

// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

// Disable SSL certificate validation for development
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

import chalk from 'chalk';
import { Command } from 'commander';
import path from 'path';
import fs from 'fs';

import { AutoTerminalClient } from './api-client';
import { AgentDetector } from './agent-detector';
import { PromptManager } from './prompt-manager';
import { TeamOrchestrator } from './team-orchestrator';
import { TeamConfiguration } from './team-types';

class TeamManager {
  private client: AutoTerminalClient;
  private detector: AgentDetector;
  private promptManager: PromptManager;
  private orchestrator: TeamOrchestrator | null = null;
  private isRunning: boolean = false;

  constructor() {
    // Initialize core components
    const CONFIG = {
      apiUrl: process.env.API_URL || 'http://localhost:3001',
      wsUrl: process.env.WS_URL || 'ws://localhost:9876', 
      token: process.env.API_TOKEN || ''
    };

    this.client = new AutoTerminalClient({
      apiUrl: CONFIG.apiUrl,
      wsUrl: CONFIG.wsUrl,
      token: CONFIG.token,
      autoReconnect: true,
      reconnectInterval: 5000
    });
    this.detector = new AgentDetector();
    this.promptManager = new PromptManager();

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Handle orchestrator events
    this.client.on('connected', () => {
      console.log(chalk.green('✅ Connected to Auto-Terminal API'));
    });

    this.client.on('disconnected', () => {
      console.log(chalk.red('❌ Disconnected from Auto-Terminal API'));
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\\n🛑 Received shutdown signal...'));
      await this.shutdown();
      process.exit(0);
    });
  }

  async startTeam(configPath: string, resume: boolean = false): Promise<void> {
    try {
      if (resume) {
        console.log(chalk.cyan('🔄 Resuming Multi-Agent Software Development Team'));
      } else {
        console.log(chalk.cyan('🎭 Starting Multi-Agent Software Development Team'));
      }
      console.log(chalk.gray(`Configuration: ${configPath}\\n`));

      // Validate configuration file exists
      if (!fs.existsSync(configPath)) {
        throw new Error(`Configuration file not found: ${configPath}`);
      }

      // Connect to Auto-Terminal
      console.log(chalk.yellow('🔌 Connecting to Auto-Terminal...'));
      await this.client.connect();

      // Initialize team orchestrator (ChatHub WebSocket connection handled internally)
      const chatHubWsUrl = process.env.CHATHUB_BASE_URL!;
      console.log(chalk.gray(`ChatHub WebSocket URL: ${chatHubWsUrl}`));
      
      this.orchestrator = new TeamOrchestrator(
        this.client,
        this.detector, 
        this.promptManager,
        configPath,
        chatHubWsUrl
      );

      // Setup orchestrator event handlers
      this.orchestrator.on('projectStatusUpdate', (status) => {
        this.handleProjectStatusUpdate(status);
      });

      // Start or resume the team
      if (resume) {
        await this.orchestrator.resumeTeam();
      } else {
        await this.orchestrator.startTeam();
      }
      
      this.isRunning = true;

      console.log(chalk.green('\\n🎯 Team is now operational!'));
      console.log(chalk.cyan('📊 Agent Monitor supervising via ChatHub WebSocket'));
      console.log(chalk.yellow('🤖 Agents collaborate via ChatHub MCP tools'));
      console.log(chalk.blue('🏗️  System Architect will assign tasks via ChatHub'));
      console.log(chalk.gray('Press Ctrl+C to gracefully shutdown the team.\\n'));

      // Start monitoring loop
      await this.startMonitoring();

    } catch (error) {
      console.error(chalk.red(`❌ Failed to start team: ${error}`));
      await this.shutdown();
      throw error;
    }
  }

  private async startMonitoring(): Promise<void> {
    // Main monitoring loop - WebSocket handles real-time events
    while (this.isRunning) {
      try {
        // Display team summary periodically
        if (this.orchestrator) {
          const summary = this.orchestrator.getTeamSummary();
          if (Date.now() % 300000 < 5000) { // Every 5 minutes
            console.log(chalk.cyan(`\\n📊 Team Status Summary:`));
            console.log(chalk.gray('═'.repeat(50)));
            console.log(chalk.blue(`  Project: ${summary.project}`));
            console.log(chalk.green(`  🤖 Active Agents: ${summary.activeAgents}/${summary.totalAgents}`));
            console.log(chalk.yellow(`  🔗 Connected to ChatHub: ${summary.connectedAgents}/${summary.totalAgents}`));
            console.log(chalk.gray(`  💤 Idle: ${summary.idleAgents}`));
            console.log(chalk.red(`  ❌ Errors: ${summary.errorAgents}`));
            console.log(chalk.blue(`  📡 Monitor Connected: ${summary.chatHubConnected ? '✅' : '❌'}`));
            
            if (summary.pendingTasksReported) {
              console.log(chalk.yellow('  📋 Status: Pending tasks reported by Project Coordinator'));
            } else {
              console.log(chalk.gray('  📋 Status: No pending tasks reported'));
            }
            console.log(chalk.gray('═'.repeat(50) + '\\n'));
          }
        }

        // Wait before next check
        await this.sleep(30000); // 30 seconds

      } catch (error) {
        console.error(chalk.red(`❌ Monitoring error: ${error}`));
        await this.sleep(10000);
      }
    }
  }

  private handleProjectStatusUpdate(status: any): void {
    // Log significant status changes
    if (status.criticalIssues > 0) {
      console.log(chalk.red(`🚨 Critical issues detected: ${status.criticalIssues}`));
    }

    if (status.blockedTasks > 0) {
      console.log(chalk.yellow(`⚠️  Blocked tasks: ${status.blockedTasks}`));
    }
  }

  async shutdown(): Promise<void> {
    console.log(chalk.yellow('🛑 Shutting down team management...'));
    this.isRunning = false;

    if (this.orchestrator) {
      await this.orchestrator.cleanup();
    }

    if (this.client) {
      await this.client.disconnect();
    }

    console.log(chalk.green('✅ Team management shutdown complete'));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // CLI Commands
  async listTeamStatus(): Promise<void> {
    if (!this.orchestrator) {
      console.log(chalk.red('❌ Team not started'));
      return;
    }

    const summary = this.orchestrator.getTeamSummary();
    
    console.log(chalk.cyan('\\n📊 Detailed Team Status Report'));
    console.log(chalk.gray('═'.repeat(60)));
    console.log(chalk.blue(`📁 Project: ${summary.project}`));
    console.log(chalk.blue(`👥 Total Agents: ${summary.totalAgents}`));
    console.log(chalk.green(`🔗 Connected to ChatHub: ${summary.connectedAgents}`));
    console.log(chalk.yellow(`⚡ Currently Active: ${summary.activeAgents}`));
    console.log(chalk.gray(`💤 Idle: ${summary.idleAgents}`));
    console.log(chalk.red(`❌ Error State: ${summary.errorAgents}`));
    console.log(chalk.blue(`📡 Monitor WebSocket: ${summary.chatHubConnected ? '✅ Connected' : '❌ Disconnected'}`));
    console.log(chalk.yellow(`📋 Pending Tasks Status: ${summary.pendingTasksReported ? '⚠️ Reported' : '✅ None reported'}`));
    console.log(chalk.gray(`🕐 Last Update: ${summary.lastUpdate}`));
    console.log(chalk.gray('═'.repeat(60) + '\\n'));
  }

  async validateConfiguration(configPath: string): Promise<void> {
    try {
      const fullPath = path.resolve(configPath);
      
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Configuration file not found: ${fullPath}`);
      }

      const config = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as TeamConfiguration;
      
      // Validate required fields
      if (!config.teamConfig) {
        throw new Error('Missing teamConfig section');
      }
      
      if (!config.agents || config.agents.length === 0) {
        throw new Error('No agents defined');
      }
      
      // Check for required roles
      const roles = config.agents.map(a => a.role);
      if (!roles.includes('Project Coordinator')) {
        console.log(chalk.yellow('⚠️  Warning: No Project Coordinator defined'));
      }
      
      if (!roles.includes('System Architect')) {
        console.log(chalk.yellow('⚠️  Warning: No System Architect defined (required for task assignment)'));
      }
      
      console.log(chalk.green('✅ Configuration is valid'));
      console.log(chalk.blue(`📁 Project: ${config.teamConfig.projectName}`));
      console.log(chalk.blue(`👥 Team Size: ${config.agents.length} agents`));
      console.log(chalk.blue(`📡 ChatHub Channel: ${config.teamConfig.chatHubChannel}`));
      
      if (config.teamConfig.discordWebhookUrl) {
        console.log(chalk.blue('🔔 Discord alerts: Configured'));
      } else {
        console.log(chalk.yellow('⚠️  Discord alerts: Not configured'));
      }
      
      // List agents by role
      console.log(chalk.cyan('\\n🤖 Team Composition:'));
      const roleGroups = config.agents.reduce((acc, agent) => {
        if (!acc[agent.role]) acc[agent.role] = [];
        acc[agent.role].push(agent);
        return acc;
      }, {} as Record<string, any[]>);
      
      Object.entries(roleGroups).forEach(([role, agents]) => {
        console.log(chalk.gray(`  ${role}:`));
        agents.forEach(agent => {
          console.log(chalk.gray(`    • ${agent.name} (${agent.aiType}/${agent.model})`));
        });
      });
      
    } catch (error) {
      console.error(chalk.red(`❌ Configuration validation failed: ${error}`));
      process.exit(1);
    }
  }
}

// CLI Interface
const program = new Command();

program
  .name('team-manager')
  .description('Multi-Agent Software Development Team Orchestration\\n\\nArchitecture:\\n- Agent Monitor: WebSocket monitoring of ChatHub\\n- Agents: MCP tools for ChatHub collaboration\\n- System Architect: Assigns tasks via ChatHub\\n- Project Coordinator: Reports status and blockers')
  .version('2.0.0');

program
  .command('start')
  .description('Start the development team with specified configuration')
  .argument('<config>', 'Path to team configuration JSON file')
  .option('-v, --verbose', 'Enable verbose logging')
  .option('--chathub-url <url>', 'ChatHub WebSocket URL', 'ws://localhost:8080')
  .option('-r, --resume', 'Resume from previous session (reconnect to existing agents)')
  .action(async (configPath, options) => {
    try {
      // Set environment variables from options
      if (options.chathubUrl) {
        process.env.CHATHUB_WS_URL = options.chathubUrl;
      }
      
      if (options.verbose) {
        process.env.DEBUG = 'agent-monitor:*';
      }
      
      const manager = new TeamManager();
      await manager.startTeam(path.resolve(configPath), options.resume || false);
    } catch (error) {
      console.error(chalk.red(`Failed to start team: ${error}`));
      process.exit(1);
    }
  });

program
  .command('validate')
  .description('Validate team configuration file')
  .argument('<config>', 'Path to team configuration JSON file')
  .action(async (configPath) => {
    const manager = new TeamManager();
    await manager.validateConfiguration(configPath);
  });

program
  .command('session')
  .description('Check saved session status')
  .argument('<config>', 'Path to team configuration JSON file')
  .action(async (configPath) => {
    try {
      const resolvedPath = path.resolve(configPath);
      if (!fs.existsSync(resolvedPath)) {
        console.error(chalk.red(`❌ Configuration file not found: ${resolvedPath}`));
        process.exit(1);
      }

      const config = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
      const SessionPersistence = require('./session-persistence').SessionPersistence;
      const persistence = new SessionPersistence(config.teamConfig.projectFolder);

      if (persistence.hasActiveSession()) {
        console.log(chalk.yellow('⚠️ Active session detected - another instance may be running'));
      }

      const sessionData = await persistence.loadSession();
      if (sessionData) {
        console.log(persistence.getSessionSummary(sessionData));
        console.log(chalk.cyan('\n💡 Use --resume flag with start command to reconnect to this session'));
      } else {
        console.log(chalk.gray('No saved session found for this project'));
      }
    } catch (error) {
      console.error(chalk.red(`❌ Failed to check session: ${error}`));
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show current team status (requires running team)')
  .action(async () => {
    console.log(chalk.yellow('📊 Team status monitoring is integrated into the main process'));
    console.log(chalk.gray('Start a team with "npm run team:start config.json" to see live status'));
  });

program
  .command('create-example')
  .description('Create an example team configuration file')
  .argument('[path]', 'Output path for example configuration', './team-config.json')
  .action((outputPath) => {
    const examplePath = path.join(__dirname, '..', 'example-team.json');
    const targetPath = path.resolve(outputPath);
    
    try {
      if (fs.existsSync(examplePath)) {
        fs.copyFileSync(examplePath, targetPath);
        console.log(chalk.green(`✅ Example configuration created: ${targetPath}`));
      } else {
        // Create inline example if file doesn't exist
        const exampleConfig = {
          "teamConfig": {
            "projectName": "Example Project",
            "projectFolder": process.cwd(),
            "chatHubChannel": 1,
            "maxIdleTime": 300,
            "heartbeatInterval": 120
          },
          "agents": [
            {
              "id": "coordinator-001",
              "name": "Alex Coordinator",
              "role": "Project Coordinator",
              "aiType": "Claude",
              "model": "sonnet",
              "cliCommand": "claude --model claude-3-5-sonnet",
              "priority": 1,
              "specializations": ["Project Management"],
              "maxConcurrentTasks": 5
            },
            {
              "id": "architect-001",
              "name": "Morgan Architect",
              "role": "System Architect", 
              "aiType": "Claude",
              "model": "opus",
              "cliCommand": "claude --model claude-3-opus",
              "priority": 2,
              "specializations": ["System Design", "Architecture"],
              "maxConcurrentTasks": 3
            }
          ]
        };
        
        fs.writeFileSync(targetPath, JSON.stringify(exampleConfig, null, 2));
        console.log(chalk.green(`✅ Example configuration created: ${targetPath}`));
      }
      
      console.log(chalk.yellow('💡 Edit the configuration to match your project needs'));
      console.log(chalk.cyan('🔧 Set your API_TOKEN in .env file before starting'));
      console.log(chalk.blue('📡 Ensure ChatHub server is running for agent collaboration'));
      
    } catch (error) {
      console.error(chalk.red(`❌ Failed to create example: ${error}`));
      process.exit(1);
    }
  });

program
  .command('test-setup')
  .description('Test the setup and connections')
  .argument('[config]', 'Optional path to team configuration JSON file')
  .action(async (configPath) => {
    console.log(chalk.cyan('🧪 Testing Multi-Agent Team Setup...\\n'));
    
    // Check environment variables
    const requiredEnvVars = ['API_TOKEN'];
    const optionalEnvVars = ['API_URL', 'WS_URL', 'CHATHUB_WS_URL', 'DISCORD_WEBHOOK_URL'];
    
    console.log(chalk.blue('📋 Environment Variables:'));
    requiredEnvVars.forEach(varName => {
      const value = process.env[varName];
      if (value) {
        console.log(chalk.green(`  ✅ ${varName}: Set`));
      } else {
        console.log(chalk.red(`  ❌ ${varName}: Missing (required)`));
      }
    });
    
    optionalEnvVars.forEach(varName => {
      const value = process.env[varName];
      if (value) {
        console.log(chalk.green(`  ✅ ${varName}: ${varName === 'DISCORD_WEBHOOK_URL' ? 'Set' : value}`));
      } else {
        console.log(chalk.gray(`  ⚪ ${varName}: Using default`));
      }
    });
    
    console.log(chalk.blue('\\n🔧 Configuration:'));
    console.log(chalk.gray(`  Auto-Terminal API: ${process.env.API_URL || 'http://localhost:3001'}`));
    console.log(chalk.gray(`  Auto-Terminal WebSocket: ${process.env.WS_URL || 'ws://localhost:9876'}`));
    console.log(chalk.gray(`  ChatHub WebSocket: ${process.env.CHATHUB_BASE_URL}`));
    
    // Test Auto-Terminal API connection
    console.log(chalk.blue('\\n🔌 Testing Auto-Terminal API...'));
    const axios = require('axios');
    const apiUrl = process.env.API_URL || 'http://localhost:3001';
    const token = process.env.API_TOKEN || '';
    
    try {
      // Test system info endpoint
      const sysResponse = await axios.get(`${apiUrl}/api/system/info`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      console.log(chalk.green('  ✅ /api/system/info - Connected'));
      console.log(chalk.gray(`     Version: ${sysResponse.data.version}`));
      
      // Test terminals endpoint
      const termsResponse = await axios.get(`${apiUrl}/api/terminals`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      console.log(chalk.green('  ✅ /api/terminals - Accessible'));
      console.log(chalk.gray(`     Active terminals: ${termsResponse.data.length}`));
    } catch (error: any) {
      console.log(chalk.red(`  ❌ Auto-Terminal API - Failed`));
      console.log(chalk.red(`     Error: ${error.response?.status || error.message}`));
      console.log(chalk.yellow('     Make sure Auto-Terminal is running with JWT_SECRET=dev-key-secret'));
    }
    
    // Test ChatHub connection
    console.log(chalk.blue('\\n🌐 Testing ChatHub...'));
    const chatHubUrl = process.env.CHATHUB_BASE_URL || process.env.CHATHUB_HTTP_URL || 'https://localhost:5001';
    
    try {
      // Test health endpoint
      const healthResponse = await axios.get(`${chatHubUrl}/api/Health`, {
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
      });
      console.log(chalk.green('  ✅ /api/Health - Connected'));
      console.log(chalk.gray(`     Status: ${healthResponse.data}`));
    } catch (error: any) {
      console.log(chalk.red(`  ❌ ChatHub /api/Health - Failed`));
      console.log(chalk.red(`     Error: ${error.response?.status || error.message}`));
    }
    
    // Test SignalR negotiate
    try {
      const negotiateResponse = await axios.post(`${chatHubUrl}/chathub/negotiate?negotiateVersion=1`, {}, {
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
      });
      console.log(chalk.blue('\\n�� Testing SignalR negotiate...', negotiateResponse.data));
      console.log(chalk.green('  ✅ SignalR /negotiate - Available'));
      console.log(chalk.gray(`     Connection token received`));
    } catch (error: any) {
      console.log(chalk.red(`  ❌ SignalR /negotiate - Failed`));
      console.log(chalk.red(`     Error: ${error.response?.status || error.message}`));
    }
    
    // If config file provided, validate it
    if (configPath) {
      console.log(chalk.blue('\\n📄 Validating Configuration...'));
      try {
        const fullPath = path.resolve(configPath);
        if (!fs.existsSync(fullPath)) {
          throw new Error(`File not found: ${fullPath}`);
        }
        
        const config = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        console.log(chalk.green('  ✅ Configuration file is valid JSON'));
        console.log(chalk.gray(`     Project: ${config.teamConfig?.projectName}`));
        console.log(chalk.gray(`     Agents: ${config.agents?.length || 0}`));
        console.log(chalk.gray(`     ChatHub Channel: ${config.teamConfig?.chatHubChannel}`));
        
        // Check if project folder exists
        if (config.teamConfig?.projectFolder) {
          const projectExists = fs.existsSync(config.teamConfig.projectFolder);
          if (projectExists) {
            console.log(chalk.green(`  ✅ Project folder exists: ${config.teamConfig.projectFolder}`));
          } else {
            console.log(chalk.yellow(`  ⚠️  Project folder not found: ${config.teamConfig.projectFolder}`));
          }
        }
      } catch (error: any) {
        console.log(chalk.red(`  ❌ Configuration validation failed`));
        console.log(chalk.red(`     Error: ${error.message}`));
      }
    }
    
    console.log(chalk.yellow('\\n📊 Summary:'));
    console.log(chalk.gray('  1. Check all ✅ items above are green'));
    console.log(chalk.gray('  2. Fix any ❌ errors before starting the team'));
    console.log(chalk.gray('  3. Run: npm run team:start ' + (configPath || 'team-config.json')));
  });

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error(chalk.red('❌ Unhandled Rejection at:', promise, 'reason:', reason));
  process.exit(1);
});

// Export for programmatic use
export { TeamManager };

// Run CLI if this is the main module
if (require.main === module) {
  program.parse();
}