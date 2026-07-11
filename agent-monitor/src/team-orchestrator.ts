/**
 * Team Orchestrator - Multi-Agent Software Development Team Management
 */

import { EventEmitter } from 'events';
import chalk from 'chalk';
import fs from 'fs';

import { AutoTerminalClient } from './api-client';
import { HeadlessAutoTerminalClient } from './headless-client';
import { getHeadlessConfig, validateHeadlessConfig } from './headless-config';
import { AgentDetector } from './agent-detector';
import { PromptManager } from './prompt-manager';
import { ChatHubIntegration } from './chathub-integration';
import { DiscordAlerter } from './discord-alerts';
import { SessionPersistence } from './session-persistence';
import { ActivityDetector, ActivityDecision } from './activity-detector';
import {
  TeamConfiguration,
  AgentInstance,
  Task,
  ProjectStatus,
  DEFAULT_KICKOFF_PROMPTS
} from './team-types';

export class TeamOrchestrator extends EventEmitter {
  private client: AutoTerminalClient;
  private headlessClient: HeadlessAutoTerminalClient | null = null;
  private useHeadlessMode: boolean = false;
  private detector: AgentDetector;
  private promptManager: PromptManager;
  private chatHub: ChatHubIntegration;
  private discordAlerter: DiscordAlerter | null = null;
  private teamConfig: TeamConfiguration;
  private agentInstances: Map<string, AgentInstance> = new Map();
  private activeTasks: Map<string, Task> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private aggressiveIdleInterval: NodeJS.Timeout | null = null;
  private pendingTasksReported: boolean = false;
  private idlePromptsSent: Map<string, Date> = new Map(); // Track when we last prompted each agent
  private reactivationPromptsSent: Map<string, Date> = new Map(); // Track reactivation attempts
  private heartbeatPromptsSent: Map<string, Date> = new Map(); // Track heartbeat checks
  
  // Message deduplication to prevent spam
  private lastTaskCompletionMessage = new Map<string, Date>();
  private lastConnectionMessage = new Map<string, Date>();
  private lastEscalationMessage = new Map<string, Date>();
  private lastStatusMessage = new Map<string, Date>();
  private pendingVerifications: Map<string, { agentId: string; timestamp: Date }> = new Map(); // Track pending completion verifications
  private sessionPersistence: SessionPersistence;
  private sharedTabId: string | undefined;
  private sessionSaveInterval: NodeJS.Timeout | null = null;
  private lastOutputLog: Map<string, number> = new Map(); // Track last output log time per terminal
  private activityDetector: ActivityDetector; // Smart activity detection
  private isPaused: boolean = false; // Human pause/resume control
  private pausedBy: string = ''; // Who paused the system
  private pausedAt: Date | null = null; // When was it paused

  constructor(
    client: AutoTerminalClient,
    detector: AgentDetector, 
    promptManager: PromptManager,
    teamConfigPath: string,
    chatHubWsUrl: string,
    useHeadlessMode: boolean = false
  ) {
    super();
    this.client = client;
    this.detector = detector;
    this.promptManager = promptManager;
    this.teamConfig = this.loadTeamConfiguration(teamConfigPath);
    this.chatHub = new ChatHubIntegration(chatHubWsUrl!);
    this.useHeadlessMode = useHeadlessMode;
    
    // Initialize headless client if headless mode is enabled
    if (this.useHeadlessMode) {
      this.initializeHeadlessMode();
    }
    
    // Initialize Discord alerter if webhook is configured
    if (this.teamConfig.teamConfig.discordWebhookUrl) {
      this.discordAlerter = new DiscordAlerter(
        this.teamConfig.teamConfig.discordWebhookUrl,
        this.teamConfig
      );
    }
    
    this.setupEventHandlers();
    
    // Initialize session persistence
    this.sessionPersistence = new SessionPersistence(this.teamConfig.teamConfig.projectFolder);
    
    // Initialize smart activity detector
    this.activityDetector = new ActivityDetector({
      // Customize config for agent monitoring
      minActivityThreshold: 2,     // 2 activity events for active status
      maxInactivityThreshold: 240000, // 4 minutes max inactivity
      confidenceThreshold: 0.6,    // Lower threshold for faster response
      decisionCooldown: 20000      // 20 seconds between decisions
    });
    
    // Listen for activity decisions
    this.activityDetector.on('activityDecision', (decision: ActivityDecision) => {
      this.handleActivityDecision(decision);
    });
  }

  /**
   * Initialize headless mode configuration
   */
  private initializeHeadlessMode(): void {
    try {
      console.log(chalk.blue('🖥️ Initializing headless mode...'));
      
      const headlessConfig = getHeadlessConfig();
      validateHeadlessConfig(headlessConfig);
      
      // Override with project-specific settings
      if (this.teamConfig?.teamConfig?.projectFolder) {
        headlessConfig.terminalConfig.workingDirectory = this.teamConfig.teamConfig.projectFolder;
      }
      
      this.headlessClient = new HeadlessAutoTerminalClient(headlessConfig);
      
      console.log(chalk.green('✅ Headless mode initialized'));
      console.log(chalk.gray(`   API: ${headlessConfig.apiUrl}`));
      console.log(chalk.gray(`   WebSocket: ${headlessConfig.wsUrl}`));
      console.log(chalk.gray(`   Working Directory: ${headlessConfig.terminalConfig.workingDirectory}`));
      
    } catch (error) {
      console.error(chalk.red(`❌ Failed to initialize headless mode: ${error}`));
      console.log(chalk.yellow('⚠️ Falling back to UI mode'));
      this.useHeadlessMode = false;
      this.headlessClient = null;
    }
  }

  /**
   * Load team configuration from JSON file
   */
  private loadTeamConfiguration(configPath: string): TeamConfiguration {
    try {
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configContent) as TeamConfiguration;
      this.validateTeamConfiguration(config);
      return config;
    } catch (error) {
      console.error(chalk.red(`Failed to load team configuration: ${error}`));
      process.exit(1);
    }
  }

  /**
   * Validate team configuration
   */
  private validateTeamConfiguration(config: TeamConfiguration): void {
    if (!config.agents || config.agents.length < 2) {
      throw new Error('Team must have at least 2 agents');
    }

    const roles = config.agents.map(a => a.role);
    if (!roles.includes('Project Coordinator')) {
      throw new Error('Team must include a Project Coordinator');
    }

    // Check for duplicate agent IDs
    const ids = config.agents.map(a => a.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error('Agent IDs must be unique');
    }
  }


  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    // Handle agent responses
    this.detector.on('responseCompleted', async ({ terminalId, response }) => {
      const instance = this.findAgentByTerminalId(terminalId);
      if (instance) {
        instance.lastActivity = new Date();
        await this.processAgentResponse(instance, response);
      }
    });

    // Handle prompt completion
    this.promptManager.on('sessionCompleted', (session) => {
      const instance = this.findAgentByTerminalId(session.terminalId);
      if (instance && instance.status === 'busy') {
        instance.status = 'idle';
        console.log(chalk.green(`📋 ${instance.agent.name} completed task and is now idle`));
      }
    });

    // Handle ChatHub events
    this.chatHub.on('connected', () => {
      console.log(chalk.green('✅ Agent Monitor connected to ChatHub'));
    });

    this.chatHub.on('pendingTasks', ({ tasks }) => {
      console.log(chalk.yellow(`📋 Project Coordinator reports ${tasks.length} pending tasks`));
      this.pendingTasksReported = true;
      
      // Check for idle agents and prompt them
      this.promptIdleAgentsForTasks(tasks);
    });

    this.chatHub.on('agentStatusUpdate', (agent) => {
      console.log(chalk.gray(`👤 ${agent.name} status: ${agent.status}`));
    });

    this.chatHub.on('coordinatorUpdate', (update) => {
      console.log(chalk.blue(`📢 Coordinator: ${update.message}`));
    });

    this.chatHub.on('newMessage', (message) => {
      // Monitor all messages for important patterns
      this.analyzeMessage(message);
    });

    // Handle new ChatHub event types
    this.chatHub.on('taskAssignment', ({ message, mentions }) => {
      console.log(chalk.cyan(`🎯 System Architect assigned tasks with ${mentions?.length || 0} mentions`));
      // Immediately activate mentioned agents
      this.activateMentionedAgents(message, mentions);
    });

    this.chatHub.on('taskCompletion', ({ agentId }) => {
      console.log(chalk.green(`✅ Task completed by agent ${agentId}`));
      const instance = Array.from(this.agentInstances.values())
        .find(inst => inst.agent.id === agentId);
      if (instance) {
        instance.status = 'idle';
        instance.lastActivity = new Date();
      }
    });

    this.chatHub.on('escalationRequest', ({ message, severity }) => {
      console.log(chalk.red(`🚨 Escalation request detected - severity: ${severity}`));
      if (this.discordAlerter) {
        this.discordAlerter.sendEscalationAlert({
          id: `chathub-escalation-${Date.now()}`,
          severity: severity as any,
          title: 'Agent Reported Issue in ChatHub',
          description: message.content.substring(0, 200) + (message.content.length > 200 ? '...' : ''),
          reportedBy: message.senderName,
          affectedAgents: [message.senderId],
          suggestedAction: 'Review the ChatHub conversation and provide assistance',
          timestamp: message.timestamp
        }, this.agentInstances);
      }
    });
  }

  /**
   * Start the team orchestration
   */
  async startTeam(): Promise<void> {
    const modeText = this.useHeadlessMode ? 'Headless Mode' : 'UI Mode';
    console.log(chalk.cyan(`\n🚀 Starting Software Development Team: ${this.teamConfig.teamConfig.projectName} (${modeText})`));
    console.log(chalk.gray(`Project Folder: ${this.teamConfig.teamConfig.projectFolder}`));
    console.log(chalk.gray(`ChatHub Channel: ${this.teamConfig.teamConfig.chatHubChannel}`));
    console.log(chalk.gray(`Team Size: ${this.teamConfig.agents.length} agents`));
    console.log(chalk.gray(`Terminal Mode: ${modeText}\n`));

    try {
      // Step 1: Connect to headless WebSocket if in headless mode
      if (this.useHeadlessMode && this.headlessClient) {
        await this.connectToHeadlessMode();
      }

      // Step 2: Connect to ChatHub (WebSocket monitoring)
      await this.connectToChatHub();

      // Step 3: Create terminals and start agents
      await this.provisionAgents();

      // Step 4: Send kickoff prompts (agents will connect via MCP)
      await this.sendKickoffPrompts();

      // Step 5: Set up terminal output monitoring
      await this.setupTerminalMonitoring();

      // Step 6: Send team start notification
      if (this.discordAlerter) {
        await this.discordAlerter.sendTeamStartNotification(this.agentInstances);
      }

      // Step 7: Start monitoring and coordination
      await this.startHeartbeat();

      // Step 8: Start aggressive idle detection (30 second intervals)
      await this.startAggressiveIdleDetection();

      // Step 9: Save session data for resume capability
      await this.saveSession();
      this.startPeriodicSessionSave();

      console.log(chalk.green('\n✅ Team orchestration started successfully!'));
      console.log(chalk.yellow('🎯 All agents are connecting to ChatHub via MCP. Monitor will supervise coordination.'));
      
      if (this.useHeadlessMode) {
        console.log(chalk.blue('🖥️ All agent terminals running in headless mode with independent processes.'));
      } else {
        console.log(chalk.blue('📊 All agent terminals are in a shared tab with unique process IDs for proper routing.'));
      }
      
      console.log(chalk.magenta('👁️ Aggressive idle detection active - checking every 30 seconds'));
      console.log(chalk.cyan('💾 Session data saved - can resume if interrupted'));

    } catch (error) {
      console.error(chalk.red(`❌ Failed to start team: ${error}`));
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Connect to headless Auto-Terminal WebSocket
   */
  private async connectToHeadlessMode(): Promise<void> {
    if (!this.headlessClient) {
      throw new Error('Headless client not initialized');
    }

    console.log(chalk.yellow('🖥️ Connecting to Auto-Terminal headless WebSocket...'));
    
    try {
      await this.headlessClient.connect();
      
      // Verify headless mode is active
      const isHeadless = await this.headlessClient.checkHeadlessMode();
      if (!isHeadless) {
        console.warn(chalk.yellow('⚠️ Auto-Terminal may not be running in headless mode'));
      }
      
      console.log(chalk.green('✅ Connected to Auto-Terminal headless mode'));
    } catch (error) {
      throw new Error(`Failed to connect to headless Auto-Terminal: ${error}`);
    }
  }

  /**
   * Connect to ChatHub via WebSocket (monitoring mode)
   */
  private async connectToChatHub(): Promise<void> {
    console.log(chalk.yellow('🔗 Agent Monitor connecting to ChatHub via WebSocket...'));
    
    try {
      await this.chatHub.connect();
      await this.chatHub.joinChannel(this.teamConfig.teamConfig.chatHubChannel);
      
      // Send initial monitoring message
      await this.chatHub.sendMonitorMessage(
        `🤖 Agent Monitor started for project: ${this.teamConfig.teamConfig.projectName}. Monitoring ${this.teamConfig.agents.length} agents.`
      );
      
      console.log(chalk.green('✅ Agent Monitor connected to ChatHub'));
    } catch (error) {
      throw new Error(`Failed to connect to ChatHub: ${error}`);
    }
  }

  /**
   * Provision all agents with terminals
   * In headless mode: Each agent gets an independent terminal process
   * In UI mode: All agents share a tab with unique process IDs
   */
  private async provisionAgents(): Promise<void> {
    if (this.useHeadlessMode) {
      console.log(chalk.yellow(`👥 Provisioning ${this.teamConfig.agents.length} agents in headless mode...`));
      console.log(chalk.gray(`🖥️ Each agent will have an independent terminal process`));
    } else {
      console.log(chalk.yellow(`👥 Provisioning ${this.teamConfig.agents.length} agents in shared tab...`));

      // Check if a specific tab ID is configured in environment
      const envTabId = process.env.DEFAULT_TERMINAL_TABID;
      this.sharedTabId = envTabId;
      
      if (envTabId) {
        console.log(chalk.blue(`📋 Using configured tab ID from environment: ${envTabId}`));
      } else {
        console.log(chalk.blue(`📂 Will create new shared tab dynamically`));
      }
      
      console.log(chalk.gray(`📐 Using auto-distribution for ${this.teamConfig.agents.length} agents`));
    }
    
    for (let i = 0; i < this.teamConfig.agents.length; i++) {
      const agent = this.teamConfig.agents[i];
      
      try {
        console.log(chalk.cyan(`🤖 Setting up ${agent.name} (${agent.role})...`));
        
        let terminal;
        
        if (this.useHeadlessMode && this.headlessClient) {
          // Headless mode: Create independent terminal for each agent
          console.log(chalk.blue(`🖥️ Creating headless terminal for ${agent.name}...`));
          terminal = await this.headlessClient.createHeadlessTerminal({
            name: `${agent.name} - ${agent.role}`,
            profile: agent.shellProfile || 'powershell',
            cwd: this.teamConfig.teamConfig.projectFolder,
            env: {
              AGENT_NAME: agent.name,
              AGENT_ROLE: agent.role,
              AGENT_ID: agent.id
            }
          });
          
          console.log(chalk.green(`  ✅ Headless terminal created: ${terminal.id}`));
          console.log(chalk.gray(`     Process ID: ${terminal.processId} (independent process)`));
          console.log(chalk.gray(`     Shell Type: ${terminal.shellType}`));
          console.log(chalk.gray(`     Mode: headless`));
        } else {
          // UI mode: Use shared tab approach
          const envTabId = process.env.DEFAULT_TERMINAL_TABID;
          
          if (envTabId) {
            // Use the configured tab ID for all agents
            console.log(chalk.blue(`📋 Adding to configured tab: ${envTabId} (auto-distribution)`));
            terminal = await this.client.createTerminal({
              name: `${agent.name} - ${agent.role}`,
              profile: agent.shellProfile || 'powershell',
              tabId: envTabId
            });
          } else if (i === 0) {
            // First agent creates the tab dynamically
            console.log(chalk.blue(`📂 Creating shared tab for all agents...`));
            terminal = await this.client.createTerminal({
              name: `${agent.name} - ${agent.role}`,
              profile: agent.shellProfile || 'powershell'
            });
            
            this.sharedTabId = terminal.tabId;
            console.log(chalk.green(`  ✅ Created shared tab: ${this.sharedTabId}`));
          } else {
            // Subsequent agents use the dynamically created tab with auto-distribution
            console.log(chalk.blue(`📋 Adding to shared tab: ${this.sharedTabId} (auto-distribution)`));
            terminal = await this.client.createTerminal({
              name: `${agent.name} - ${agent.role}`,
              profile: agent.shellProfile || 'powershell',
              tabId: this.sharedTabId!
            });
          }

          console.log(chalk.green(`  ✅ Terminal created: ${terminal.id}`));
          console.log(chalk.gray(`     Process ID: ${terminal.processId} (unique per terminal)`));
          console.log(chalk.gray(`     Tab ID: ${terminal.tabId}`));
          console.log(chalk.gray(`     Shell Profile: ${terminal.profile}`));
        }
        
        // Setup the agent
        await this.setupAgent(agent, terminal);
        
      } catch (error) {
        console.error(chalk.red(`  ❌ Failed to provision ${agent.name}: ${error}`));
        throw error;
      }
    }
  }

  /**
   * Setup an agent with an already created terminal
   */
  private async setupAgent(agent: any, terminal: any): Promise<void> {
    try {
      console.log(chalk.cyan(`🤖 Setting up ${agent.name} (${agent.role})...`));
      
      // Change to project directory with shell-specific line ending
      const cdCommand = `cd "${this.teamConfig.teamConfig.projectFolder}"`;
      await this.sendInputWithCorrectEnding(terminal.id, cdCommand, agent.shellProfile);
      await this.sleep(1000);

      // Start the AI CLI with shell-specific line ending
      await this.sendInputWithCorrectEnding(terminal.id, agent.cliCommand, agent.shellProfile);
      await this.sleep(7000); // Give time for CLI to start

      // Create agent instance
      const instance: AgentInstance = {
        agent,
        terminalId: terminal.id,
        processId: terminal.processId,
        status: 'initializing',
        currentTasks: [],
        lastActivity: new Date(),
        isConnectedToHub: false
      };

      this.agentInstances.set(agent.id, instance);
      console.log(chalk.green(`  ✅ ${agent.name} provisioned successfully`));
      
    } catch (error) {
      console.error(chalk.red(`  ❌ Failed to setup ${agent.name}: ${error}`));
      throw error;
    }
  }



  /**
   * Send kickoff prompts to all agents
   */
  /**
   * Send kickoff prompts to all agents.
   * 
   * This function iterates through each agent in the agentInstances map, creates a kickoff prompt
   * with placeholders replaced with actual values, and sends the prompt to the agent's terminal.
   * 
   * @throws Will throw an error if any agent fails to receive the kickoff prompt.
   */
  private async sendKickoffPrompts(): Promise<void> {
    console.log(chalk.yellow('\n📨 Sending kickoff prompts to agents...'));

    for (const [agentId, instance] of this.agentInstances) {
      try {
        const agent = instance.agent;
        let kickoffPrompt = agent.kickoffPrompt || DEFAULT_KICKOFF_PROMPTS[agent.role];
        
        // Replace placeholders and add MCP connection instructions
        kickoffPrompt = kickoffPrompt.replace('{channelId}', this.teamConfig.teamConfig.chatHubChannel.toString());
        kickoffPrompt = kickoffPrompt.replace('{projectName}', this.teamConfig.teamConfig.projectName);
        kickoffPrompt = kickoffPrompt.replace('{projectFolder}', this.teamConfig.teamConfig.projectFolder);
        kickoffPrompt = kickoffPrompt.replace('{requirementsFolder}', this.teamConfig.teamConfig.requirementsFolder || '/docs');
        
        // Add specific MCP connection instructions
        kickoffPrompt += `\n\nIMPORTANT MCP CONNECTION STEPS:
1. Use /mcp_chathub_connect with role="${agent.role}" and aiType="${agent.aiType}"
2. Use /mcp_chathub_join_channel with channelId=${this.teamConfig.teamConfig.chatHubChannel}
3. Use /mcp_chathub_get_responsibility to get your detailed responsibilities
4. Actively monitor and participate in team discussions

The Agent Monitor is supervising this project and will prompt you if you're idle while tasks are pending.`;

        console.log(chalk.cyan(`📤 Sending kickoff to ${agent.name}...`));

        // Send the kickoff prompt using appropriate client
        await this.executePromptWithClient(instance.terminalId, kickoffPrompt, agent.aiType.toLowerCase());
        
        instance.status = 'connecting';
        console.log(chalk.green(`  ✅ Kickoff sent to ${agent.name}`));

        // Wait between agents to avoid overwhelming
        await this.sleep(5000);

      } catch (error) {
        console.error(chalk.red(`  ❌ Failed to send kickoff to agent ${agentId}: ${error}`));
      }
    }
  }

  /**
   * Set up terminal output monitoring to track agent activity
   */
  private async setupTerminalMonitoring(): Promise<void> {
    const modeText = this.useHeadlessMode ? 'headless' : 'UI';
    console.log(chalk.yellow(`📡 Setting up ${modeText} terminal output monitoring for agents...`));
    
    // Subscribe to each agent's terminal events
    for (const [, instance] of this.agentInstances) {
      try {
        if (this.useHeadlessMode && this.headlessClient) {
          this.headlessClient.subscribeToTerminal(instance.terminalId);
        } else {
          this.client.subscribeToTerminal(instance.terminalId);
        }
        console.log(chalk.gray(`  ✓ Subscribed to ${instance.agent.name}'s ${modeText} terminal`));
      } catch (error) {
        console.error(chalk.red(`  ✗ Failed to subscribe to ${instance.agent.name}'s terminal: ${error}`));
      }
    }
    
    // Set up event handlers for the appropriate client
    const eventClient = this.useHeadlessMode && this.headlessClient ? this.headlessClient : this.client;
    
    // Handle output.data events
    eventClient.on('output.data', (event: any) => {
      const terminalId = event.terminalId;
      const instance = this.findAgentByTerminalId(terminalId);
      
      // The event structure from EventIntegration has data.content
      const outputData = event.data?.content || '';
      
      if (instance && outputData && typeof outputData === 'string' && outputData.trim()) {
        // Update last activity when we see any output
        instance.lastActivity = new Date();
        
        // Throttle logging - only log status changes once per 5 seconds per terminal
        const now = Date.now();
        const lastLog = this.lastOutputLog.get(terminalId) || 0;
        const shouldLog = now - lastLog > 5000;
        
        // If agent was idle, mark them as busy
        if (instance.status === 'idle') {
          instance.status = 'busy';
          if (shouldLog) {
            const modeText = this.useHeadlessMode ? '[Headless]' : '[UI]';
            console.log(chalk.green(`🔄 ${modeText} ${instance.agent.name} is now active`));
            this.lastOutputLog.set(terminalId, now);
          }
        }
        
        // Skip processing loading animations or progress indicators
        const loadingPatterns = [
          'scombobulating', 'alescing', 'loading', 'processing',
          '...', '■', '□', '▪', '▫', '●', '○', '◆', '◇'
        ];
        const isLoadingAnimation = loadingPatterns.some(pattern => 
          outputData.toLowerCase().includes(pattern)
        );
        
        // Only process meaningful output, not loading animations
        if (!isLoadingAnimation) {
          // Process the output for responses
          this.processAgentResponse(instance, outputData);
        }
      }
    });
    
    // Handle input.data events to track when prompts are sent
    eventClient.on('input.data', (event: any) => {
      const terminalId = event.terminalId;
      const instance = this.findAgentByTerminalId(terminalId);
      
      if (instance) {
        instance.lastActivity = new Date();
        instance.status = 'busy';
      }
    });
    
    // Handle process.exit events
    eventClient.on('process.exit', (event: any) => {
      const terminalId = event.terminalId;
      const instance = this.findAgentByTerminalId(terminalId);
      
      if (instance) {
        instance.status = 'error';
        const modeText = this.useHeadlessMode ? '[Headless]' : '[UI]';
        console.log(chalk.red(`❌ ${modeText} ${instance.agent.name}'s process exited`));
      }
    });
    
    // Handle process.activity events - agent is actively running
    eventClient.on('process.activity', (event: any) => {
      const terminalId = event.terminalId;
      const instance = this.findAgentByTerminalId(terminalId);
      
      if (instance) {
        // Feed to activity detector for smart analysis
        this.activityDetector.processEvent(terminalId, 'process.activity', event.timestamp || Date.now(), event.data);
        
        // Update basic activity tracking
        instance.lastActivity = new Date();
        
        // Log activity detection
        const now = Date.now();
        const lastLog = this.lastOutputLog.get(terminalId) || 0;
        if (now - lastLog > 30000) { // Log once per 30 seconds
          const modeText = this.useHeadlessMode ? '[Headless]' : '[UI]';
          console.log(chalk.blue(`🔄 ${modeText} ${instance.agent.name} process activity detected`));
          this.lastOutputLog.set(terminalId, now);
        }
      }
    });
    
    // Handle process.inactive events - agent process is idle
    eventClient.on('process.inactive', (event: any) => {
      const terminalId = event.terminalId;
      const instance = this.findAgentByTerminalId(terminalId);
      
      if (instance) {
        // Feed to activity detector for smart analysis
        this.activityDetector.processEvent(terminalId, 'process.inactive', event.timestamp || Date.now(), event.data);
        
        // Log inactivity detection  
        const now = Date.now();
        const lastLog = this.lastOutputLog.get(terminalId) || 0;
        if (now - lastLog > 30000) { // Log once per 30 seconds
          const modeText = this.useHeadlessMode ? '[Headless]' : '[UI]';
          console.log(chalk.gray(`💤 ${modeText} ${instance.agent.name} process inactive`));
          this.lastOutputLog.set(terminalId, now);
        }
      }
    });
    
    console.log(chalk.green('✅ Terminal monitoring established'));
  }

  /**
   * Start heartbeat monitoring
   */
  private async startHeartbeat(): Promise<void> {
    const interval = this.teamConfig.teamConfig.heartbeatInterval * 1000;
    
    this.heartbeatInterval = setInterval(async () => {
      await this.performHeartbeatCheck();
    }, interval);

    console.log(chalk.blue(`💓 Heartbeat monitoring started (${this.teamConfig.teamConfig.heartbeatInterval}s intervals)`));
  }

  /**
   * Start aggressive idle detection - checks every 30 seconds for idle agents
   */
  private async startAggressiveIdleDetection(): Promise<void> {
    // Check every 30 seconds for idle agents
    this.aggressiveIdleInterval = setInterval(async () => {
      await this.checkAndPromptIdleAgents();
    }, 30000);

    console.log(chalk.magenta(`👁️ Aggressive idle detection started (30s intervals)`));
  }

  /**
   * Check for idle agents and send activation prompts intelligently
   */
  private async checkAndPromptIdleAgents(): Promise<void> {
    // Skip if system is paused
    if (this.isPaused) {
      return;
    }
    
    const now = new Date();
    const shortIdleThreshold = 60000; // 1 minute for initial check
    const verificationCheckInterval = 300000; // 5 minutes between verification checks

    // Only log idle checking every 5 minutes to reduce noise
    const shouldLogCheck = Math.random() < 0.033; // ~1 in 30 checks (every 15 minutes on average)
    if (shouldLogCheck) {
      console.log(chalk.gray(`\n🔍 Checking for idle agents at ${now.toLocaleTimeString()}`));
    }

    for (const [agentId, instance] of this.agentInstances) {
      if (instance.status === 'error') {
        continue; // Skip agents in error state
      }

      // Skip agents that have been verified as complete
      if (instance.completionVerified) {
        continue;
      }

      const timeSinceLastActivity = now.getTime() - instance.lastActivity.getTime();
      const timeSinceLastIdleCheck = instance.lastIdleCheckTime 
        ? now.getTime() - instance.lastIdleCheckTime.getTime() 
        : Infinity;

      // Only log agent status occasionally to reduce noise
      if (shouldLogCheck) {
        console.log(chalk.gray(`  ${instance.agent.name}: status=${instance.status}, idle for ${Math.round(timeSinceLastActivity/1000)}s`));
      }

      // Check if agent has been idle for more than 1 minute
      if (timeSinceLastActivity > shortIdleThreshold) {
        // Mark as idle if not already
        if (instance.status !== 'idle') {
          instance.status = 'idle';
          console.log(chalk.yellow(`🕐 ${instance.agent.name} marked as idle`));
        }

        // Process idle agent
        if (instance.status === 'idle') {
          // For agents that might have completed their tasks, check with Project Coordinator
          if (instance.tasksCompleted || this.isEarlyCompletionRole(instance.agent.role)) {
            // Only check every 5 minutes to avoid spamming
            if (timeSinceLastIdleCheck > verificationCheckInterval) {
              await this.verifyAgentCompletion(instance);
              instance.lastIdleCheckTime = now;
            }
          } else {
            // For agents not marked as complete, check if they need activation
            const lastPromptTime = this.idlePromptsSent.get(agentId);
            const timeSinceLastPrompt = lastPromptTime ? now.getTime() - lastPromptTime.getTime() : Infinity;
            const repromptThreshold = 180000; // 3 minutes

            if (timeSinceLastPrompt > repromptThreshold) {
              // First check if there are any pending requests for this agent
              const hasPendingRequests = await this.checkForPendingRequests(instance);
              
              if (hasPendingRequests) {
                console.log(chalk.yellow(`📨 ${instance.agent.name} has pending requests - activating`));
                await this.activateAgentForRequests(instance);
                instance.status = 'busy';
                instance.lastActivity = now;
              } else {
                // No pending requests, ask if they're truly done
                console.log(chalk.blue(`🤔 Checking if ${instance.agent.name} has completed their tasks`));
                await this.checkIfAgentIsDone(instance);
              }
              
              this.idlePromptsSent.set(agentId, now);
            }
          }
        } else if (instance.status === 'busy' && timeSinceLastActivity > 300000) {
          // Agent marked as busy but inactive for 5+ minutes - verify actual status
          console.log(chalk.yellow(`🔍 ${instance.agent.name} marked as busy but inactive for ${Math.round(timeSinceLastActivity/60000)} minutes - verifying status`));
          await this.verifyAgentStatus(instance);
          this.idlePromptsSent.set(agentId, now);
        }
      }
    }
  }

  /**
   * Check if role typically completes early in project
   */
  private isEarlyCompletionRole(role: string): boolean {
    const earlyRoles = ['Product Manager', 'UI/UX Engineer', 'System Architect'];
    return earlyRoles.includes(role);
  }

  /**
   * Check ChatHub for any pending requests mentioning this agent
   */
  private async checkForPendingRequests(instance: AgentInstance): Promise<boolean> {
    try {
      // Get recent messages from ChatHub
      const recentMessages = await this.chatHub.getRecentMessages(20);
      
      // Check if any messages mention this agent or their role
      const mentionPatterns = [
        `@${instance.agent.name}`,
        `@${instance.agent.role}`,
        instance.agent.name.toLowerCase(),
        instance.agent.role.toLowerCase()
      ];
      
      for (const message of recentMessages) {
        const lowerContent = message.content.toLowerCase();
        const hasMention = mentionPatterns.some(pattern => lowerContent.includes(pattern.toLowerCase()));
        
        // Check if message is recent (last 10 minutes) and mentions this agent
        const messageAge = Date.now() - new Date(message.sentAt).getTime();
        if (hasMention && messageAge < 600000) { // 10 minutes
          // Check if it's a request or question
          const requestIndicators = ['need', 'help', 'please', 'can you', 'could you', 'waiting for', 'blocked by'];
          const isRequest = requestIndicators.some(indicator => lowerContent.includes(indicator));
          
          if (isRequest) {
            return true;
          }
        }
      }
    } catch (error) {
      console.error(chalk.red(`Failed to check pending requests: ${error}`));
    }
    
    return false;
  }

  /**
   * Activate agent because they have pending requests
   */
  private async activateAgentForRequests(instance: AgentInstance): Promise<void> {
    const prompt = `🔔 ACTIVATION: You have pending requests from team members.

Please check recent messages using:
/mcp_chathub_get_messages (put limit, filter if needed)

Look for:
1. Any @mentions of your name or role
2. Questions or requests directed to you
3. Tasks that need your expertise
4. Team members waiting for your input

Respond to any pending requests and help unblock the team.`;

    try {
      await this.executePromptWithClient(instance.terminalId, prompt, instance.agent.aiType.toLowerCase());
      console.log(chalk.cyan(`📨 Activated ${instance.agent.name} for pending requests`));
    } catch (error) {
      console.error(chalk.red(`❌ Failed to activate ${instance.agent.name}: ${error}`));
    }
  }

  /**
   * Check if agent has completed their tasks
   */
  private async checkIfAgentIsDone(instance: AgentInstance): Promise<void> {
    const prompt = `Please provide a brief status update:

1. Have you completed all your assigned tasks? (Yes/No)
2. Are you waiting for anything from other team members?
3. Do you have any work in progress?

If you've completed your tasks, I'll verify with the Project Coordinator.
If you have pending work, please continue with it.
Please check recent messages using:
/mcp_chathub_get_messages (put limit, filter if needed)`
;

    try {
      await this.executePromptWithClient(instance.terminalId, prompt, instance.agent.aiType.toLowerCase());
      instance.lastActivity = new Date();
      // Mark as checking status, will process response
      instance.status = 'busy';
    } catch (error) {
      console.error(chalk.red(`❌ Failed to check status with ${instance.agent.name}: ${error}`));
    }
  }

  /**
   * Actively verify agent status by requesting a status report
   */
  private async verifyAgentStatus(instance: AgentInstance): Promise<void> {
    // Check if we've already sent a status verification recently to prevent spam
    const now = new Date();
    const lastPromptTime = this.idlePromptsSent.get(instance.agent.id);
    const timeSinceLastPrompt = lastPromptTime ? now.getTime() - lastPromptTime.getTime() : Infinity;
    const statusVerificationThreshold = 180000; // 3 minutes
    
    if (timeSinceLastPrompt < statusVerificationThreshold) {
      console.log(chalk.gray(`⏭️ Skipping status verification for ${instance.agent.name} - already verified ${Math.round(timeSinceLastPrompt/1000)}s ago`));
      return;
    }
    
    const statusPrompt = `🔍 STATUS VERIFICATION:

Please respond with your current status using this exact format:

STATUS: [IDLE/BUSY/WORKING/STANDBY]
CURRENT_TASK: [Description of what you're working on, or "None" if idle]
NEEDS_HELP: [Yes/No]

Example responses:
- STATUS: IDLE | CURRENT_TASK: None | NEEDS_HELP: No
- STATUS: BUSY | CURRENT_TASK: Implementing user authentication | NEEDS_HELP: No
- STATUS: STANDBY | CURRENT_TASK: Monitoring for new tasks | NEEDS_HELP: No

This helps the Agent Monitor track your status accurately.`;

    try {
      await this.executePromptWithClient(instance.terminalId, statusPrompt, instance.agent.aiType.toLowerCase());
      instance.lastActivity = new Date();
      
      // Update throttling timestamp to prevent immediate re-prompting
      this.idlePromptsSent.set(instance.agent.id, now);
      
      console.log(chalk.blue(`🔍 Requested status verification from ${instance.agent.name}`));
    } catch (error) {
      console.error(chalk.red(`❌ Failed to verify status with ${instance.agent.name}: ${error}`));
    }
  }

  /**
   * Attempt to reactivate an unresponsive agent with a strong wake-up prompt
   */
  private async attemptAgentReactivation(instance: AgentInstance): Promise<void> {
    // Check if we've already sent a reactivation prompt recently to prevent spam
    const now = new Date();
    const lastPromptTime = this.reactivationPromptsSent.get(instance.agent.id);
    const timeSinceLastPrompt = lastPromptTime ? now.getTime() - lastPromptTime.getTime() : Infinity;
    const reactivationThreshold = 300000; // 5 minutes for reactivation (more strict)
    
    if (timeSinceLastPrompt < reactivationThreshold) {
      console.log(chalk.gray(`⏭️ Skipping reactivation for ${instance.agent.name} - already prompted ${Math.round(timeSinceLastPrompt/1000)}s ago`));
      return;
    }
    
    const reactivationPrompt = `🚨 URGENT REACTIVATION NOTICE 🚨

The Agent Monitor has detected that you may be unresponsive or stuck.

IMMEDIATE ACTIONS REQUIRED:
1. Respond with: "AGENT ACTIVE - REACTIVATED" to confirm you're responsive
2. Report your current status using this format:
   STATUS: [IDLE/BUSY/WORKING/STANDBY]
   CURRENT_TASK: [What you're working on or "None"]
   NEEDS_HELP: [Yes/No]

3. If you have been idle, check for new tasks:
   - Use /mcp_chathub_get_messages limit=20 to see recent messages
   - Look for @mentions or assignments for your role
   - Check with the Project Coordinator if no tasks are visible

4. If you're experiencing issues:
   - Report the problem immediately
   - Request human assistance if needed

⚠️ CRITICAL: If you don't respond within the next few minutes, you will be marked as unresponsive and may need manual intervention.

The team is counting on your participation. Please respond immediately.`;

    try {
      await this.executePromptWithClient(instance.terminalId, reactivationPrompt, instance.agent.aiType.toLowerCase());
      console.log(chalk.yellow(`🔄 Sent reactivation prompt to ${instance.agent.name}`));
      
      // Update throttling timestamp to prevent immediate re-prompting
      this.reactivationPromptsSent.set(instance.agent.id, now);
      
      // Reset their status to give them a chance to respond
      if (instance.status !== 'error') {
        instance.status = 'busy'; // Mark as busy to indicate we're expecting a response
      }
      instance.lastActivity = new Date();
      
    } catch (error) {
      console.error(chalk.red(`❌ Failed to send reactivation prompt to ${instance.agent.name}: ${error}`));
    }
  }

  /**
   * Verify with Project Coordinator if agent is truly done
   */
  private async verifyAgentCompletion(instance: AgentInstance): Promise<void> {
    const coordinator = Array.from(this.agentInstances.values())
      .find(inst => inst.agent.role === 'Project Coordinator');
    
    if (!coordinator || coordinator.status === 'error') {
      console.log(chalk.yellow(`⚠️ Cannot verify ${instance.agent.name} completion - Project Coordinator unavailable`));
      return;
    }

    const verificationPrompt = `TASK COMPLETION VERIFICATION:

${instance.agent.name} (${instance.agent.role}) has been idle and may have completed all their tasks.

Please verify:
1. Has ${instance.agent.name} completed all assigned tasks for the current phase?
2. Are there any pending tasks that require ${instance.agent.role} expertise?
3. Should they remain on standby or can they be marked as complete?

Please respond with:
- "VERIFIED COMPLETE" if they've finished all tasks
- "TASKS PENDING: [list tasks]" if they have work remaining
- "STANDBY" if they should remain available for future tasks`;

    try {
      await this.executePromptWithClient(coordinator.terminalId, verificationPrompt, coordinator.agent.aiType.toLowerCase());
      coordinator.status = 'busy';
      coordinator.lastActivity = new Date();
      
      console.log(chalk.blue(`🔍 Verifying ${instance.agent.name} completion with Project Coordinator`));
      
      // Store context for response processing
      this.pendingVerifications.set(instance.agent.id, {
        agentId: instance.agent.id,
        timestamp: new Date()
      });
    } catch (error) {
      console.error(chalk.red(`❌ Failed to verify completion with Project Coordinator: ${error}`));
    }
  }


  /**
   * Perform heartbeat check on all agents
   */
  private async performHeartbeatCheck(): Promise<void> {
    const now = new Date();
    const maxIdleTime = this.teamConfig.teamConfig.maxIdleTime * 1000;

    for (const [agentId, instance] of this.agentInstances) {
      const timeSinceLastActivity = now.getTime() - instance.lastActivity.getTime();
      
      // Check if agent has been idle too long
      if (timeSinceLastActivity > maxIdleTime && instance.status === 'idle') {
        // Check if we've already sent a heartbeat prompt recently to prevent spam
        const lastPromptTime = this.heartbeatPromptsSent.get(instance.agent.id);
        const timeSinceLastPrompt = lastPromptTime ? now.getTime() - lastPromptTime.getTime() : Infinity;
        const heartbeatPromptThreshold = 240000; // 4 minutes between heartbeat prompts
        
        if (timeSinceLastPrompt < heartbeatPromptThreshold) {
          console.log(chalk.gray(`⏭️ Skipping heartbeat prompt for ${instance.agent.name} - already prompted ${Math.round(timeSinceLastPrompt/1000)}s ago`));
          continue;
        }
        
        console.log(chalk.yellow(`⏰ ${instance.agent.name} has been idle for ${Math.round(timeSinceLastActivity/1000)}s`));
        
        // Create role-specific idle prompt
        const idlePrompt = this.createIdlePrompt(instance);
        
        try {
          await this.executePromptWithClient(instance.terminalId, idlePrompt, instance.agent.aiType.toLowerCase());
          instance.status = 'busy';
          instance.lastActivity = now;
          
          // Update throttling timestamp to prevent immediate re-prompting
          this.heartbeatPromptsSent.set(instance.agent.id, now);
          
          console.log(chalk.cyan(`📨 Prompted ${instance.agent.name} to ${instance.agent.role === 'Project Coordinator' ? 'check project status and report' : 'check for new tasks'}`));
        } catch (error) {
          console.error(chalk.red(`❌ Failed to prompt ${instance.agent.name}: ${error}`));
        }
      }

      // Check agent health - try to reactivate unresponsive agents before marking as error
      if (timeSinceLastActivity > maxIdleTime * 2) {
        const minutesInactive = Math.round(timeSinceLastActivity / 60000);
        console.log(chalk.red(`🚨 ${instance.agent.name} may be unresponsive (${minutesInactive} minutes inactive)`));
        
        // Check if we've already tried to reactivate this agent recently
        const lastReactivationAttempt = instance.lastReactivationAttempt || new Date(0);
        const timeSinceLastReactivation = now.getTime() - lastReactivationAttempt.getTime();
        const reactivationCooldown = 300000; // 5 minutes
        
        if (timeSinceLastReactivation > reactivationCooldown) {
          // Try to reactivate the agent before marking as error
          console.log(chalk.yellow(`🔄 Attempting to reactivate unresponsive agent: ${instance.agent.name}`));
          await this.attemptAgentReactivation(instance);
          instance.lastReactivationAttempt = now;
        } else if (timeSinceLastActivity > maxIdleTime * 3) {
          // Agent still unresponsive after reactivation attempt - mark as error
          console.log(chalk.red(`❌ ${instance.agent.name} confirmed unresponsive - marking as error`));
          instance.status = 'error';
          
          // Consider escalation if it's the Project Coordinator
          if (instance.agent.role === 'Project Coordinator' && this.discordAlerter) {
            await this.discordAlerter.sendEscalationAlert({
              id: `coordinator-unresponsive-${Date.now()}`,
              severity: 'high',
              title: 'Project Coordinator Unresponsive',
              description: `The Project Coordinator (${instance.agent.name}) has been unresponsive for over ${Math.round(timeSinceLastActivity/60000)} minutes despite reactivation attempts.`,
              reportedBy: 'Agent Monitor',
              affectedAgents: [agentId],
              suggestedAction: 'Check terminal and restart if needed',
              timestamp: now
            }, this.agentInstances);
          }
        }
      }
    }

    // Periodically request status verification from all agents (every 10 heartbeats = ~10 minutes)
    const heartbeatCount = Math.floor(Date.now() / (this.teamConfig.teamConfig.heartbeatInterval * 1000));
    if (heartbeatCount % 10 === 0) {
      console.log(chalk.blue('🔍 Requesting status verification from all agents'));
      for (const [, instance] of this.agentInstances) {
        if (instance.status !== 'error') {
          await this.verifyAgentStatus(instance);
          await this.sleep(2000); // Stagger requests
        }
      }
    }

    // Update project status
    await this.updateProjectStatus();
  }

  /**
   * Create role-specific idle prompt for agents
   */
  private createIdlePrompt(instance: AgentInstance): string {
    const baseChannelInfo = `ChatHub channel ${this.teamConfig.teamConfig.chatHubChannel}`;
    
    if (instance.agent.role === 'Project Coordinator') {
      return `⏰ PROJECT COORDINATOR IDLE CHECK:

You've been inactive for a while. As the Project Coordinator, please:

1. **Check team status** - Use /mcp chathub get_messages limit=20 to review recent activity
2. **Review requirements** - Check ${this.teamConfig.teamConfig.requirementsFolder || '/docs'} for project requirements and documentation
3. **Assess project progress** - Review what team members have completed and any blockers reported
4. **Provide status update** - Report current project status using the standard format:

📊 PROJECT STATUS UPDATE:

Progress Summary:
- [Overall progress and team accomplishments]
- [Current sprint/milestone status]

PENDING TASKS:
- [List any unassigned or blocked tasks]
- [Tasks that need immediate attention]

Critical Issues:
- [Any blockers or escalations needed]

Timeline:
- [Upcoming deadlines or milestones]

Team Status:
- [Agent availability and coordination needs]

5. **Coordinate next actions** - If there are pending tasks, work with the System Architect to assign them

The Agent Monitor is supervising overall team coordination. Stay active in ${baseChannelInfo} to maintain project momentum.`;
    } else if (instance.agent.role === 'System Architect') {
      return `⏰ SYSTEM ARCHITECT IDLE CHECK:

You've been inactive. As the System Architect, please:

1. **Check for pending tasks** - Use /mcp chathub get_messages limit=20 to see Project Coordinator reports
2. **Review technical requirements** - Check ${this.teamConfig.teamConfig.requirementsFolder || '/docs'} for architecture documentation and technical specs
3. **Review team requests** - Look for technical questions or architecture decisions needed
4. **Assign available work** - If there are unassigned tasks, use @mentions to assign them to appropriate roles
5. **Provide technical guidance** - Help unblock any agents waiting on architectural decisions

Monitor ${baseChannelInfo} for task assignment opportunities and technical coordination needs.`;
    } else if (instance.agent.role === 'Product Manager') {
      return `⏰ PRODUCT MANAGER IDLE CHECK:

You've been inactive. As the Product Manager, please:

1. **Review project requirements** - Use /mcp chathub get_messages limit=20 to see team discussions
2. **Check requirements documentation** - Review ${this.teamConfig.teamConfig.requirementsFolder || '/docs'} for existing user stories and requirements
3. **Write user stories** - Create detailed user stories for any undefined or unclear requirements
4. **Refine backlog priorities** - Review and prioritize features based on business value
5. **Provide product guidance** - Answer questions about user requirements and acceptance criteria
6. **Check for requirements gaps** - Identify missing user stories or incomplete acceptance criteria

Focus on creating clear, actionable user stories using the standard format:

**As a** [user type]
**I want** [functionality]
**So that** [business value]

**Acceptance Criteria:**
- [Specific, testable criteria]

Stay active in ${baseChannelInfo} to support the development team with clear requirements.`;
    } else {
      // For other roles (Backend, Frontend, UI/UX, QA)
      return `⏰ ${instance.agent.role.toUpperCase()} IDLE CHECK:

You've been inactive. Please:

1. **Check for new assignments** - Use /mcp chathub get_messages limit=20 to see recent messages
2. **Look for @mentions** - See if the System Architect has assigned you new tasks
3. **Check for collaboration requests** - Other team members may need your input
4. **Report current status** - If you've completed work, report it using the standard completion format

The Project Coordinator may have reported pending tasks that need attention. Stay active in ${baseChannelInfo} and coordinate with the team.`;
    }
  }

  /**
   * Process agent response and extract actionable information
   */
  private async processAgentResponse(instance: AgentInstance, response: string): Promise<void> {
    // Check for structured status reports first (highest priority)
    const structuredStatusMatch = response.match(/STATUS:\s*(IDLE|BUSY|WORKING|STANDBY)/i);
    if (structuredStatusMatch) {
      const reportedStatus = structuredStatusMatch[1].toUpperCase();
      let newStatus: 'idle' | 'busy' | 'error' | 'initializing' | 'connecting';
      
      switch (reportedStatus) {
        case 'IDLE':
        case 'STANDBY':
          newStatus = 'idle';
          break;
        case 'BUSY':
        case 'WORKING':
          newStatus = 'busy';
          break;
        default:
          newStatus = 'idle';
      }
      
      if (instance.status !== newStatus) {
        const oldStatus = instance.status;
        instance.status = newStatus;
        console.log(chalk.cyan(`🔄 ${instance.agent.name} status updated: ${oldStatus} → ${newStatus} (self-reported)`));
      }
      
      // Clear all throttling since agent provided a proper status response
      this.idlePromptsSent.delete(instance.agent.id);
      this.reactivationPromptsSent.delete(instance.agent.id);
      this.heartbeatPromptsSent.delete(instance.agent.id);
      
      // Extract current task if provided
      const taskMatch = response.match(/CURRENT_TASK:\s*([^|]+)/i);
      if (taskMatch) {
        const currentTask = taskMatch[1].trim();
        if (currentTask !== 'None') {
          console.log(chalk.blue(`📋 ${instance.agent.name} current task: ${currentTask}`));
        }
      }
      
      // Extract help status
      const helpMatch = response.match(/NEEDS_HELP:\s*(Yes|No)/i);
      if (helpMatch && helpMatch[1].toLowerCase() === 'yes') {
        console.log(chalk.yellow(`🆘 ${instance.agent.name} needs help`));
      }
      
      instance.lastActivity = new Date();
      return; // Exit early since we got structured status
    }
    
    // Check for reactivation confirmation
    if (response.includes('AGENT ACTIVE - REACTIVATED') || response.includes('REACTIVATED')) {
      console.log(chalk.green(`✅ ${instance.agent.name} confirmed reactivation - responsive again`));
      instance.lastActivity = new Date();
      // Clear all throttling since agent confirmed they're responsive
      this.idlePromptsSent.delete(instance.agent.id);
      this.reactivationPromptsSent.delete(instance.agent.id);
      this.heartbeatPromptsSent.delete(instance.agent.id);
      // Don't change status here, let other indicators determine if they're idle or busy
      return;
    }

    // Check for human override acknowledgment
    if (response.includes('HUMAN OVERRIDE ACKNOWLEDGED') || response.includes('AGENT ACTIVATED')) {
      console.log(chalk.magenta(`🚨 ${instance.agent.name} acknowledged HUMAN OVERRIDE - priority activation successful`));
      instance.lastActivity = new Date();
      instance.status = 'busy'; // Ensure they're marked as busy after human override
      return;
    }
    
    // Look for specific patterns in the response
    
    // Check if agent successfully connected to ChatHub
    if (response.includes('Connected to ChatHub') || response.includes('Joined channel')) {
      instance.isConnectedToHub = true;
      instance.status = 'idle';
      if (this.shouldLogMessage(instance.agent.id, 'connection', 300000)) { // 5 minute threshold
        console.log(chalk.green(`🔗 ${instance.agent.name} connected to ChatHub`));
        this.lastConnectionMessage.set(instance.agent.id, new Date());
      }
    }

    // Check for task completion indicators with deduplication
    if (this.detectTaskCompletion(response)) {
      if (this.shouldLogMessage(instance.agent.id, 'task_completion', 60000)) { // 1 minute threshold
        console.log(chalk.green(`✅ ${instance.agent.name} completed a task`));
        this.lastTaskCompletionMessage.set(instance.agent.id, new Date());
      }
      instance.status = 'idle';
    }

    // Check for escalation requests
    if (response.includes('NEED HUMAN HELP') || response.includes('ESCALATE')) {
      if (this.shouldLogMessage(instance.agent.id, 'escalation', 300000)) { // 5 minute threshold
        console.log(chalk.red(`🚨 ${instance.agent.name} requested escalation`));
        this.lastEscalationMessage.set(instance.agent.id, new Date());
      }
      
      if (this.discordAlerter) {
        await this.discordAlerter.sendEscalationAlert({
          id: `agent-escalation-${Date.now()}`,
          severity: instance.agent.role === 'Project Coordinator' ? 'high' : 'medium',
          title: `${instance.agent.role} Needs Assistance`,
          description: `${instance.agent.name} has requested human assistance: ${response.substring(0, 200)}...`,
          reportedBy: instance.agent.name,
          affectedAgents: [instance.agent.id],
          suggestedAction: instance.agent.role === 'Project Coordinator' 
            ? 'PRIORITY: Project Coordinator needs immediate attention - review project status and provide guidance'
            : 'Review agent request and provide guidance',
          timestamp: new Date()
        }, this.agentInstances);
      }
    }

    // Special handling for Project Coordinator status reports
    if (instance.agent.role === 'Project Coordinator') {
      if (response.includes('PROJECT STATUS UPDATE') || response.includes('PENDING TASKS:')) {
        console.log(chalk.blue(`📊 Project Coordinator provided status update`));
        this.pendingTasksReported = true;
        
        // Extract and analyze pending tasks if present
        if (response.includes('PENDING TASKS:')) {
          const tasks = this.extractTasksFromResponse(response);
          if (tasks.length > 0) {
            console.log(chalk.yellow(`📋 Detected ${tasks.length} pending tasks from Project Coordinator`));
            // Notify System Architect if available to handle task assignment
            await this.notifySystemArchitectOfPendingTasks(tasks);
          }
        }
      }
      
      // Check if Project Coordinator is reporting critical issues
      if (response.includes('Critical Issues:') && !response.includes('- None') && !response.includes('- [None')) {
        console.log(chalk.red(`🚨 Project Coordinator reported critical issues`));
        if (this.discordAlerter) {
          await this.discordAlerter.sendEscalationAlert({
            id: `coordinator-critical-${Date.now()}`,
            severity: 'high',
            title: 'Project Coordinator Reports Critical Issues',
            description: `Critical issues reported: ${response.substring(response.indexOf('Critical Issues:'), 300)}...`,
            reportedBy: instance.agent.name,
            affectedAgents: [instance.agent.id],
            suggestedAction: 'Review critical issues and provide immediate support',
            timestamp: new Date()
          }, this.agentInstances);
        }
      }
    }

    // Check for completion verification responses from Project Coordinator
    if (instance.agent.role === 'Project Coordinator' && this.pendingVerifications.size > 0) {
      for (const [agentId] of this.pendingVerifications) {
        if (response.includes('VERIFIED COMPLETE')) {
          const verifiedAgent = this.agentInstances.get(agentId);
          if (verifiedAgent) {
            verifiedAgent.completionVerified = true;
            verifiedAgent.tasksCompleted = true;
            console.log(chalk.green(`✅ ${verifiedAgent.agent.name} tasks verified complete by Project Coordinator`));
            this.pendingVerifications.delete(agentId);
            
            // Send confirmation to the verified agent
            await this.sendCompletionConfirmation(verifiedAgent);
          }
        } else if (response.includes('TASKS PENDING:')) {
          const verifiedAgent = this.agentInstances.get(agentId);
          if (verifiedAgent) {
            verifiedAgent.tasksCompleted = false;
            console.log(chalk.yellow(`📋 ${verifiedAgent.agent.name} has pending tasks`));
            this.pendingVerifications.delete(agentId);
            
            // Extract and send the pending tasks to the agent
            const tasksMatch = response.match(/TASKS PENDING:\s*(.+?)(?:\n\n|$)/s);
            if (tasksMatch) {
              await this.sendPendingTasksToAgent(verifiedAgent, tasksMatch[1]);
            }
          }
        } else if (response.includes('STANDBY')) {
          const verifiedAgent = this.agentInstances.get(agentId);
          if (verifiedAgent) {
            verifiedAgent.tasksCompleted = true; // Tasks done but stay available
            console.log(chalk.blue(`⏸️ ${verifiedAgent.agent.name} on standby for future tasks`));
            this.pendingVerifications.delete(agentId);
          }
        }
      }
    }

    // Check if agent is reporting task completion
    if (response.includes('completed all my assigned tasks') || 
        response.includes('finished all tasks') ||
        response.includes('no more tasks') ||
        (response.includes('Yes') && response.includes('completed') && response.includes('tasks'))) {
      instance.tasksCompleted = true;
      console.log(chalk.blue(`📋 ${instance.agent.name} reports tasks completed - will verify with Project Coordinator`));
    }

    // Check for agent going idle - expanded detection
    const idleIndicators = [
      'waiting for tasks',
      'nothing to do',
      'awaiting instructions',
      'ready for next task',
      'standing by',
      'on standby',
      'monitoring chathub',
      'no active tasks',
      'completed all tasks',
      'finished assigned work',
      'ready to help',
      'what would you like me to do',
      'how can I help',
      'please provide',
      'waiting for',
      'need more information',
      'ready to proceed',
      'available for',
      'ready to assist'
    ];
    
    const lowerResponse = response.toLowerCase();
    const isIdle = idleIndicators.some(indicator => lowerResponse.includes(indicator));
    
    if (isIdle && instance.status !== 'idle') {
      instance.status = 'idle';
      console.log(chalk.yellow(`💤 ${instance.agent.name} is now idle`));
      
      // Don't immediately prompt if they might be done with tasks
      if (!instance.tasksCompleted && this.pendingTasksReported) {
        await this.promptAgentToCheckChatHub(instance);
      }
    }
  }

  /**
   * Prompt idle agents to check ChatHub for tasks
   */
  private async promptIdleAgentsForTasks(tasks: string[]): Promise<void> {
    // Skip if system is paused
    if (this.isPaused) {
      return;
    }
    
    const idleAgents = Array.from(this.agentInstances.values())
      .filter(instance => instance.status === 'idle');
    
    if (idleAgents.length === 0) {
      console.log(chalk.yellow('⚠️  No idle agents available to prompt'));
      return;
    }
    
    console.log(chalk.blue(`📢 Prompting ${idleAgents.length} idle agents to check for tasks`));
    
    for (const agent of idleAgents) {
      await this.promptAgentToCheckChatHub(agent, tasks);
      // Stagger prompts to avoid overwhelming
      await this.sleep(1000);
    }
  }

  /**
   * Prompt a specific agent to check ChatHub
   */
  private async promptAgentToCheckChatHub(agent: AgentInstance, pendingTasks?: string[]): Promise<void> {
    const tasksInfo = pendingTasks ? `\n\nPending tasks reported:\n${pendingTasks.map(t => `- ${t}`).join('\n')}` : '';
    
    const prompt = `The Project Coordinator has reported pending tasks that need assignment. Please:

1. Use /mcp_chathub_get_messages to check recent messages
2. Look for task assignments from the System Architect
3. If you find relevant tasks for your role, acknowledge and begin work
4. If no tasks are assigned to you, use /mcp_chathub_what_next to get suggestions${tasksInfo}

Stay active in ChatHub and coordinate with the team.`;
    
    try {
      await this.executePromptWithClient(agent.terminalId, prompt, agent.agent.aiType.toLowerCase());
      agent.lastActivity = new Date();
      agent.status = 'busy'; // Temporarily mark as busy while checking
      
      console.log(chalk.cyan(`📨 Prompted ${agent.agent.name} to check ChatHub for tasks`));
    } catch (error) {
      console.error(chalk.red(`❌ Failed to prompt ${agent.agent.name}: ${error}`));
    }
  }

  /**
   * Analyze incoming ChatHub messages
   */
  private async analyzeMessage(message: any): Promise<void> {
    // Look for key patterns in messages
    if (message.content) {
      const content = message.content.toLowerCase();
      
      // PRIORITY 1: Check for human override commands
      if (this.isHumanMessage(message)) {
        await this.handleHumanOverride(message);
      }
      
      // Check for mentions (@agent_name or @role)
      if (message.content.includes('@') || (message.mentions && message.mentions.length > 0)) {
        console.log(chalk.blue(`👋 Mentions detected in message from ${message.senderName}`));
        await this.handleMentionsInMessage(message);
      }
      
      // Check for blocked/stuck indicators
      if (content.includes('blocked') || content.includes('stuck') || content.includes('cannot proceed')) {
        console.log(chalk.red(`🚫 Potential blocker detected from ${message.senderName}`));
        
        if (this.discordAlerter) {
          await this.discordAlerter.sendEscalationAlert({
            id: `blocker-${Date.now()}`,
            severity: 'high',
            title: 'Agent Reported Blocker',
            description: `${message.senderName} reported: ${message.content}`,
            reportedBy: message.senderName,
            affectedAgents: [message.senderId],
            suggestedAction: 'Review blocker and provide assistance or escalate to team lead',
            timestamp: new Date()
          });
        }
      }
      
      // Check for help requests
      if (content.includes('need help') || content.includes('assistance required')) {
        console.log(chalk.yellow(`🆘 Help request from ${message.senderName}`));
      }
    }
  }

  /**
   * Handle mentions detected in any message
   */
  private async handleMentionsInMessage(message: any): Promise<void> {
    try {
      // Extract mentioned agents from both formal mentions and @text patterns
      const mentionedAgents = this.extractMentionedAgents(message);
      
      if (mentionedAgents.length > 0) {
        console.log(chalk.cyan(`📍 Found ${mentionedAgents.length} mentioned agents: ${mentionedAgents.map(a => a.agent.name).join(', ')}`));
        
        // Activate each mentioned agent
        for (const mentionedAgent of mentionedAgents) {
          await this.activateAgentForMention(mentionedAgent, message);
        }
      }
    } catch (error) {
      console.error(chalk.red(`❌ Error handling mentions: ${error}`));
    }
  }

  /**
   * Activate mentioned agents from task assignments or general mentions
   */
  private async activateMentionedAgents(message: any, mentions: any[]): Promise<void> {
    try {
      const mentionedAgents = this.extractMentionedAgents(message, mentions);
      
      if (mentionedAgents.length > 0) {
        console.log(chalk.cyan(`🎯 Activating ${mentionedAgents.length} mentioned agents from task assignment`));
        
        for (const mentionedAgent of mentionedAgents) {
          await this.activateAgentForMention(mentionedAgent, message);
        }
      }
    } catch (error) {
      console.error(chalk.red(`❌ Error activating mentioned agents: ${error}`));
    }
  }

  /**
   * Extract agents that are mentioned in a message using smart pattern matching
   */
  private extractMentionedAgents(message: any, explicitMentions?: any[]): AgentInstance[] {
    const mentionedAgents: AgentInstance[] = [];
    const content = message.content.toLowerCase();
    
    // Check formal mentions first
    if (explicitMentions && explicitMentions.length > 0) {
      for (const mention of explicitMentions) {
        const agent = this.agentInstances.get(mention.mentionedAgentId);
        if (agent && !mentionedAgents.includes(agent)) {
          mentionedAgents.push(agent);
        }
      }
    }
    
    // Smart mention detection for each agent
    for (const [, instance] of this.agentInstances) {
      if (this.isAgentMentioned(content, instance)) {
        if (!mentionedAgents.includes(instance)) {
          mentionedAgents.push(instance);
        }
      }
    }
    
    return mentionedAgents;
  }

  /**
   * Smart detection if an agent is mentioned using multiple pattern matching strategies
   */
  private isAgentMentioned(content: string, instance: AgentInstance): boolean {
    const agentName = instance.agent.name.toLowerCase();
    const agentRole = instance.agent.role.toLowerCase();
    
    // Generate multiple possible mention patterns
    const mentionPatterns = this.generateMentionPatterns(agentName, agentRole);
    
    // Check if any pattern matches
    for (const pattern of mentionPatterns) {
      if (content.includes(pattern)) {
        console.log(chalk.blue(`🎯 Detected mention pattern "${pattern}" for ${instance.agent.name}`));
        return true;
      }
    }
    
    // Also check for fuzzy matching (partial words)
    if (this.checkFuzzyMentions(content, agentName, agentRole)) {
      console.log(chalk.blue(`🔍 Detected fuzzy mention for ${instance.agent.name}`));
      return true;
    }
    
    return false;
  }

  /**
   * Generate all possible mention patterns for an agent
   */
  private generateMentionPatterns(agentName: string, agentRole: string): string[] {
    const patterns: string[] = [];
    
    // Basic patterns with @
    patterns.push(`@${agentName}`);
    patterns.push(`@${agentRole}`);
    
    // Underscore variations
    patterns.push(`@${agentName.replace(/\s+/g, '_')}`);
    patterns.push(`@${agentRole.replace(/\s+/g, '_')}`);
    
    // Claude prefix variations
    patterns.push(`@claude_${agentName.replace(/\s+/g, '_')}`);
    patterns.push(`@claude_${agentRole.replace(/\s+/g, '_')}`);
    
    // Remove common words and create variations
    const roleWords = agentRole.split(/\s+/);
    for (const word of roleWords) {
      if (word.length > 2) { // Skip short words like "qa", "ui"
        patterns.push(`@${word}`);
        patterns.push(`@claude_${word}`);
      }
    }
    
    // Handle compound roles (e.g., "QA Engineer" -> "qa", "engineer", "qa_engineer")
    if (roleWords.length > 1) {
      patterns.push(`@${roleWords.join('_')}`);
      patterns.push(`@claude_${roleWords.join('_')}`);
      
      // Acronym patterns (e.g., "QA Engineer" -> "qae", "qa_eng")
      const acronym = roleWords.map(w => w.charAt(0)).join('');
      if (acronym.length >= 2) {
        patterns.push(`@${acronym}`);
        patterns.push(`@claude_${acronym}`);
      }
    }
    
    // Special handling for specific roles
    if (agentRole.includes('qa')) {
      patterns.push('@qa');
      patterns.push('@qa_engineer');
      patterns.push('@claude_qa');
      patterns.push('@claude_qa_engineer');
      patterns.push('@quality_assurance');
    }
    
    if (agentRole.includes('backend')) {
      patterns.push('@backend');
      patterns.push('@backend_dev');
      patterns.push('@backend_developer');
      patterns.push('@claude_backend');
    }
    
    if (agentRole.includes('frontend')) {
      patterns.push('@frontend');
      patterns.push('@frontend_dev');
      patterns.push('@frontend_developer');
      patterns.push('@claude_frontend');
    }
    
    if (agentRole.includes('ui') || agentRole.includes('ux')) {
      patterns.push('@ui');
      patterns.push('@ux');
      patterns.push('@ui_ux');
      patterns.push('@designer');
      patterns.push('@claude_ui');
      patterns.push('@claude_ux');
    }
    
    // Remove duplicates and return
    return [...new Set(patterns)];
  }

  /**
   * Check for fuzzy mentions (partial matches and common variations)
   */
  private checkFuzzyMentions(content: string, agentName: string, agentRole: string): boolean {
    // Split content into words for fuzzy matching
    const words = content.split(/\s+/);
    
    // Check for partial role matches
    const roleWords = agentRole.split(/\s+/);
    for (const roleWord of roleWords) {
      if (roleWord.length > 3) { // Only check meaningful words
        for (const word of words) {
          // Check if word starts with @ and contains the role word
          if (word.startsWith('@') && word.includes(roleWord)) {
            return true;
          }
          
          // Check for variations like "claude_qa_engineer" mentioning "QA Engineer"
          if (word.startsWith('@claude_') && word.includes(roleWord)) {
            return true;
          }
        }
      }
    }
    
    // Check for name-based fuzzy matching
    const nameWords = agentName.split(/\s+/);
    for (const nameWord of nameWords) {
      if (nameWord.length > 3) {
        for (const word of words) {
          if (word.startsWith('@') && word.includes(nameWord)) {
            return true;
          }
        }
      }
    }
    
    return false;
  }

  /**
   * Activate a specific agent that was mentioned
   */
  private async activateAgentForMention(agentInstance: AgentInstance, message: any): Promise<void> {
    try {
      // Skip if system is paused (except for human overrides which are handled separately)
      if (this.isPaused) {
        console.log(chalk.yellow(`⏸️ Skipping activation of ${agentInstance.agent.name} - system is paused by ${this.pausedBy}`));
        return;
      }
      
      // Skip if agent is already busy or in error state
      if (agentInstance.status === 'busy' || agentInstance.status === 'error') {
        console.log(chalk.gray(`⏭️ Skipping ${agentInstance.agent.name} - already ${agentInstance.status}`));
        return;
      }
      
      // Note: Agent activation via terminal prompt works regardless of ChatHub connection status
      // The agent will connect to ChatHub after receiving the activation prompt
      
      const activationPrompt = `🔔 MENTION ALERT: You have been mentioned by ${message.senderName}!

Message: "${message.content.substring(0, 200)}${message.content.length > 200 ? '...' : ''}"

You are needed! Please:
1. Use /mcp_chathub_get_messages limit=10 to see the recent conversation
2. Look for the specific message from ${message.senderName}
3. Respond to their request or question immediately
4. If it's a task assignment, acknowledge and begin work
5. If you need clarification, ask for it

Time is important - the team is waiting for your response!`;

      await this.executePromptWithClient(agentInstance.terminalId, activationPrompt, agentInstance.agent.aiType.toLowerCase());
      
      // Update agent status
      agentInstance.status = 'busy';
      agentInstance.lastActivity = new Date();
      
      // Clear any idle prompt tracking since we're activating them
      this.idlePromptsSent.delete(agentInstance.agent.id);
      
      console.log(chalk.green(`🚀 Activated ${agentInstance.agent.name} for mention from ${message.senderName}`));
      
    } catch (error) {
      console.error(chalk.red(`❌ Failed to activate ${agentInstance.agent.name}: ${error}`));
    }
  }

  /**
   * Update project status
   */
  private async updateProjectStatus(): Promise<void> {
    const status: ProjectStatus = {
      completedTasks: 0,
      totalTasks: this.activeTasks.size,
      activeAgents: Array.from(this.agentInstances.values()).filter(i => i.status !== 'error').length,
      blockedTasks: Array.from(this.activeTasks.values()).filter(t => t.status === 'blocked').length,
      criticalIssues: Array.from(this.agentInstances.values()).filter(i => i.status === 'error').length,
      lastUpdate: new Date()
    };

    // Emit status update
    this.emit('projectStatusUpdate', status);

    // Log summary periodically (every 5 heartbeats)
    if (Date.now() % (this.teamConfig.teamConfig.heartbeatInterval * 5 * 1000) < 1000) {
      console.log(chalk.cyan(`\n📊 Project Status: ${status.activeAgents}/${this.teamConfig.agents.length} agents active, ${status.criticalIssues} issues\n`));
    }
  }

  // Discord escalation now handled by DiscordAlerter class

  // Severity color handling moved to DiscordAlerter

  /**
   * Extract tasks from Project Coordinator response
   */
  private extractTasksFromResponse(response: string): string[] {
    const tasks: string[] = [];
    
    // Look for "PENDING TASKS:" followed by task descriptions
    const pendingIndex = response.indexOf('PENDING TASKS:');
    if (pendingIndex !== -1) {
      const tasksSection = response.substring(pendingIndex + 'PENDING TASKS:'.length);
      const lines = tasksSection.split('\n');
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && (trimmed.startsWith('-') || trimmed.startsWith('•') || trimmed.startsWith('*') || trimmed.startsWith('1.') || trimmed.startsWith('2.'))) {
          // Stop if we hit another section
          if (trimmed.includes(':') && (trimmed.includes('Critical Issues') || trimmed.includes('Timeline') || trimmed.includes('Team Status'))) {
            break;
          }
          tasks.push(trimmed.replace(/^[-•*]/, '').replace(/^\d+\./, '').trim());
        }
      }
    }
    
    return tasks;
  }

  /**
   * Notify System Architect about pending tasks from Project Coordinator
   */
  private async notifySystemArchitectOfPendingTasks(tasks: string[]): Promise<void> {
    const systemArchitect = Array.from(this.agentInstances.values())
      .find(instance => instance.agent.role === 'System Architect');
    
    if (systemArchitect && systemArchitect.status !== 'error') {
      const taskList = tasks.map((task, index) => `${index + 1}. ${task}`).join('\n');
      
      const architectPrompt = `🎯 TASK ASSIGNMENT NEEDED:

The Project Coordinator has reported ${tasks.length} pending tasks that need assignment:

${taskList}

As the System Architect, please:

1. **Review each task** - Assess technical requirements and complexity
2. **Assign to appropriate roles** - Use @mentions to assign tasks to team members:
   - @Backend_Developer for server-side work
   - @Frontend_Developer for UI implementation  
   - @UI_UX_Engineer for design work
   - @QA_Engineer for testing tasks
3. **Provide technical guidance** - Include implementation approach or dependencies
4. **Set priorities** - Mark urgent tasks as "Priority: High"

Use the standard task assignment format from teamwork.md to ensure clear communication.

The Agent Monitor is tracking task assignment completion.`;

      try {
        await this.client.executePrompt(systemArchitect.terminalId, architectPrompt, systemArchitect.agent.aiType.toLowerCase());
        systemArchitect.status = 'busy';
        systemArchitect.lastActivity = new Date();
        console.log(chalk.cyan(`📨 Notified System Architect about ${tasks.length} pending tasks`));
      } catch (error) {
        console.error(chalk.red(`❌ Failed to notify System Architect: ${error}`));
      }
    } else {
      console.log(chalk.yellow(`⚠️ System Architect not found or in error state - cannot assign ${tasks.length} pending tasks`));
    }
  }

  /**
   * Send completion confirmation to agent
   */
  private async sendCompletionConfirmation(agent: AgentInstance): Promise<void> {
    const confirmationPrompt = `✅ TASK COMPLETION CONFIRMED

The Project Coordinator has verified that you've completed all your assigned tasks for the current phase.

You are now on standby. Please:
1. Monitor ChatHub for any new requests or questions
2. Be ready to help team members if they need your expertise
3. Stay available for future phases or urgent tasks

Thank you for your contributions! Stay connected to ChatHub in case you're needed.`;

    try {
      await this.client.executePrompt(agent.terminalId, confirmationPrompt, agent.agent.aiType.toLowerCase());
      console.log(chalk.green(`✅ Sent completion confirmation to ${agent.agent.name}`));
    } catch (error) {
      console.error(chalk.red(`❌ Failed to send completion confirmation: ${error}`));
    }
  }

  /**
   * Send pending tasks to agent
   */
  private async sendPendingTasksToAgent(agent: AgentInstance, tasks: string): Promise<void> {
    const tasksPrompt = `📋 PENDING TASKS FROM PROJECT COORDINATOR

The Project Coordinator has identified the following pending tasks for you:

${tasks}

Please:
1. Review these tasks carefully
2. Start working on the highest priority items
3. Report progress in ChatHub
4. Ask for clarification if needed

Get started on these tasks now.`;

    try {
      await this.client.executePrompt(agent.terminalId, tasksPrompt, agent.agent.aiType.toLowerCase());
      agent.status = 'busy';
      agent.lastActivity = new Date();
      agent.tasksCompleted = false;
      console.log(chalk.yellow(`📋 Sent pending tasks to ${agent.agent.name}`));
    } catch (error) {
      console.error(chalk.red(`❌ Failed to send pending tasks: ${error}`));
    }
  }

  /**
   * Find agent instance by terminal ID
   */
  private findAgentByTerminalId(terminalId: string): AgentInstance | undefined {
    return Array.from(this.agentInstances.values()).find(instance => instance.terminalId === terminalId);
  }

  /**
   * Get Project Coordinator status and activity
   */
  getProjectCoordinatorStatus(): any {
    const coordinator = Array.from(this.agentInstances.values())
      .find(instance => instance.agent.role === 'Project Coordinator');
    
    if (!coordinator) {
      return { status: 'not_found', message: 'No Project Coordinator configured' };
    }

    const now = new Date();
    const timeSinceLastActivity = now.getTime() - coordinator.lastActivity.getTime();
    const minutesSinceActivity = Math.round(timeSinceLastActivity / 60000);

    return {
      name: coordinator.agent.name,
      status: coordinator.status,
      isConnectedToHub: coordinator.isConnectedToHub,
      lastActivity: coordinator.lastActivity,
      minutesSinceActivity: minutesSinceActivity,
      terminalId: coordinator.terminalId,
      needsAttention: minutesSinceActivity > (this.teamConfig.teamConfig.maxIdleTime / 60),
      pendingTasksReported: this.pendingTasksReported
    };
  }

  /**
   * Get team summary
   */
  getTeamSummary(): any {
    const coordinatorStatus = this.getProjectCoordinatorStatus();
    
    const summary = {
      project: this.teamConfig.teamConfig.projectName,
      totalAgents: this.teamConfig.agents.length,
      connectedAgents: Array.from(this.agentInstances.values()).filter(i => i.isConnectedToHub).length,
      activeAgents: Array.from(this.agentInstances.values()).filter(i => i.status === 'busy').length,
      idleAgents: Array.from(this.agentInstances.values()).filter(i => i.status === 'idle').length,
      errorAgents: Array.from(this.agentInstances.values()).filter(i => i.status === 'error').length,
      chatHubConnected: this.chatHub.isConnected,
      pendingTasksReported: this.pendingTasksReported,
      projectCoordinator: coordinatorStatus,
      lastUpdate: new Date()
    };

    return summary;
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    console.log(chalk.yellow('\n🧹 Cleaning up team orchestration...'));

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.aggressiveIdleInterval) {
      clearInterval(this.aggressiveIdleInterval);
      this.aggressiveIdleInterval = null;
    }

    if (this.sessionSaveInterval) {
      clearInterval(this.sessionSaveInterval);
      this.sessionSaveInterval = null;
    }

    // Clear session data on cleanup
    this.sessionPersistence.clearSession();

    // Disconnect from ChatHub
    if (this.chatHub) {
      await this.chatHub.sendMonitorMessage('🛑 Agent Monitor shutting down. Team supervision ended.');
      await this.chatHub.disconnect();
    }

    // Cleanup agent terminals
    for (const instance of this.agentInstances.values()) {
      try {
        // Send goodbye message to agents with correct line ending
        await this.sendInputWithCorrectEnding(instance.terminalId, 'exit', instance.agent.shellProfile);
        console.log(chalk.gray(`  🚪 ${instance.agent.name} terminal cleaned up`));
      } catch (error) {
        console.error(chalk.red(`  ❌ Error cleaning up ${instance.agent.name}: ${error}`));
      }
    }

    console.log(chalk.green('✅ Cleanup completed'));
  }

  /**
   * Save current session state
   */
  private async saveSession(): Promise<void> {
    try {
      const chatHubInfo = {
        channelId: this.teamConfig.teamConfig.chatHubChannel,
        agentId: this.chatHub.getAgentId(),
        connected: this.chatHub.isConnected
      };

      const projectStatus = {
        pendingTasksReported: this.pendingTasksReported,
        lastHeartbeat: new Date()
      };

      await this.sessionPersistence.saveSession(
        this.teamConfig,
        this.agentInstances,
        this.sharedTabId,
        chatHubInfo,
        projectStatus
      );

      // Update lock to indicate session is active
      await this.sessionPersistence.updateLock();
    } catch (error) {
      console.error(chalk.red(`❌ Failed to save session: ${error}`));
    }
  }

  /**
   * Start periodic session saving
   */
  private startPeriodicSessionSave(): void {
    // Save session every 60 seconds
    this.sessionSaveInterval = setInterval(async () => {
      await this.saveSession();
    }, 60000);
  }

  /**
   * Resume from saved session
   */
  async resumeTeam(): Promise<void> {
    console.log(chalk.cyan('\n🔄 Resuming team from saved session...'));

    try {
      // Load session data
      const sessionData = await this.sessionPersistence.loadSession();
      if (!sessionData) {
        throw new Error('No session data found to resume from');
      }

      // Display session summary
      console.log(this.sessionPersistence.getSessionSummary(sessionData));

      // Step 1: Reconnect to ChatHub
      await this.connectToChatHub();

      // Step 2: Verify terminals still exist and reconnect
      console.log(chalk.yellow('\n🔍 Verifying agent terminals...'));
      let reconnectedCount = 0;
      let failedCount = 0;

      for (const savedAgent of sessionData.agents) {
        try {
          // Get agent config from saved team config
          const agentConfig = sessionData.teamConfig.agents.find(a => a.id === savedAgent.agentId);
          if (!agentConfig) {
            console.log(chalk.red(`❌ Agent config not found for ${savedAgent.name}`));
            failedCount++;
            continue;
          }

          // Verify terminal still exists
          const terminals = await this.client.getTerminals();
          const terminalExists = terminals.some(t => t.id === savedAgent.terminalId);

          if (!terminalExists) {
            console.log(chalk.yellow(`⚠️ Terminal no longer exists for ${savedAgent.name}, recreating...`));
            
            // Recreate terminal in the saved tab
            const terminal = await this.client.createTerminal({
              name: `${savedAgent.name} - ${savedAgent.role}`,
              profile: agentConfig.shellProfile || 'powershell',
              tabId: this.sharedTabId
            });

            // Reinitialize the agent
            await this.setupAgent(agentConfig, terminal);
            await this.sleep(2000);
            
            // Send reconnection prompt
            const reconnectPrompt = `🔄 RECONNECTION NOTICE:

The Agent Monitor was restarted and has reconnected to your session.

Please:
1. Reconnect to ChatHub using: /mcp_chathub_connect role="${savedAgent.role}" aiType="${agentConfig.aiType}"
2. Rejoin channel ${this.teamConfig.teamConfig.chatHubChannel}: /mcp_chathub_join_channel channelId=${this.teamConfig.teamConfig.chatHubChannel}
3. Check recent messages: /mcp_chathub_get_messages limit=20
4. Continue with your assigned tasks

Your previous work is preserved. The monitoring system is now active again.`;

            await this.client.executePrompt(terminal.id, reconnectPrompt, agentConfig.aiType.toLowerCase());
          } else {
            console.log(chalk.green(`✅ Reconnected to ${savedAgent.name} (${savedAgent.terminalId})`));
            
            // Restore agent instance
            const instance: AgentInstance = {
              agent: agentConfig,
              terminalId: savedAgent.terminalId,
              processId: savedAgent.processId,
              status: savedAgent.status as any,
              currentTasks: [],
              lastActivity: new Date(savedAgent.lastActivity),
              isConnectedToHub: false, // Will be updated when they reconnect
              tasksCompleted: savedAgent.tasksCompleted,
              completionVerified: savedAgent.completionVerified
            };

            this.agentInstances.set(savedAgent.agentId, instance);
            reconnectedCount++;

            // Send brief reconnection notice
            const noticePrompt = `🔄 MONITOR RECONNECTED:

The Agent Monitor has reconnected to your terminal session.
Continue with your current work. The monitoring system is active again.

If you were disconnected from ChatHub, please reconnect using:
/mcp_chathub_get_messages limit=1

Stay active in channel ${this.teamConfig.teamConfig.chatHubChannel}.`;

            await this.client.executePrompt(savedAgent.terminalId, noticePrompt, agentConfig.aiType.toLowerCase());
          }
        } catch (error) {
          console.error(chalk.red(`❌ Failed to reconnect to ${savedAgent.name}: ${error}`));
          failedCount++;
        }
      }

      console.log(chalk.blue(`\n📊 Reconnection Summary:`));
      console.log(chalk.green(`  ✅ Reconnected: ${reconnectedCount} agents`));
      console.log(chalk.red(`  ❌ Failed: ${failedCount} agents`));

      // Step 3: Restore state
      this.pendingTasksReported = sessionData.projectStatus.pendingTasksReported;
      this.sharedTabId = sessionData.sharedTabId;

      // Step 4: Restart monitoring
      await this.setupTerminalMonitoring();
      await this.startHeartbeat();
      await this.startAggressiveIdleDetection();
      this.startPeriodicSessionSave();

      // Step 5: Send team resume notification
      if (this.discordAlerter) {
        await this.discordAlerter.sendTeamStartNotification(this.agentInstances, true);
      }

      // Announce resume in ChatHub
      await this.chatHub.sendMonitorMessage(
        `🔄 Agent Monitor resumed after interruption. Reconnected to ${reconnectedCount} agents. Monitoring active.`
      );

      console.log(chalk.green('\n✅ Team successfully resumed!'));
      console.log(chalk.yellow('🎯 Agents should reconnect to ChatHub if they were disconnected.'));
      console.log(chalk.blue('📊 Monitoring and coordination active.'));

    } catch (error) {
      console.error(chalk.red(`❌ Failed to resume team: ${error}`));
      throw error;
    }
  }

  /**
   * Get appropriate line ending for shell type
   */
  private getShellLineEnding(shellProfile?: string): string {
    // All shells now use \r\n for consistency
    switch (shellProfile?.toLowerCase()) {
      case 'cmd':
      case 'powershell':
      case 'pwsh':
      case 'bash':
      case 'git-bash':
        return '\r\n';
      default:
        // Default to Windows-style for unknown shells
        return '\r\n';
    }
  }

  /**
   * Execute prompt using appropriate client (headless or UI)
   */
  private async executePromptWithClient(terminalId: string, prompt: string, cliType: string): Promise<any> {
    if (this.useHeadlessMode && this.headlessClient) {
      return await this.headlessClient.executePrompt(terminalId, prompt, cliType);
    } else {
      return await this.client.executePrompt(terminalId, prompt, cliType);
    }
  }

  /**
   * Send input to terminal with correct line ending for shell type
   */
  private async sendInputWithCorrectEnding(terminalId: string, command: string, shellProfile?: string): Promise<void> {
    const lineEnding = this.getShellLineEnding(shellProfile);
    
    if (this.useHeadlessMode && this.headlessClient) {
      await this.headlessClient.sendInput(terminalId, command + lineEnding);
    } else {
      await this.client.sendInput(terminalId, command + lineEnding);
    }
  }

  /**
   * Handle activity decisions from the smart activity detector
   */
  private handleActivityDecision(decision: ActivityDecision): void {
    // Skip if system is paused
    if (this.isPaused) {
      return;
    }
    
    const instance = this.findAgentByTerminalId(decision.terminalId);
    if (!instance) {
      return;
    }

    const previousStatus = instance.status;
    
    // Update agent status based on smart detection
    if (decision.newStatus === 'active') {
      // Smart detector says agent is active
      if (instance.status === 'idle' || instance.status === 'error') {
        instance.status = 'busy';
        console.log(chalk.green(`🤖 ${instance.agent.name} detected as ACTIVE by smart detector (${Math.round(decision.confidence * 100)}% confidence)`));
        console.log(chalk.gray(`   Reason: ${decision.reason}`));
        
        // Update last activity time
        instance.lastActivity = new Date();
        
        // Clear any idle prompt tracking since they're now active
        this.idlePromptsSent.delete(instance.agent.id);
      }
    } else if (decision.newStatus === 'inactive') {
      // Smart detector says agent is inactive
      if (instance.status === 'busy') {
        instance.status = 'idle';
        console.log(chalk.yellow(`😴 ${instance.agent.name} detected as INACTIVE by smart detector (${Math.round(decision.confidence * 100)}% confidence)`));
        console.log(chalk.gray(`   Reason: ${decision.reason}`));
        
        // If agent has been marked as inactive and we have pending tasks, prompt them
        if (this.pendingTasksReported && !instance.tasksCompleted) {
          setTimeout(async () => {
            await this.promptAgentToCheckChatHub(instance);
          }, 5000); // Give them a few seconds to settle
        }
      }
    }

    // Emit status change event if status actually changed
    if (previousStatus !== instance.status) {
      this.emit('agentStatusChange', {
        agentId: instance.agent.id,
        agentName: instance.agent.name,
        previousStatus,
        newStatus: instance.status,
        reason: 'smart-activity-detector',
        confidence: decision.confidence,
        timestamp: new Date()
      });
    }
  }

  /**
   * Get activity detector statistics for monitoring
   */
  getActivityDetectorStats(): any {
    return this.activityDetector.getDetectorStats();
  }

  /**
   * Get activity state for specific agent
   */
  getAgentActivityState(agentId: string): any {
    const instance = this.agentInstances.get(agentId);
    if (!instance) return null;
    
    return this.activityDetector.getTerminalStats(instance.terminalId);
  }

  /**
   * Check if a message is from a human (not an AI agent)
   */
  private isHumanMessage(message: any): boolean {
    // Check for human indicators
    const humanIndicators = [
      'human',
      'admin',
      'user',
      'monitor',
      'supervisor',
      'manager'
    ];
    
    const senderName = message.senderName?.toLowerCase() || '';
    
    // Check if sender name contains human indicators
    if (humanIndicators.some(indicator => senderName.includes(indicator))) {
      return true;
    }
    
    // Check if message contains override commands typically used by humans
    const content = message.content?.toLowerCase() || '';
    const overridePatterns = [
      'activate agent',
      'force activate',
      'override activate',
      'human command',
      'admin command',
      'monitor command',
      'urgent activate',
      'immediately activate'
    ];
    
    return overridePatterns.some(pattern => content.includes(pattern)) ||
           this.isPauseCommand(content) ||
           this.isResumeCommand(content);
  }

  /**
   * Handle human override commands with highest priority
   */
  private async handleHumanOverride(message: any): Promise<void> {
    console.log(chalk.magenta(`👨‍💻 HUMAN OVERRIDE detected from ${message.senderName}`));
    console.log(chalk.magenta(`   Message: "${message.content}"`));
    
    const content = message.content.toLowerCase();
    
    // PRIORITY 1: Handle pause/resume commands
    if (this.isPauseCommand(content)) {
      await this.handlePauseCommand(message);
      return;
    }
    
    if (this.isResumeCommand(content)) {
      await this.handleResumeCommand(message);
      return;
    }
    
    // If system is paused, only allow resume commands
    if (this.isPaused) {
      console.log(chalk.yellow(`⏸️ System is PAUSED by ${this.pausedBy}. Only resume commands accepted.`));
      await this.sendPausedNotification(message);
      return;
    }
    
    // Parse activation commands
    if (content.includes('activate')) {
      const targetAgents = this.parseActivationTargets(message.content);
      
      for (const target of targetAgents) {
        const agent = this.findAgentByNameOrRole(target);
        
        if (agent) {
          console.log(chalk.magenta(`🚨 HUMAN OVERRIDE: Force activating ${agent.agent.name} regardless of current status`));
          
          // Force activation regardless of current status
          await this.forceActivateAgent(agent, message);
          
          // Update status immediately
          agent.status = 'busy';
          agent.lastActivity = new Date();
          
          // Clear idle prompt tracking
          this.idlePromptsSent.delete(agent.agent.id);
          
          // Send Discord notification for human override
          if (this.discordAlerter) {
            await this.discordAlerter.sendEscalationAlert({
              id: `human-override-${Date.now()}`,
              severity: 'high',
              title: 'Human Override: Agent Force Activated',
              description: `Human ${message.senderName} force activated ${agent.agent.name}. Message: "${message.content}"`,
              reportedBy: message.senderName,
              affectedAgents: [agent.agent.id],
              suggestedAction: 'Monitor agent response to human command',
              timestamp: new Date()
            }, this.agentInstances);
          }
        } else {
          console.log(chalk.yellow(`⚠️ Could not find agent matching: ${target}`));
        }
      }
    }
    
    // Handle other human commands
    if (content.includes('status') || content.includes('report')) {
      await this.sendTeamStatusToHuman(message);
    }
  }

  /**
   * Parse activation targets from human message
   */
  private parseActivationTargets(content: string): string[] {
    const targets: string[] = [];
    
    // Look for @mentions first
    const mentionMatches = content.match(/@([a-zA-Z_][a-zA-Z0-9_\s]*)/g);
    if (mentionMatches) {
      targets.push(...mentionMatches.map(m => m.substring(1).trim()));
    }
    
    // Look for role names
    const roleNames = [
      'coordinator', 'project coordinator',
      'architect', 'system architect', 
      'frontend', 'frontend developer',
      'backend', 'backend developer',
      'qa', 'qa engineer',
      'ui/ux', 'ui ux engineer',
      'devops', 'devops engineer',
      'product manager'
    ];
    
    const lowerContent = content.toLowerCase();
    for (const role of roleNames) {
      if (lowerContent.includes(role)) {
        targets.push(role);
      }
    }
    
    // Look for agent names directly
    for (const [, instance] of this.agentInstances) {
      const agentName = instance.agent.name.toLowerCase();
      if (lowerContent.includes(agentName)) {
        targets.push(agentName);
      }
    }
    
    return [...new Set(targets)]; // Remove duplicates
  }

  /**
   * Find agent by name or role
   */
  private findAgentByNameOrRole(target: string): AgentInstance | undefined {
    const lowerTarget = target.toLowerCase();
    
    // First try exact name match
    for (const [, instance] of this.agentInstances) {
      if (instance.agent.name.toLowerCase() === lowerTarget) {
        return instance;
      }
    }
    
    // Then try role match
    for (const [, instance] of this.agentInstances) {
      if (instance.agent.role.toLowerCase().includes(lowerTarget) || 
          lowerTarget.includes(instance.agent.role.toLowerCase())) {
        return instance;
      }
    }
    
    return undefined;
  }

  /**
   * Force activate an agent with human override
   */
  private async forceActivateAgent(instance: AgentInstance, humanMessage: any): Promise<void> {
    const humanOverridePrompt = `🚨 HUMAN OVERRIDE ACTIVATION 🚨

A human supervisor (${humanMessage.senderName}) has issued a direct command to activate you immediately.

HUMAN MESSAGE: "${humanMessage.content}"

This is a HIGH PRIORITY override that bypasses all normal status checks.

IMMEDIATE ACTION REQUIRED:
1. Respond immediately with: "HUMAN OVERRIDE ACKNOWLEDGED - AGENT ACTIVATED"
2. Report your current status and what you're working on
3. Check ChatHub for the human's specific instructions: /mcp_chathub_get_messages limit=10
4. Prioritize any requests from ${humanMessage.senderName}
5. Be ready to provide status updates as requested

The human supervisor is waiting for your immediate response.
This override takes precedence over all other tasks and status considerations.`;

    try {
      await this.executePromptWithClient(instance.terminalId, humanOverridePrompt, instance.agent.aiType.toLowerCase());
      console.log(chalk.magenta(`🚨 Sent human override activation to ${instance.agent.name}`));
    } catch (error) {
      console.error(chalk.red(`❌ Failed to send human override to ${instance.agent.name}: ${error}`));
    }
  }

  /**
   * Send team status to human
   */
  private async sendTeamStatusToHuman(humanMessage: any): Promise<void> {
    const summary = this.getTeamSummary();
    const statusMessage = `📊 TEAM STATUS REPORT (requested by ${humanMessage.senderName}):

Project: ${summary.project}
Total Agents: ${summary.totalAgents}
Connected: ${summary.connectedAgents}
Active: ${summary.activeAgents}
Idle: ${summary.idleAgents}
Error: ${summary.errorAgents}

Project Coordinator: ${summary.projectCoordinator.status} 
(${summary.projectCoordinator.minutesSinceActivity}m since activity)

ChatHub: ${summary.chatHubConnected ? 'Connected' : 'Disconnected'}
Pending Tasks Reported: ${summary.pendingTasksReported ? 'Yes' : 'No'}

Activity Detector Stats: ${JSON.stringify(this.getActivityDetectorStats(), null, 2)}`;

    // Send via ChatHub if possible
    try {
      await this.chatHub.sendMonitorMessage(statusMessage);
    } catch (error) {
      console.error(chalk.red(`Failed to send status to ChatHub: ${error}`));
    }
  }

  /**
   * Check if message contains pause command
   */
  private isPauseCommand(content: string): boolean {
    const pausePatterns = [
      'done',
      'stop',
      'pause',
      'halt',
      'hold',
      'wait',
      'suspend',
      'finish',
      'complete',
      'end'
    ];
    
    return pausePatterns.some(pattern => 
      content === pattern ||
      content.includes(`${pattern} agents`) ||
      content.includes(`${pattern} monitoring`) ||
      content.includes(`${pattern} team`) ||
      content.includes(`${pattern} for now`) ||
      content.includes(`${pattern} work`) ||
      content.includes(`${pattern} everything`) ||
      content.includes(`${pattern} all`) ||
      (pattern === 'done' && (content.includes('all done') || content.includes('we are done'))) ||
      (pattern === 'stop' && (content.includes('stop all') || content.includes('stop now')))
    );
  }
  
  /**
   * Check if message contains resume command
   */
  private isResumeCommand(content: string): boolean {
    const resumePatterns = [
      'continue',
      'resume',
      'start',
      'go',
      'proceed',
      'keep going',
      'carry on',
      'restart',
      'begin again',
      'activate again',
      'back to work',
      'let\'s go'
    ];
    
    return resumePatterns.some(pattern => content.includes(pattern));
  }
  
  /**
   * Handle pause command from human
   */
  private async handlePauseCommand(message: any): Promise<void> {
    if (this.isPaused) {
      console.log(chalk.yellow(`⏸️ System already paused by ${this.pausedBy} at ${this.pausedAt?.toLocaleString()}`));
      return;
    }
    
    this.isPaused = true;
    this.pausedBy = message.senderName;
    this.pausedAt = new Date();
    
    console.log(chalk.red(`⏸️ SYSTEM PAUSED by ${message.senderName} at ${this.pausedAt.toLocaleString()}`));
    console.log(chalk.red(`   Message: "${message.content}"`));
    console.log(chalk.red(`   All agent monitoring and activation suspended`));
    
    // Notify via ChatHub
    try {
      await this.chatHub.sendMonitorMessage(
        `🛑 SYSTEM PAUSED by ${message.senderName}\n` +
        `Time: ${this.pausedAt.toLocaleString()}\n` +
        `Message: "${message.content}"\n\n` +
        `All agent monitoring and activation suspended until further instruction.\n` +
        `Send "continue", "resume", or "keep going" to resume operations.`
      );
    } catch (error) {
      console.error(chalk.red(`Failed to send pause notification: ${error}`));
    }
    
    // Send Discord notification
    if (this.discordAlerter) {
      await this.discordAlerter.sendEscalationAlert({
        id: `system-paused-${Date.now()}`,
        severity: 'critical',
        title: 'System Paused by Human',
        description: `${message.senderName} paused the agent monitoring system. Message: "${message.content}"`,
        reportedBy: message.senderName,
        affectedAgents: Array.from(this.agentInstances.keys()),
        suggestedAction: 'System paused - monitoring suspended until resumed by human',
        timestamp: new Date()
      }, this.agentInstances);
    }
  }
  
  /**
   * Handle resume command from human
   */
  private async handleResumeCommand(message: any): Promise<void> {
    if (!this.isPaused) {
      console.log(chalk.green(`▶️ System is already running normally`));
      return;
    }
    
    const pauseDuration = this.pausedAt ? Date.now() - this.pausedAt.getTime() : 0;
    const previousPausedBy = this.pausedBy;
    
    this.isPaused = false;
    this.pausedBy = '';
    this.pausedAt = null;
    
    console.log(chalk.green(`▶️ SYSTEM RESUMED by ${message.senderName}`));
    console.log(chalk.green(`   Previously paused by: ${previousPausedBy}`));
    console.log(chalk.green(`   Pause duration: ${Math.round(pauseDuration / 1000)}s`));
    console.log(chalk.green(`   Message: "${message.content}"`));
    console.log(chalk.green(`   Agent monitoring and activation restored`));
    
    // Notify via ChatHub
    try {
      await this.chatHub.sendMonitorMessage(
        `✅ SYSTEM RESUMED by ${message.senderName}\n` +
        `Previously paused by: ${previousPausedBy}\n` +
        `Pause duration: ${Math.round(pauseDuration / (1000 * 60))} minutes\n` +
        `Message: "${message.content}"\n\n` +
        `Agent monitoring and activation restored. Checking agent status...`
      );
    } catch (error) {
      console.error(chalk.red(`Failed to send resume notification: ${error}`));
    }
    
    // Send Discord notification
    if (this.discordAlerter) {
      await this.discordAlerter.sendEscalationAlert({
        id: `system-resumed-${Date.now()}`,
        severity: 'low',
        title: 'System Resumed by Human',
        description: `${message.senderName} resumed the agent monitoring system after ${Math.round(pauseDuration / (1000 * 60))} minutes pause.`,
        reportedBy: message.senderName,
        affectedAgents: Array.from(this.agentInstances.keys()),
        suggestedAction: 'System resumed - checking agent status and activating if needed',
        timestamp: new Date()
      }, this.agentInstances);
    }
    
    // After resuming, check and activate idle agents if needed
    setTimeout(async () => {
      console.log(chalk.blue(`🔄 Post-resume: Checking agent status and activating if needed...`));
      await this.checkAndPromptIdleAgents();
    }, 2000);
  }
  
  /**
   * Send notification that system is paused
   */
  private async sendPausedNotification(_message: any): Promise<void> {
    const pauseDuration = this.pausedAt ? Date.now() - this.pausedAt.getTime() : 0;
    
    try {
      await this.chatHub.sendMonitorMessage(
        `⏸️ System is currently PAUSED\n` +
        `Paused by: ${this.pausedBy}\n` +
        `Paused since: ${this.pausedAt?.toLocaleString()}\n` +
        `Duration: ${Math.round(pauseDuration / (1000 * 60))} minutes\n\n` +
        `Agent monitoring and activation suspended.\n` +
        `Send "continue", "resume", or "keep going" to resume operations.`
      );
    } catch (error) {
      console.error(chalk.red(`Failed to send paused notification: ${error}`));
    }
  }

  /**
   * Utility: Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if we should log a message (deduplication helper)
   */
  private shouldLogMessage(agentId: string, messageType: string, thresholdMs: number): boolean {
    let lastMessageMap: Map<string, Date>;
    
    switch (messageType) {
      case 'task_completion':
        lastMessageMap = this.lastTaskCompletionMessage;
        break;
      case 'connection':
        lastMessageMap = this.lastConnectionMessage;
        break;
      case 'escalation':
        lastMessageMap = this.lastEscalationMessage;
        break;
      case 'status':
        lastMessageMap = this.lastStatusMessage;
        break;
      default:
        return true; // Allow unknown message types
    }
    
    const lastMessage = lastMessageMap.get(agentId);
    if (!lastMessage) {
      return true; // First message of this type
    }
    
    const timeSinceLastMessage = Date.now() - lastMessage.getTime();
    return timeSinceLastMessage >= thresholdMs;
  }

  /**
   * Detect task completion with improved accuracy to prevent false positives
   */
  private detectTaskCompletion(response: string): boolean {
    // More specific patterns to avoid false positives from casual emoji use
    const taskCompletionPatterns = [
      'TASK COMPLETED',
      'task completed',
      'Task completed',
      '✅ Completed',
      '✅ Done',
      '✅ Finished',
      'completed the task',
      'finished the task',
      'task is done',
      'work is complete',
      'implementation complete'
    ];
    
    // Avoid triggering on casual emoji use
    const casualPatterns = [
      '✅ Connected',
      '✅ Available',
      '✅ Ready',
      '✅ Understood',
      '✅ Got it',
      '✅ Okay',
      '✅ Sure',
      '✅ Yes'
    ];
    
    const lowerResponse = response.toLowerCase();
    
    // Check for casual patterns first - if found, don't treat as task completion
    for (const casualPattern of casualPatterns) {
      if (response.includes(casualPattern)) {
        return false;
      }
    }
    
    // Check for actual task completion patterns
    return taskCompletionPatterns.some(pattern => {
      return lowerResponse.includes(pattern.toLowerCase());
    });
  }
}