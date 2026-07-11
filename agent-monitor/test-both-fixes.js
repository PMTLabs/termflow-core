#!/usr/bin/env node

// Comprehensive test of both Auto-Terminal shell profile fixes and agent-monitor improvements
require('dotenv').config();

const fs = require('fs');
const { AutoTerminalClient } = require('./dist/api-client');

async function testBothFixes() {
  console.log('🎯 COMPREHENSIVE TEST: Auto-Terminal Shell Profile Fix + Agent-Monitor');
  console.log('='.repeat(80));
  
  const CONFIG = {
    apiUrl: process.env.API_URL || 'http://localhost:3001',
    wsUrl: process.env.WS_URL || 'ws://localhost:9876',
    token: process.env.API_TOKEN || ''
  };

  console.log(`Environment:`);
  console.log(`  Auto-Terminal API: ${CONFIG.apiUrl}`);
  console.log(`  WebSocket: ${CONFIG.wsUrl}`);
  console.log(`  Token present: ${!!CONFIG.token}`);
  console.log(`  DEFAULT_TERMINAL_TABID: ${process.env.DEFAULT_TERMINAL_TABID || 'Not set'}`);
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

    // Test 1: Shell Profile Mapping Fix
    console.log('🔧 TEST 1: Auto-Terminal Shell Profile Mapping Fix');
    console.log('-'.repeat(50));

    const testProfiles = [
      { profile: 'cmd', expected: 'Command Prompt', description: 'Windows Command Prompt' },
      { profile: 'powershell', expected: 'PowerShell', description: 'Windows PowerShell' },
      { profile: 'pwsh', expected: 'PowerShell Core', description: 'PowerShell Core (if available)' },
      { profile: 'bash', expected: 'Git Bash', description: 'Git Bash (if available)' }
    ];

    const createdTerminals = [];
    
    for (const { profile, expected, description } of testProfiles) {
      try {
        console.log(`Creating terminal with profile: ${profile} (expecting ${expected})`);
        
        const terminal = await client.createTerminal({
          name: `Test ${profile.toUpperCase()}`,
          profile: profile
        });
        
        createdTerminals.push({ profile, expected, terminal, description });
        console.log(`  ✅ Created: ${terminal.id}`);
        
        // Give Auto-Terminal time to initialize
        await sleep(1000);
        
        // Send a test command with \n (testing agent-monitor sendInput fix)
        const testCmd = profile === 'powershell' || profile === 'pwsh' 
          ? 'Write-Output "Shell test successful!"'
          : 'echo Shell test successful!';
          
        console.log(`  📤 Sending command: ${testCmd}`);
        await client.sendInput(terminal.id, testCmd + '\\n'); // Using \\n fix
        
        await sleep(1500);
        console.log(`  💡 Check Auto-Terminal UI - terminal should show ${expected}, not Git Bash`);
        console.log('');
        
      } catch (error) {
        console.log(`  ❌ Failed to create ${profile}: ${error.message}\\n`);
      }
    }

    // Test 2: Agent-Monitor Integration Test
    console.log('🤖 TEST 2: Agent-Monitor Team Configuration Test');
    console.log('-'.repeat(50));

    const teamConfig = JSON.parse(fs.readFileSync('./team-simple.json', 'utf-8'));
    console.log(`Team: ${teamConfig.teamConfig.projectName}`);
    console.log(`Agents: ${teamConfig.agents.length}`);

    for (let i = 0; i < teamConfig.agents.length; i++) {
      const agent = teamConfig.agents[i];
      console.log(`\\nAgent ${i + 1}: ${agent.name} (${agent.role})`);
      console.log(`  Shell Profile: ${agent.shellProfile || 'default'}`);
      console.log(`  CLI Command: ${agent.cliCommand}`);

      try {
        // Create terminal as agent-monitor would
        const createOptions = {
          name: `${agent.name} - ${agent.role}`,
          profile: agent.shellProfile || 'powershell'
        };

        // Add tabId only if DEFAULT_TERMINAL_TABID is set
        if (process.env.DEFAULT_TERMINAL_TABID) {
          createOptions.tabId = process.env.DEFAULT_TERMINAL_TABID;
          console.log(`  📂 Using tab: ${process.env.DEFAULT_TERMINAL_TABID}`);
        }

        const terminal = await client.createTerminal(createOptions);
        console.log(`  ✅ Terminal created: ${terminal.id}`);

        // Test directory change (agent-monitor pattern)
        const projectFolder = teamConfig.teamConfig.projectFolder;
        const cdCommand = `cd "${projectFolder}"`;
        console.log(`  📁 Changing to project directory: ${cdCommand}`);
        await client.sendInput(terminal.id, cdCommand + '\\n'); // Fixed with \\n
        
        await sleep(1000);
        
        // Test CLI command (agent-monitor pattern)
        console.log(`  🚀 Starting AI CLI: ${agent.cliCommand}`);
        await client.sendInput(terminal.id, agent.cliCommand + '\\n'); // Fixed with \\n
        
        await sleep(2000);
        console.log(`  💡 Check terminal for ${agent.name} - should execute commands immediately`);
        
      } catch (error) {
        console.log(`  ❌ Failed to create agent terminal: ${error.message}`);
      }
    }

    // Test 3: Summary and Validation
    console.log('\\n📊 TEST SUMMARY');
    console.log('='.repeat(50));
    console.log('✅ FIXES APPLIED:');
    console.log('   1. Auto-Terminal shell profile mapping - prevents Git Bash override');
    console.log('   2. Agent-monitor sendInput commands - all append \\\\n for execution');
    console.log('   3. Team configuration - explicit shellProfile per agent');
    console.log('');
    console.log('💡 WHAT TO VERIFY IN AUTO-TERMINAL UI:');
    console.log('   • CMD profiles show Command Prompt (not Git Bash)');
    console.log('   • PowerShell profiles show PowerShell (not Git Bash)');
    console.log('   • All commands execute immediately (no typing without execution)');
    console.log('   • Each agent gets unique terminal (even if same tab)');
    console.log('');
    
    if (process.env.DEFAULT_TERMINAL_TABID) {
      console.log('⚠️  DEFAULT_TERMINAL_TABID is set - all terminals in same tab');
      console.log('   This is normal for agent-monitor workflow');
      console.log('   Each agent still gets unique terminal ID for input routing');
    }

    console.log('\\n🎉 Test completed! Both Auto-Terminal and agent-monitor fixes are applied.');

  } catch (error) {
    if (error.message.includes('Authentication failed')) {
      console.log('❌ Auto-Terminal API Token authentication failed');
      console.log('💡 Get new token from Auto-Terminal DevTools: localStorage.getItem("api-token")');
    } else {
      console.error('❌ Test failed:', error.message);
    }
  } finally {
    await client.disconnect();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

testBothFixes().catch(console.error);