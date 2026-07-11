#!/usr/bin/env node

// Solution for agent-monitor: Fix terminal routing by using separate tabs or valid tab detection
require('dotenv').config();

const fs = require('fs');
const { AutoTerminalClient } = require('./dist/api-client');

async function fixAgentMonitorRouting() {
  console.log('🔧 FIXING AGENT-MONITOR TERMINAL ROUTING');
  console.log('='.repeat(50));
  
  const CONFIG = {
    apiUrl: process.env.API_URL || 'http://localhost:3001',
    wsUrl: process.env.WS_URL || 'ws://localhost:9876',
    token: process.env.API_TOKEN || ''
  };

  console.log(`Current environment:`);
  console.log(`   DEFAULT_TERMINAL_TABID: ${process.env.DEFAULT_TERMINAL_TABID || 'Not set'}`);
  console.log(`   Problem: When set, all terminals created in same tab, input goes to first terminal\n`);

  const client = new AutoTerminalClient({
    apiUrl: CONFIG.apiUrl,
    wsUrl: CONFIG.wsUrl,
    token: CONFIG.token,
    autoReconnect: false
  });

  try {
    await client.connect();
    console.log('✅ Connected to Auto-Terminal\n');

    // Solution 1: Test terminals WITHOUT tabId (separate tabs)
    console.log('💡 SOLUTION 1: Create terminals in separate tabs (no tabId)');
    
    const teamConfig = JSON.parse(fs.readFileSync('./team-simple.json', 'utf-8'));
    const separateTabTerminals = [];
    
    for (let i = 0; i < teamConfig.agents.length; i++) {
      const agent = teamConfig.agents[i];
      console.log(`Creating terminal for ${agent.name}...`);
      
      // Create terminal WITHOUT tabId - each gets its own tab
      const terminal = await client.createTerminal({
        name: `${agent.name} - ${agent.role}`,
        profile: agent.shellProfile || 'powershell'
        // No tabId - creates in separate tab
      });
      
      separateTabTerminals.push({ terminal, agent });
      console.log(`  ✅ Created in separate tab: ${terminal.id}`);
      
      await sleep(1000);
      
      // Test sending command to verify routing
      const testCmd = `echo "TEST: ${agent.name} terminal working correctly"`;
      console.log(`  📤 Testing command: ${testCmd}`);
      await client.sendInput(terminal.id, testCmd + '\\n');
      
      await sleep(2000);
    }
    
    console.log(`\\n✅ Solution 1 Results:`);
    console.log(`   - Created ${separateTabTerminals.length} terminals in separate tabs`);
    console.log(`   - Each terminal should receive its own commands`);
    console.log(`   - Check Auto-Terminal: should see multiple tabs with working terminals\\n`);

    // Solution 2: Test with current approach but verify first terminal state
    console.log('💡 SOLUTION 2: Test agent-monitor workflow without DEFAULT_TERMINAL_TABID');
    
    // Simulate what agent-monitor does but without tabId
    console.log('Simulating agent-monitor workflow...');
    
    for (const { terminal, agent } of separateTabTerminals) {
      console.log(`\\n🤖 Agent: ${agent.name}`);
      
      // Step 1: Change directory (as agent-monitor does)
      const cdCommand = `cd "${teamConfig.teamConfig.projectFolder}"`;
      console.log(`  📁 Directory: ${cdCommand}`);
      await client.sendInput(terminal.id, cdCommand + '\\n');
      await sleep(1000);
      
      // Step 2: Start AI CLI (as agent-monitor does)  
      console.log(`  🚀 AI CLI: ${agent.cliCommand}`);
      await client.sendInput(terminal.id, agent.cliCommand + '\\n');
      await sleep(2000);
      
      console.log(`  ✅ ${agent.name} setup complete`);
    }

    console.log('\\n📊 RECOMMENDATIONS:');
    console.log('');
    console.log('🎯 FOR MULTI-AGENT WORKFLOW:');
    console.log('  Option A: Remove DEFAULT_TERMINAL_TABID entirely');
    console.log('    - Each agent gets separate tab');
    console.log('    - Eliminates routing conflicts');
    console.log('    - Easier to track agent activity');
    console.log('');
    console.log('  Option B: Create all agents in separate tabs by default');
    console.log('    - Better isolation between agents');
    console.log('    - Clear visual separation');
    console.log('    - No input routing confusion');
    console.log('');
    console.log('🔧 IMPLEMENTATION:');
    console.log('  1. Comment out DEFAULT_TERMINAL_TABID in .env');
    console.log('  2. Or modify agent-monitor to not use tabId parameter');
    console.log('  3. Each agent gets unique tab for better management');

  } catch (error) {
    console.error('❌ Fix attempt failed:', error.message);
  } finally {
    await client.disconnect();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

fixAgentMonitorRouting().catch(console.error);