#!/usr/bin/env node

// Debug script to test shell profile selection issue
require('dotenv').config();

const { AutoTerminalClient } = require('./dist/api-client');

async function debugShellProfiles() {
  console.log('🔍 DEBUGGING SHELL PROFILE SELECTION ISSUE');
  console.log('='.repeat(60));
  console.log('Issue: All terminals opening Git Bash instead of specified profiles\n');
  
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

    // Test different shell profiles exactly as agent-monitor uses them
    const testProfiles = [
      { name: 'Alex Coordinator - Project Coordinator', profile: 'cmd' },
      { name: 'Jordan Backend - Backend Developer', profile: 'powershell' },
      { name: 'Test Terminal - PowerShell Explicit', profile: 'powershell' },
      { name: 'Test Terminal - CMD Explicit', profile: 'cmd' },
      { name: 'Test Terminal - Default', profile: undefined }
    ];

    const envTabId = process.env.DEFAULT_TERMINAL_TABID;
    console.log(`🔧 DEFAULT_TERMINAL_TABID: ${envTabId || 'Not set'}\n`);

    const terminals = [];
    
    for (let i = 0; i < testProfiles.length; i++) {
      const test = testProfiles[i];
      
      try {
        console.log(`📋 Test ${i + 1}: Creating terminal with profile '${test.profile || 'default'}'`);
        console.log(`   Name: "${test.name}"`);
        
        const createOptions = {
          name: test.name,
          profile: test.profile || 'powershell'
        };
        
        // Use environment tab ID if set (like agent-monitor does)
        if (envTabId && i > 0) {
          createOptions.tabId = envTabId;
          console.log(`   Using tab ID: ${envTabId}`);
        }
        
        console.log(`   Request payload:`, JSON.stringify(createOptions, null, 2));
        
        const terminal = await client.createTerminal(createOptions);
        
        console.log(`   ✅ Terminal created successfully`);
        console.log(`      Terminal ID: ${terminal.id}`);
        console.log(`      Process ID: ${terminal.processId}`);
        console.log(`      Profile Used: ${terminal.profile}`);
        console.log(`      Tab ID: ${terminal.tabId}`);
        console.log(`      PID: ${terminal.pid}`);
        
        terminals.push({
          ...terminal,
          requestedProfile: test.profile || 'default'
        });
        
        await sleep(2000); // Wait between creations
        console.log('');
        
      } catch (error) {
        console.log(`   ❌ Failed to create terminal: ${error.message}`);
        console.log(`      Error details:`, error.response?.data || error.message);
        console.log('');
      }
    }

    // Summary of results
    console.log('📊 PROFILE MAPPING RESULTS:');
    console.log('='.repeat(60));
    
    for (const terminal of terminals) {
      const profileMatch = terminal.profile === terminal.requestedProfile;
      const status = profileMatch ? '✅ CORRECT' : '❌ WRONG';
      
      console.log(`${status} Terminal: ${terminal.name}`);
      console.log(`     Requested: ${terminal.requestedProfile}`);
      console.log(`     Got: ${terminal.profile}`);
      console.log(`     Terminal ID: ${terminal.id}`);
      console.log('');
    }

    // Test commands to verify shells
    console.log('🧪 SHELL VERIFICATION TESTS:');
    console.log('='.repeat(60));
    console.log('Sending test commands to verify which shell is actually running...\n');
    
    for (const terminal of terminals) {
      console.log(`🎯 Testing ${terminal.name} (Profile: ${terminal.profile})`);
      
      // Send shell identification command
      const testCommand = 'echo Shell Type: $0 & echo Shell Type: %ComSpec% & $PSVersionTable.PSVersion 2>nul & git --version 2>nul';
      
      console.log(`   Sending command: ${testCommand}`);
      await client.sendInput(terminal.id, testCommand + '\r\n');
      
      await sleep(1000);
      console.log(`   ✅ Command sent to ${terminal.id}\n`);
    }

    console.log('💡 NEXT STEPS:');
    console.log('1. Check Auto-Terminal UI to see which shells actually opened');
    console.log('2. Look at the command output to identify the actual shell types');
    console.log('3. Compare requested vs actual profiles from the results above');
    console.log('4. Check Auto-Terminal logs for shell profile resolution messages');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('   Response data:', error.response.data);
      console.error('   Status:', error.response.status);
    }
  } finally {
    await client.disconnect();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

debugShellProfiles().catch(console.error);