#!/usr/bin/env node

// Debug script to understand terminal assignment and shell profile issues
require('dotenv').config();

const fs = require('fs');
const { TeamOrchestrator } = require('./dist/team-orchestrator');
const { AutoTerminalClient } = require('./dist/api-client');
const { AgentDetector } = require('./dist/agent-detector');
const { PromptManager } = require('./dist/prompt-manager');

async function debugTerminalAssignment() {
  console.log('🔍 DEBUGGING TERMINAL ASSIGNMENT AND SHELL PROFILES');
  console.log('='.repeat(60));
  
  const CONFIG = {
    apiUrl: process.env.API_URL || 'http://localhost:3001',
    wsUrl: process.env.WS_URL || 'ws://localhost:9876',
    token: process.env.API_TOKEN || ''
  };

  const client = new AutoTerminalClient({
    apiUrl: CONFIG.apiUrl,
    wsUrl: CONFIG.wsUrl,
    token: CONFIG.token,
    autoReconnect: false
  });

  try {
    await client.connect();
    console.log('✅ Connected to Auto-Terminal\n');

    // Load team configuration
    const teamConfig = JSON.parse(fs.readFileSync('./team-simple.json', 'utf-8'));
    console.log(`📋 Team Configuration Analysis:`);
    console.log(`   Project: ${teamConfig.teamConfig.projectName}`);
    console.log(`   Agents Count: ${teamConfig.agents.length}`);
    console.log(`   DEFAULT_TERMINAL_TABID: ${process.env.DEFAULT_TERMINAL_TABID || 'Not set'}\n`);

    console.log(`🤖 Agent Details:`);
    teamConfig.agents.forEach((agent, index) => {
      console.log(`   ${index + 1}. ${agent.name} (${agent.role})`);
      console.log(`      - Shell Profile: ${agent.shellProfile || 'Not specified (will use default)'}`);
      console.log(`      - CLI Command: ${agent.cliCommand}`);
    });

    console.log(`\n🔧 Testing Terminal Creation with Different Profiles:\n`);

    // Test each profile type
    const profiles = ['cmd', 'powershell', 'bash', 'pwsh'];
    const createdTerminals = [];

    for (const profile of profiles) {
      try {
        console.log(`Testing profile: ${profile}`);
        
        const createOptions = {
          name: `Test ${profile.toUpperCase()} Profile`,
          profile: profile
        };

        // Only add tabId if it's set (to test the issue)
        if (process.env.DEFAULT_TERMINAL_TABID) {
          createOptions.tabId = process.env.DEFAULT_TERMINAL_TABID;
          console.log(`  - Using tabId: ${process.env.DEFAULT_TERMINAL_TABID}`);
        }

        const terminal = await client.createTerminal(createOptions);
        createdTerminals.push({ profile, terminal });
        
        console.log(`  ✅ Created terminal: ${terminal.id}`);
        console.log(`     - Process ID: ${terminal.processId}`);
        console.log(`     - Check Auto-Terminal UI to see if this shows ${profile} or Git Bash\n`);

      } catch (error) {
        console.log(`  ❌ Failed to create ${profile} terminal: ${error.message}\n`);
      }
    }

    console.log(`📊 Summary:`);
    console.log(`   - Created ${createdTerminals.length} terminals`);
    console.log(`   - All terminals created in tab: ${process.env.DEFAULT_TERMINAL_TABID || 'default'}`);
    
    if (process.env.DEFAULT_TERMINAL_TABID) {
      console.log(`   ⚠️  DEFAULT_TERMINAL_TABID is set - all terminals go to same tab`);
      console.log(`   💡 This might create confusion about which terminal receives input`);
    }

    console.log(`\n🧪 Testing Individual Terminal Input:`);
    
    // Test sending different commands to each terminal
    for (let i = 0; i < createdTerminals.length; i++) {
      const { profile, terminal } = createdTerminals[i];
      const testCommand = profile === 'powershell' || profile === 'pwsh' 
        ? `Write-Output "Terminal ${i+1} (${profile}) executed command!"` 
        : `echo "Terminal ${i+1} (${profile}) executed command!"`;
      
      console.log(`Sending to terminal ${i+1} (${profile}): ${testCommand}`);
      await client.sendInput(terminal.id, testCommand + '\\n');
      
      // Wait a bit between commands
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(`\n💡 Check Auto-Terminal UI now:`);
    console.log(`   1. Which terminals show which shell type?`);
    console.log(`   2. Which terminals executed their commands?`);
    console.log(`   3. Are all terminals in the same tab due to DEFAULT_TERMINAL_TABID?`);

  } catch (error) {
    console.error('❌ Debug failed:', error.message);
  } finally {
    await client.disconnect();
  }
}

debugTerminalAssignment().catch(console.error);