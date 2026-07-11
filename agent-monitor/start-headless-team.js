#!/usr/bin/env node

/**
 * Start team orchestration with headless Auto-Terminal support
 * This script ensures Auto-Terminal is running in headless mode before starting the team
 */

// Load environment variables first
require('dotenv').config();

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

// Configuration
const AUTO_TERMINAL_PATH = path.resolve(__dirname, '..');
const TEAM_CONFIG = process.argv[2] || 'team-config.json';
const USE_HEADLESS = process.env.USE_HEADLESS_MODE !== 'false';

console.log("process.env.USE_HEADLESS_MODE", process.env.USE_HEADLESS_MODE, USE_HEADLESS);

console.log(chalk.cyan('🚀 Starting Team Orchestration with Auto-Terminal Integration'));
console.log(chalk.gray(`Team Config: ${TEAM_CONFIG}`));
console.log(chalk.gray(`Headless Mode: ${USE_HEADLESS ? 'Enabled' : 'Disabled'}`));
console.log(chalk.gray(`Auto-Terminal Path: ${AUTO_TERMINAL_PATH}\n`));

/**
 * Check if Auto-Terminal is already running
 */
async function checkAutoTerminalRunning() {
  const axios = require('axios');

  try {
    const response = await axios.get('http://localhost:3001/api/health', { timeout: 2000 });
    return response.data.mode === 'headless' || !USE_HEADLESS;
  } catch (error) {
    return false;
  }
}

/**
 * Start Auto-Terminal in headless mode
 */
function startAutoTerminalHeadless() {
  return new Promise((resolve, reject) => {
    console.log(chalk.yellow('🖥️ Starting Auto-Terminal in headless mode...'));

    const autoTerminalProcess = spawn('npm', ['run', 'start:headless'], {
      cwd: AUTO_TERMINAL_PATH,
      stdio: 'pipe',
      shell: true
    });

    let started = false;

    autoTerminalProcess.stdout.on('data', (data) => {
      const output = data.toString();

      // Look for indication that API is ready
      if (output.includes('API server listening') || output.includes('WebSocket server')) {
        if (!started) {
          started = true;
          console.log(chalk.green('✅ Auto-Terminal headless mode started'));
          setTimeout(resolve, 2000); // Give it a moment to fully initialize
        }
      }
    });

    autoTerminalProcess.stderr.on('data', (data) => {
      console.error(chalk.red(`Auto-Terminal error: ${data}`));
    });

    autoTerminalProcess.on('close', (code) => {
      if (code !== 0 && !started) {
        reject(new Error(`Auto-Terminal exited with code ${code}`));
      }
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!started) {
        autoTerminalProcess.kill();
        reject(new Error('Auto-Terminal failed to start within 30 seconds'));
      }
    }, 30000);
  });
}

/**
 * Start team orchestration
 */
function startTeamOrchestration() {
  return new Promise((resolve, reject) => {
    console.log(chalk.yellow('👥 Starting team orchestration...'));

    const env = {
      ...process.env,
      USE_HEADLESS_MODE: USE_HEADLESS.toString(),     
    };

    // log TEAM_CONFIG to see if it's being used
    console.log("TEAM_CONFIG", TEAM_CONFIG);
    console.log("env", env);

    const teamProcess = spawn('node', ['dist/team-manager.js', 'start', TEAM_CONFIG], {
      stdio: 'inherit',
      env,
      shell: true
    });

    teamProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Team orchestration exited with code ${code}`));
      }
    });

    teamProcess.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Main execution
 */
async function main() {
  try {
    // Check if team config exists
    if (!fs.existsSync(TEAM_CONFIG)) {
      console.error(chalk.red(`❌ Team config file not found: ${TEAM_CONFIG}`));
      process.exit(1);
    }

    if (USE_HEADLESS) {
      // Check if Auto-Terminal is already running in headless mode
      const isRunning = await checkAutoTerminalRunning();
      console.log("Auto-Terminal service is running: ", isRunning ? chalk.green('Yes') : chalk.red('No') + '\n');

      if (!isRunning) {
        await startAutoTerminalHeadless();
      } else {
        console.log(chalk.green('✅ Auto-Terminal is already running in headless mode'));
      }
    } else {
      console.log(chalk.blue('📊 Using UI mode - ensure Auto-Terminal is running with GUI'));
    }

    // Start team orchestration
    await startTeamOrchestration();

  } catch (error) {
    console.error(chalk.red(`❌ Failed to start team: ${error.message}`));
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log(chalk.yellow('\n🛑 Shutting down team orchestration...'));
  process.exit(0);
});

// Start the process
main();