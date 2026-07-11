#!/usr/bin/env node

// Test shared tab functionality
require('dotenv').config();

const { AutoTerminalClient } = require('./dist/api-client');

async function testSharedTab() {
  console.log('🧪 TESTING SHARED TAB FUNCTIONALITY');
  console.log('='.repeat(70));
  
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

    // Test creating multiple terminals without specifying tabId
    // They should all go to the same new tab
    console.log('📋 Test 1: Creating terminals without tabId (should create new shared tab)\n');
    
    const test1Terminals = [];
    let firstTabId = null;
    
    for (let i = 1; i <= 3; i++) {
      console.log(`📦 Creating Terminal ${i}...`);
      const terminal = await client.createTerminal({
        name: `Terminal ${i}`,
        profile: i % 2 === 0 ? 'powershell' : 'cmd'
      });
      
      console.log(`   ✅ Created: ${terminal.id}`);
      console.log(`   Process ID: ${terminal.processId}`);
      console.log(`   Tab ID: ${terminal.tabId}`);
      console.log(`   Profile: ${terminal.profile}\n`);
      
      test1Terminals.push(terminal);
      
      // Capture the first tab ID
      if (!firstTabId && terminal.tabId) {
        firstTabId = terminal.tabId;
      }
      
      await sleep(1000);
    }
    
    // Check if all terminals are in different tabs (current behavior)
    const tabIds = [...new Set(test1Terminals.map(t => t.tabId))];
    console.log(`📊 Tab IDs used: ${tabIds.length} unique tabs`);
    console.log(`   Tab IDs: ${tabIds.join(', ')}\n`);
    
    // Test 2: Use the first tab ID to add more terminals
    if (firstTabId) {
      console.log(`📋 Test 2: Creating terminals in existing tab ${firstTabId}\n`);
      
      const test2Terminals = [];
      
      for (let i = 4; i <= 6; i++) {
        console.log(`📦 Creating Terminal ${i} in tab ${firstTabId}...`);
        try {
          const terminal = await client.createTerminal({
            name: `Terminal ${i}`,
            profile: i % 2 === 0 ? 'powershell' : 'cmd',
            tabId: firstTabId
          });
          
          console.log(`   ✅ Created: ${terminal.id}`);
          console.log(`   Process ID: ${terminal.processId}`);
          console.log(`   Tab ID: ${terminal.tabId}`);
          console.log(`   Profile: ${terminal.profile}\n`);
          
          test2Terminals.push(terminal);
        } catch (error) {
          console.log(`   ❌ Failed: ${error.message}\n`);
        }
        
        await sleep(1000);
      }
      
      // Check results
      const allTerminals = [...test1Terminals, ...test2Terminals];
      const allProcessIds = allTerminals.map(t => t.processId);
      const uniqueProcessIds = new Set(allProcessIds);
      
      console.log('📊 SUMMARY:');
      console.log(`   Total terminals created: ${allTerminals.length}`);
      console.log(`   Unique process IDs: ${uniqueProcessIds.size}`);
      console.log(`   Process ID uniqueness: ${uniqueProcessIds.size === allTerminals.length ? '✅ PASS' : '❌ FAIL'}`);
      
      // Test input routing
      console.log('\n🧪 Testing input routing to each terminal...\n');
      
      for (const terminal of allTerminals) {
        const timestamp = new Date().toLocaleTimeString();
        const command = terminal.profile === 'powershell' 
          ? `Write-Host "[${timestamp}] Terminal ${terminal.id.substr(-6)}" -ForegroundColor Cyan`
          : `echo [${timestamp}] Terminal ${terminal.id.substr(-6)}`;
          
        console.log(`📤 Sending to ${terminal.id.substr(-6)} (${terminal.profile}): ${command}`);
        await client.sendInput(terminal.id, command + '\r\n');
        await sleep(500);
      }
      
      console.log('\n✅ Input routing test complete!');
      console.log('🔍 Check Auto-Terminal UI to verify:');
      console.log('   1. Each terminal shows its own unique output');
      console.log('   2. No commands appear in wrong terminals');
      console.log('   3. PowerShell terminals show colored output');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    await client.disconnect();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

testSharedTab().catch(console.error);