#!/usr/bin/env node

/**
 * Enhanced Team Orchestration Startup Script
 * Starts team with communication enforcement and quality management
 */

const { EnhancedTeamOrchestrator } = require('./dist/enhanced-team-orchestrator');
const { AutoTerminalClient } = require('./dist/api-client');
const { AgentDetector } = require('./dist/agent-detector');
const { PromptManager } = require('./dist/prompt-manager');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  apiUrl: process.env.API_URL || 'http://localhost:3001',
  wsUrl: process.env.WS_URL || 'ws://localhost:9876',
  token: process.env.API_TOKEN || '',
  chatHubUrl: process.env.CHATHUB_WS_URL || 'ws://localhost:5000',
  useHeadlessMode: process.env.USE_HEADLESS === 'true',
  configPath: process.argv[2] || 'enhanced-team-config.json',
  enforcementConfigPath: process.argv[3] || null // Optional separate enforcement config
};

// Global orchestrator instance for cleanup
let orchestrator = null;
let isShuttingDown = false;

/**
 * Main startup function
 */
async function startEnhancedTeam() {
  try {
    console.log(chalk.cyan('🚀 Starting Enhanced Team Orchestration'));
    console.log(chalk.gray('=====================================\n'));

    // Validate configuration file
    if (!fs.existsSync(CONFIG.configPath)) {
      console.error(chalk.red(`❌ Configuration file not found: ${CONFIG.configPath}`));
      console.log(chalk.yellow('💡 Use: node start-enhanced-team.js <config-file> [enforcement-config]'));
      process.exit(1);
    }

    // Check API token
    if (!CONFIG.token) {
      console.error(chalk.red('❌ API_TOKEN environment variable is required'));
      console.log(chalk.yellow('💡 Get a token from Auto-Terminal and set API_TOKEN=your-token'));
      process.exit(1);
    }

    // Initialize components
    console.log(chalk.blue('🏗️  Initializing enhanced orchestration components...'));
    
    const client = new AutoTerminalClient(CONFIG.apiUrl, CONFIG.wsUrl, CONFIG.token);
    const detector = new AgentDetector();
    const promptManager = new PromptManager();

    // Test API connection
    console.log(chalk.gray('   • Testing Auto-Terminal API connection...'));
    try {
      await client.testConnection();
      console.log(chalk.green('   ✅ Auto-Terminal API connected'));
    } catch (error) {
      console.error(chalk.red(`   ❌ Auto-Terminal API connection failed: ${error.message}`));
      console.log(chalk.yellow('   💡 Ensure Auto-Terminal is running on port 3001'));
      process.exit(1);
    }

    // Create enhanced orchestrator
    console.log(chalk.gray('   • Creating Enhanced Team Orchestrator...'));
    orchestrator = new EnhancedTeamOrchestrator(
      client,
      detector,
      promptManager,
      CONFIG.configPath,
      CONFIG.chatHubUrl,
      CONFIG.useHeadlessMode,
      CONFIG.enforcementConfigPath
    );

    // Set up event handlers
    setupEventHandlers(orchestrator);

    // Start orchestration
    console.log(chalk.blue('🎬 Starting enhanced team orchestration...'));
    await orchestrator.start();

    console.log(chalk.green('\n🎉 Enhanced Team Orchestration started successfully!'));
    console.log(chalk.cyan('📊 Monitoring dashboard available at: http://localhost:3000'));
    console.log(chalk.gray('Press Ctrl+C to stop\n'));

    // Deploy the team
    console.log(chalk.blue('👥 Deploying team with enhanced capabilities...'));
    await orchestrator.deployTeam();

    console.log(chalk.green('✅ Team deployment complete with full enforcement enabled'));

  } catch (error) {
    console.error(chalk.red(`❌ Failed to start enhanced team: ${error.message}`));
    console.error(chalk.gray(error.stack));
    process.exit(1);
  }
}

/**
 * Set up event handlers for orchestrator
 */
function setupEventHandlers(orchestrator) {
  // Team coordination events
  orchestrator.on('teamStarted', (data) => {
    console.log(chalk.green(`👥 Team started with ${data.agentCount} agents`));
  });

  orchestrator.on('agentStarted', (data) => {
    console.log(chalk.blue(`🤖 Agent started: ${data.agentId} (${data.role})`));
  });

  orchestrator.on('agentMessage', (data) => {
    console.log(chalk.cyan(`💬 Message from ${data.fromAgent}: ${data.message.substring(0, 100)}...`));
  });

  // Enhancement-specific events
  orchestrator.on('sendMessageToAgent', (data) => {
    console.log(chalk.yellow(`📤 System message to ${data.agentId}: ${data.message.substring(0, 80)}...`));
  });

  orchestrator.on('humanEscalationRequired', (data) => {
    console.log(chalk.red(`🚨 HUMAN ESCALATION REQUIRED: ${data.issue}`));
    console.log(chalk.red(`   Severity: ${data.severity}`));
    console.log(chalk.red(`   Time: ${data.timestamp.toISOString()}`));
  });

  // Quality gate events
  orchestrator.on('qualityGatePassed', (data) => {
    console.log(chalk.green(`🎉 Quality gate PASSED: ${data.gateId} (${data.phase})`));
  });

  orchestrator.on('qualityGateFailed', (data) => {
    console.log(chalk.red(`❌ Quality gate FAILED: ${data.gateId} (${data.phase})`));
    if (data.failedChecks && data.failedChecks.length > 0) {
      console.log(chalk.red(`   Failed checks: ${data.failedChecks.map(c => c.type).join(', ')}`));
    }
  });

  // Git discipline events
  orchestrator.on('commitReminderSent', (data) => {
    console.log(chalk.yellow(`⏰ Git commit reminder sent to ${data.agentId}`));
  });

  orchestrator.on('gitViolationDetected', (data) => {
    console.log(chalk.red(`🚨 Git discipline violation: ${data.violation} (${data.agentId})`));
  });

  // Communication enforcement events
  orchestrator.on('communicationViolation', (data) => {
    console.log(chalk.yellow(`📝 Communication protocol violation by ${data.agentId}: ${data.violation}`));
  });

  orchestrator.on('antiPatternDetected', (data) => {
    console.log(chalk.yellow(`⚠️  Anti-pattern detected: ${data.pattern} (${data.severity})`));
  });

  // Terminal naming events
  orchestrator.on('terminalRenamed', (data) => {
    console.log(chalk.green(`🏷️  Terminal renamed: ${data.oldName} → ${data.newName}`));
  });
}

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(chalk.yellow('\n\n🛑 Received shutdown signal, stopping enhanced team orchestration...'));

  try {
    if (orchestrator) {
      // Export final statistics
      const stats = orchestrator.getEnhancementStatistics();
      console.log(chalk.blue('📊 Final Statistics:'));
      console.log(chalk.gray(JSON.stringify(stats, null, 2)));

      // Export configuration for future reference
      const config = orchestrator.exportConfiguration();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const exportPath = `enhanced-team-export-${timestamp}.json`;
      
      fs.writeFileSync(exportPath, config);
      console.log(chalk.green(`💾 Configuration exported to: ${exportPath}`));

      // Shutdown orchestrator
      await orchestrator.shutdown();
    }

    console.log(chalk.green('✅ Enhanced Team Orchestration stopped gracefully'));
    process.exit(0);

  } catch (error) {
    console.error(chalk.red(`❌ Error during shutdown: ${error.message}`));
    process.exit(1);
  }
}

/**
 * Display startup banner
 */
function showBanner() {
  console.log(chalk.cyan(`
╔══════════════════════════════════════════════════════════════╗
║                Enhanced Team Orchestration                   ║
║                                                              ║
║  🚀 Communication Enforcement                                ║
║  📏 Quality Gate Management                                  ║
║  🔧 Git Discipline Monitoring                               ║
║  🏷️  Terminal Organization                                   ║
║  🛡️  Anti-Pattern Prevention                                 ║
║                                                              ║
║  Based on communication-enforce.md requirements             ║
╚══════════════════════════════════════════════════════════════╝
`));
}

/**
 * Display configuration summary
 */
function showConfigSummary() {
  console.log(chalk.cyan('\n📋 Configuration Summary:'));
  console.log(chalk.white('  • Team Config: ') + chalk.gray(CONFIG.configPath));
  console.log(chalk.white('  • Enforcement Config: ') + chalk.gray(CONFIG.enforcementConfigPath || 'Built-in defaults'));
  console.log(chalk.white('  • Auto-Terminal API: ') + chalk.gray(CONFIG.apiUrl));
  console.log(chalk.white('  • WebSocket: ') + chalk.gray(CONFIG.wsUrl));
  console.log(chalk.white('  • ChatHub: ') + chalk.gray(CONFIG.chatHubUrl));
  console.log(chalk.white('  • Headless Mode: ') + chalk.gray(CONFIG.useHeadlessMode ? 'Enabled' : 'Disabled'));
  console.log('');
}

/**
 * Check for updates and compatibility
 */
function checkCompatibility() {
  // Check Node.js version
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
  
  if (majorVersion < 16) {
    console.warn(chalk.yellow(`⚠️  Node.js ${nodeVersion} detected. Node.js 16+ is recommended for best performance.`));
  }

  // Check if required files exist
  const requiredFiles = [
    './dist/enhanced-team-orchestrator.js',
    './dist/git-discipline-enforcer.js',
    './dist/communication-protocol-enforcer.js',
    './dist/terminal-naming-manager.js',
    './dist/quality-gate-manager.js'
  ];

  const missingFiles = requiredFiles.filter(file => !fs.existsSync(file));
  if (missingFiles.length > 0) {
    console.error(chalk.red('❌ Missing required files. Please run: npm run build'));
    console.error(chalk.red('   Missing: ' + missingFiles.join(', ')));
    process.exit(1);
  }
}

/**
 * Main execution
 */
async function main() {
  // Set up signal handlers
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
  process.on('uncaughtException', (error) => {
    console.error(chalk.red(`💥 Uncaught Exception: ${error.message}`));
    console.error(chalk.gray(error.stack));
    gracefulShutdown();
  });
  process.on('unhandledRejection', (reason, promise) => {
    console.error(chalk.red(`💥 Unhandled Rejection at: ${promise}`));
    console.error(chalk.red(`   Reason: ${reason}`));
    gracefulShutdown();
  });

  // Check compatibility
  checkCompatibility();

  // Show banner and configuration
  showBanner();
  showConfigSummary();

  // Start the enhanced team
  await startEnhancedTeam();
}

// Run if this file is executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error(chalk.red(`💥 Fatal error: ${error.message}`));
    console.error(chalk.gray(error.stack));
    process.exit(1);
  });
}

module.exports = {
  startEnhancedTeam,
  CONFIG
};