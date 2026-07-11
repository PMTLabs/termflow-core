#!/usr/bin/env node

// Debug the 500 error when creating agent terminals
require('dotenv').config();

const fs = require('fs');
const { AutoTerminalClient } = require('./dist/api-client');

async function debug500Error() {
  console.log('🔍 DEBUGGING 500 ERROR IN AGENT TERMINAL CREATION');
  console.log('='.repeat(60));
  
  const CONFIG = {
    apiUrl: process.env.API_URL || 'http://localhost:3001',
    wsUrl: process.env.WS_URL || 'ws://localhost:9876',
    token: process.env.API_TOKEN || ''
  };

  console.log(`Configuration:`);
  console.log(`  API URL: ${CONFIG.apiUrl}`);
  console.log(`  WebSocket: ${CONFIG.wsUrl}`);
  console.log(`  Token: ${CONFIG.token.substring(0, 20)}...`);
  console.log(`  DEFAULT_TERMINAL_TABID: ${process.env.DEFAULT_TERMINAL_TABID}`);
  console.log('');

  const client = new AutoTerminalClient({
    apiUrl: CONFIG.apiUrl,
    wsUrl: CONFIG.wsUrl,
    token: CONFIG.token,
    autoReconnect: false
  });

  try {
    await client.connect();
    console.log('✅ Connected to Auto-Terminal\n');

    // Load the team configuration that's causing the issue
    const teamConfig = JSON.parse(fs.readFileSync('./team-simple.json', 'utf-8'));
    console.log('📋 Team Configuration:');
    console.log(`   Project: ${teamConfig.teamConfig.projectName}`);
    console.log(`   Agents: ${teamConfig.agents.length}\n`);

    // Test creating terminals exactly as agent-monitor does
    for (let i = 0; i < teamConfig.agents.length; i++) {
      const agent = teamConfig.agents[i];
      console.log(`🤖 Testing Agent ${i + 1}: ${agent.name} (${agent.role})`);
      console.log(`   Shell Profile: ${agent.shellProfile || 'default'}`);
      
      try {
        // Replicate exact agent-monitor terminal creation logic
        const createTerminalOptions = {
          name: `${agent.name} - ${agent.role}`,
          profile: agent.shellProfile || 'powershell'
        };
        
        // Add default tab ID if specified in environment
        if (process.env.DEFAULT_TERMINAL_TABID) {
          createTerminalOptions.tabId = process.env.DEFAULT_TERMINAL_TABID;
          console.log(`   Using tabId: ${process.env.DEFAULT_TERMINAL_TABID}`);
        }

        console.log(`   Creating terminal with options:`, createTerminalOptions);
        
        const terminal = await client.createTerminal(createTerminalOptions);
        
        console.log(`   ✅ SUCCESS: Terminal created`);
        console.log(`      - Terminal ID: ${terminal.id}`);
        console.log(`      - Process ID: ${terminal.processId}`);
        console.log(`      - Name: ${terminal.name || 'N/A'}`);
        
        // Test the commands that would be sent
        console.log(`   📁 Testing directory change...`);
        const projectFolder = teamConfig.teamConfig.projectFolder;
        await client.sendInput(terminal.id, `cd "${projectFolder}"\\n`);
        
        await sleep(1000);
        
        console.log(`   🚀 Testing CLI command...`);
        await client.sendInput(terminal.id, agent.cliCommand + '\\n');
        
        await sleep(2000);
        console.log(`   ✅ All commands sent successfully\n`);
        
      } catch (error) {
        console.log(`   ❌ FAILED: ${error.message}`);
        console.log(`   Error details:`, error.response?.data || 'No additional details');
        console.log(`   Status: ${error.response?.status || 'N/A'}`);
        console.log(`   Headers:`, error.response?.headers || 'N/A');
        console.log('');
        
        // Let's try simpler options to isolate the issue
        console.log('   🔧 Trying simpler terminal creation...');
        
        try {
          // Try without tabId
          const simpleOptions = {
            name: `Simple ${agent.name}`,
            profile: 'cmd' // Try basic cmd profile
          };
          
          console.log(`   Trying with simpler options:`, simpleOptions);
          const simpleTerminal = await client.createTerminal(simpleOptions);
          console.log(`   ✅ Simple terminal worked: ${simpleTerminal.id}`);
          
        } catch (simpleError) {
          console.log(`   ❌ Even simple terminal failed: ${simpleError.message}`);
          
          // Try absolute minimal
          try {
            const minimalTerminal = await client.createTerminal({ name: 'Minimal Test' });
            console.log(`   ✅ Minimal terminal worked: ${minimalTerminal.id}`);
            console.log('   💡 Issue might be with profile or tabId parameters');
          } catch (minimalError) {
            console.log(`   ❌ Minimal terminal also failed: ${minimalError.message}`);
            console.log('   💡 Issue might be with Auto-Terminal API itself');
          }
        }
        
        break; // Stop testing other agents after first failure
      }
    }

  } catch (error) {
    console.error('❌ Debug failed:', error.message);
  } finally {
    await client.disconnect();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

debug500Error().catch(console.error);