/**
 * Enhanced Team Orchestrator - Integrates all communication enforcement modules
 * Based on communication-enforce.md requirements and existing TeamOrchestrator
 */

import { EventEmitter } from 'events';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

import { TeamOrchestrator } from './team-orchestrator';
import { AutoTerminalClient } from './api-client';
import { AgentDetector } from './agent-detector';
import { PromptManager } from './prompt-manager';

// Import enhancement modules
import { GitDisciplineEnforcer, GitDisciplineConfig } from './git-discipline-enforcer';
import { CommunicationProtocolEnforcer } from './communication-protocol-enforcer';
import { TerminalNamingManager, NamingConvention } from './terminal-naming-manager';
import { QualityGateManager, QualityStandards } from './quality-gate-manager';

// Import configuration
import { 
  EnhancedTeamConfiguration, 
  EnforcementConfiguration,
  DEFAULT_ENFORCEMENT_CONFIG,
  ConfigurationValidator,
  ConfigurationUtils
} from './enforcement-config';

import { TeamConfiguration, AgentInstance, AgentRole } from './team-types';

export class EnhancedTeamOrchestrator extends EventEmitter {
  private baseOrchestrator: TeamOrchestrator;
  private enforcementConfig: EnforcementConfiguration;
  
  // Enhancement modules
  private gitEnforcer: GitDisciplineEnforcer;
  private namingManager: TerminalNamingManager;
  private protocolEnforcer: CommunicationProtocolEnforcer;
  private qualityGates: QualityGateManager;

  // State tracking
  private isEnhanced: boolean = true;
  private startupComplete: boolean = false;
  private agentInstances: Map<string, AgentInstance> = new Map();

  constructor(
    client: AutoTerminalClient,
    detector: AgentDetector,
    promptManager: PromptManager,
    configPath: string,
    chatHubWsUrl: string,
    useHeadlessMode: boolean = false,
    enforcementConfigPath?: string
  ) {
    super();

    // Load enhanced configuration
    const enhancedConfig = this.loadEnhancedConfiguration(configPath, enforcementConfigPath);
    this.enforcementConfig = enhancedConfig.enforcement;

    // Create base orchestrator
    this.baseOrchestrator = new TeamOrchestrator(
      client,
      detector,
      promptManager,
      configPath,
      chatHubWsUrl,
      useHeadlessMode
    );

    // Initialize enhancement modules
    this.initializeEnhancementModules(client);
    
    // Set up event forwarding and enhancement integration
    this.setupEventIntegration();

    console.log(chalk.green('🚀 Enhanced Team Orchestrator initialized'));
    this.printEnhancementStatus();
  }

  /**
   * Load enhanced team configuration
   */
  private loadEnhancedConfiguration(
    configPath: string, 
    enforcementConfigPath?: string
  ): EnhancedTeamConfiguration {
    try {
      // Load base team configuration
      const baseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as TeamConfiguration;
      
      let enforcementConfig = DEFAULT_ENFORCEMENT_CONFIG;
      
      // Load enforcement configuration if provided
      if (enforcementConfigPath && fs.existsSync(enforcementConfigPath)) {
        const customEnforcement = JSON.parse(fs.readFileSync(enforcementConfigPath, 'utf-8'));
        enforcementConfig = ConfigurationUtils.mergeWithDefaults(customEnforcement);
      }

      const enhancedConfig: EnhancedTeamConfiguration = {
        ...baseConfig,
        enforcement: enforcementConfig
      };

      // Validate configuration
      const validation = ConfigurationValidator.validateTeamConfiguration(enhancedConfig);
      if (!validation.isValid) {
        console.error(chalk.red('❌ Configuration validation failed:'));
        validation.errors.forEach(error => console.error(chalk.red(`  • ${error}`)));
        process.exit(1);
      }

      if (validation.warnings.length > 0) {
        console.warn(chalk.yellow('⚠️  Configuration warnings:'));
        validation.warnings.forEach(warning => console.warn(chalk.yellow(`  • ${warning}`)));
      }

      return enhancedConfig;

    } catch (error) {
      console.error(chalk.red(`❌ Failed to load enhanced configuration: ${error}`));
      process.exit(1);
    }
  }

  /**
   * Initialize all enhancement modules
   */
  private initializeEnhancementModules(client: AutoTerminalClient): void {
    console.log(chalk.blue('🏗️  Initializing enhancement modules...'));

    // Git Discipline Enforcer
    if (this.enforcementConfig.gitDiscipline.enabled) {
      this.gitEnforcer = new GitDisciplineEnforcer(this.enforcementConfig.gitDiscipline);
      this.setupGitEnforcerEvents();
      console.log(chalk.green('✅ Git Discipline Enforcer initialized'));
    }

    // Terminal Naming Manager
    if (this.enforcementConfig.terminalNaming.enabled) {
      this.namingManager = new TerminalNamingManager(client, this.enforcementConfig.terminalNaming);
      this.setupNamingManagerEvents();
      console.log(chalk.green('✅ Terminal Naming Manager initialized'));
    }

    // Communication Protocol Enforcer
    if (this.enforcementConfig.communicationProtocol.enabled) {
      this.protocolEnforcer = new CommunicationProtocolEnforcer();
      this.setupProtocolEnforcerEvents();
      console.log(chalk.green('✅ Communication Protocol Enforcer initialized'));
    }

    // Quality Gate Manager
    if (this.enforcementConfig.qualityGates.enabled) {
      this.qualityGates = new QualityGateManager(this.enforcementConfig.qualityGates);
      this.setupQualityGateEvents();
      console.log(chalk.green('✅ Quality Gate Manager initialized'));
    }

    console.log(chalk.green('🎉 All enhancement modules initialized successfully'));
  }

  /**
   * Set up event integration between base orchestrator and enhancements
   */
  private setupEventIntegration(): void {
    // Forward important events from base orchestrator
    this.baseOrchestrator.on('agentStarted', (data) => {
      this.handleAgentStarted(data);
      this.emit('agentStarted', data);
    });

    this.baseOrchestrator.on('agentMessage', (data) => {
      this.handleAgentMessage(data);
      this.emit('agentMessage', data);
    });

    this.baseOrchestrator.on('taskCompleted', (data) => {
      this.handleTaskCompleted(data);
      this.emit('taskCompleted', data);
    });

    this.baseOrchestrator.on('teamStarted', (data) => {
      this.handleTeamStarted(data);
      this.emit('teamStarted', data);
    });
  }

  /**
   * Set up Git Discipline Enforcer events
   */
  private setupGitEnforcerEvents(): void {
    if (!this.gitEnforcer) return;

    this.gitEnforcer.on('commitReminderRequired', (data) => {
      this.sendMessageToAgent(data.agentId, data.message);
      console.log(chalk.yellow(`⏰ Git reminder sent to ${data.agentId}`));
    });

    this.gitEnforcer.on('workTimeWarningRequired', (data) => {
      this.sendMessageToAgent(data.agentId, data.message);
      console.log(chalk.red(`🚨 Work time warning sent to ${data.agentId}`));
    });

    this.gitEnforcer.on('monitoringStarted', (data) => {
      console.log(chalk.blue(`🔍 Git monitoring started for ${data.agentId}`));
    });
  }

  /**
   * Set up Terminal Naming Manager events
   */
  private setupNamingManagerEvents(): void {
    if (!this.namingManager) return;

    this.namingManager.on('renamingPromptRequired', async (data) => {
      if (this.enforcementConfig.terminalNaming.autoPromptOnStartup) {
        await this.handleTerminalRenamingPrompt();
      }
    });

    this.namingManager.on('terminalRenamed', (data) => {
      console.log(chalk.green(`🏷️  Terminal renamed: ${data.oldName} → ${data.newName}`));
    });
  }

  /**
   * Set up Communication Protocol Enforcer events
   */
  private setupProtocolEnforcerEvents(): void {
    if (!this.protocolEnforcer) return;

    this.protocolEnforcer.on('antiPatternDetected', (data) => {
      console.warn(chalk.yellow(`⚠️  Anti-pattern detected: ${data.antiPattern.violationType}`));
      
      if (data.antiPattern.severity === 'critical') {
        this.escalateToHuman(`Critical communication anti-pattern: ${data.antiPattern.violationType}`, data);
      }
    });
  }

  /**
   * Set up Quality Gate Manager events
   */
  private setupQualityGateEvents(): void {
    if (!this.qualityGates) return;

    this.qualityGates.on('qualityGatePassed', (data) => {
      console.log(chalk.green(`🎉 Quality gate passed: ${data.gateId}`));
      this.notifyAgentsOfQualityGate(data.gateId, 'passed');
    });

    this.qualityGates.on('qualityGateFailed', (data) => {
      console.log(chalk.red(`❌ Quality gate failed: ${data.gateId}`));
      this.notifyAgentsOfQualityGate(data.gateId, 'failed', data.failedChecks);
    });
  }

  /**
   * Enhanced startup sequence with communication enforcement
   */
  async start(): Promise<void> {
    console.log(chalk.cyan('🚀 Starting Enhanced Team Orchestrator...'));

    try {
      // Step 1: Terminal naming prompt and setup
      if (this.enforcementConfig.terminalNaming.enabled && 
          this.enforcementConfig.terminalNaming.autoPromptOnStartup) {
        await this.handleTerminalRenamingPrompt();
      }

      // Step 2: Start base orchestrator
      await this.baseOrchestrator.start();

      // Step 3: Initialize project lifecycle if enabled
      if (this.enforcementConfig.projectLifecycle.enabled) {
        await this.initializeProjectLifecycle();
      }

      // Step 4: Set up quality gates for the project
      if (this.enforcementConfig.qualityGates.enabled) {
        await this.setupProjectQualityGates();
      }

      this.startupComplete = true;
      console.log(chalk.green('✅ Enhanced Team Orchestrator started successfully'));

    } catch (error) {
      console.error(chalk.red(`❌ Failed to start Enhanced Team Orchestrator: ${error}`));
      throw error;
    }
  }

  /**
   * Handle terminal renaming prompt and process
   */
  private async handleTerminalRenamingPrompt(): Promise<void> {
    if (!this.namingManager) return;

    try {
      console.log(chalk.cyan('\n🏷️  Terminal Organization'));
      console.log(chalk.white('Analyzing terminals for descriptive naming...'));

      const analyses = await this.namingManager.analyzeAllTerminals();
      
      if (analyses.length > 0) {
        console.log(chalk.blue(`Found ${analyses.length} terminals to potentially rename:`));
        
        analyses.forEach(analysis => {
          console.log(chalk.gray(`  • "${analysis.currentName}" → "${analysis.suggestedName}" (${(analysis.confidence * 100).toFixed(0)}% confidence)`));
        });

        // Apply suggestions automatically if configured
        if (this.enforcementConfig.terminalNaming.autoRename) {
          await this.namingManager.applyNamingSuggestions(
            analyses, 
            this.enforcementConfig.terminalNaming.minimumConfidence
          );
        }
      } else {
        console.log(chalk.gray('No terminals found that need renaming.'));
      }

    } catch (error) {
      console.error(chalk.red(`❌ Terminal naming failed: ${error}`));
    }
  }

  /**
   * Initialize project lifecycle management
   */
  private async initializeProjectLifecycle(): Promise<void> {
    console.log(chalk.blue('🏗️  Initializing project lifecycle management...'));
    
    // This would implement the project discovery and startup sequence
    // from communication-enforce.md requirements
    
    // For now, just log that it's initialized
    console.log(chalk.green('✅ Project lifecycle management initialized'));
  }

  /**
   * Setup quality gates for the project phases
   */
  private async setupProjectQualityGates(): Promise<void> {
    if (!this.qualityGates) return;

    console.log(chalk.blue('🚪 Setting up project quality gates...'));

    try {
      // Create quality gates for each project phase
      const phases = ['requirements', 'design', 'implementation', 'testing', 'integration', 'deployment'];
      
      for (const phase of phases) {
        const gateId = `${phase}-gate`;
        const gateName = `${phase.charAt(0).toUpperCase() + phase.slice(1)} Quality Gate`;
        
        this.qualityGates.createQualityGate(
          gateId,
          gateName,
          phase as any,
          ['Project Coordinator', 'QA Engineer'],
          ['Backend Developer', 'Frontend Developer']
        );
      }

      console.log(chalk.green(`✅ Created ${phases.length} quality gates`));

    } catch (error) {
      console.error(chalk.red(`❌ Failed to setup quality gates: ${error}`));
    }
  }

  /**
   * Handle agent started event with enhancements
   */
  private handleAgentStarted(data: any): void {
    const agentId = data.agentId || data.agent?.id;
    if (!agentId) return;

    // Start git discipline monitoring
    if (this.gitEnforcer && this.enforcementConfig.gitDiscipline.enabled) {
      const workingDirectory = data.workingDirectory || process.cwd();
      this.gitEnforcer.startMonitoring(data.agent, workingDirectory);
    }

    // Store agent instance for tracking
    if (data.agent) {
      this.agentInstances.set(agentId, data.agent);
    }

    console.log(chalk.green(`🤖 Enhanced monitoring started for agent: ${agentId}`));
  }

  /**
   * Handle agent message with communication protocol enforcement
   */
  private handleAgentMessage(data: any): void {
    if (!this.protocolEnforcer || !this.enforcementConfig.communicationProtocol.enabled) {
      return;
    }

    const { fromAgent, fromRole, toAgent, toRole, message } = data;
    
    // Validate message against communication protocols
    const validation = this.protocolEnforcer.validateMessage(
      fromAgent,
      fromRole,
      toAgent,
      toRole,
      message
    );

    if (!validation.isValid) {
      console.warn(chalk.yellow(`📝 Communication protocol violation by ${fromAgent}:`));
      validation.suggestions.forEach(suggestion => {
        console.warn(chalk.yellow(`  • ${suggestion}`));
      });

      // Send feedback to agent
      const feedbackMessage = this.generateCommunicationFeedback(validation);
      this.sendMessageToAgent(fromAgent, feedbackMessage);
    }

    // Track message for anti-pattern detection
    this.protocolEnforcer.trackMessage(
      fromAgent,
      fromRole,
      [toAgent],
      message
    );
  }

  /**
   * Handle task completed with quality gate checks
   */
  private handleTaskCompleted(data: any): void {
    if (!this.qualityGates || !this.enforcementConfig.qualityGates.enabled) {
      return;
    }

    const { agentId, taskId, phase } = data;
    
    // Check if any quality gates are blocking for this phase
    const agentInstance = this.agentInstances.get(agentId);
    if (agentInstance) {
      const blockingInfo = this.qualityGates.canAgentProceed(agentInstance.agent.role, phase);
      
      if (!blockingInfo.canProceed) {
        console.warn(chalk.yellow(`🚫 Agent ${agentId} blocked by quality gates: ${blockingInfo.reason}`));
        
        const blockingMessage = this.generateQualityGateBlockingMessage(blockingInfo.blockingGates);
        this.sendMessageToAgent(agentId, blockingMessage);
      }
    }
  }

  /**
   * Handle team started event
   */
  private handleTeamStarted(data: any): void {
    console.log(chalk.green('👥 Enhanced team orchestration started'));
    
    // Start continuous quality monitoring if enabled
    if (this.qualityGates && this.enforcementConfig.qualityGates.continuousMonitoringEnabled) {
      this.startContinuousQualityMonitoring();
    }
  }

  /**
   * Generate communication feedback message
   */
  private generateCommunicationFeedback(validation: any): string {
    let feedback = '📝 **Communication Protocol Feedback**\n\n';
    feedback += '❌ Your message did not follow the required communication templates.\n\n';
    
    if (validation.suggestions.length > 0) {
      feedback += '**Suggestions for improvement:**\n';
      validation.suggestions.forEach((suggestion: string) => {
        feedback += `• ${suggestion}\n`;
      });
    }

    if (validation.template) {
      feedback += '\n**Expected format:**\n';
      feedback += `\`\`\`\n${validation.template.example}\n\`\`\``;
    }

    return feedback;
  }

  /**
   * Generate quality gate blocking message
   */
  private generateQualityGateBlockingMessage(blockingGates: any[]): string {
    let message = '🚫 **Quality Gate Blocking**\n\n';
    message += 'Your progress is currently blocked by the following quality gates:\n\n';
    
    blockingGates.forEach(gate => {
      message += `**${gate.name}** (${gate.phase})\n`;
      message += `Status: ${gate.overallStatus}\n`;
      
      const failedChecks = Object.entries(gate.checklist)
        .filter(([_, check]: [string, any]) => check.required && check.status === 'failed')
        .map(([type, _]) => type);
      
      if (failedChecks.length > 0) {
        message += `Failed checks: ${failedChecks.join(', ')}\n`;
      }
      message += '\n';
    });

    message += 'Please work with the Project Coordinator to resolve these quality issues before proceeding.';
    return message;
  }

  /**
   * Start continuous quality monitoring
   */
  private startContinuousQualityMonitoring(): void {
    if (!this.qualityGates) return;

    // Start monitoring for all active quality gates
    const activeGates = Array.from(this.qualityGates['qualityGates'].values())
      .filter(gate => gate.overallStatus !== 'passed');

    activeGates.forEach(gate => {
      this.qualityGates.startContinuousMonitoring(gate.id, 30); // 30-minute intervals
    });

    console.log(chalk.blue(`📡 Started continuous monitoring for ${activeGates.length} quality gates`));
  }

  /**
   * Notify agents of quality gate status changes
   */
  private notifyAgentsOfQualityGate(gateId: string, status: string, failedChecks?: any[]): void {
    const message = status === 'passed' 
      ? `🎉 Quality gate **${gateId}** has passed. You may proceed to the next phase.`
      : `❌ Quality gate **${gateId}** has failed. Please address the issues before proceeding.`;

    // Notify all agents
    this.agentInstances.forEach((agent, agentId) => {
      this.sendMessageToAgent(agentId, message);
    });
  }

  /**
   * Send message to specific agent
   */
  private sendMessageToAgent(agentId: string, message: string): void {
    // This would integrate with the ChatHub or terminal messaging system
    console.log(chalk.blue(`📤 Message to ${agentId}: ${message.substring(0, 100)}...`));
    
    // Emit event for base orchestrator to handle actual messaging
    this.emit('sendMessageToAgent', {
      agentId,
      message,
      timestamp: new Date()
    });
  }

  /**
   * Escalate critical issues to human oversight
   */
  private escalateToHuman(issue: string, data: any): void {
    if (!this.enforcementConfig.humanInteraction.escalationToHuman) {
      return;
    }

    console.log(chalk.red(`🚨 ESCALATING TO HUMAN: ${issue}`));
    
    this.emit('humanEscalationRequired', {
      issue,
      severity: 'critical',
      data,
      timestamp: new Date()
    });

    // Send to configured notification channels
    this.enforcementConfig.humanInteraction.notificationChannels.forEach(channel => {
      this.sendNotification(channel, issue, data);
    });
  }

  /**
   * Send notification to external channel
   */
  private sendNotification(channel: string, issue: string, data: any): void {
    switch (channel) {
      case 'discord':
        // Would integrate with Discord webhook
        console.log(chalk.yellow(`📢 Discord notification: ${issue}`));
        break;
      case 'console':
        console.log(chalk.red(`🚨 ALERT: ${issue}`));
        break;
      default:
        console.log(chalk.gray(`📢 ${channel} notification: ${issue}`));
    }
  }

  /**
   * Print enhancement status summary
   */
  private printEnhancementStatus(): void {
    console.log(chalk.cyan('\n📊 Enhancement Modules Status:'));
    console.log(chalk.white('┌─────────────────────────────────────┬─────────┐'));
    console.log(chalk.white('│ Module                              │ Status  │'));
    console.log(chalk.white('├─────────────────────────────────────┼─────────┤'));
    
    const modules = [
      ['Git Discipline Enforcer', this.enforcementConfig.gitDiscipline.enabled],
      ['Terminal Naming Manager', this.enforcementConfig.terminalNaming.enabled],
      ['Communication Protocol Enforcer', this.enforcementConfig.communicationProtocol.enabled],
      ['Quality Gate Manager', this.enforcementConfig.qualityGates.enabled],
      ['Project Lifecycle Manager', this.enforcementConfig.projectLifecycle.enabled],
      ['Anti-Pattern Prevention', this.enforcementConfig.antiPatternPrevention.enabled]
    ];

    modules.forEach(([name, enabled]) => {
      const status = enabled ? chalk.green('✅ ON ') : chalk.red('❌ OFF');
      console.log(`│ ${name.padEnd(35)} │ ${status} │`);
    });

    console.log(chalk.white('└─────────────────────────────────────┴─────────┘\n'));
  }

  /**
   * Export enhanced configuration
   */
  exportConfiguration(): string {
    const config: EnhancedTeamConfiguration = {
      teamConfig: (this.baseOrchestrator as any).teamConfig.teamConfig,
      agents: (this.baseOrchestrator as any).teamConfig.agents,
      enforcement: this.enforcementConfig
    };

    return ConfigurationUtils.exportConfiguration(config);
  }

  /**
   * Get enhancement statistics
   */
  getEnhancementStatistics(): any {
    const stats: any = {
      enhancementModules: {
        gitDiscipline: this.gitEnforcer ? this.gitEnforcer.getStatistics() : null,
        terminalNaming: this.namingManager ? this.namingManager.getStatistics() : null,
        communicationProtocol: this.protocolEnforcer ? this.protocolEnforcer.getStatistics() : null,
        qualityGates: this.qualityGates ? this.qualityGates.getQualityStatistics() : null
      },
      configuration: this.enforcementConfig,
      startupComplete: this.startupComplete,
      activeAgents: this.agentInstances.size
    };

    return stats;
  }

  /**
   * Shutdown enhancement modules
   */
  async shutdown(): Promise<void> {
    console.log(chalk.yellow('🛑 Shutting down Enhanced Team Orchestrator...'));

    // Stop git discipline monitoring
    if (this.gitEnforcer) {
      this.agentInstances.forEach((_, agentId) => {
        this.gitEnforcer.stopMonitoring(agentId);
      });
    }

    // Cleanup quality gate monitoring
    if (this.qualityGates) {
      this.qualityGates.cleanup();
    }

    // Shutdown base orchestrator
    if (this.baseOrchestrator && typeof this.baseOrchestrator.shutdown === 'function') {
      await this.baseOrchestrator.shutdown();
    }

    console.log(chalk.green('✅ Enhanced Team Orchestrator shutdown complete'));
  }

  // Proxy methods to base orchestrator for backward compatibility
  async deployTeam(): Promise<void> {
    return this.baseOrchestrator.deployTeam();
  }

  pause(): void {
    if (typeof this.baseOrchestrator.pause === 'function') {
      this.baseOrchestrator.pause();
    }
  }

  resume(): void {
    if (typeof this.baseOrchestrator.resume === 'function') {
      this.baseOrchestrator.resume();
    }
  }

  getStatus(): any {
    const baseStatus = typeof this.baseOrchestrator.getStatus === 'function' 
      ? this.baseOrchestrator.getStatus() 
      : {};
    
    return {
      ...baseStatus,
      enhanced: true,
      enhancementStatistics: this.getEnhancementStatistics()
    };
  }
}