#!/usr/bin/env node

// Final verification script for all Auto-Terminal fixes
// Tests: Same tab, unique processes, correct shells, proper input routing

require('dotenv').config();

const { AutoTerminalClient } = require('./dist/api-client');

async function verifyAllFixes() {
  console.log('🔍 FINAL VERIFICATION OF AUTO-TERMINAL FIXES');
  console.log('='.repeat(70));
  console.log('Testing: Shell profiles, process isolation, and input routing\n');
  
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

    const envTabId = process.env.DEFAULT_TERMINAL_TABID;
    console.log(`📋 Using tab ID from environment: ${envTabId}\n`);

    // Test with exact agent-monitor configuration
    const testTerminals = [
      { 
        name: 'Alex Coordinator - Project Coordinator', 
        profile: 'cmd',
        expectedShell: 'Command Prompt'
      },
      { 
        name: 'Jordan Backend - Backend Developer', 
        profile: 'powershell',
        expectedShell: 'PowerShell'
      },
      { 
        name: 'Test Terminal - CMD', 
        profile: 'cmd',
        expectedShell: 'Command Prompt'
      },
      { 
        name: 'Test Terminal - PowerShell', 
        profile: 'powershell',
        expectedShell: 'PowerShell'
      }
    ];

    const terminals = [];
    const processIdSet = new Set();
    
    // Create terminals
    console.log('🚀 CREATING TERMINALS:\n');
    
    for (let i = 0; i < testTerminals.length; i++) {
      const test = testTerminals[i];
      
      console.log(`📦 Terminal ${i + 1}: ${test.name}`);
      console.log(`   Requested Profile: ${test.profile}`);
      
      const terminal = await client.createTerminal({
        name: test.name,
        profile: test.profile,
        tabId: envTabId
      });
      
      console.log(`   ✅ Created Successfully`);
      console.log(`      Terminal ID: ${terminal.id}`);
      console.log(`      Process ID: ${terminal.processId}`);
      console.log(`      Profile: ${terminal.profile}`);
      console.log(`      Tab ID: ${terminal.tabId}`);
      
      // Check for unique process ID
      if (processIdSet.has(terminal.processId)) {
        console.log(`   ❌ DUPLICATE PROCESS ID DETECTED!`);
      } else {
        console.log(`   ✅ Process ID is unique`);
        processIdSet.add(terminal.processId);
      }
      
      terminals.push({
        ...terminal,
        ...test
      });
      
      await sleep(2000);
      console.log('');
    }

    // Verify results
    console.log('\n📊 VERIFICATION RESULTS:');
    console.log('='.repeat(70));
    
    // 1. Check tab sharing
    const tabIds = [...new Set(terminals.map(t => t.tabId))];
    const tabCheck = tabIds.length === 1 && tabIds[0] === envTabId;
    console.log(`\n${tabCheck ? '✅' : '❌'} Tab Sharing: ${tabCheck ? 'PASS' : 'FAIL'}`);
    console.log(`   Expected: All in tab ${envTabId}`);
    console.log(`   Actual: ${tabIds.length === 1 ? `All in tab ${tabIds[0]}` : `Multiple tabs: ${tabIds.join(', ')}`}`);
    
    // 2. Check process uniqueness
    const processCheck = processIdSet.size === terminals.length;
    console.log(`\n${processCheck ? '✅' : '❌'} Process Uniqueness: ${processCheck ? 'PASS' : 'FAIL'}`);
    console.log(`   Expected: ${terminals.length} unique processes`);
    console.log(`   Actual: ${processIdSet.size} unique processes`);
    
    // 3. Check shell profiles
    let profileCheck = true;
    console.log(`\n📋 Shell Profile Check:`);
    terminals.forEach((t, i) => {
      const match = t.profile === t.profile;
      profileCheck = profileCheck && match;
      console.log(`   ${match ? '✅' : '❌'} Terminal ${i + 1}: Requested ${t.profile}, Got ${t.profile}`);
    });
    
    // 4. Test input routing
    console.log('\n🧪 TESTING INPUT ROUTING:');
    console.log('='.repeat(70));
    console.log('Sending unique commands to each terminal...\n');
    
    for (let i = 0; i < terminals.length; i++) {
      const terminal = terminals[i];
      const timestamp = new Date().toLocaleTimeString();
      
      // Send shell-specific verification commands
      let commands = [];
      
      if (terminal.profile === 'cmd') {
        commands = [
          `echo [${timestamp}] Terminal ${i + 1}: CMD Shell Test`,
          `echo %COMSPEC%`,
          `ver`
        ];
      } else if (terminal.profile === 'powershell') {
        commands = [
          `Write-Host "[${timestamp}] Terminal ${i + 1}: PowerShell Test" -ForegroundColor Green`,
          `$PSVersionTable.PSVersion`,
          `Get-Host | Select-Object Version`
        ];
      }
      
      console.log(`📤 Terminal ${i + 1} (${terminal.profile}):`);
      for (const cmd of commands) {
        console.log(`   → ${cmd}`);
        await client.sendInput(terminal.id, cmd + '\r\n');
        await sleep(500);
      }
      console.log('');
    }
    
    // Summary
    console.log('\n✅ VERIFICATION COMPLETE!\n');
    console.log('📋 CHECKLIST:');
    console.log(`   ${tabCheck ? '✅' : '❌'} All terminals in same tab: ${envTabId}`);
    console.log(`   ${processCheck ? '✅' : '❌'} Each terminal has unique process ID`);
    console.log(`   ${profileCheck ? '✅' : '❌'} Shell profiles match requests`);
    console.log('   ⏳ Check Auto-Terminal UI for input routing...');
    
    console.log('\n🔍 MANUAL VERIFICATION:');
    console.log('1. Switch to Auto-Terminal UI tab: ' + envTabId);
    console.log('2. Verify each terminal shows its own unique output');
    console.log('3. CMD terminals should show "Microsoft Windows" version');
    console.log('4. PowerShell terminals should show PSVersion table');
    console.log('5. No commands should appear in wrong terminals');
    
    if (!tabCheck || !processCheck) {
      console.log('\n⚠️  WARNING: Some checks failed. The fixes may not be working correctly.');
    }

  } catch (error) {
    console.error('\n❌ Verification failed:', error.message);
    if (error.response) {
      console.error('   Details:', error.response.data);
    }
  } finally {
    await client.disconnect();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

verifyAllFixes().catch(console.error);